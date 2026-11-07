/**
 * Manager-side live chat service: keeps the Bilibili danmaku buffer, the reply
 * queue and the optional interaction host (see live-host.ts).
 *
 * The service is the only place that appends replies to
 * `<data-dir>/live/replies.jsonl`; `scripts/narrate.ps1 -Live` tails that file
 * and speaks replies only while the game narration is idle. Everything stays
 * read-only towards Bilibili: no danmaku is ever sent back.
 */

import fs from "node:fs";
import path from "node:path";
import { asString } from "./validation.js";
import {
  BilibiliLiveChat,
  liveChatTransportAvailable,
  type LiveChatMessage,
  type LiveChatStatus,
  type LiveLogger,
} from "./bilibili-live.js";
import {
  LiveHost,
  liveHostEnvConfig,
  resolveReplyBackend,
  type LiveDanmakuEntry,
  type LiveGameContext,
  type LiveHostStatus,
  type LiveReplyRecord,
  type LiveVoiceState,
} from "./live-host.js";

const MAX_MESSAGES = 500;
const MAX_REPLIES = 200;
const MAX_REPLY_CHARS = 200;

/** Minimal client surface so tests can inject a fake danmaku connection. */
export type LiveChatClient = {
  start(): Promise<LiveChatStatus>;
  stop(): void;
  status_(): LiveChatStatus;
};

export type LiveChatClientOptions = {
  roomId: number | string;
  userAgent?: string;
  cookie?: string;
  onMessage: (message: LiveChatMessage) => void;
  onStatus: (status: LiveChatStatus) => void;
  logger?: LiveLogger;
};

export type LiveChatClientFactory = (options: LiveChatClientOptions) => LiveChatClient;

export type LiveChatServiceOptions = {
  dataDir: string;
  context?: () => LiveGameContext | undefined;
  logger?: LiveLogger;
  env?: NodeJS.ProcessEnv;
  userAgent?: string;
  cookie?: string;
  /** Start the interaction host when a room connects (AUTORIO_LIVE_HOST=1). */
  autoHost?: boolean;
  chatFactory?: LiveChatClientFactory;
};

export type LiveChatServiceStatus = LiveChatStatus & {
  messages_buffered: number;
  last_message_seq: number;
  replies_buffered: number;
  last_reply_seq: number;
  host: LiveHostStatus | null;
  transport_available: boolean;
};

function emptyStatus(): LiveChatStatus {
  return {
    state: "idle",
    room_id: null,
    live_status: null,
    title: null,
    popularity: null,
    connected_at: null,
    last_message_at: null,
    last_error: null,
  };
}

