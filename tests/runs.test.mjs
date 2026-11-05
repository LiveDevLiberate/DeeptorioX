import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-runs-test-"));
// Windows cannot execute shebang scripts directly; wrap them in a .cmd shim.
const toExecutable = (script, name) => {
  if (process.platform !== "win32") {
    fs.chmodSync(script, 0o755);
    return script;
  }
  const launcher = path.join(temp, `${name}.cmd`);
  fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  return launcher;
};
const fakeScript = path.join(temp, "factorio.mjs");
fs.writeFileSync(
  fakeScript,
  `#!${process.execPath}\nimport fs from 'node:fs';\nconst a=process.argv.slice(2);\nif(a.includes('--version')) console.log('Version: 2.0.77 (test full game)');\nelse if(a.includes('--create')) fs.writeFileSync(a[a.indexOf('--create')+1], 'fixed baseline');\n`,
);
const fake = toExecutable(fakeScript, "factorio");
const fakeCodexScript = path.join(temp, "codex.mjs");
fs.writeFileSync(
  fakeCodexScript,
  `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a.includes('--version'))console.log('codex test');\nelse if(a[0]==='login')console.log('logged in');\nelse if(process.env.AUTORIO_TEST_NO_FINAL) { const fs=await import('node:fs'); const path=await import('node:path'); const dir=path.join(process.env.CODEX_HOME,'sessions',new Date().toISOString().slice(0,10).replaceAll('-','/')); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'rollout-interrupted-session.jsonl'),JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:25,cached_input_tokens:10,output_tokens:3,total_tokens:28}}}})+'\\n'); console.log(JSON.stringify({type:'thread.started',thread_id:'interrupted-session'})); setInterval(()=>{},1000); }\nelse { console.log(JSON.stringify({type:'thread.started',thread_id:'test-session'})); console.log(JSON.stringify({type:'item.completed',item:{id:'message',type:'agent_message',text:'I claim success'}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:5}})); }\n`,
);
const fakeCodex = toExecutable(fakeCodexScript, "codex");
const quotaCodexScript = path.join(temp, "quota-codex.mjs");
fs.writeFileSync(
  quotaCodexScript,
  `#!${process.execPath}
import fs from 'node:fs';import path from 'node:path';
const a=process.argv.slice(2);
if(a.includes('--version'))console.log('codex quota test');
else if(a[0]==='login')console.log('logged in');
else {
 console.log(JSON.stringify({type:'thread.started',thread_id:'quota-session'}));
 if(a.includes('resume') && !process.env.AUTORIO_TEST_REPEAT_QUOTA) {
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
  setInterval(()=>{},1000);
 } else {
  const dir=path.join(process.env.CODEX_HOME,'sessions',new Date().toISOString().slice(0,10).replaceAll('-','/'));fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'rollout-quota-session.jsonl'),JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:25,output_tokens:3}}}})+'\\n');
  console.log(JSON.stringify({type:'item.completed',item:{id:'m1',type:'agent_message',text:'Working on the factory'}}));
  const event=JSON.stringify({type:'turn.failed',error:{message:"You've hit your usage limit. Try again after your quota resets.",code:'usage_limit_exceeded'}})+'\\n';
  process.stdout.write(event.slice(0,24));setTimeout(()=>process.stdout.write(event.slice(24)),30);
  setInterval(()=>{},1000);
 }
}
`,
);
const quotaCodex = toExecutable(quotaCodexScript, "quota-codex");
const fakeDshScript = path.join(temp, "dsh.mjs");
fs.writeFileSync(
  fakeDshScript,
  `#!${process.execPath}
import fs from 'node:fs';
const a = process.argv.slice(2);
if (a.includes('--version')) { console.log('dsh test 0.2.1'); process.exit(0); }
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const out = process.env.AUTORIO_DSH_TEST_DIR;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(out + '/dsh-args.json', JSON.stringify(a));
  fs.writeFileSync(out + '/dsh-stdin.txt', input);
  fs.writeFileSync(out + '/dsh-env.json', JSON.stringify({ key: process.env.DEEPSEEK_API_KEY, profile: process.env.DSH_PROFILE, pythonpath: process.env.PYTHONPATH }));
  const events = [
    { type: 'session', sessionId: 'dsh-test-session', cwd: process.cwd() },
    { type: 'status', phase: 'turn_start', turn: 1 },
    { type: 'status', phase: 'step_start', turn: 1, step: 1 },
    { type: 'thinking', text: 'I should observe the player first.' },
    { type: 'tool_call', callId: 'call-1', tool: 'pwsh', input: { description: 'Observe player', command: 'pwsh -File .\\\\play.ps1 factorio.py observe-player' } },
    { type: 'tool_result', callId: 'call-1', status: 'completed', result: '{"ok":true}' },
    { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, totalTokens: 120 } },
    { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
    { type: 'final', text: 'I observed the player.' }
  ];
  for (const event of events) console.log(JSON.stringify(event));
  process.exit(0);
});
`,
);
const fakeDsh = toExecutable(fakeDshScript, "dsh");
process.env.AUTORIO_DATA_DIR = temp;
process.env.FACTORIO_BIN = fake;
process.env.CODEX_BIN = fakeCodex;
process.env.CODEX_HOME = path.join(temp, "codex-home");
delete process.env.AUTORIO_TERMINAL;
// Keep legacy tests deterministic; the auto-continuation test overrides this.
process.env.AUTORIO_AUTO_CONTINUE_MAX = "0";
const { RunManager } = await import("../dist/runs.js");
const { reached, parseSnapshot, trackedMilestones } = await import("../dist/benchmarks.js");
const snapshot = (production = {}) => ({
  tick: 60,
  speed: 1,
  paused: false,
  character: true,
  player: "Autorio",
  production,
  consumption: {},
  fluids_produced: {},
  fluids_consumed: {},
  research: {},
  rockets: 0,
});
const waitFor = async (fn, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > end) throw new Error("Timed out waiting for test state");
    await new Promise((r) => setTimeout(r, 30));
  }
};
function setup(overrides = {}) {
  let game = false,
    produced = false,
    researched = false,
    stopCount = 0,
    profile,
    startLocale;
  const hooks = {
    running: () => game,
    openRecording: async () => {},
    start: async (_save, dir, _log, options) => {
      game = true;
      profile = dir;
      startLocale = options?.locale;
      fs.mkdirSync(path.join(dir, "saves"), { recursive: true });
    },
    stop: async () => {
      game = false;
      stopCount++;
    },
    connect: async () => {},
    cancelJobs: async () => {},
    command: async (lua) => {
      if (lua.startsWith("/save ")) {
        fs.writeFileSync(path.join(profile, "saves", lua.slice(6) + ".zip"), "final save");
        return "saving";
      }
      if (lua.includes("starting inventory")) return "ready";
      if (lua.includes("get_item_production_statistics"))
        return JSON.stringify({
          ...snapshot(produced ? { "iron-gear-wheel": 1 } : {}),
          research: researched ? { "logistic-science-pack": true } : {},
        });
      return "ok";
    },
    ...overrides,
  };
  const manager = new RunManager(hooks);
  return {
    manager,
    hooks,
    startLocale: () => startLocale,
    reload: () => new RunManager(hooks),
    unlock: () => {
      researched = true;
    },
    produce: () => {
      produced = true;
    },
    stopped: () => stopCount,
  };
}

