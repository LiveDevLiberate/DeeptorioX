// Pure helpers for the autorio cluster supervisor (scripts/cluster.mjs).
// Kept side-effect free so tests can cover instance planning, argument parsing,
// cluster metadata and run requests without launching games or managers.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const CLUSTER_VERSION = 1;

export const DEFAULT_OPTIONS = Object.freeze({
  instances: 2,
  port: 3000,
  rconPort: 27099,
  gamePort: 34197,
  dataDir: path.join(".autorio", "cluster"),
  recording: true,
});

const NUMERIC_OPTIONS = new Map([
  ["instances", "instances"],
  ["port", "port"],
  ["rcon-port", "rconPort"],
  ["game-port", "gamePort"],
  ["max-seconds", "maxSeconds"],
]);

const STRING_OPTIONS = new Map([
  ["data-dir", "dataDir"],
  ["save", "save"],
  ["benchmark", "benchmark"],
  ["model", "model"],
  ["agent", "agent"],
  ["language", "language"],
  ["instances-list", "instancesList"],
]);

const BOOLEAN_OPTIONS = new Map([
  ["json", "json"],
  ["recording", "recording"],
  ["no-recording", "noRecording"],
  ["help", "help"],
]);

function readOptionValue(name, inline, argv, index) {
  if (inline !== undefined) return { value: inline, nextIndex: index };
  if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
    throw new Error(`Option --${name} requires a value`);
  }
  return { value: argv[index + 1], nextIndex: index + 1 };
}

/** Parse cluster CLI arguments. Returns {command, options, positional}. */
export function parseArgs(argv = []) {
  const args = argv.slice();
  const command = args.length > 0 && !args[0].startsWith("-") ? args.shift() : "help";
  const options = { ...DEFAULT_OPTIONS };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const raw = token.slice(2);
    const eq = raw.indexOf("=");
    const name = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;
    if (BOOLEAN_OPTIONS.has(name)) {
      const key = BOOLEAN_OPTIONS.get(name);
      if (inline !== undefined && inline !== "true" && inline !== "false") {
        throw new Error(`Option --${name} expects true or false`);
      }
      const value = inline === undefined ? true : inline === "true";
      if (key === "noRecording") options.recording = !value;
      else options[key] = value;
      continue;
    }
    if (NUMERIC_OPTIONS.has(name)) {
      const { value, nextIndex } = readOptionValue(name, inline, args, i);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Option --${name} expects a positive integer`);
      }
      options[NUMERIC_OPTIONS.get(name)] = parsed;
      i = nextIndex;
      continue;
    }
    if (STRING_OPTIONS.has(name)) {
      const { value, nextIndex } = readOptionValue(name, inline, args, i);
      options[STRING_OPTIONS.get(name)] = value;
      i = nextIndex;
      continue;
    }
    throw new Error(`Unknown option --${name}`);
  }
  return { command, options, positional };
}

/**
 * Derive per-instance ports and data directories. Instances are 1-based in the
 * CLI and each one gets consecutive API, RCON and Factorio game-host ports.
 */
export function planInstances({ root, ...options } = {}) {
  const count = Number(options.instances ?? DEFAULT_OPTIONS.instances);
  const port = Number(options.port ?? DEFAULT_OPTIONS.port);
  const rconPort = Number(options.rconPort ?? DEFAULT_OPTIONS.rconPort);
  const gamePort = Number(options.gamePort ?? DEFAULT_OPTIONS.gamePort);
  const dataDir = String(options.dataDir ?? DEFAULT_OPTIONS.dataDir);
  if (!Number.isInteger(count) || count < 1) throw new Error("instances must be a positive integer");
  if (count > 16) throw new Error("At most 16 instances are supported");
  for (const [label, start] of [
    ["api port", port],
    ["rcon port", rconPort],
    ["game port", gamePort],
  ]) {
    if (!Number.isInteger(start) || start < 1) throw new Error(`${label} must be a positive integer`);
    if (start + count - 1 > 65535) throw new Error(`${label} range exceeds 65535`);
  }
  const baseDir = path.resolve(root || process.cwd(), dataDir);
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    apiPort: port + index,
    rconPort: rconPort + index,
    gamePort: gamePort + index,
    dataDir: path.join(baseDir, `instance-${index + 1}`),
    url: `http://127.0.0.1:${port + index}`,
  }));
}