function clampLimit(value: number, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ring buffer + reply queue + interaction host owner. */
export class LiveChatService {
  private readonly options: LiveChatServiceOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly dataDir: string;
  private readonly logger?: LiveLogger;
  private readonly chatFactory: LiveChatClientFactory;
  private chat: LiveChatClient | null = null;
  private chatStatus: LiveChatStatus = emptyStatus();
  private messages: LiveDanmakuEntry[] = [];
  private replies: LiveReplyRecord[] = [];
  private nextMessageSeq = 1;
  private nextReplySeq = 1;
  private host: LiveHost | null = null;
  private hostRunning = false;

  constructor(options: LiveChatServiceOptions) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.dataDir = options.dataDir;
    this.logger = options.logger;
    this.chatFactory =
      options.chatFactory ??
      ((clientOptions) =>
        new BilibiliLiveChat({
          ...clientOptions,
          userAgent: clientOptions.userAgent,
          cookie: clientOptions.cookie,
        }));
  }

  /** Resolve the room, connect the WebSocket and (optionally) start the host. */
  async start(roomId: number | string): Promise<LiveChatServiceStatus> {
    const resolved = typeof roomId === "number" ? roomId : Number(roomId);
    if (!Number.isFinite(resolved) || resolved <= 0) {
      throw new Error("room_id must be a positive Bilibili room id (short id is fine)");
    }
    if (!liveChatTransportAvailable() && this.options.chatFactory === undefined) {
      throw new Error(
        "Live danmaku needs the Node.js WebSocket global (Node 22+; Node 20 with NODE_OPTIONS=--experimental-websocket).",
      );
    }
    this.stop();
    this.messages = [];
    this.chatStatus = { ...emptyStatus(), state: "connecting", room_id: resolved };
    const client = this.chatFactory({
      roomId: resolved,
      userAgent: this.options.userAgent,
      cookie: this.options.cookie,
      onMessage: (message) => this.pushMessage(message),
      onStatus: (status) => {
        this.chatStatus = status;
      },
      logger: this.logger,
    });
    this.chat = client;
    try {
      this.chatStatus = await client.start();
    } catch (error) {
      this.chat = null;
      this.chatStatus = { ...this.chatStatus, state: "error", last_error: errorMessage(error) };
      throw error;
    }
    if (this.options.autoHost) this.startHost();
    return this.status();
  }

  /** Disconnect danmaku and stop the interaction host. */
  stop(): void {
    this.stopHost();
    this.chat?.stop();
    this.chat = null;
    this.chatStatus = emptyStatus();
  }

  status(): LiveChatServiceStatus {
    return {
      ...this.chatStatus,
      messages_buffered: this.messages.length,
      last_message_seq: this.messages.length > 0 ? this.messages[this.messages.length - 1].seq : 0,
      replies_buffered: this.replies.length,
      last_reply_seq: this.replies.length > 0 ? this.replies[this.replies.length - 1].seq : 0,
      host: this.host ? this.host.status() : this.hostStatusStopped(),
      transport_available: liveChatTransportAvailable(),
    };
  }

  /** New viewer messages after `afterSeq` (danmaku + super chats by default). */
  messagesAfter(afterSeq: number, limit = 20, kinds?: Array<LiveChatMessage["kind"]>): LiveDanmakuEntry[] {
    const max = clampLimit(limit, 20, 100);
    const after = Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : 0;
    const allowed = kinds && kinds.length > 0 ? new Set(kinds) : undefined;
    return this.messages
      .filter((message) => message.seq > after && (!allowed || allowed.has(message.kind)))
      .slice(0, max);
  }

  /**
   * Queue one spoken reply. Host output is already sanitized; manual replies
   * from the operator still get a hard length cap and newline cleanup.
   */
  enqueueReply(text: string, sourceSeqs: number[] = []): LiveReplyRecord {
    const cleaned = asString(text)?.replace(/\s+/g, " ").trim() ?? "";
    const capped = Array.from(cleaned).slice(0, MAX_REPLY_CHARS).join("");
    if (!capped) throw new Error("reply text is empty");
    const record: LiveReplyRecord = {
      seq: this.nextReplySeq++,
      ts: new Date().toISOString(),
      text: capped,
      source_seqs: sourceSeqs.filter((seq) => Number.isFinite(seq)),
      host: "persona",
    };
    this.replies.push(record);
    if (this.replies.length > MAX_REPLIES) this.replies.splice(0, this.replies.length - MAX_REPLIES);
    this.appendReply(record);
    return record;
  }

  repliesAfter(afterSeq: number, limit = 20): LiveReplyRecord[] {
    const max = clampLimit(limit, 20, 100);
    const after = Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : 0;
    return this.replies.filter((reply) => reply.seq > after).slice(0, max);
  }

  /** Voice-narrator state written by scripts/narrate.ps1 -Live. */
  voiceState(): LiveVoiceState | undefined {
    try {
      const text = fs.readFileSync(this.voicePath(), "utf8");
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
      const record = parsed as Record<string, unknown>;
      const updatedAt = asString(record.updated_at);
      if (!updatedAt) return undefined;
      return {
        speaking: record.speaking === true,
        updated_at: updatedAt,
        ...(asString(record.text) ? { text: asString(record.text) } : {}),
      };
    } catch {
      return undefined;
    }
  }

  gameContext(): LiveGameContext | undefined {
    try {
      return this.options.context?.();
    } catch {
      return undefined;
    }
  }

  startHost(): LiveHostStatus {
    if (this.hostRunning && this.host) return this.host.status();
    const envConfig = liveHostEnvConfig(this.env);
    const personaPath = envConfig.personaPath ?? path.join(this.dataDir, "live", "persona.md");
    this.host = new LiveHost({
      messagesAfter: (afterSeq, limit) => this.messagesAfter(afterSeq, limit),
      enqueueReply: (text, sourceSeqs) => this.enqueueReply(text, sourceSeqs),
      voiceState: () => this.voiceState(),
      context: () => this.gameContext(),
      backend: resolveReplyBackend({ dataDir: this.dataDir, env: this.env }),
      config: {
        maxChars: envConfig.maxChars,
        minIntervalSeconds: envConfig.minIntervalSeconds,
        batchSize: envConfig.batchSize,
        voiceStaleSeconds: envConfig.voiceStaleSeconds,
        personaPath,
      },
      logger: this.logger,
    });
    this.hostRunning = true;
    this.host.start();
    return this.host.status();
  }

  stopHost(): void {
    this.host?.stop();
    this.host = null;
    this.hostRunning = false;
  }

  private hostStatusStopped(): LiveHostStatus {
    return {
      running: false,
      backend: "none",
      persona_path: null,
      last_reply_at: null,
      last_text: null,
      last_error: null,
      replied: 0,
    };
  }

  private pushMessage(message: LiveChatMessage): void {
    const entry: LiveDanmakuEntry = { ...message, seq: this.nextMessageSeq++ };
    this.messages.push(entry);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
  }

  private repliesPath(): string {
    return path.join(this.dataDir, "live", "replies.jsonl");
  }

  private voicePath(): string {
    return path.join(this.dataDir, "live", "voice.json");
  }

  private appendReply(reply: LiveReplyRecord): void {
    try {
      const file = this.repliesPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(reply)}\n`);
    } catch (error) {
      this.logger?.("warn", "Failed to append live reply", { error: errorMessage(error) });
    }
  }
}
