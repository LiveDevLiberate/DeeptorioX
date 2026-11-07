import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { brotliCompressSync, deflateSync } from "node:zlib";
import {
  encodeBiliPacket,
  liveChatTransportAvailable,
  parseBiliMessagePayload,
  readBiliFrames,
  wbiKeyFromNav,
  wbiSignedParams,
} from "../dist/bilibili-live.js";

function frame(op, protover, payload, sequence = 1) {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16 + payload.length, 0);
  header.writeUInt16BE(16, 4);
  header.writeUInt16BE(protover, 6);
  header.writeUInt32BE(op, 8);
  header.writeUInt32BE(sequence, 12);
  return Buffer.concat([header, payload]);
}

const NAV = {
  code: -101,
  data: {
    wbi_img: {
      img_url: "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png",
      sub_url: "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png",
    },
  },
};

test("derives the WBI key from nav wbi_img URLs", () => {
  assert.equal(wbiKeyFromNav(NAV), "ea1db124af3c7062474693fa704f4ff8");
  assert.equal(wbiKeyFromNav({ code: 0, data: {} }), undefined);
  assert.equal(wbiKeyFromNav(undefined), undefined);
});

test("WBI signature sorts params, adds wts and filters special characters", () => {
  const signed = wbiSignedParams({ type: 0, id: 123 }, "abcdefghijklmnopqrstuvwxyz123456", 1_700_000_000_000);
  assert.equal(signed.wts, "1700000000");
  const expected = createHash("md5")
    .update("id=123&type=0&wts=1700000000abcdefghijklmnopqrstuvwxyz123456")
    .digest("hex");
  assert.equal(signed.w_rid, expected);
  assert.equal(signed.id, "123");
});

test("encodes a 16-byte header packet and decodes it back", () => {
  const packet = encodeBiliPacket('{"k":"v"}', 7, 2);
  assert.equal(packet.readUInt32BE(0), 16 + Buffer.byteLength('{"k":"v"}'));
  assert.equal(packet.readUInt16BE(4), 16);
  assert.equal(packet.readUInt16BE(6), 1);
  assert.equal(packet.readUInt32BE(8), 7);
  assert.equal(packet.readUInt32BE(12), 2);
  const frames = readBiliFrames(packet);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].op, 7);
  assert.equal(frames[0].payload.toString("utf8"), '{"k":"v"}');
});

test("flattens zlib and brotli compressed nested message packets", () => {
  const json = Buffer.from(JSON.stringify({ cmd: "DANMU_MSG", info: [] }));
  const inner = frame(5, 0, json);
  // Outer protover: 2 = zlib, 3 = brotli.
  for (const encoded of [frame(5, 2, deflateSync(inner)), frame(5, 3, brotliCompressSync(inner))]) {
    const frames = readBiliFrames(encoded);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].op, 5);
    assert.equal(JSON.parse(frames[0].payload.toString("utf8")).cmd, "DANMU_MSG");
  }
});

test("parses DANMU_MSG and SUPER_CHAT_MESSAGE viewer messages", () => {
  const danmaku = parseBiliMessagePayload(
    Buffer.from(
      JSON.stringify({
        cmd: "DANMU_MSG:4:0:2:2:2:0",
        info: [
          [0, 1, 25, 16777215, 1_700_000_123_000, 1_700_000_123, 0, "", 0, 0, 0, "", 0, 0, null, 0, 0, 0],
          "主播好强",
          [123456, "观众甲", 1, 0, 0, 10000, 1, ""],
          ["粉丝牌", "铁子", 0, 0, 0, 0, 0],
        ],
      }),
    ),
  );
  assert.deepEqual(danmaku, {
    kind: "danmaku",
    ts: 1_700_000_123_000,
    uid: 123456,
    uname: "观众甲",
    text: "主播好强",
    admin: true,
    medal: "铁子",
  });
  const superChat = parseBiliMessagePayload(
    JSON.stringify({
      cmd: "SUPER_CHAT_MESSAGE",
      data: {
        message: "加油！",
        start_time: 1_700_000_000,
        price: 30,
        user_info: { uid: 77, uname: "老板" },
        medal_info: { medal_name: "铁子" },
      },
    }),
  );
  assert.equal(superChat.kind, "super_chat");
  assert.equal(superChat.text, "加油！");
  assert.equal(superChat.price, 30);
  assert.equal(superChat.uname, "老板");
  assert.equal(parseBiliMessagePayload(Buffer.from("not json")), undefined);
  assert.equal(parseBiliMessagePayload(JSON.stringify({ cmd: "SEND_GIFT" })), undefined);
});

test("reports whether the runtime has the WebSocket global", () => {
  assert.equal(typeof liveChatTransportAvailable(), "boolean");
});

