import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildManagerEnv,
  buildRunRequest,
  clusterFilePath,
  formatInstanceTable,
  killProcessTree,
  parseArgs,
  planInstances,
  probeInstance,
  readClusterInfo,
  selectInstances,
  waitForInstance,
  writeClusterInfo,
} from "../scripts/cluster-lib.mjs";

function tempDir(prefix = "autorio-cluster-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("parseArgs uses defaults and parses overrides", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.command, "help");
  assert.equal(defaults.options.instances, 2);
  assert.equal(defaults.options.port, 3000);
  assert.equal(defaults.options.rconPort, 27099);
  assert.equal(defaults.options.gamePort, 34197);
  assert.equal(defaults.options.recording, true);

  const parsed = parseArgs([
    "start", "--instances", "3", "--port=3100", "--rcon-port", "27100",
    "--game-port", "34198", "--data-dir", "tmp/cluster", "--save", "seed.zip",
    "--no-recording", "--json",
  ]);
  assert.equal(parsed.command, "start");
  assert.equal(parsed.options.instances, 3);
  assert.equal(parsed.options.port, 3100);
  assert.equal(parsed.options.rconPort, 27100);
  assert.equal(parsed.options.gamePort, 34198);
  assert.equal(parsed.options.dataDir, "tmp/cluster");
  assert.equal(parsed.options.save, "seed.zip");
  assert.equal(parsed.options.recording, false);
  assert.equal(parsed.options.json, true);

  const recording = parseArgs(["run", "--recording=false"]);
  assert.equal(recording.options.recording, false);
});

