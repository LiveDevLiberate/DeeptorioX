/**
 * Minimal Bilibili live-danmaku client (read-only, zero dependencies).
 *
 * Bilibili's anonymous HTTP history endpoints are unreliable (the web rooms
 * return empty history or WBI risk-control errors), so the real-time source is
 * the live chat WebSocket:
 *
 *   room_init -> buvid3 cookie -> WBI keys (nav) -> signed getDanmuInfo
 *   -> wss://<host>:443/sub -> AUTH packet -> 30 s heartbeat
 *   -> op=5 packets (zlib/brotli, possibly nested) -> DANMU_MSG JSON
 *
 * The transport uses the WHATWG `WebSocket` global (Node.js 22+; Node 20 works
 * with `NODE_OPTIONS=--experimental-websocket`), matching `src/obs-client.ts`.
 * Everything else (WBI signing, packet framing, decompression, message parsing)
 * is pure and unit-tested without network access.
 */

import { createHash } from "node:crypto";
import { brotliDecompressSync, inflateSync } from "node:zlib";
import { asNumber, asRecord, asString } from "./validation.js";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const ROOM_INIT_URL = "https://api.live.bilibili.com/room/v1/Room/room_init";
const ROOM_INFO_URL = "https://api.live.bilibili.com/room/v1/Room/get_info";
const DANMAKU_INFO_URL = "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo";
const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
const BUVID_URL = "https://www.bilibili.com/";
const LIVE_REFERER = "https://live.bilibili.com/";
const WBI_INDEX_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13,
];
const PACKET_HEADER_BYTES = 16;
const HEARTBEAT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;
const FETCH_TIMEOUT_MS = 10_000;

/** WebSocket operation codes used by the live chat protocol. */
export const BILI_WS_OP = {
  heartbeat: 2,
  heartbeatReply: 3,
  message: 5,
  auth: 7,
  authReply: 8,
} as const;

export type LiveChatKind = "danmaku" | "super_chat";

/** One viewer message extracted from the live chat. */
export type LiveChatMessage = {
  kind: LiveChatKind;
  /** Unix milliseconds (room-local server time for DANMU_MSG). */
  ts: number;
  uid: number;
  uname: string;
  text: string;
  admin?: boolean;
  /** Fan-medal name, when the viewer has one. */
  medal?: string;
  /** Super-chat price in CNY. */
  price?: number;
};

export type LiveChatConnectionState =
  "idle" | "connecting" | "connected" | "reconnecting" | "error" | "stopped";

export type LiveChatStatus = {
  state: LiveChatConnectionState;
  room_id: number | null;
  live_status: number | null;
  title: string | null;
  popularity: number | null;
  connected_at: string | null;
  last_message_at: string | null;
  last_error: string | null;
};

export type LiveLogger = (
  level: "info" | "warn" | "error",
  message: string,
  context?: Record<string, unknown>,
) => void;

export type BilibiliLiveOptions = {
  /** Short or long room id (both are resolved through room_init). */
  roomId: number | string;
  userAgent?: string;
  /** Optional `SESSDATA=...;` style cookie appended to HTTP requests. */
  cookie?: string;
  onMessage?: (message: LiveChatMessage) => void;
  onStatus?: (status: LiveChatStatus) => void;
  logger?: LiveLogger;
  /** Reconnect backoff (defaults 1s -> 60s). */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  heartbeatMs?: number;
};

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

