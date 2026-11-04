#!/usr/bin/env node
// Multi-instance autorio cluster: runs N isolated managers (each with its own
// HTTP port, RCON port, Factorio host port and data directory) so benchmark
// runs can be evaluated in parallel on one machine, without Docker.
//
// Usage: node scripts/cluster.mjs <start|status|run|stop|logs> [options]
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
} from "./cluster-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = path.join(ROOT, "dist", "server.js");

const HELP = `autorio cluster supervisor

Usage:
  node scripts/cluster.mjs start [options]     start N isolated managers
  node scripts/cluster.mjs status [options]    probe every instance
  node scripts/cluster.mjs run [options]       start one benchmark run per instance
  node scripts/cluster.mjs stop [options]      stop games and managers
  node scripts/cluster.mjs logs [options]      show instance log paths + tails

Options:
  --instances <n>        number of instances (default 2, max 16)
  --port <n>             first manager HTTP port (default 3000, then +1 each)
  --rcon-port <n>        first RCON port (default 27099, then +1 each)
  --game-port <n>        first Factorio host port (default 34197, then +1 each)
  --data-dir <path>      cluster metadata + instance data root (default .autorio/cluster)
  --save <name.zip>      seed a save into every instance and host it after start
  --benchmark <name>     benchmark id for "run" (e.g. smoke, automation)
  --model <model>        model for "run"
  --agent <agent>        agent backend for "run" (opencode default, codex optional)
  --language <lang>      agent output language for "run"
  --max-seconds <n>      run time limit for "run"
  --instances-list <ids> comma separated 1-based instance ids for "run"/"status"/"logs"
  --no-recording         do not open the recording view for cluster runs
  --json                 raw JSON output for "status"
  --help                 show this help

Examples:
  npm run build
  node scripts/cluster.mjs start --instances 2
  node scripts/cluster.mjs run --benchmark automation --model opencode-go/deepseek-v4.1-flash#low
  node scripts/cluster.mjs status
  node scripts/cluster.mjs stop
`;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`cluster: ${message}\n`);
  process.exitCode = 1;
}

async function fetchJson(url, { method = "GET", body, timeoutMs = 10_000 } = {}) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    const detail = parsed?.error || parsed?.raw || response.statusText;
    throw new Error(`HTTP ${response.status} for ${url}: ${detail}`);
  }
  return parsed;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(file) {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readTail(file, lines = 40) {
  try {
    const content = fs.readFileSync(file, "utf8");
    return content.split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "(no log yet)";
  }
}

function activeRunId(runs) {
  const activeStates = new Set(["preparing", "launching", "running", "saving", "paused"]);
  const active = (runs || []).filter((run) => activeStates.has(run.state));
  if (active.length === 0) return null;
  return active[active.length - 1].id;
}

function ensureBuild() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`dist/server.js not found; run "npm run build" first (${SERVER_ENTRY})`);
  }
}

function clusterAlreadyRunning(info) {
  return Boolean(
    info && Array.isArray(info.instances) && info.instances.some((instance) => isAlive(instance.pid)),
  );
}