test("corrupt compressed batches are ignored and parse branches tolerate gaps", () => {
  assert.deepEqual(readBiliFrames(frameWithProtover(5, 2, Buffer.from("garbage"))), []);
  assert.deepEqual(readBiliFrames(frameWithProtover(5, 3, Buffer.from("garbage"))), []);
  assert.equal(
    parseBiliMessagePayload(JSON.stringify({ cmd: "DANMU_MSG", info: [[0, 1, 25, 0, 1], "   ", [1, "a"]] })),
    undefined,
  );
  const superChat = parseBiliMessagePayload(
    JSON.stringify({
      cmd: "SUPER_CHAT_MESSAGE",
      data: { message: "好", user_info: { uid: 1, uname: "老板" } },
    }),
  );
  assert.equal(superChat.price, 0);
  assert.equal(superChat.medal, undefined);
});

const { BilibiliLiveChat } = await import("../dist/bilibili-live.js");

function frameWithProtover(op, protover, payload) {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(16 + payload.length, 0);
  header.writeUInt16BE(16, 4);
  header.writeUInt16BE(protover, 6);
  header.writeUInt32BE(op, 8);
  header.writeUInt32BE(1, 12);
  return Buffer.concat([header, payload]);
}

function fakeResponse(value, headers = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, entry]) => [key.toLowerCase(), entry]),
  );
  return {
    ok: true,
    status: 200,
    json: async () => value,
    headers: {
      get: (name) => normalized[String(name).toLowerCase()] ?? null,
      getSetCookie: () => (normalized["set-cookie"] ? [normalized["set-cookie"]] : []),
    },
  };
}

function jsonResponse(value, headers) {
  return fakeResponse(value, { "content-type": "application/json", ...(headers ?? {}) });
}

function installBilibiliFetch({
  roomInit = { code: 0, data: { room_id: 123, live_status: 1 } },
  danmuInfo,
} = {}) {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("room_init")) return jsonResponse(roomInit);
    if (url.includes("Room/get_info")) return jsonResponse({ code: 0, data: { title: "测试直播间" } });
    if (url.includes("web-interface/nav")) return jsonResponse(NAV);
    if (url.includes("getDanmuInfo"))
      return jsonResponse(
        danmuInfo ?? { code: 0, data: { host_list: [{ host: "fake-host", wss_port: 443 }], token: "tok" } },
      );
    if (url.startsWith("https://www.bilibili.com"))
      return fakeResponse("", { "set-cookie": "buvid3=test-buvid; Path=/" });
    return jsonResponse({ code: -1 });
  };
  globalThis.fetch = fetchImpl;
  return calls;
}

function installFakeWebSocket() {
  const instances = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.listeners = new Map();
      this.binaryType = "blob";
      instances.push(this);
      Promise.resolve().then(() => this.emit("open"));
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    emit(type, event = {}) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }
    send(data) {
      const buffer = Buffer.from(data);
      const op = buffer.readUInt32BE(8);
      this.sent.push({ op, payload: buffer.subarray(16).toString("utf8") });
      if (op === 7) {
        const authReply = Buffer.from(JSON.stringify({ code: 0 }));
        Promise.resolve().then(() => this.emit("message", { data: frameWithProtover(8, 1, authReply) }));
      }
      if (op === 2) {
        const heartbeat = Buffer.from("42");
        Promise.resolve().then(() => this.emit("message", { data: frameWithProtover(3, 1, heartbeat) }));
      }
    }
    close() {
      this.emit("close", { code: 1000, reason: "closed" });
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  return { FakeWebSocket, instances };
}