test("milestones subtract initial production, validate player readiness, and require actual research", () => {
  const m = { id: "plates", kind: "production", name: "iron-plate", count: 10 };
  assert.equal(reached(m, snapshot({ "iron-plate": 25 }), snapshot({ "iron-plate": 20 })), false);
  assert.equal(reached(m, snapshot({ "iron-plate": 30 }), snapshot({ "iron-plate": 20 })), true);
  assert.equal(reached({ id: "a", kind: "research", name: "automation" }, snapshot(), snapshot()), false);
  assert.throws(() => parseSnapshot('{"tick":1,"character":false}'), /character/);
});

test("run completion is independently measured, saved, and reloaded", async () => {
  const { manager, produce, stopped, unlock } = setup();
  const run = manager.start({ agent: "manual", benchmark: "smoke" });
  assert.throws(() => manager.start({ agent: "manual" }), /active/);
  await waitFor(() => manager.get(run.id).state === "running");
  unlock();
  produce();
  await waitFor(() => manager.get(run.id).state === "completed");
  const result = manager.get(run.id);
  assert.ok(result.milestones["first-gear"]);
  assert.ok(result.milestones["research:logistic-science-pack"]);
  assert.equal(result.benchmark.milestones.filter((m) => m.name?.endsWith("-science-pack")).length, 7);
  const events = fs.readFileSync(path.join(temp, "runs", run.id, "milestones.jsonl"), "utf8");
  assert.match(events, /research:logistic-science-pack/);
  assert.equal(stopped(), 1);
  assert.deepEqual(result.warnings, []);
  assert.ok(fs.existsSync(path.join(temp, "runs", run.id, "final.zip")));
  assert.ok(
    fs.readFileSync(path.join(temp, "runs", run.id, "telemetry.jsonl"), "utf8").includes("iron-gear-wheel"),
  );
  assert.equal(new RunManager({}).get(run.id).state, "completed");
  assert.ok(manager.log(run.id, 0).text.includes("Milestone first-gear"));
});