/** Environment for one manager process; ports and data stay isolated. */
export function buildManagerEnv(baseEnv, instance) {
  return {
    ...baseEnv,
    AUTORIO_PORT: String(instance.apiPort),
    RCON_PORT: String(instance.rconPort),
    AUTORIO_GAME_PORT: String(instance.gamePort),
    AUTORIO_DATA_DIR: instance.dataDir,
  };
}

export function clusterFilePath(dataDir) {
  return path.join(path.resolve(dataDir), "cluster.json");
}

export function writeClusterInfo(dataDir, info) {
  const file = clusterFilePath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    version: CLUSTER_VERSION,
    updatedAt: new Date().toISOString(),
    ...info,
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

export function readClusterInfo(dataDir) {
  const file = clusterFilePath(dataDir);
  if (!fs.existsSync(file)) {
    throw new Error(`No cluster metadata at ${file}. Run "cluster start" first.`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Request body for POST /api/runs on a manager instance. */
export function buildRunRequest(options = {}) {
  const body = {};
  if (options.benchmark) body.benchmark = options.benchmark;
  if (options.model) body.model = options.model;
  if (options.agent) body.agent = options.agent;
  if (options.language) body.language = options.language;
  if (options.maxSeconds) body.max_seconds = options.maxSeconds;
  body.terminal = false;
  body.recording = options.recording !== false;
  body.capture_video = false;
  return body;
}

export function selectInstances(instances, selection) {
  const list = Array.isArray(instances) ? instances : [];
  if (!selection || selection === "all") return list.slice();
  const ids = String(selection)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => Number(value));
  if (ids.length === 0 || ids.some((id) => !Number.isInteger(id))) {
    throw new Error("--instances-list expects comma separated instance numbers");
  }
  return ids.map((id) => {
    const found = list.find((instance) => instance.id === id);
    if (!found) throw new Error(`Unknown instance ${id}`);
    return found;
  });
}

export async function probeInstance(url, { timeoutMs = 1500, fetchImpl = globalThis.fetch } = {}) {
  try {
    const response = await fetchImpl(`${url}/api/server/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, statusCode: response.status, body };
  } catch (error) {
    return { ok: false, statusCode: 0, body: null, error: error?.message || String(error) };
  }
}

export async function waitForInstance(url, { timeoutMs = 30_000, intervalMs = 300, fetchImpl } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probeInstance(url, { fetchImpl });
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${url}: ${last?.error || "not ready"}`);
}

/** Format instance rows as a compact fixed-width table for the terminal. */
export function formatInstanceTable(rows = []) {
  const header = ["#", "API", "RCON", "GAME", "PID", "MANAGER", "GAME STATE", "RUN"];
  const cells = rows.map((row) => [
    String(row.id),
    String(row.apiPort),
    String(row.rconPort),
    String(row.gamePort),
    row.pid ? String(row.pid) : "-",
    row.ok ? "up" : "down",
    row.running ? (row.rconConnected ? "running" : "starting") : "stopped",
    row.runId || "-",
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...cells.map((line) => line[column].length)),
  );
  const line = (values) => values.map((value, column) => value.padEnd(widths[column])).join("  ").trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...cells.map(line)].join("\n");
}

/** Kill a manager/process tree. Injectable for tests. */
export function killProcessTree(pid, { platform = process.platform, run = spawnSync } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (platform === "win32") {
    const result = run("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return result?.status === 0;
  }
  const result = run("kill", ["-TERM", String(pid)], { stdio: "ignore" });
  return result?.status === 0;
}
