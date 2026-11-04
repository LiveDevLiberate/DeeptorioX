import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// TTS/overlay reasoning digest: a pure heuristic plus the real `thought()`
// file pipeline driven by a fake DSH agent run (no game, model or network).
// The raw thoughts.log/thoughts.txt stream must stay byte-identical.

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-thought-digest-"));

/** Windows cannot execute shebang scripts directly; wrap them in a .cmd shim. */
const toExecutable = (script, name) => {
  if (process.platform !== "win32") {
    fs.chmodSync(script, 0o755);
    return script;
  }
  const launcher = path.join(temp, `${name}.cmd`);
  fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  return launcher;
};

const fakeFactorioScript = path.join(temp, "factorio.mjs");
fs.writeFileSync(
  fakeFactorioScript,
  `#!${process.execPath}
import fs from 'node:fs';
const a = process.argv.slice(2);
if (a.includes('--version')) console.log('Version: 2.0.77 (test full game)');
else if (a.includes('--create')) fs.writeFileSync(a[a.indexOf('--create') + 1], 'fixed baseline');
`,
);
const fakeFactorio = toExecutable(fakeFactorioScript, "factorio");

// Reasoning chunks emitted twice in a row to prove consecutive dedupe; one CJK
// chunk whose keyword sentence is not the first sentence.
const ENGLISH_PLAN = "I should observe the player first.";
const CJK_PLAN = "玩家站在矿旁边。下一步建造熔炉。";
const PLAIN = "The area is clear.";
const THINKING = [ENGLISH_PLAN, ENGLISH_PLAN, CJK_PLAN, PLAIN, PLAIN];

const fakeDshScript = path.join(temp, "dsh.mjs");
fs.writeFileSync(
  fakeDshScript,
  `#!${process.execPath}
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('dsh test 0.2.1'); process.exit(0); }
process.stdin.resume();
process.stdin.on('end', () => {
  const speaking = ${JSON.stringify(THINKING)};
  const events = [{ type: 'session', sessionId: 'digest-session' }];
  for (const text of speaking) events.push({ type: 'thinking', text });
  events.push({ type: 'final', text: 'done' });
  for (const event of events) console.log(JSON.stringify(event));
  process.exit(0);
});
`,
);
const fakeDsh = toExecutable(fakeDshScript, "dsh");

process.env.AUTORIO_DATA_DIR = temp;
process.env.FACTORIO_BIN = fakeFactorio;
delete process.env.AUTORIO_TERMINAL;
const { RunManager, digestThought, DIGEST_MAX_CHARS } = await import("../dist/runs.js");

const waitFor = async (fn, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw new Error("Timed out waiting for test state");
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
};

const snapshot = () => ({
  tick: 60,
  speed: 1,
  paused: false,
  character: true,
  player: "Autorio",
  production: {},
  consumption: {},
  fluids_produced: {},
  fluids_consumed: {},
  research: {},
  rockets: 0,
});

function setup() {
  let game = false;
  let profile;
  const hooks = {
    running: () => game,
    openRecording: async () => {},
    start: async (_save, dir) => {
      game = true;
      profile = dir;
      fs.mkdirSync(path.join(dir, "saves"), { recursive: true });
    },
    stop: async () => {
      game = false;
    },
    connect: async () => {},
    cancelJobs: async () => {},
    command: async (lua) => {
      if (lua.startsWith("/save ")) {
        fs.writeFileSync(path.join(profile, "saves", lua.slice(6) + ".zip"), "final save");
        return "saving";
      }
      if (lua.includes("starting inventory")) return "ready";
      if (lua.includes("get_item_production_statistics")) return JSON.stringify(snapshot());
      return "ok";
    },
  };
  return new RunManager(hooks);
}

test("digestThought prefers a plan/decision keyword sentence", () => {
  assert.equal(
    digestThought("The player stands near the ore. I should mine coal next."),
    "I should mine coal next.",
  );
  // No keyword in the first sentence: keep it rather than guessing.
  assert.equal(digestThought("The area is clear. Nothing to report."), "The area is clear.");
});