test("launch map_gen overrides the benchmark map generation settings", async () => {
  const { manager } = setup();
  assert.throws(
    () => manager.start({ agent: "manual", benchmark: "smoke", map_gen: { seed: 1.5 } }),
    /map_gen.seed/,
  );
  const run = manager.start({
    agent: "manual",
    benchmark: "smoke",
    map_gen: {
      seed: 7,
      peaceful_mode: false,
      starting_area: 2,
      autoplace_controls: { "iron-ore": { frequency: 2, size: 1.5, richness: 4 } },
    },
  });
  assert.equal(run.benchmark.map_gen.seed, 7);
  assert.equal(run.benchmark.map_gen.peaceful_mode, false);
  assert.equal(run.benchmark.map_gen.starting_area, 2);
  assert.deepEqual(run.benchmark.map_gen.autoplace_controls, {
    "iron-ore": { frequency: 2, size: 1.5, richness: 4 },
  });
  await waitFor(() => manager.get(run.id).state === "running");
  const stored = JSON.parse(fs.readFileSync(path.join(temp, "runs", run.id, "benchmark.json"), "utf8"));
  assert.equal(stored.map_gen.seed, 7);
  await manager.stop();
});

test("operator stop and wall-clock limit produce distinct terminal states", async () => {
  const { manager, stopped } = setup();
  const run = manager.start({ agent: "manual", benchmark: "smoke" });
  await waitFor(() => manager.get(run.id).state === "running");
  await manager.stop();
  assert.equal(manager.get(run.id).state, "stopped");
  assert.equal(stopped(), 1);
  const timed = manager.start({ agent: "manual", benchmark: "smoke", max_seconds: 1 });
  await waitFor(() => manager.get(timed.id).state === "timed_out");
  assert.equal(stopped(), 2);
});

