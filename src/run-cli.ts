#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { obsStatus } from "./obs.js";
import { DATA_DIR, PORT } from "./runtime.js";
import { asRecord, asString } from "./validation.js";

/** Run fields the CLI reads from `GET/POST /api/runs`; the API adds more. */
type RunSummary = {
  id: string;
  name?: string;
  state: string;
  reason?: string;
  agent: string;
  model?: string;
  model_label?: string;
  terminal?: boolean;
  elapsed_seconds: number;
  segments: unknown[];
  benchmark: { id: string };
  hashes?: Record<string, string>;
  milestones: Record<string, { wall_seconds: number; game_ticks: number }>;
};
type RunLog = { text: string; offset: number };
type BenchmarkSummary = { id: string; title: string; max_seconds: number };

const base = process.env.FACTORIO_API_BASE || `http://127.0.0.1:${PORT}`;
async function api<T = unknown>(endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch(base + endpoint, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    // The manager reports failures as `{error}`; malformed bodies keep the status text.
    throw new Error(asString(asRecord(data)?.error) || `HTTP ${response.status}`);
  }
  return data as T;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function ensureManager() {
  try {
    await fetch(base + "/api/server/status", { signal: AbortSignal.timeout(1000) }).then((r) => {
      if (!r.ok) throw new Error("HTTP error");
    });
    return;
  } catch {
    /* Start the local manager below. */
  }
  if (process.env.FACTORIO_API_BASE) throw new Error(`Manager is unavailable at ${base}; start it first.`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(path.join(DATA_DIR, "manager.log"), "a");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.js", import.meta.url))], {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
    },
  });
  child.unref();
  fs.closeSync(log);
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(200);
    try {
      await api("/api/server/status");
      return;
    } catch {
      /* wait */
    }
  }
  throw new Error(`Manager did not start. See ${path.join(DATA_DIR, "manager.log")}`);
}
const args = process.argv.slice(2);
const command = args.shift() || "help";
function option(name: string) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${name} needs a value`);
  return args[i + 1];
}
async function watch(id: string) {
  let offset = 0,
    state = "";
  process.once("SIGINT", () => {
    console.log("\nStopping run and saving...");
    void api(`/api/runs/${id}/stop`, {}).then(
      () => process.exit(130),
      (error) => {
        console.error(error.message);
        process.exit(1);
      },
    );
  });
  for (;;) {
    const [run, log] = await Promise.all([
      api<RunSummary>(`/api/runs/${id}`),
      api<RunLog>(`/api/runs/${id}/log?offset=${offset}`),
    ]);
    if (state !== run.state) {
      state = run.state;
      console.log(`\n[${id}] ${state}`);
    }
    if (log.text) process.stdout.write(log.text);
    offset = log.offset;
    if (["completed", "failed", "stopped", "timed_out", "interrupted", "paused"].includes(state)) {
      console.log(`${run.reason}\nResults: ${path.join(DATA_DIR, "runs", id)}`);
      if (state !== "completed") process.exitCode = 1;
      return;
    }
    await sleep(1000);
  }
}
async function main() {
  if (command === "obs-status") {
    console.log(JSON.stringify(await obsStatus(), null, 2));
    return;
  }
  if (["help", "--help", "-h"].includes(command)) {
    const cli = process.platform === "win32" ? "autorio.cmd" : "./autorio";
    const osName =
      process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
    console.log(
      `Autorio runs (${osName})\n\n  ${cli} start [smoke|automation|rocket] [--model NAME] [--agent opencode|codex|dsh] [--language NAME] [--thinking LEVEL] [--seconds N] [--construction-mode free|planned] [--manual] [--detach] [--terminal] [--watch] [--video|--no-video]\n  ${cli} benchmarks\n  ${cli} list\n  ${cli} show RUN_ID\n  ${cli} watch RUN_ID\n  ${cli} stop RUN_ID\n  ${cli} pause RUN_ID\n  ${cli} resume RUN_ID\n  ${cli} compare RUN_ID RUN_ID [...]\n  ${cli} obs-status\n  ${cli} shutdown\n\nStart opens graphical Factorio and runs an agent (OpenCode by default; --agent codex opts into Codex, --agent dsh runs the local DeepSeek Harness headless profile). Steam must be running and signed in.\nA standalone recording window opens for the run and closes two seconds after it ends.\nUse --terminal for the optional terminal viewer; --watch follows operator logs here. Ctrl-C while watching stops and saves the run.\n--thinking selects reasoning effort (default low; supported levels depend on model).\n--manual starts the game and telemetry without Codex for integration/debugging.\nshutdown stops any run and closes the manager. Equivalent npm entry: npm run run -- COMMAND`,
    );
    return;
  }
  if (command === "shutdown") {
    await api("/api/manager/stop", {});
    console.log("Manager shutdown requested; any active run will be stopped and saved.");
    return;
  }
  if (
    !["start", "benchmarks", "list", "show", "watch", "stop", "pause", "resume", "compare"].includes(command)
  )
    throw new Error(`Unknown command: ${command}`);
  await ensureManager();
  if (command === "start") {
    const run = await api<RunSummary>("/api/runs", {
      benchmark: args[0]?.startsWith("--") ? "smoke" : args[0] || "smoke",
      model: option("--model"),
      reasoning_effort: option("--thinking"),
      language: option("--language"),
      agent: args.includes("--manual") ? "manual" : option("--agent") || "opencode",
      capture_video: args.includes("--video") ? true : args.includes("--no-video") ? false : undefined,
      recording: !args.includes("--detach"),
      terminal: args.includes("--terminal") ? true : args.includes("--no-terminal") ? false : undefined,
      max_seconds: option("--seconds") === undefined ? undefined : Number(option("--seconds")),
      construction_mode: option("--construction-mode"),
    });
    console.log(
      `Run: ${run.name || run.id}\nID: ${run.id}\nAgent: ${run.model_label}\nRun details: ${base}/run.html?run=${encodeURIComponent(run.id)}`,
    );
    const recordingUrl = `${base}/recording.html?run=${encodeURIComponent(run.id)}`;
    if (run.agent !== "manual" && !run.terminal) {
      console.log(`Recording: ${recordingUrl}`);
    }
    if (args.includes("--watch") && !args.includes("--detach")) await watch(run.id);
  } else if (command === "resume") {
    if (!args[0]) throw new Error("Usage: ./autorio resume RUN_ID");
    const run = await api<RunSummary>(`/api/runs/${encodeURIComponent(args[0])}/resume`, {});
    console.log(
      `Resuming ${run.name || run.id} · segment ${run.segments.length}\n${base}/run.html?run=${encodeURIComponent(run.id)}`,
    );
  } else if (command === "benchmarks")
    console.table(
      (await api<{ benchmarks: BenchmarkSummary[] }>("/api/benchmarks")).benchmarks.map((benchmark) => ({
        id: benchmark.id,
        title: benchmark.title,
        limit_seconds: benchmark.max_seconds,
      })),
    );
  else if (command === "list")
    console.table(
      (await api<{ runs: RunSummary[] }>("/api/runs")).runs.map((run) => ({
        run: run.name || run.id,
        id: run.id,
        benchmark: run.benchmark.id,
        agent: run.agent,
        model: run.model_label,
        state: run.state,
        seconds: Math.round(run.elapsed_seconds),
      })),
    );
  else if (command === "show") console.log(JSON.stringify(await api(`/api/runs/${args[0]}`), null, 2));
  else if (command === "watch") await watch(args[0]);
  else if (command === "stop")
    console.log(JSON.stringify(await api(`/api/runs/${args[0]}/stop`, {}), null, 2));
  else if (command === "pause")
    console.log(JSON.stringify(await api(`/api/runs/${args[0]}/pause`, {}), null, 2));
  else if (command === "compare") {
    if (args.length < 2) throw new Error("compare needs at least two run IDs");
    const runs = await Promise.all(args.map((id) => api<RunSummary>(`/api/runs/${id}`)));
    if (
      new Set(runs.map((r) => `${r.hashes?.benchmark}:${r.hashes?.baseline_save}:${r.hashes?.client}`)).size >
      1
    ) {
      console.log(
        "These runs have different benchmark, starting-save, or Python-client hashes; comparisons are approximate.",
      );
    }
    console.table(
      runs.map((r) => ({
        run: r.name || r.id,
        model: r.model_label,
        state: r.state,
        seconds: Math.round(r.elapsed_seconds),
        ...Object.fromEntries(
          Object.entries(r.milestones).map(([id, milestone]) => [
            id,
            `${milestone.wall_seconds.toFixed(1)}s / ${milestone.game_ticks} ticks`,
          ]),
        ),
      })),
    );
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
