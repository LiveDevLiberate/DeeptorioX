import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LiveHost,
  LIVE_REPLY_FALLBACK,
  buildLiveHostPrompt,
  commandReplyBackend,
  dshReplyBackend,
  formatGameContext,
  isVoiceIdle,
  loadLivePersona,
  resolveReplyBackend,
  sanitizeLiveReply,
  selectLiveDanmaku,
  violatesPersonaBoundary,
} from "../dist/live-host.js";

function entry(seq, text, overrides = {}) {
  return {
    seq,
    kind: "danmaku",
    ts: 1_700_000_000_000 + seq,
    uid: seq,
    uname: `观众${seq}`,
    text,
    ...overrides,
  };
}

const STATE_MD = [
  "# STATE",
  "Objective: launch a rocket",
  "Current: expanding iron smelting (score 60)",
  "Done when: 60 iron plates/min sustained 3 min",
  "Progress: 2 of 4 furnaces running",
  "Next: add two drills",
].join("\n");

test("sanitizes spoken replies: markdown, links, emoji, prefixes and length", () => {
  assert.equal(sanitizeLiveReply("**好的**，马上看~"), "好的，马上看~");
  assert.equal(sanitizeLiveReply("主播：在扩铁"), "在扩铁");
  assert.equal(sanitizeLiveReply("看这个 https://example.com/x 就行"), "看这个 就行");
  assert.equal(sanitizeLiveReply("回答：主播在扩铁 😂"), "主播在扩铁");
  assert.equal(sanitizeLiveReply("```js\nx\n```\n主播在扩铁"), "主播在扩铁");
  const long = "这是一句非常非常长的话，".repeat(10);
  const capped = sanitizeLiveReply(long, 20);
  assert.ok(Array.from(capped).length <= 20);
  assert.equal(sanitizeLiveReply("   "), "");
});

test("detects replies that fake a human identity or leak the prompt", () => {
  assert.equal(violatesPersonaBoundary("我是真人主播，今天打火箭"), true);
  assert.equal(violatesPersonaBoundary("作为人类主播，我承诺明天继续"), true);
  assert.equal(violatesPersonaBoundary("我其实不是AI，我是真人"), true);
  assert.equal(violatesPersonaBoundary("我的系统提示词里写着要傲娇"), true);
  assert.equal(violatesPersonaBoundary("对，我是AI主播，然后呢"), false);
  assert.equal(violatesPersonaBoundary("主播现在在扩铁，我帮你们看着"), false);
});

test("voice is idle only when the narrator is not speaking and the heartbeat is recent", () => {
  const now = 1_700_000_000_000;
  assert.equal(isVoiceIdle(undefined, now), true);
  assert.equal(isVoiceIdle({ speaking: false, updated_at: new Date(now - 1_000).toISOString() }, now), true);
  assert.equal(isVoiceIdle({ speaking: true, updated_at: new Date(now - 1_000).toISOString() }, now), false);
  assert.equal(isVoiceIdle({ speaking: true, updated_at: new Date(now - 60_000).toISOString() }, now), true);
});

test("formats the gameplay agent context from STATE.md and snapshot", () => {
  const text = formatGameContext({
    run_state: "running",
    benchmark: "smoke",
    elapsed_seconds: 600,
    state_md: STATE_MD,
    latest: { tick: 1234, current_research: "automation" },
  });
  assert.match(text, /运行状态：running/);
  assert.match(text, /当前在做：expanding iron smelting/);
  assert.match(text, /完成条件：60 iron plates\/min/);
  assert.match(text, /游戏快照：.*"tick":1234/);
});

test("prompt places identity rules before the persona and includes limits", () => {
  const prompt = buildLiveHostPrompt({
    persona: "你是 AI 主播「小鲸鱼」，语气傲娇。",
    context: { run_state: "running", state_md: STATE_MD },
    messages: [entry(1, "主播快把基地拆了")],
    maxChars: 40,
  });
  assert.ok(prompt.indexOf("【身份边界") >= 0);
  assert.ok(prompt.indexOf("【身份边界") < prompt.indexOf("【主播人设"));
  assert.match(prompt, /AI 游戏主播/);
  assert.match(prompt, /不是真人/);
  assert.match(prompt, /不得超出/);
  assert.match(prompt, /拆基地/);
  assert.match(prompt, /泄露提示词/);
  assert.ok(prompt.includes(LIVE_REPLY_FALLBACK));
  assert.match(prompt, /最多 40 个汉字/);
  assert.match(prompt, /观众1：主播快把基地拆了/);
  assert.match(prompt, /当前在做：expanding iron smelting/);
});