test("a successful agent exit does not count as game success", async () => {
  const { manager } = setup();
  const run = manager.start({
    benchmark: "smoke",
    model: "test-model",
    reasoning_effort: "high",
    agent: "codex",
  });
  assert.equal(run.model_label, "test-model (high)");
  assert.match(run.id, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_P[DS]T-[a-f0-9]{8}$/);
  await waitFor(() => manager.get(run.id).state === "failed");
  assert.match(manager.get(run.id).reason, /before the objective/);
  assert.equal(manager.get(run.id).failure_kind, "agent_early_exit");
  assert.equal(manager.get(run.id).session_id, "test-session");
  assert.equal(manager.get(run.id).agent_exit.code, 0);
  const folder = path.join(temp, "runs", run.id);
  const launch = JSON.parse(fs.readFileSync(path.join(folder, "agent-launch.json"), "utf8"));
  assert.equal(launch.args.includes("--json"), true);
  assert.ok(launch.args.includes('model_reasoning_effort="high"'));
  assert.equal(launch.args[launch.args.indexOf("--model") + 1], "test-model");
  const native = fs.readFileSync(path.join(folder, "agent.events.jsonl"));
  assert.match(native.toString("utf8"), /I claim success/);
  assert.equal(run.terminal, false);
  assert.equal(run.output_format, "events");
  assert.equal(run.recording, true);
  assert.deepEqual(manager.get(run.id).usage, { input_tokens: 20, output_tokens: 5 });
  const log = manager.log(run.id, 0, "events");
  assert.deepEqual(Buffer.from(log.data, "base64"), native);
  assert.equal(log.offset, native.length);
  assert.equal(manager.log(run.id, log.offset, "events").data, "");
  assert.deepEqual(Buffer.from(manager.log(run.id, 3, "events").data, "base64"), native.subarray(3));
  assert.deepEqual(manager.get(run.id).milestones, {});
});

test("AUTORIO_AUTO_RESUME resumes the newest interrupted run on manager start", async () => {
  const previous = process.env.AUTORIO_AUTO_RESUME;
  process.env.AUTORIO_AUTO_RESUME = "1";
  const env = setup();
  const manager = env.manager;
  try {
    const run = manager.start({ benchmark: "smoke", agent: "manual" });
    await waitFor(() => manager.get(run.id).state === "running");
    await manager.stop();
    const folder = path.join(temp, "runs", run.id);
    const stored = JSON.parse(fs.readFileSync(path.join(folder, "run.json"), "utf8"));
    stored.state = "interrupted";
    stored.reason = "simulated manager crash";
    fs.writeFileSync(path.join(folder, "run.json"), JSON.stringify(stored));
    const reloaded = env.reload();
    assert.equal(reloaded.autoResumeInterrupted(), run.id);
    await waitFor(() => reloaded.get(run.id).state === "running");
    await reloaded.stop();
    assert.equal(reloaded.get(run.id).state, "stopped");
  } finally {
    await manager.shutdown();
    process.env.AUTORIO_AUTO_RESUME = previous;
  }
});

test("a failed run with a current checkpoint can be retried", async () => {
  const { manager } = setup();
  try {
    const run = manager.start({ benchmark: "smoke", agent: "codex" });
    await waitFor(() => manager.get(run.id).state === "failed");
    assert.equal(manager.get(run.id).resumable, true);
    manager.resume(run.id);
    await waitFor(() => manager.get(run.id).state === "running");
    assert.equal(manager.get(run.id).segments.length, 2);
    await manager.stop();
    assert.equal(manager.get(run.id).state, "stopped");
  } finally {
    await manager.shutdown();
  }
});