function toBuffer(data: unknown): Buffer | undefined {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

function partName(url: string): string {
  const name = url.slice(url.lastIndexOf("/") + 1);
  return name.split(".")[0];
}

/**
 * Derive the 32-char WBI key from the `/x/web-interface/nav` payload.
 * Anonymous calls still return `wbi_img` (code -101), which is enough for
 * signing the danmaku-server request.
 */
export function wbiKeyFromNav(nav: unknown): string | undefined {
  const data = asRecord(asRecord(nav)?.data);
  const wbiImg = asRecord(data?.wbi_img);
  const imgUrl = asString(wbiImg?.img_url);
  const subUrl = asString(wbiImg?.sub_url);
  if (!imgUrl || !subUrl) return undefined;
  const shuffled = partName(imgUrl) + partName(subUrl);
  if (shuffled.length < 32) return undefined;
  return WBI_INDEX_TABLE.map((index) => shuffled[index] ?? "").join("");
}

/** Add `wts` + `w_rid` WBI-signature parameters (matches the blivedm algorithm). */
export function wbiSignedParams(
  params: Record<string, string | number>,
  wbiKey: string,
  nowMs = Date.now(),
): Record<string, string> {
  const wts = String(Math.floor(nowMs / 1000));
  const withTimestamp: Record<string, string> = { ...toSignedStrings(params), wts };
  const query = Object.keys(withTimestamp)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(withTimestamp[key])}`)
    .join("&");
  return { ...toSignedStrings(params), wts, w_rid: md5(query + wbiKey) };
}

function toSignedStrings(params: Record<string, string | number>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    result[key] = String(value).replace(/[!'()*]/g, "");
  }
  return result;
}

/** Encode one protocol packet: 16-byte big-endian header + payload. */
export function encodeBiliPacket(body: Buffer | string, op: number, sequence = 1): Buffer {
  const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const header = Buffer.alloc(PACKET_HEADER_BYTES);
  header.writeUInt32BE(PACKET_HEADER_BYTES + payload.length, 0);
  header.writeUInt16BE(PACKET_HEADER_BYTES, 4);
  header.writeUInt16BE(1, 6);
  header.writeUInt32BE(op, 8);
  header.writeUInt32BE(sequence, 12);
  return Buffer.concat([header, payload]);
}

export type BiliFrame = { op: number; protover: number; payload: Buffer };

function readRawFrames(buffer: Buffer): BiliFrame[] {
  const frames: BiliFrame[] = [];
  let offset = 0;
  while (offset + PACKET_HEADER_BYTES <= buffer.length) {
    const total = buffer.readUInt32BE(offset);
    const headerBytes = buffer.readUInt16BE(offset + 4);
    const protover = buffer.readUInt16BE(offset + 6);
    const op = buffer.readUInt32BE(offset + 8);
    if (total < PACKET_HEADER_BYTES || offset + total > buffer.length) break;
    frames.push({
      op,
      protover,
      payload: buffer.subarray(offset + headerBytes, offset + total),
    });
    offset += total;
  }
  return frames;
}

/**
 * Decode a WebSocket frame buffer into JSON-bearing frames. `op=5` payloads
 * with protover 2 (zlib) or 3 (brotli) are decompressed and may contain another
 * packet batch; those nested packets are flattened here.
 */
export function readBiliFrames(buffer: Buffer): BiliFrame[] {
  const frames: BiliFrame[] = [];
  for (const frame of readRawFrames(buffer)) {
    if (
      frame.op === BILI_WS_OP.message &&
      (frame.protover === 2 || frame.protover === 3) &&
      frame.payload.length
    ) {
      try {
        const inflated =
          frame.protover === 2 ? inflateSync(frame.payload) : brotliDecompressSync(frame.payload);
        frames.push(...readBiliFrames(Buffer.from(inflated)));
      } catch {
        // A single corrupt batch must not kill the connection.
      }
      continue;
    }
    frames.push(frame);
  }
  return frames;
}

function numberField(value: unknown, fallback = 0): number {
  return asNumber(value) ?? fallback;
}

function chatText(value: unknown): string {
  return (asString(value) ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Parse one JSON payload into a viewer message. Unknown commands (gifts,
 * follows, room events) return undefined; malformed JSON also returns undefined.
 */
export function parseBiliMessagePayload(payload: Buffer | string): LiveChatMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof payload === "string" ? payload : payload.toString("utf8"));
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  const cmd = asString(record?.cmd) ?? "";
  if (cmd.startsWith("DANMU_MSG")) {
    const info = Array.isArray(record?.info) ? record.info : [];
    const meta = Array.isArray(info[0]) ? info[0] : [];
    const text = chatText(info[1]);
    if (!text) return undefined;
    const user = Array.isArray(info[2]) ? info[2] : [];
    const medal = Array.isArray(info[3]) ? asString(info[3][1]) : undefined;
    return {
      kind: "danmaku",
      ts: numberField(meta[4], Date.now()),
      uid: numberField(user[0]),
      uname: chatText(user[1]) || "观众",
      text,
      ...(numberField(user[2]) === 1 ? { admin: true } : {}),
      ...(medal ? { medal } : {}),
    };
  }
  if (cmd === "SUPER_CHAT_MESSAGE") {
    const data = asRecord(record?.data);
    const userInfo = asRecord(data?.user_info);
    const text = chatText(data?.message);
    if (!text) return undefined;
    const startSeconds = numberField(data?.start_time);
    const medalInfo = asRecord(data?.medal_info);
    return {
      kind: "super_chat",
      ts: startSeconds > 0 ? startSeconds * 1000 : Date.now(),
      uid: numberField(userInfo?.uid),
      uname: chatText(userInfo?.uname) || "观众",
      text,
      ...(medalInfo ? { medal: chatText(medalInfo.medal_name) || undefined } : {}),
      price: numberField(data?.price),
    };
  }
  return undefined;
}

function assertWebSocketAvailable(): void {
  if (typeof WebSocket !== "function") {
    throw new Error(
      "Live danmaku needs the Node.js WebSocket global (Node 22+; Node 20 with NODE_OPTIONS=--experimental-websocket).",
    );
  }
}

type ResolvedRoom = { roomId: number; liveStatus: number | null; title: string | null };
type DanmakuServer = { host: string; port: number; token: string };

/** Read-only Bilibili live chat client with automatic reconnects. */
export class BilibiliLiveChat {
  private readonly roomInput: number | string;
  private readonly userAgent: string;
  private readonly cookie: string;
  private readonly onMessage?: (message: LiveChatMessage) => void;
  private readonly onStatus?: (status: LiveChatStatus) => void;
  private readonly logger?: LiveLogger;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly heartbeatMs: number;

  private status: LiveChatStatus = {
    state: "idle",
    room_id: null,
    live_status: null,
    title: null,
    popularity: null,
    connected_at: null,
    last_message_at: null,
    last_error: null,
  };
  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private authResolve: (() => void) | null = null;
  private authReject: ((error: Error) => void) | null = null;
  private reconnectAttempts = 0;
  private started = false;
  private stopped = true;

  constructor(options: BilibiliLiveOptions) {
    this.roomInput = options.roomId;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.cookie = options.cookie ?? "";
    this.onMessage = options.onMessage;
    this.onStatus = options.onStatus;
    this.logger = options.logger;
    this.reconnectBaseMs = Math.max(250, options.reconnectBaseMs ?? 1_000);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, options.reconnectMaxMs ?? 60_000);
    this.heartbeatMs = Math.max(10_000, options.heartbeatMs ?? HEARTBEAT_MS);
  }

  status_(): LiveChatStatus {
    return { ...this.status };
  }

  /** Resolve the room, connect and authenticate; throws on the first failure. */
  async start(): Promise<LiveChatStatus> {
    if (this.started) return this.status_();
    assertWebSocketAvailable();
    this.started = true;
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.patchStatus({ state: "connecting", last_error: null });
    try {
      await this.connectOnce();
    } catch (error) {
      this.started = false;
      this.cleanupSocket();
      this.patchStatus({ state: "error", last_error: errorMessage(error) });
      throw error;
    }
    return this.status_();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    this.clearTimers();
    this.cleanupSocket();
    this.patchStatus({ state: "stopped" });
  }

  private patchStatus(patch: Partial<LiveChatStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.status_());
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
  }

  private cleanupSocket(): void {
    this.authResolve = null;
    this.authReject = null;
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const attempts = Math.min(this.reconnectAttempts + 1, 8);
    this.reconnectAttempts = attempts;
    const wait = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** (attempts - 1));
    this.patchStatus({ state: "reconnecting" });
    this.logger?.("warn", "Live chat disconnected; reconnecting", { wait_ms: wait, attempt: attempts });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void this.connectOnce().catch((error) => {
        this.patchStatus({ state: "reconnecting", last_error: errorMessage(error) });
        this.scheduleReconnect();
      });
    }, wait);
    this.reconnectTimer.unref?.();
  }

  private async connectOnce(): Promise<void> {
    this.clearTimers();
    this.cleanupSocket();
    this.patchStatus({ state: "connecting" });
    const room = await this.resolveRoom();
    this.patchStatus({ room_id: room.roomId, live_status: room.liveStatus, title: room.title });
    const wbiKey = await this.fetchWbiKey();
    const buvid = await this.fetchBuvid();
    const server = await this.fetchDanmakuServer(room.roomId, wbiKey);
    assertWebSocketAvailable();
    const socket = new WebSocket(`wss://${server.host}:${server.port}/sub`);
    socket.binaryType = "arraybuffer";
    this.ws = socket;
    socket.addEventListener("message", (event) => {
      const data = toBuffer(event.data);
      if (data) this.handleSocketData(data);
    });
    socket.addEventListener("close", () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.clearTimers();
      const authReject = this.authReject;
      this.authResolve = null;
      this.authReject = null;
      if (this.stopped) return;
      if (authReject) {
        authReject(new Error("Live chat socket closed during authentication"));
        return;
      }
      this.patchStatus({ state: "reconnecting", connected_at: null });
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      // The close event carries the reconnect decision.
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.authResolve = null;
        this.authReject = null;
        reject(new Error("Live chat authentication timed out"));
        this.cleanupSocket();
      }, CONNECT_TIMEOUT_MS);
      const settle = (error?: Error) => {
        clearTimeout(timer);
        this.authResolve = null;
        this.authReject = null;
        if (error) reject(error);
        else resolve();
      };
      this.authResolve = () => settle();
      this.authReject = (error) => settle(error);
      socket.addEventListener("open", () => {
        const auth = {
          uid: 0,
          roomid: room.roomId,
          protover: 3,
          platform: "web",
          type: 2,
          buvid,
          key: server.token,
        };
        try {
          socket.send(encodeBiliPacket(JSON.stringify(auth), BILI_WS_OP.auth));
        } catch (error) {
          settle(new Error(`Live chat auth packet failed: ${errorMessage(error)}`));
        }
      });
    });
    this.patchStatus({ state: "connected", connected_at: new Date().toISOString(), last_error: null });
    this.reconnectAttempts = 0;
    this.logger?.("info", "Live chat connected", { room_id: room.roomId, title: room.title });
    this.heartbeatTimer = setInterval(() => {
      try {
        this.ws?.send(encodeBiliPacket("{}", BILI_WS_OP.heartbeat));
      } catch {
        /* reconnect path handles a dead socket */
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private handleSocketData(buffer: Buffer): void {
    for (const frame of readBiliFrames(buffer)) {
      if (frame.op === BILI_WS_OP.authReply) {
        let code = 0;
        try {
          code = numberField(asRecord(JSON.parse(frame.payload.toString("utf8")))?.code);
        } catch {
          code = -1;
        }
        if (code === 0) this.authResolve?.();
        else this.authReject?.(new Error(`Live chat auth rejected (code ${code})`));
        continue;
      }
      if (frame.op === BILI_WS_OP.heartbeatReply) {
        const popularity = Number(frame.payload.toString("utf8"));
        if (Number.isFinite(popularity)) this.patchStatus({ popularity: Math.round(popularity) });
        continue;
      }
      if (frame.op === BILI_WS_OP.message) {
        const message = parseBiliMessagePayload(frame.payload);
        if (message) {
          this.patchStatus({ last_message_at: new Date().toISOString() });
          this.onMessage?.(message);
        }
      }
    }
  }

  private async resolveRoom(): Promise<ResolvedRoom> {
    const roomInit = await this.fetchJson(
      `${ROOM_INIT_URL}?id=${encodeURIComponent(String(this.roomInput))}`,
    );
    if (roomInit.code !== 0) throw new Error(`Bilibili room_init failed (code ${roomInit.code})`);
    const roomId = numberField(asRecord(roomInit.data)?.room_id);
    if (!roomId) throw new Error("Bilibili room_init returned no room id");
    const liveStatus = numberField(asRecord(roomInit.data)?.live_status, -1);
    let title: string | null = null;
    try {
      const info = await this.fetchJson(`${ROOM_INFO_URL}?room_id=${roomId}`);
      const data = asRecord(info.data);
      title = asString(data?.title) ?? null;
    } catch {
      /* the title is best-effort */
    }
    return { roomId, liveStatus: liveStatus < 0 ? null : liveStatus, title };
  }

  private async fetchWbiKey(): Promise<string> {
    const nav = await this.fetchJson(NAV_URL);
    const key = wbiKeyFromNav(nav);
    if (!key) throw new Error("Bilibili nav did not return WBI keys; cannot sign the danmaku request");
    return key;
  }

  private async fetchBuvid(): Promise<string> {
    try {
      const response = await fetch(BUVID_URL, {
        headers: this.headers(false),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const setCookies =
        typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      const combined = setCookies.join("\n") || response.headers.get("set-cookie") || "";
      const match = combined.match(/buvid3=([^;\n]+)/);
      return match ? match[1] : "";
    } catch {
      return "";
    }
  }

  private async fetchDanmakuServer(roomId: number, wbiKey: string): Promise<DanmakuServer> {
    const params = wbiSignedParams({ id: roomId, type: 0 }, wbiKey);
    const payload = await this.fetchJson(
      `${DANMAKU_INFO_URL}?${new URLSearchParams(params).toString()}`,
      true,
    );
    if (payload.code !== 0) {
      throw new Error(
        `Bilibili getDanmuInfo failed (code ${payload.code}). ` +
          "If this is -352 or -401, retry later or provide BILIBILI_COOKIE with a browser buvid3/SESSDATA pair.",
      );
    }
    const data = asRecord(payload.data);
    const hosts = Array.isArray(data?.host_list) ? data.host_list : [];
    const first = asRecord(hosts[0]);
    const host = asString(first?.host);
    const token = asString(data?.token) ?? "";
    const port = numberField(first?.wss_port, 443);
    if (!host) throw new Error("Bilibili getDanmuInfo returned no websocket host");
    return { host, port, token };
  }

  private headers(liveReferer: boolean): Record<string, string> {
    const headers: Record<string, string> = { "User-Agent": this.userAgent };
    if (liveReferer) headers.Referer = LIVE_REFERER;
    if (this.cookie) headers.Cookie = this.cookie;
    return headers;
  }

  private async fetchJson(
    url: string,
    liveReferer = false,
  ): Promise<{ code: number; data?: unknown; message?: string }> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: this.headers(liveReferer),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(`Bilibili request failed: ${errorMessage(error)}`, { cause: error });
    }
    if (!response.ok) throw new Error(`Bilibili request failed with HTTP ${response.status}`);
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new Error("Bilibili returned invalid JSON");
    }
    const record = asRecord(parsed);
    if (!record) throw new Error("Bilibili returned a non-object response");
    return {
      code: numberField(record.code, -1),
      data: record.data,
      message: asString(record.message),
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when the runtime exposes the WHATWG WebSocket global. */
export function liveChatTransportAvailable(): boolean {
  return typeof WebSocket === "function";
}