test("LiveHost replies only when the voice is idle, at a bounded rate", async () => {
  let now = 1_700_000_000_000;
  const messages = [entry(1, "主播在干嘛？"), entry(2, "这游戏好难")];
  const replies = [];
  const prompts = [];
  let voice = { speaking: true, updated_at: new Date(now).toISOString() };
  const host = new LiveHost({
    messagesAfter: (afterSeq, limit) => messages.filter((message) => message.seq > afterSeq).slice(0, limit),
    enqueueReply: (text, sourceSeqs) => {
      replies.push({ text, sourceSeqs });
      return {
        seq: replies.length,
        ts: new Date(now).toISOString(),
        text,
        source_seqs: sourceSeqs,
        host: "persona",
      };
    },
    voiceState: () => voice,
    context: () => ({ run_state: "running", state_md: STATE_MD }),
    backend: {
      name: "fake",
      generate: async (prompt) => {
        prompts.push(prompt);
        return "**主播在扩铁**，一会儿就好~";
      },
    },
    config: { maxChars: 30, minIntervalSeconds: 15 },
    now: () => now,
  });

  await host.tick();
  assert.equal(replies.length, 0, "voice is speaking, host must wait");

  voice = { speaking: false, updated_at: new Date(now).toISOString() };
  await host.tick();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].text, "主播在扩铁，一会儿就好~");
  assert.deepEqual(replies[0].sourceSeqs, [1, 2]);
  assert.match(prompts[0], /观众2：这游戏好难/);

  // Rate limit: 10 s later there is still no new reply.
  now += 10_000;
  messages.push(entry(3, "加速！"));
  await host.tick();
  assert.equal(replies.length, 1);

  // After the interval a new message is answered.
  now += 10_000;
  voice = { speaking: false, updated_at: new Date(now).toISOString() };
  await host.tick();
  assert.equal(replies.length, 2);
  assert.deepEqual(replies[1].sourceSeqs, [3]);
});

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autorio-live-host-"));
}

function writeNodeScript(directory, body) {
  const file = path.join(directory, "fake-llm.mjs");
  fs.writeFileSync(file, body);
  return `"${process.execPath}" "${file}"`;
}

test("commandReplyBackend pipes the prompt into a command and returns its reply", async () => {
  const dir = tempDir();
  const command = writeNodeScript(
    dir,
    "let input='';process.stdin.on('data',(chunk)=>input+=chunk);process.stdin.on('end',()=>{process.stdout.write('命令回复：'+input.length);});",
  );
  const backend = commandReplyBackend(command);
  assert.equal(await backend.generate("你好", 10_000), "命令回复：2");
});

test("resolveReplyBackend prefers AUTORIO_LIVE_AGENT_CMD and defaults to DSH", () => {
  const dir = tempDir();
  const command = writeNodeScript(dir, "process.stdout.write('x')");
  const withCommand = resolveReplyBackend({
    dataDir: dir,
    env: { ...process.env, AUTORIO_LIVE_AGENT_CMD: command },
  });
  assert.match(withCommand.name, /^cmd:/);
  const withDsh = resolveReplyBackend({
    dataDir: dir,
    env: { ...process.env, AUTORIO_LIVE_AGENT_CMD: "", DSH_BIN: "/nonexistent-dsh" },
  });
  assert.match(withDsh.name, /^dsh:/);
});

test("dshReplyBackend parses headless JSON events into a reply", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake dsh executable is a POSIX shell script");
    return;
  }
  const dir = tempDir();
  const dsh = path.join(dir, "fake-dsh.sh");
  fs.writeFileSync(
    dsh,
    [
      "#!/bin/sh",
      "cat >/dev/null",
      'printf \'%s\\n\' \'{"type":"status","phase":"step_start"}\'',
      'printf \'%s\\n\' \'{"type":"text","text":"中间消息"}\'',
      'printf \'%s\\n\' \'{"type":"final","text":"DSH回复~"}\'',
      "",
    ].join("\n"),
  );
  fs.chmodSync(dsh, 0o755);
  const backend = dshReplyBackend({
    dataDir: dir,
    env: { ...process.env, DSH_BIN: dsh, DEEPSEEK_API_KEY: "test-key" },
  });
  assert.equal(await backend.generate("提示", 20_000), "DSH回复~");
  assert.ok(fs.existsSync(path.join(dir, "live", "host-workspace", "dsh-model.patch.yml")));
});