test("clean early exits auto-continue the same session, then pause when the budget is exhausted", async () => {
  const previous = process.env.AUTORIO_AUTO_CONTINUE_MAX;
  process.env.AUTORIO_AUTO_CONTINUE_MAX = "2";
  const { manager } = setup();
  try {
    const run = manager.start({ benchmark: "smoke", agent: "codex" });
    await waitFor(() => manager.get(run.id).state === "paused", 30000);
    const result = manager.get(run.id);
    assert.equal(result.auto_continues, 2);
    assert.equal(result.resumable, true);
    assert.equal(result.agent_exit.code, 0);
    assert.equal(result.segments.length, 1, "automatic continuation stays in the same segment");
    assert.match(result.reason, /auto-continuation limit \(2\) reached/);
    const launch = JSON.parse(fs.readFileSync(path.join(temp, "runs", run.id, "agent-launch.json")));
    assert.equal(launch.args.includes("resume"), true);
    assert.ok(JSON.stringify(launch).includes("test-session"));
    manager.resume(run.id);
    await waitFor(() => manager.get(run.id).state === "running");
    assert.equal(manager.get(run.id).auto_continues, 0, "manual retry resets the auto budget");
    await manager.stop();
  } finally {
    await manager.shutdown();
    process.env.AUTORIO_AUTO_CONTINUE_MAX = previous;
  }
});