async function startCommand(options) {
  ensureBuild();
  const existingFile = clusterFilePath(options.dataDir);
  if (fs.existsSync(existingFile)) {
    try {
      if (clusterAlreadyRunning(readClusterInfo(options.dataDir))) {
        throw new Error(`cluster already running (${existingFile}); stop it first`);
      }
    } catch (error) {
      if (String(error.message).includes("already running")) throw error;
    }
  }

  const plan = planInstances({
    root: ROOT,
    instances: options.instances,
    port: options.port,
    rconPort: options.rconPort,
    gamePort: options.gamePort,
    dataDir: options.dataDir,
  });
  log(`Starting ${plan.length} autorio instance(s) under ${path.dirname(plan[0].dataDir)}`);

  let seedSave = null;
  if (options.save) {
    if (path.basename(options.save) !== options.save || !options.save.endsWith(".zip")) {
      throw new Error("--save expects a plain .zip save name (e.g. clear-test.zip)");
    }
    seedSave = path.join(ROOT, ".autorio", "saves", options.save);
    if (!fs.existsSync(seedSave)) throw new Error(`seed save not found: ${seedSave}`);
  }

  const instances = [];
  const started = [];
  try {
    for (const instance of plan) {
      fs.mkdirSync(path.join(instance.dataDir, "saves"), { recursive: true });
      const outFile = path.join(instance.dataDir, "manager.out.log");
      const errFile = path.join(instance.dataDir, "manager.err.log");
      if (seedSave) {
        fs.copyFileSync(seedSave, path.join(instance.dataDir, "saves", path.basename(seedSave)));
      }
      const outFd = fs.openSync(outFile, "a");
      const errFd = fs.openSync(errFile, "a");
      const child = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: ROOT,
        env: buildManagerEnv(process.env, instance),
        stdio: ["ignore", outFd, errFd],
        detached: true,
        windowsHide: true,
      });
      child.unref();
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      const record = {
        ...instance,
        pid: child.pid,
        outFile,
        errFile,
      };
      instances.push(record);
      started.push(record);
      log(
        `  instance ${record.id}: manager pid ${record.pid}, api :${record.apiPort}, rcon :${record.rconPort}, game :${record.gamePort}`,
      );
    }

    await Promise.all(
      instances.map(async (instance) => {
        await waitForInstance(instance.url, { timeoutMs: 30_000 });
        log(`  instance ${instance.id}: manager ready at ${instance.url}`);
      }),
    );

    if (seedSave) {
      const saveName = path.basename(seedSave);
      await Promise.all(
        instances.map(async (instance) => {
          log(`  instance ${instance.id}: hosting ${saveName}`);
          await fetchJson(`${instance.url}/api/server/start`, {
            method: "POST",
            body: { save: saveName },
            timeoutMs: 180_000,
          });
          const deadline = Date.now() + 180_000;
          for (;;) {
            const probe = await probeInstance(instance.url);
            if (probe.ok && probe.body?.rcon?.connected) break;
            if (Date.now() > deadline) throw new Error(`instance ${instance.id}: RCON did not connect`);
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
          // A hosted save starts paused; unpause so a manual cluster session runs.
          await fetchJson(`${instance.url}/api/rcon/command`, {
            method: "POST",
            body: { command: "/sc game.tick_paused=false" },
            timeoutMs: 15_000,
          }).catch((error) => log(`  instance ${instance.id}: unpause skipped (${error.message})`));
        }),
      );
    }

    const info = {
      createdAt: new Date().toISOString(),
      root: ROOT,
      options,
      instances,
    };
    const file = writeClusterInfo(options.dataDir, info);
    log(`\nCluster ready: ${plan.length} instance(s), metadata at ${file}`);
    await statusCommand({ ...options, instancesList: "all" });
  } catch (error) {
    // Do not leave half-started managers behind.
    for (const instance of started) {
      try {
        await fetchJson(`${instance.url}/api/manager/stop`, { method: "POST", timeoutMs: 5_000 });
      } catch {
        /* ignore */
      }
      if (isAlive(instance.pid)) killProcessTree(instance.pid);
    }
    throw error;
  }
}

async function statusCommand(options) {
  let info;
  try {
    info = readClusterInfo(options.dataDir);
  } catch (error) {
    throw new Error(`${error.message} (data dir ${path.resolve(ROOT, options.dataDir)})`, { cause: error });
  }
  const selected = selectInstances(info.instances || [], options.instancesList);
  const rows = await Promise.all(
    selected.map(async (instance) => {
      const probe = await probeInstance(instance.url);
      let runId = null;
      if (probe.ok) {
        try {
          const runs = await fetchJson(`${instance.url}/api/runs`, { timeoutMs: 5_000 });
          runId = activeRunId(runs?.runs);
        } catch {
          runId = null;
        }
      }
      return {
        ...instance,
        ok: probe.ok,
        running: Boolean(probe.body?.running),
        rconConnected: Boolean(probe.body?.rcon?.connected),
        save: probe.body?.save || null,
        runId,
        error: probe.error || null,
      };
    }),
  );
  if (options.json) {
    log(
      JSON.stringify({ cluster: path.dirname(clusterFilePath(options.dataDir)), instances: rows }, null, 2),
    );
  } else {
    log(formatInstanceTable(rows));
    const down = rows.filter((row) => !row.ok);
    if (down.length > 0)
      log(`\n${down.length} instance(s) not responding: ${down.map((row) => row.id).join(", ")}`);
  }
  return rows;
}