test("digestThought handles CJK sentences and keywords", () => {
  assert.equal(digestThought(CJK_PLAN), "下一步建造熔炉。");
  // CJK sentence terminators end a sentence even without spaces.
  assert.equal(digestThought("这里没有威胁。目标是扩大生产。"), "目标是扩大生产。");
});

test("digestThought normalizes code/whitespace and caps the line length", () => {
  assert.equal(
    digestThought("  First   line.\n```lua\nprint('x')\n``` I need to  craft. "),
    "I need to craft.",
  );
  assert.equal(digestThought("```lua\nprint('x')\n```"), "");
  assert.equal(digestThought("   \n  "), "");
  const long = `I should ${"very ".repeat(60)}build a furnace.`;
  const digest = digestThought(long);
  assert.ok(digest.length <= DIGEST_MAX_CHARS, `digest is ${digest.length} chars`);
  assert.ok(digest.startsWith("I should very"));
  assert.equal(digest, digest.trimEnd());
});

test("agent reasoning writes a deduped digest stream and keeps thoughts.log unchanged", async () => {
  const previous = {
    bin: process.env.DSH_BIN,
    home: process.env.DSH_HOME,
    key: process.env.DEEPSEEK_API_KEY,
    dir: process.env.AUTORIO_DSH_TEST_DIR,
  };
  process.env.DSH_BIN = fakeDsh;
  process.env.DSH_HOME = path.join(temp, "dsh-home");
  process.env.DEEPSEEK_API_KEY = "sk-test-digest";
  process.env.AUTORIO_DSH_TEST_DIR = path.join(temp, "dsh-working");
  const manager = setup();
  try {
    const run = manager.start({
      benchmark: "smoke",
      agent: "dsh",
      model: "deepseek-flash#low",
      recording: false,
    });
    await waitFor(() => manager.get(run.id).state === "failed");
    const dir = path.join(temp, "runs", run.id);

    // Raw stream unchanged: every cleaned chunk, including consecutive repeats.
    const expectedRaw = THINKING.map((text) => `${text}\n`).join("");
    const thoughtsLog = fs.readFileSync(path.join(dir, "thoughts.log"), "utf8");
    assert.equal(thoughtsLog, expectedRaw);
    assert.equal(fs.readFileSync(path.join(dir, "thoughts.txt"), "utf8"), `${PLAIN}\n`);

    // Digest stream: keyword-first sentences, no consecutive duplicates.
    const expectedDigest = `${ENGLISH_PLAN}\n下一步建造熔炉。\n${PLAIN}\n`;
    const digestLog = fs.readFileSync(path.join(dir, "thoughts.digest.log"), "utf8");
    assert.equal(digestLog, expectedDigest);
    assert.equal(fs.readFileSync(path.join(dir, "thoughts.digest.txt"), "utf8"), `${PLAIN}\n`);
    const digestLines = digestLog.trim().split("\n");
    for (let index = 1; index < digestLines.length; index++) {
      assert.notEqual(digestLines[index], digestLines[index - 1], "consecutive digest duplicates");
    }
    assert.ok(digestLines.every((line) => line.length <= DIGEST_MAX_CHARS));

    // A reloaded manager (fresh in-memory state) recovers the last digest from
    // disk, so a repeated reasoning chunk after a restart is still suppressed.
    const reloaded = new RunManager({});
    const restoredRun = reloaded.runs.get(run.id);
    assert.ok(restoredRun, "reloaded manager should know the finished run");
    reloaded.thought(restoredRun, PLAIN);
    assert.equal(fs.readFileSync(path.join(dir, "thoughts.digest.log"), "utf8"), expectedDigest);
    assert.equal(
      fs.readFileSync(path.join(dir, "thoughts.log"), "utf8"),
      `${expectedRaw}${PLAIN}\n`,
      "restart only adds the raw thought, never a duplicate digest",
    );
  } finally {
    await manager.shutdown();
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("DSH_BIN", previous.bin);
    restore("DSH_HOME", previous.home);
    restore("DEEPSEEK_API_KEY", previous.key);
    restore("AUTORIO_DSH_TEST_DIR", previous.dir);
  }
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