test("dsh agent runs headless, translates its event stream, and records usage", async () => {
  const working = path.join(temp, "dsh-test");
  fs.mkdirSync(working, { recursive: true });
  const previousBin = process.env.DSH_BIN;
  const previousHome = process.env.DSH_HOME;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousDir = process.env.AUTORIO_DSH_TEST_DIR;
  process.env.DSH_BIN = fakeDsh;
  process.env.DSH_HOME = path.join(temp, "dsh-home");
  process.env.DEEPSEEK_API_KEY = "sk-test-key";
  process.env.AUTORIO_DSH_TEST_DIR = working;
  const { manager, startLocale } = setup();
  try {
    const run = manager.start({
      benchmark: "smoke",
      agent: "dsh",
      model: "deepseek-flash#low",
      language: "Chinese",
    });
    await waitFor(() => manager.get(run.id).state === "failed");
    const result = manager.get(run.id);
    assert.match(result.reason, /before the objective/);
    assert.equal(result.session_id, "dsh-test-session");
    assert.equal(result.model, "deepseek-official/deepseek-flash");
    assert.equal(startLocale(), "zh-CN", "Chinese runs must start Factorio in zh-CN");
    assert.deepEqual(result.usage, {
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 40,
      total_tokens: 120,
    });
    assert.equal(result.usage_source, "dsh");
    assert.equal(result.output_format, "events");
    assert.equal(result.terminal, false);
    const folder = path.join(temp, "runs", run.id);
    const launch = JSON.parse(fs.readFileSync(path.join(folder, "agent-launch.json"), "utf8"));
    assert.deepEqual(launch.args.slice(0, 2), ["--profile", "headless"]);
    assert.ok(launch.args.includes("--patch"));
    assert.ok(launch.args.includes("--json"));
    assert.equal(launch.args.includes("--session-id"), false);
    const args = JSON.parse(fs.readFileSync(path.join(working, "dsh-args.json"), "utf8"));
    assert.deepEqual(args.slice(0, 2), ["--profile", "headless"]);
    const stdinText = fs.readFileSync(path.join(working, "dsh-stdin.txt"), "utf8");
    assert.match(stdinText, /Read AGENTS\.md, COOKBOOK\.md and TASK\.md/);
    assert.ok(fs.existsSync(path.join(folder, "workspace", "COOKBOOK.md")));
    assert.match(stdinText, process.platform === "win32" ? /play\.(cmd|ps1)/ : /play\.sh/);
    assert.match(stdinText, /never sleep longer than 10 seconds/i);
    const childEnv = JSON.parse(fs.readFileSync(path.join(working, "dsh-env.json"), "utf8"));
    assert.equal(childEnv.key, "sk-test-key");
    assert.equal(childEnv.profile, "headless");
    assert.ok(String(childEnv.pythonpath || "").includes(path.join(folder, "workspace")));
    const workspace = path.join(folder, "workspace");
    assert.ok(fs.existsSync(path.join(workspace, "dsh-model.patch.yml")));
    assert.match(
      fs.readFileSync(path.join(workspace, "dsh-model.patch.yml"), "utf8"),
      /reasoningEffort: "low"/,
    );
    assert.ok(fs.existsSync(path.join(workspace, process.platform === "win32" ? "play.cmd" : "play.sh")));
    assert.ok(fs.existsSync(path.join(workspace, "bin", "sleep")));
    assert.ok(fs.existsSync(path.join(workspace, "sitecustomize.py")));
    const events = fs
      .readFileSync(path.join(folder, "agent.events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      events.some((event) => event.type === "thread.started" && event.thread_id === "dsh-test-session"),
    );
    assert.ok(events.some((event) => event.type === "item.completed" && event.item?.type === "reasoning"));
    assert.ok(
      events.some(
        (event) =>
          event.type === "item.completed" &&
          event.item?.type === "agent_message" &&
          event.item.text === "I observed the player.",
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "item.started" &&
          event.item?.type === "command_execution" &&
          event.item.command.includes("observe-player"),
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "item.completed" &&
          event.item?.status === "completed" &&
          event.item.aggregated_output.includes("ok"),
      ),
    );
    assert.match(manager.log(run.id, 0).text, /DSH exited/);
  } finally {
    await manager.shutdown();
    if (previousBin === undefined) delete process.env.DSH_BIN;
    else process.env.DSH_BIN = previousBin;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
    if (previousDir === undefined) delete process.env.AUTORIO_DSH_TEST_DIR;
    else process.env.AUTORIO_DSH_TEST_DIR = previousDir;
  }
});

test("stop during preparation cannot start an agent or leave a live run", async () => {
  const { manager } = setup();
  const run = manager.start({ benchmark: "smoke", recording: false, agent: "codex" });
  assert.equal(run.recording, false);
  await manager.stop();
  assert.equal(manager.get(run.id).state, "stopped");
  assert.equal(manager.busy, false);
  assert.equal(fs.existsSync(path.join(temp, "runs", run.id, "agent-launch.json")), false);
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));

test("science milestones measure research independently of science-pack production", () => {
  const milestones = trackedMilestones({ milestones: [] });
  assert.equal(milestones.length, 7);
  const science = milestones.find((m) => m.name === "chemical-science-pack");
  assert.equal(reached(science, snapshot({ "chemical-science-pack": 100 }), snapshot()), false);
  assert.equal(
    reached(science, { ...snapshot(), research: { "chemical-science-pack": true } }, snapshot()),
    true,
  );
  assert.equal(trackedMilestones({ milestones: [science] }).length, 7);
});

test("stopping an agent retains session token counters without a final turn event", async () => {
  process.env.AUTORIO_TEST_NO_FINAL = "1";
  const { manager } = setup();
  try {
    const run = manager.start({ benchmark: "smoke", agent: "codex" });
    await waitFor(() => manager.get(run.id).session_id === "interrupted-session");
    await manager.stop();
    const result = manager.get(run.id);
    assert.equal(result.state, "stopped");
    assert.equal(result.usage_status, "last_reported");
    assert.equal(result.usage_source, "session_log");
    assert.equal(result.usage.input_tokens, 25);
    assert.equal(result.usage.output_tokens, 3);
  } finally {
    delete process.env.AUTORIO_TEST_NO_FINAL;
  }
});

test("video stops before game shutdown and rendering completes after scoring", async () => {
  let stoppedVideo = false;
  const env = setup({
    startVideo: async (dir) => ({
      stop: async () => {
        assert.equal(env.stopped(), 0);
        stoppedVideo = true;
        return path.join(dir, "video", "capture.mov");
      },
    }),
    renderVideo: async () => {
      assert.equal(stoppedVideo, true);
      assert.equal(env.stopped(), 1);
      return { fps: 30, frames: 30, duration_seconds: 1 };
    },
  });
  const run = env.manager.start({ benchmark: "smoke", capture_video: true, agent: "codex" });
  await waitFor(() => env.manager.get(run.id).state === "running");
  env.produce();
  await waitFor(() => env.manager.get(run.id).video?.state === "ready");
  const result = env.manager.get(run.id);
  assert.equal(result.state, "completed");
  assert.equal(result.video.file, "video/timelapse.mp4");
  assert.equal(result.video.speed, 6);
});

test("quota errors checkpoint immediately, survive manager restart, and resume the same game/session without resetting progress", async () => {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = quotaCodex;
  let videoStops = 0;
  const captureDirs = [];
  let manager;
  const env = setup({
    startVideo: async (dir) => {
      captureDirs.push(dir);
      return {
        stop: async () => {
          videoStops++;
          return path.join(dir, "video", "capture.mov");
        },
      };
    },
    renderVideo: async () => ({ fps: 30, frames: 30 }),
  });
  manager = env.manager;
  const loads = [],
    commands = [];
  const start = env.hooks.start,
    command = env.hooks.command;
  env.hooks.start = async (save, ...args) => {
    loads.push(save);
    await new Promise((r) => setTimeout(r, 250));
    await start(save, ...args);
  };
  env.hooks.command = async (lua) => {
    commands.push(lua);
    return command(lua);
  };
  try {
    const run = manager.start({ benchmark: "smoke", capture_video: true, max_seconds: 30, agent: "codex" });
    await waitFor(() => manager.get(run.id).state === "paused");
    await waitFor(() => manager.get(run.id).video?.state === "ready");
    const paused = manager.get(run.id),
      folder = path.join(temp, "runs", run.id);
    assert.equal(paused.resumable, true);
    assert.equal(manager.busy, false);
    assert.equal(env.stopped(), 1);
    assert.equal(videoStops, 1);
    assert.match(paused.quota.message, /usage limit/);
    assert.equal(paused.session_id, "quota-session");
    assert.equal(paused.usage.input_tokens, 25);
    assert.equal(fs.readFileSync(path.join(folder, paused.checkpoint.file), "utf8"), "final save");
    assert.equal(paused.checkpoint.file, "segments/001/checkpoint.zip");
    const inventoryResets = commands.filter((c) => c.includes("p.clear_items_inside")).length;
    const baselineHash = paused.hashes.baseline_save;
    fs.writeFileSync(path.join(folder, "workspace", "agent-notes.txt"), "keep my factory plan");
    // Simulate restarting after the converter finished but before run.json was updated.
    const stored = JSON.parse(fs.readFileSync(path.join(folder, "run.json")));
    stored.video.state = "rendering";
    stored.segments[0].video.state = "rendering";
    fs.mkdirSync(path.join(folder, "video"), { recursive: true });
    fs.writeFileSync(path.join(folder, "video", "timelapse.mp4"), "converted fixture");
    fs.writeFileSync(
      path.join(folder, "video", "timelapse.json"),
      JSON.stringify({ fps: 30.000001907348633, frames: 30 }),
    );
    fs.writeFileSync(path.join(folder, "run.json"), JSON.stringify(stored));
    manager = env.reload();
    assert.equal(manager.get(run.id).video.state, "ready");
    assert.equal(manager.get(run.id).state, "paused");
    assert.equal(manager.get(run.id).resumable, true);
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(folder, "workspace", "factorio.py"), "# stale client before resume\n");
    manager.resume(run.id);
    assert.throws(() => manager.resume(run.id), /active/);
    await waitFor(() => manager.get(run.id).state === "running");
    await waitFor(() => manager.get(run.id).usage.input_tokens === 35);
    const resumed = manager.get(run.id);
    assert.ok(
      resumed.elapsed_seconds - paused.elapsed_seconds < 0.2,
      "waiting and 250ms game launch must not count",
    );
    assert.equal(resumed.baseline_tick, paused.baseline_tick);
    assert.equal(resumed.hashes.baseline_save, baselineHash);
    assert.equal(loads[1], path.join(folder, paused.checkpoint.file));
    assert.equal(commands.filter((c) => c.includes("p.clear_items_inside")).length, inventoryResets);
    assert.equal(
      fs.readFileSync(path.join(folder, "workspace", "agent-notes.txt"), "utf8"),
      "keep my factory plan",
    );
    assert.match(
      fs.readFileSync(path.join(folder, "workspace", "factorio.py"), "utf8"),
      /def list_blueprints/,
      "resume must refresh the bundled workspace client",
    );
    const launch = JSON.parse(fs.readFileSync(path.join(folder, "agent-launch.json")));
    assert.equal(launch.args[launch.args.indexOf("resume") + 1], "quota-session");
    env.produce();
    env.unlock();
    await waitFor(() => manager.get(run.id).state === "completed");
    await waitFor(() => manager.get(run.id).video?.state === "ready");
    const result = manager.get(run.id);
    assert.equal(result.segments.length, 2);
    assert.equal(videoStops, 2);
    assert.equal(env.stopped(), 2);
    assert.equal(result.segments[0].state, "paused");
    assert.equal(result.segments[1].state, "completed");
    assert.equal(result.checkpoint.file, "segments/002/checkpoint.zip");
    assert.ok(result.milestones["first-gear"]);
    assert.ok(result.milestones["research:logistic-science-pack"]);
    assert.ok(result.milestones["first-gear"].wall_seconds >= paused.elapsed_seconds);
    assert.equal(result.usage.input_tokens, 35);
    assert.equal(result.usage.output_tokens, 5);
    assert.notEqual(captureDirs[0], captureDirs[1]);
    assert.equal(result.video.file, "segments/002/video/timelapse.mp4");
    assert.equal(result.segments[0].video.file, "video/timelapse.mp4");
    assert.equal(manager.videoFile(run.id, 1), path.join(folder, "video", "timelapse.mp4"));
    const points = fs
      .readFileSync(path.join(folder, "telemetry.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(points.every((p, i) => i === 0 || p.wall_seconds >= points[i - 1].wall_seconds));
  } finally {
    await manager.shutdown();
    process.env.CODEX_BIN = previous;
  }
});

test("repeated quota exhaustion preserves each checkpoint and a failed save cannot offer stale progress as resumable", async () => {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = quotaCodex;
  process.env.AUTORIO_TEST_REPEAT_QUOTA = "1";
  const env = setup();
  const manager = env.manager;
  try {
    const run = manager.start({ benchmark: "smoke", max_seconds: 30, agent: "codex" });
    await waitFor(() => manager.get(run.id).state === "paused");
    const checkpoint = manager.get(run.id).checkpoint;
    fs.appendFileSync(path.join(temp, "runs", run.id, checkpoint.file), "changed");
    assert.throws(() => manager.resume(run.id), /checksum/);
    fs.writeFileSync(path.join(temp, "runs", run.id, checkpoint.file), "final save");
    manager.resume(run.id);
    await waitFor(() => manager.get(run.id).state === "paused");
    assert.equal(manager.get(run.id).checkpoint.segment, 2);
    assert.equal(manager.get(run.id).segments.length, 2);
    const command = env.hooks.command;
    env.hooks.command = async (lua) => {
      if (lua.startsWith("/save ")) throw new Error("disk full");
      return command(lua);
    };
    manager.resume(run.id);
    await waitFor(() => manager.get(run.id).state === "failed");
    assert.equal(manager.get(run.id).resumable, false);
    assert.match(manager.get(run.id).reason, /no valid game checkpoint/);
    assert.ok(manager.get(run.id).warnings.some((w) => w.includes("disk full")));
    assert.equal(
      manager.get(run.id).checkpoint.segment,
      2,
      "prior save is retained for recovery but not offered as current",
    );
  } finally {
    await manager.shutdown();
    process.env.CODEX_BIN = previous;
    delete process.env.AUTORIO_TEST_REPEAT_QUOTA;
  }
});