async function runCommand(options) {
  const info = readClusterInfo(options.dataDir);
  if (!options.benchmark) throw new Error("--benchmark is required for run");
  const selected = selectInstances(info.instances || [], options.instancesList);
  const body = buildRunRequest(options);
  log(
    `Starting ${body.benchmark} on ${selected.length} instance(s)${body.model ? ` with ${body.model}` : ""}`,
  );
  const results = await Promise.all(
    selected.map(async (instance) => {
      try {
        // A manually hosted game (e.g. `cluster start --save`) must be closed
        // before the manager can start a benchmark run on this instance.
        const probe = await probeInstance(instance.url);
        if (probe.ok && probe.body?.running) {
          const runs = await fetchJson(`${instance.url}/api/runs`, { timeoutMs: 5_000 }).catch(() => null);
          if (!activeRunId(runs?.runs)) {
            log(`  instance ${instance.id}: stopping manually hosted game before run`);
            await fetchJson(`${instance.url}/api/server/stop`, { method: "POST", timeoutMs: 60_000 });
          }
        }
        const run = await fetchJson(`${instance.url}/api/runs`, {
          method: "POST",
          body,
          timeoutMs: 30_000,
        });
        const runId = run?.id || run?.run?.id || null;
        return { instance, ok: true, runId, run };
      } catch (error) {
        return { instance, ok: false, error: error.message };
      }
    }),
  );
  const ids = [];
  for (const result of results) {
    if (result.ok) {
      ids.push(result.runId);
      log(
        `  instance ${result.instance.id}: run ${result.runId} -> ${result.instance.url}/recording.html?run=${encodeURIComponent(result.runId || "")}`,
      );
    } else {
      log(`  instance ${result.instance.id}: FAILED ${result.error}`);
    }
  }
  if (ids.length > 0) {
    log(`\nRuns: ${ids.filter(Boolean).join(", ")}`);
    log(`Track with: node scripts/cluster.mjs status --data-dir ${options.dataDir}`);
  }
  if (results.some((result) => !result.ok)) process.exitCode = 1;
  return results;
}

async function stopCommand(options) {
  let info;
  try {
    info = readClusterInfo(options.dataDir);
  } catch (error) {
    log(`${error.message}; nothing to stop.`);
    return;
  }
  const selected = selectInstances(info.instances || [], options.instancesList);
  for (const instance of selected) {
    log(`Stopping instance ${instance.id} (pid ${instance.pid})...`);
    // An active benchmark run must be stopped through the run endpoint first;
    // the game refuses /api/server/stop while a run owns it.
    try {
      const runs = await fetchJson(`${instance.url}/api/runs`, { timeoutMs: 5_000 });
      for (const run of runs?.runs || []) {
        if (!["preparing", "launching", "running", "saving", "paused"].includes(run.state)) continue;
        log(`  stopping run ${run.id} (${run.state})`);
        try {
          await fetchJson(`${instance.url}/api/runs/${encodeURIComponent(run.id)}/stop`, {
            method: "POST",
            timeoutMs: 300_000,
          });
        } catch (error) {
          log(`  run stop failed: ${error.message}`);
        }
      }
    } catch {
      /* no runs endpoint yet */
    }
    try {
      await fetchJson(`${instance.url}/api/server/stop`, { method: "POST", timeoutMs: 30_000 });
    } catch {
      /* game may already be stopped */
    }
    try {
      await fetchJson(`${instance.url}/api/manager/stop`, { method: "POST", timeoutMs: 10_000 });
    } catch {
      /* manager may already be stopped */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const gamePid = readPid(path.join(instance.dataDir, "factorio.pid"));
    if (gamePid && isAlive(gamePid)) killProcessTree(gamePid);
    if (isAlive(instance.pid)) killProcessTree(instance.pid);
  }
  const remainingInfo = {
    ...info,
    stoppedAt: new Date().toISOString(),
    instances: (info.instances || []).map((instance) => ({ ...instance, stopped: true })),
  };
  writeClusterInfo(options.dataDir, remainingInfo);
  log(`Cluster stopped (${selected.length} instance(s)).`);
}

function logsCommand(options) {
  let info;
  try {
    info = readClusterInfo(options.dataDir);
  } catch (error) {
    throw new Error(error.message, { cause: error });
  }
  const selected = selectInstances(info.instances || [], options.instancesList);
  for (const instance of selected) {
    log(`=== instance ${instance.id} (${instance.url}) ===`);
    log(`  ${instance.outFile}`);
    log(
      `${readTail(instance.outFile)
        .split(/\r?\n/)
        .map((line) => `  | ${line}`)
        .join("\n")}`,
    );
    log(`  ${instance.errFile}`);
    log(
      `${readTail(instance.errFile, 20)
        .split(/\r?\n/)
        .map((line) => `  ! ${line}`)
        .join("\n")}`,
    );
  }
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command === "help" || options.help) {
    log(HELP.trimEnd());
    return;
  }
  if (command === "start") return startCommand(options);
  if (command === "status") return statusCommand(options);
  if (command === "run") return runCommand(options);
  if (command === "stop") return stopCommand(options);
  if (command === "logs") return logsCommand(options);
  throw new Error(`Unknown command "${command}". Use --help.`);
}

main(process.argv.slice(2)).catch((error) => {
  fail(error?.message || String(error));
});