test("parseArgs rejects unknown options and missing values", () => {
  assert.throws(() => parseArgs(["start", "--bogus", "1"]), /Unknown option/);
  assert.throws(() => parseArgs(["start", "--instances"]), /requires a value/);
  assert.throws(() => parseArgs(["start", "--instances", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["start", "--instances", "abc"]), /positive integer/);
  assert.throws(() => parseArgs(["start", "--no-recording=maybe"]), /true or false/);
});

test("planInstances assigns consecutive isolated ports and data dirs", () => {
  const plan = planInstances({
    root: "/repo",
    instances: 3,
    port: 3000,
    rconPort: 27099,
    gamePort: 34197,
    dataDir: ".autorio/cluster",
  });
  assert.equal(plan.length, 3);
  assert.deepEqual(
    plan.map((instance) => [instance.id, instance.apiPort, instance.rconPort, instance.gamePort]),
    [[1, 3000, 27099, 34197], [2, 3001, 27100, 34198], [3, 3002, 27101, 34199]],
  );
  assert.equal(plan[0].url, "http://127.0.0.1:3000");
  assert.ok(plan[1].dataDir.endsWith(path.join(".autorio", "cluster", "instance-2")));
});

test("planInstances rejects invalid ranges", () => {
  assert.throws(() => planInstances({ root: "/repo", instances: 0 }), /positive integer/);
  assert.throws(() => planInstances({ root: "/repo", instances: 17 }), /At most 16/);
  assert.throws(
    () => planInstances({ root: "/repo", instances: 2, gamePort: 65535 }),
    /exceeds 65535/,
  );
});

test("buildManagerEnv isolates manager, rcon and game ports", () => {
  const env = buildManagerEnv({ PATH: "/bin", AUTORIO_PORT: "9999" }, {
    apiPort: 3002,
    rconPort: 27101,
    gamePort: 34199,
    dataDir: "/tmp/instance-3",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.AUTORIO_PORT, "3002");
  assert.equal(env.RCON_PORT, "27101");
  assert.equal(env.AUTORIO_GAME_PORT, "34199");
  assert.equal(env.AUTORIO_DATA_DIR, "/tmp/instance-3");
});

test("cluster metadata round-trips through cluster.json", () => {
  const dir = tempDir();
  const file = writeClusterInfo(dir, { options: { instances: 1 }, instances: [{ id: 1, pid: 42 }] });
  assert.equal(file, clusterFilePath(dir));
  const info = readClusterInfo(dir);
  assert.equal(info.version, 1);
  assert.equal(info.instances[0].pid, 42);
  assert.ok(info.updatedAt);
  assert.throws(() => readClusterInfo(path.join(dir, "missing")), /No cluster metadata/);
});

test("selectInstances supports all, ids and errors", () => {
  const instances = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(selectInstances(instances, "all").map((i) => i.id), [1, 2, 3]);
  assert.deepEqual(selectInstances(instances, undefined).map((i) => i.id), [1, 2, 3]);
  assert.deepEqual(selectInstances(instances, "1,3").map((i) => i.id), [1, 3]);
  assert.throws(() => selectInstances(instances, "4"), /Unknown instance 4/);
  assert.throws(() => selectInstances(instances, "a"), /comma separated/);
});

test("buildRunRequest mirrors the manager run options", () => {
  const request = buildRunRequest({
    benchmark: "automation",
    model: "opencode-go/deepseek-v4.1-flash#low",
    agent: "opencode",
    language: "Chinese",
    maxSeconds: 3600,
    recording: false,
  });
  assert.deepEqual(request, {
    benchmark: "automation",
    model: "opencode-go/deepseek-v4.1-flash#low",
    agent: "opencode",
    language: "Chinese",
    max_seconds: 3600,
    terminal: false,
    recording: false,
    capture_video: false,
  });
  assert.deepEqual(buildRunRequest({ benchmark: "smoke" }), {
    benchmark: "smoke",
    terminal: false,
    recording: true,
    capture_video: false,
  });
});

test("probeInstance reports healthy and unreachable instances", async () => {
  const healthy = await probeInstance("http://cluster:3000", {
    fetchImpl: async (url) => {
      assert.equal(url, "http://cluster:3000/api/server/status");
      return { ok: true, status: 200, json: async () => ({ running: true, rcon: { connected: true } }) };
    },
  });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.body.running, true);

  const broken = await probeInstance("http://cluster:3001", {
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /ECONNREFUSED/);
});

test("waitForInstance retries until a manager answers", async () => {
  let calls = 0;
  const result = await waitForInstance("http://cluster:3000", {
    intervalMs: 1,
    timeoutMs: 500,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error("starting");
      return { ok: true, status: 200, json: async () => ({ running: true }) };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
  await assert.rejects(
    () => waitForInstance("http://cluster:3999", {
      intervalMs: 1,
      timeoutMs: 20,
      fetchImpl: async () => { throw new Error("down"); },
    }),
    /Timed out waiting/,
  );
});

test("formatInstanceTable renders cluster state", () => {
  const table = formatInstanceTable([
    { id: 1, apiPort: 3000, rconPort: 27099, gamePort: 34197, pid: 111, ok: true, running: true, rconConnected: true, runId: "abc" },
    { id: 2, apiPort: 3001, rconPort: 27100, gamePort: 34198, pid: 222, ok: false, running: false, rconConnected: false },
  ]);
  assert.match(table, /#\s+API\s+RCON\s+GAME\s+PID/);
  assert.match(table, /^1\s+3000\s+27099\s+34197\s+111\s+up\s+running\s+abc$/m);
  assert.match(table, /^2\s+3001\s+27100\s+34198\s+222\s+down\s+stopped\s+-$/m);
});

test("killProcessTree passes the right command per platform", () => {
  const calls = [];
  const runner = (file, args) => {
    calls.push([file, args]);
    return { status: 0 };
  };
  assert.equal(killProcessTree(123, { platform: "win32", run: runner }), true);
  assert.deepEqual(calls.at(-1), ["taskkill", ["/PID", "123", "/T", "/F"]]);
  assert.equal(killProcessTree(456, { platform: "linux", run: runner }), true);
  assert.deepEqual(calls.at(-1), ["kill", ["-TERM", "456"]]);
  assert.equal(killProcessTree(0, { run: runner }), false);
});