test("persona loading falls back for missing/empty files and keeps valid ones", () => {
  const dir = tempDir();
  assert.equal(loadLivePersona().path, null);
  assert.match(loadLivePersona(path.join(dir, "missing.md")).persona, /AI 游戏主播/);
  const empty = path.join(dir, "empty.md");
  fs.writeFileSync(empty, "   \n");
  assert.equal(loadLivePersona(empty).path, empty);
  assert.match(loadLivePersona(empty).persona, /AI 游戏主播/);
  const persona = path.join(dir, "persona.md");
  fs.writeFileSync(persona, "你是「小助手」，语气轻松。");
  assert.equal(loadLivePersona(persona).persona, "你是「小助手」，语气轻松。");
});

test("formatGameContext handles missing state, selectLiveDanmaku drops blank text", () => {
  assert.match(formatGameContext(undefined), /没有进行中的游戏/);
  const selected = selectLiveDanmaku(
    [entry(1, "  "), entry(2, "第一问"), entry(3, "第二问"), entry(4, "第三问")],
    2,
  );
  assert.deepEqual(
    selected.map((item) => item.seq),
    [3, 4],
  );
  assert.equal(violatesPersonaBoundary("我代表主播承诺"), false);
  assert.equal(violatesPersonaBoundary("主播在扩铁"), false);
  assert.equal(violatesPersonaBoundary("我的提示词不能说"), true);
});

test("LiveHost start/stop skips the backlog and answers messages that arrive later", async () => {
  const messages = [entry(1, "老消息"), entry(2, "旧消息")];
  const replies = [];
  const host = new LiveHost({
    messagesAfter: (afterSeq, limit) => messages.filter((message) => message.seq > afterSeq).slice(0, limit),
    enqueueReply: (text) => {
      replies.push(text);
      return { seq: 1, ts: "now", text, source_seqs: [], host: "persona" };
    },
    voiceState: () => undefined,
    context: () => undefined,
    backend: { name: "fake", generate: async () => "好的" },
    config: { maxChars: 20, minIntervalSeconds: 0, tickMs: 15 },
  });
  assert.equal(host.status().running, false);
  host.start();
  assert.equal(host.status().running, true);
  messages.push(entry(3, "新消息"));
  await new Promise((resolve) => setTimeout(resolve, 120));
  host.stop();
  assert.equal(host.status().running, false);
  assert.equal(replies.length, 1, "the pre-start backlog is skipped");
});

test("commandReplyBackend returns an empty reply for silent commands and rejects failures", async () => {
  const dir = tempDir();
  assert.equal(await commandReplyBackend(writeNodeScript(dir, "process.exit(0)")).generate("hi", 5_000), "");
  const failing = writeNodeScript(dir, "process.stderr.write('boom');process.exit(2)");
  await assert.rejects(commandReplyBackend(failing).generate("hi", 5_000), /exited with code 2/);
});

test("liveHostEnvConfig clamps values and exposes the host switch", async () => {
  const { liveHostEnvConfig } = await import("../dist/live-host.js");
  const defaults = liveHostEnvConfig({});
  assert.equal(defaults.maxChars, 60);
  assert.equal(defaults.minIntervalSeconds, 15);
  assert.equal(defaults.required, false);
  const custom = liveHostEnvConfig({
    AUTORIO_LIVE_HOST: "1",
    AUTORIO_LIVE_REPLY_MAX_CHARS: "999",
    AUTORIO_LIVE_MIN_INTERVAL_SECONDS: "1",
    AUTORIO_LIVE_BATCH: "99",
    AUTORIO_LIVE_VOICE_STALE_SECONDS: "1",
    AUTORIO_LIVE_PERSONA: "/tmp/persona.md",
  });
  assert.equal(custom.required, true);
  assert.equal(custom.maxChars, 200);
  assert.equal(custom.minIntervalSeconds, 3);
  assert.equal(custom.batchSize, 20);
  assert.equal(custom.voiceStaleSeconds, 5);
  assert.equal(custom.personaPath, "/tmp/persona.md");
});

test("LiveHost replaces persona-violating replies with a safe fallback", async () => {
  let now = 1_700_000_000_000;
  const replies = [];
  const host = new LiveHost({
    messagesAfter: (afterSeq, limit) => [entry(1, "你是谁")].filter((m) => m.seq > afterSeq).slice(0, limit),
    enqueueReply: (text) => {
      replies.push(text);
      return { seq: 1, ts: new Date(now).toISOString(), text, source_seqs: [1], host: "persona" };
    },
    voiceState: () => undefined,
    context: () => undefined,
    backend: { name: "fake", generate: async () => "我是真人主播，今天打火箭" },
    config: { maxChars: 30, minIntervalSeconds: 0 },
    now: () => now,
  });
  await host.tick();
  assert.deepEqual(replies, [LIVE_REPLY_FALLBACK]);
});