test("BilibiliLiveChat resolves the room, authenticates and delivers danmaku", async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const calls = installBilibiliFetch();
  const { instances } = installFakeWebSocket();
  const received = [];
  const statuses = [];
  const chat = new BilibiliLiveChat({
    roomId: "6",
    onMessage: (message) => received.push(message),
    onStatus: (status) => statuses.push(status.state),
  });
  try {
    const status = await chat.start();
    assert.equal(status.state, "connected");
    assert.equal(status.room_id, 123);
    assert.equal(status.title, "测试直播间");
    assert.equal(statuses.at(-1), "connected");
    const socket = instances[0];
    assert.match(socket.url, /^wss:\/\/fake-host:443\/sub$/);
    const auth = socket.sent.find((packet) => packet.op === 7);
    assert.ok(auth);
    assert.match(auth.payload, /"roomid":123/);
    assert.match(auth.payload, /"buvid":"test-buvid"/);
    assert.match(auth.payload, /"key":"tok"/);

    const danmakuFrame = frameWithProtover(
      5,
      0,
      Buffer.from(
        JSON.stringify({ cmd: "DANMU_MSG", info: [[0, 1, 25, 0, 1_700_000_000_000], "好耶", [7, "观众"]] }),
      ),
    );
    socket.emit("message", { data: danmakuFrame });
    assert.equal(received.length, 1);
    assert.equal(received[0].text, "好耶");

    // Compressed batches also reach the message callback.
    const compressed = frameWithProtover(
      5,
      2,
      deflateSync(
        frameWithProtover(
          5,
          0,
          Buffer.from(JSON.stringify({ cmd: "DANMU_MSG", info: [[0, 1, 25, 0, 1], "第二句", [8, "乙"]] })),
        ),
      ),
    );
    socket.emit("message", { data: compressed });
    assert.equal(received.length, 2);

    chat.stop();
    assert.equal(chat.status_().state, "stopped");
    assert.ok(calls.some((url) => url.includes("room_init")));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test("BilibiliLiveChat handles auth rejection, bad HTTP and reconnect state", async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  try {
    // Auth reply code != 0 rejects start.
    const calls = installBilibiliFetch();
    class RejectingWebSocket {
      constructor() {
        this.listeners = new Map();
        this.binaryType = "blob";
        Promise.resolve().then(() => this.emit("open"));
      }
      addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
      }
      emit(type, event = {}) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
      send(data) {
        if (Buffer.from(data).readUInt32BE(8) !== 7) return;
        const reply = Buffer.from(JSON.stringify({ code: -101 }));
        Promise.resolve().then(() => this.emit("message", { data: frameWithProtover(8, 1, reply) }));
      }
      close() {
        this.emit("close", {});
      }
    }
    globalThis.WebSocket = RejectingWebSocket;
    await assert.rejects(new BilibiliLiveChat({ roomId: 5 }).start(), /auth rejected/);
    assert.ok(calls.length > 0);

    // HTTP failure and invalid JSON propagate.
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await assert.rejects(new BilibiliLiveChat({ roomId: 5 }).start(), /HTTP 500/);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    });
    await assert.rejects(new BilibiliLiveChat({ roomId: 5 }).start(), /invalid JSON/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test("BilibiliLiveChat survives a buvid/title failure and goes to reconnecting on close", async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const { instances } = installFakeWebSocket();
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.includes("room_init")) return jsonResponse({ code: 0, data: { room_id: 9, live_status: 1 } });
    if (url.includes("Room/get_info")) throw new Error("title unavailable");
    if (url.includes("web-interface/nav")) return jsonResponse(NAV);
    if (url.includes("getDanmuInfo"))
      return jsonResponse({ code: 0, data: { host_list: [{ host: "h", wss_port: 443 }], token: "t" } });
    if (url.startsWith("https://www.bilibili.com")) throw new Error("blocked");
    return jsonResponse({ code: -1 });
  };
  globalThis.fetch = fetchImpl;
  try {
    const chat = new BilibiliLiveChat({ roomId: 9, reconnectBaseMs: 10, reconnectMaxMs: 20 });
    const status = await chat.start();
    assert.equal(status.title, null);
    assert.equal(status.state, "connected");
    const socket = instances[0];
    const auth = socket.sent.find((packet) => packet.op === 7);
    assert.match(auth.payload, /"buvid":""/);
    socket.emit("close", {});
    assert.equal(chat.status_().state, "reconnecting");
    chat.stop();
    assert.equal(chat.status_().state, "stopped");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test("BilibiliLiveChat reconnects after a close and rejects a close during auth", async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const { instances } = installFakeWebSocket();
  installBilibiliFetch();
  try {
    const chat = new BilibiliLiveChat({ roomId: 3, reconnectBaseMs: 250, reconnectMaxMs: 500 });
    await chat.start();
    assert.equal(chat.status_().state, "connected");
    instances[0].emit("message", {});
    instances[0].emit("close", {});
    assert.equal(chat.status_().state, "reconnecting");
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.ok(instances.length >= 2, "a reconnect attempt creates a new socket");
    chat.stop();
    assert.equal(chat.status_().state, "stopped");

    // A close before the auth reply rejects start instead of reconnecting.
    class ClosingWebSocket {
      constructor() {
        this.listeners = new Map();
        Promise.resolve().then(() => this.emit("open"));
      }
      addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
      }
      emit(type, event = {}) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
      send() {
        Promise.resolve().then(() => this.emit("close", {}));
      }
      close() {}
    }
    globalThis.WebSocket = ClosingWebSocket;
    await assert.rejects(new BilibiliLiveChat({ roomId: 3 }).start(), /closed during authentication/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

test("BilibiliLiveChat surfaces room, WBI and danmaku-server failures", async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  try {
    installBilibiliFetch({ roomInit: { code: -1, data: {} } });
    installFakeWebSocket();
    await assert.rejects(new BilibiliLiveChat({ roomId: 1 }).start(), /room_init failed/);

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("room_init")) return jsonResponse({ code: 0, data: { room_id: 5, live_status: 1 } });
      return jsonResponse({ code: -101, data: {} });
    };
    await assert.rejects(new BilibiliLiveChat({ roomId: 5 }).start(), /WBI keys/);

    installBilibiliFetch({ danmuInfo: { code: -352, message: "risk" } });
    await assert.rejects(new BilibiliLiveChat({ roomId: 5 }).start(), /-352/);

    installBilibiliFetch({ danmuInfo: { code: 0, data: { host_list: [], token: "" } } });
    await assert.rejects(new BilibiliLiveChat({ roomId: 5 }).start(), /no websocket host/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});
