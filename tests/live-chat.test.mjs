import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LiveChatService } from "../dist/live-chat.js";

// Manager-side live chat service with an injected fake danmaku connection.

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autorio-live-chat-"));
}

function status(overrides = {}) {
  return {
    state: "connected",
    room_id: 123,
    live_status: 1,
    title: "测试直播间",
    popularity: 10,
    connected_at: new Date().toISOString(),
    last_message_at: null,
    last_error: null,
    ...overrides,
  };
}

function fakeChatFactory(record) {
  return (options) => {
    record.options = options;
    const client = {
      started: false,
      stopped: false,
      async start() {
        this.started = true;
        options.onStatus(status());
        options.onMessage({ kind: "danmaku", ts: 1, uid: 1, uname: "观众", text: "主播在干嘛？" });
        return status();
      },
      stop() {
        this.stopped = true;
      },
      status_() {
        return status();
      },
    };
    record.client = client;
    return client;
  };
}

test("start connects, buffers messages and stops the injected client", async () => {
  const dir = tempDir();
  const record = {};
  const service = new LiveChatService({
    dataDir: dir,
    chatFactory: fakeChatFactory(record),
    context: () => ({ run_state: "running", state_md: "Current: smelting" }),
  });
  const live = await service.start("123");
  assert.equal(live.state, "connected");
  assert.equal(live.room_id, 123);
  assert.equal(live.messages_buffered, 1);
  assert.equal(record.client.started, true);

  const messages = service.messagesAfter(0, 10);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "主播在干嘛？");
  assert.equal(messages[0].seq, 1);
  assert.deepEqual(service.messagesAfter(1, 10), []);
  assert.equal(service.status().last_message_seq, 1);
  assert.equal(service.gameContext()?.run_state, "running");

  service.stop();
  assert.equal(record.client.stopped, true);
  assert.equal(service.status().state, "idle");
});

test("enqueueReply validates, caps and persists replies for the narrator", () => {
  const dir = tempDir();
  const service = new LiveChatService({ dataDir: dir, chatFactory: fakeChatFactory({}) });
  const reply = service.enqueueReply("  你好，主播马上回来  ", [3, 4]);
  assert.equal(reply.text, "你好，主播马上回来");
  assert.deepEqual(reply.source_seqs, [3, 4]);
  assert.equal(service.repliesAfter(0, 10).length, 1);
  assert.throws(() => service.enqueueReply("   "), /empty/);
  const file = path.join(dir, "live", "replies.jsonl");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).text, "你好，主播马上回来");
});

test("voiceState reads the narrator heartbeat file", () => {
  const dir = tempDir();
  const service = new LiveChatService({ dataDir: dir, chatFactory: fakeChatFactory({}) });
  assert.equal(service.voiceState(), undefined);
  fs.mkdirSync(path.join(dir, "live"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "live", "voice.json"),
    JSON.stringify({ speaking: true, updated_at: new Date().toISOString(), text: "正在念" }),
  );
  const voice = service.voiceState();
  assert.equal(voice.speaking, true);
  assert.equal(voice.text, "正在念");
  fs.writeFileSync(path.join(dir, "live", "voice.json"), "not json");
  assert.equal(service.voiceState(), undefined);
});

test("startHost uses the configured command backend and stops cleanly", () => {
  const dir = tempDir();
  const script = path.join(dir, "fake-llm.mjs");
  fs.writeFileSync(script, "process.stdout.write('好的')");
  const command = `"${process.execPath}" "${script}"`;
  const service = new LiveChatService({
    dataDir: dir,
    chatFactory: fakeChatFactory({}),
    env: { ...process.env, AUTORIO_LIVE_AGENT_CMD: command },
  });
  const host = service.startHost();
  assert.equal(host.running, true);
  assert.match(host.backend, /^cmd:/);
  assert.ok(fs.existsSync(path.join(dir, "live", "host-workspace")));
  service.stopHost();
  assert.equal(service.status().host.running, false);
});

test("message/reply filters clamp limits and ignore invalid cursors", async () => {
  const dir = tempDir();
  let optionsRef;
  const service = new LiveChatService({
    dataDir: dir,
    chatFactory: (options) => {
      optionsRef = options;
      return {
        async start() {
          options.onStatus(status());
          options.onMessage({ kind: "danmaku", ts: 1, uid: 1, uname: "a", text: "弹幕" });
          options.onMessage({ kind: "super_chat", ts: 2, uid: 2, uname: "b", text: "醒目", price: 30 });
          return status();
        },
        stop() {},
        status_() {
          return status();
        },
      };
    },
    context: () => {
      throw new Error("context failed");
    },
  });
  await service.start(123);
  const danmaku = service.messagesAfter(Number.NaN, Number.NaN, ["danmaku"]);
  assert.equal(danmaku.length, 1);
  assert.equal(danmaku[0].kind, "danmaku");
  assert.equal(service.messagesAfter(0, 999).length, 2);
  assert.equal(service.repliesAfter(Number.NaN, Number.NaN).length, 0);
  assert.equal(service.gameContext(), undefined);
  assert.equal(typeof optionsRef.roomId, "number");
});

test("start failure records the error and startHost is idempotent", async () => {
  const dir = tempDir();
  const failing = new LiveChatService({
    dataDir: dir,
    chatFactory: () => ({
      async start() {
        throw new Error("connect failed");
      },
      stop() {},
      status_() {
        return status({ state: "error" });
      },
    }),
  });
  await assert.rejects(failing.start(1), /connect failed/);
  assert.match(failing.status().last_error, /connect failed/);

  const script = path.join(dir, "fake-llm.mjs");
  fs.writeFileSync(script, "process.stdout.write('好的')");
  const service = new LiveChatService({
    dataDir: dir,
    chatFactory: fakeChatFactory({}),
    env: { ...process.env, AUTORIO_LIVE_AGENT_CMD: `"${process.execPath}" "${script}"` },
  });
  const stopped = service.status().host;
  assert.equal(stopped.running, false);
  assert.equal(stopped.backend, "none");
  const first = service.startHost();
  const second = service.startHost();
  assert.equal(first.running, true);
  assert.equal(second.running, true);
  service.stopHost();
});

test("voiceState tolerates malformed payloads", () => {
  const dir = tempDir();
  const service = new LiveChatService({ dataDir: dir, chatFactory: fakeChatFactory({}) });
  fs.mkdirSync(path.join(dir, "live"), { recursive: true });
  const file = path.join(dir, "live", "voice.json");
  for (const payload of ["[]", "{}", "null", JSON.stringify({ speaking: false })]) {
    fs.writeFileSync(file, payload);
    assert.equal(service.voiceState(), undefined);
  }
  fs.writeFileSync(file, JSON.stringify({ speaking: false, updated_at: new Date().toISOString() }));
  assert.equal(service.voiceState().speaking, false);
});

test("rejects invalid room ids and unavailable transports", async () => {
  const dir = tempDir();
  const service = new LiveChatService({ dataDir: dir, chatFactory: fakeChatFactory({}) });
  await assert.rejects(service.start("nope"), /room_id/);
  const original = globalThis.WebSocket;
  delete globalThis.WebSocket;
  try {
    const native = new LiveChatService({ dataDir: dir });
    await assert.rejects(native.start("123"), /WebSocket global/);
  } finally {
    if (original) globalThis.WebSocket = original;
    else delete globalThis.WebSocket;
  }
});
