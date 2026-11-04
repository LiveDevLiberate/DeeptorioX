import { createServer, IncomingMessage, ServerResponse } from "http";
import type { ChildProcess } from "node:child_process";
import { obsStatus } from "./obs.js";
import fsSync from "fs";
import { promises as fs } from "fs";
import path from "path";
import net from "net";
import { randomUUID } from "crypto";

import {
  ROOT,
  PORT,
  DATA_DIR,
  FACTORIO_BIN,
  SAVES_DIR,
  MANAGER_PROFILE,
  RCON_HOST,
  RCON_PORT,
  RCON_PASSWORD,
  factorioEnv,
  prepareProfile,
  profileArgs,
  createMap,
  factorioVersion,
  requireSteam,
} from "./runtime.js";
import { NativeController } from "./native-control.js";
import { ActionJobQueue, actionPaths, splitJobPayload, type JobAction } from "./action-jobs.js";
import { launchRocket } from "./rocket.js";
import { RunManager } from "./runs.js";
import {
  IS_WINDOWS,
  isProcessExecutable,
  isProcessRunning,
  killProcessTree,
  sampleProcessUsage,
  spawnExecutable,
} from "./platform.js";
import { visualObservation } from "./vision.js";
import { configureLogger, logger } from "./logger.js";
import { healthPayload, healthStatusCode } from "./health.js";
import {
  agentBuildDestinationCommand,
  agentChartedResourcesCommand,
  agentClearBuildFootprintCommand,
  agentCompactWorldCommand,
  agentConnectionsCommand,
  agentCraftCommand,
  agentEntityPrototypeCommand,
  agentExtractCommand,
  agentFactoryCommand,
  agentInsertCommand,
  agentLayoutCommand,
  agentMapCommand,
  agentNativeBuildCommand,
  agentObserveEntityCommand,
  agentPlayerCommand,
  agentRecipesCommand,
  agentResearchCommand,
  agentResearchStartCommand,
  agentRotateCommand,
  agentSetRecipeCommand,
  type BuildRequest,
} from "./command-builders.js";

fsSync.mkdirSync(DATA_DIR, { recursive: true });
configureLogger({ file: path.join(DATA_DIR, "manager.log"), level: process.env.AUTORIO_LOG_LEVEL });
const managerStartedAt = Date.now();
const PID_FILE = path.join(DATA_DIR, "factorio.pid");
const LOCK_FILE = path.join(DATA_DIR, "manager.pid");
if (fsSync.existsSync(LOCK_FILE)) {
  const owner = Number(fsSync.readFileSync(LOCK_FILE, "utf8"));
  if (Number.isInteger(owner) && owner > 0 && isPidRunning(owner))
    throw new Error(`Autorio manager already running (PID ${owner}).`);
  fsSync.unlinkSync(LOCK_FILE);
}
fsSync.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
process.on("exit", () => {
  try {
    if (fsSync.readFileSync(LOCK_FILE, "utf8") === String(process.pid)) fsSync.unlinkSync(LOCK_FILE);
  } catch {
    /* already removed */
  }
});
const LOG_BUFFER_LIMIT = 500;
const USAGE_SAMPLE_MS = 2000;
const RCON_CHECK_MS = 1000;
const INTERNAL_JOB_KEY = randomUUID();
let gameLog: fsSync.WriteStream | null = null;
let activeSavePath: string | null = null;
let activeProfile: string | null = null;

const RCON_AUTH_ID = 0x1234;

const AGENT_DEFAULT_RADIUS = 12;
const AGENT_MAX_INVENTORY_SLOTS = 200;
const AGENT_MAX_EQUIPMENT_SLOTS = 50;
const AGENT_MAX_RECIPES = 300;
const AGENT_MAX_RESEARCH = 200;
const AGENT_MAX_ACTIONS = 50;
const API_SCHEMA_VERSION = 2;

function parseRconJson<T>(response: string, errorMessage: string): T {
  try {
    return JSON.parse(response) as T;
  } catch {
    throw new Error(errorMessage);
  }
}

function arrayOrEmpty(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function normalizeWorldData(data: any) {
  if (!data || typeof data !== "object") return data;
  data.entities = arrayOrEmpty(data.entities);
  if (data.terrain && typeof data.terrain === "object") {
    data.terrain.rows = arrayOrEmpty(data.terrain.rows);
    for (const row of data.terrain.rows) row.runs = arrayOrEmpty(row?.runs);
  }
  return data;
}

function normalizeResearchData(data: any) {
  if (!data || typeof data !== "object") return data;
  const normalizeTechnology = (technology: any) => {
    if (!technology || typeof technology !== "object") return;
    technology.ingredients = arrayOrEmpty(technology.ingredients);
    technology.prerequisites = arrayOrEmpty(technology.prerequisites);
    technology.missing_prerequisites = arrayOrEmpty(technology.missing_prerequisites);
  };
  normalizeTechnology(data.current);
  for (const key of ["queue", "available", "upgrades", "triggers", "locked", "completed"]) {
    data[key] = arrayOrEmpty(data[key]);
    for (const technology of data[key]) normalizeTechnology(technology);
  }
  return data;
}

function normalizeConnectionsData(data: any) {
  if (!data || typeof data !== "object") return data;
  data.counts = data.counts && typeof data.counts === "object" ? data.counts : {};
  data.inserters = arrayOrEmpty(data.inserters);
  data.belts = arrayOrEmpty(data.belts);
  data.machines = arrayOrEmpty(data.machines);
  data.issues = arrayOrEmpty(data.issues);
  return data;
}

function normalizeLayoutData(data: any) {
  if (!data || typeof data !== "object") return data;
  data.rows = arrayOrEmpty(data.rows);
  data.built_rows = arrayOrEmpty(data.built_rows);
  data.resource_rows = arrayOrEmpty(data.resource_rows);
  data.entities = arrayOrEmpty(data.entities);
  data.overlaps = arrayOrEmpty(data.overlaps);
  data.legend = data.legend && typeof data.legend === "object" ? data.legend : {};
  return data;
}

function normalizeFactoryData(data: any) {
  if (!data || typeof data !== "object") return data;
  data.counts = data.counts && typeof data.counts === "object" ? data.counts : {};
  for (const value of Object.values(data.counts as Record<string, any>)) {
    if (value && typeof value === "object")
      value.statuses = value.statuses && typeof value.statuses === "object" ? value.statuses : {};
  }
  data.problems = data.problems && typeof data.problems === "object" ? data.problems : {};
  for (const key of [
    "no_fuel",
    "no_power",
    "no_input_fluid",
    "no_minable_resources",
    "waiting_for_space_in_destination",
    "no_ingredients",
    "missing_science_packs",
  ]) {
    data.problems[key] = arrayOrEmpty(data.problems[key]);
  }
  data.totals = data.totals && typeof data.totals === "object" ? data.totals : {};
  data.alerts = arrayOrEmpty(data.alerts);
  return data;
}

function normalizeEntityData(data: any) {
  if (!data || typeof data !== "object") return data;
  data.results = arrayOrEmpty(data.results);
  for (const entity of data.results) {
    entity.inventories = arrayOrEmpty(entity?.inventories);
    entity.fluid_boxes = arrayOrEmpty(entity?.fluid_boxes);
    for (const inventory of entity.inventories) {
      inventory.purposes = arrayOrEmpty(inventory?.purposes);
      inventory.items = arrayOrEmpty(inventory?.items);
    }
    for (const fluidBox of entity.fluid_boxes) {
      fluidBox.connections = arrayOrEmpty(fluidBox?.connections);
    }
  }
  return data;
}

function normalizePrototypeData(data: any) {
  if (!data || typeof data !== "object") return data;
  data.placeable_by = arrayOrEmpty(data.placeable_by);
  data.fluid_boxes = arrayOrEmpty(data.fluid_boxes);
  data.fuel_categories = arrayOrEmpty(data.fuel_categories);
  for (const fluidBox of data.fluid_boxes) {
    fluidBox.pipe_connections = arrayOrEmpty(fluidBox?.pipe_connections);
    for (const connection of fluidBox.pipe_connections) {
      connection.connection_category = arrayOrEmpty(connection?.connection_category);
      connection.positions = arrayOrEmpty(connection?.positions);
    }
  }
  return data;
}

async function readPidFile(): Promise<number | null> {
  try {
    const text = fsSync.readFileSync(PID_FILE, "utf8").trim();
    const pid = Number(text);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (!isProcessRunning(pid)) return null;
    // The pid file can survive a crash; only adopt a process running this game.
    return (await isProcessExecutable(pid, FACTORIO_BIN)) ? pid : null;
  } catch {
    return null;
  }
}

function writePidFile(pid: number) {
  fsSync.writeFileSync(PID_FILE, String(pid));
}

function clearPidFile() {
  try {
    fsSync.unlinkSync(PID_FILE);
  } catch {
    // ignore
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err?.code === "ESRCH") return false;
    return true;
  }
}

type LastExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: string;
};

type LogLine = {
  ts: string;
  stream: "stdout" | "stderr";
  line: string;
};

type UsageStats = {
  cpuPercent: number | null;
  rssBytes: number | null;
};

type RconStatus = {
  configured: boolean;
  connected: boolean;
  host: string | null;
  port: number | null;
  note: string | null;
  lastError: string | null;
};

type RconPending = {
  resolve: (body: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

type RconState = {
  socket: net.Socket | null;
  connected: boolean;
  lastError: string | null;
  lastAttemptAt: number | null;
  buffer: Buffer;
  pending: Map<number, RconPending>;
  nextId: number;
};

type ServerState = {
  proc: ChildProcess | null;
  procPid: number | null;
  save: string | null;
  startedAt: number | null;
  lastExit: LastExit | null;
  logs: LogLine[];
  logTail: { stdout: string; stderr: string };
  usage: UsageStats;
  rcon: RconState;
};

const state: ServerState = {
  proc: null,
  procPid: null,
  save: null,
  startedAt: null,
  lastExit: null,
  logs: [],
  logTail: { stdout: "", stderr: "" },
  usage: { cpuPercent: null, rssBytes: null },
  rcon: {
    socket: null,
    connected: false,
    lastError: null,
    lastAttemptAt: null,
    buffer: Buffer.alloc(0),
    pending: new Map(),
    nextId: 0x2000,
  },
};

let saveCreationInProgress = false;

function getRunningPid(): number | null {
  if (state.proc && !state.proc.killed && state.proc.pid) {
    return state.proc.pid;
  }
  if (state.procPid && isPidRunning(state.procPid)) {
    return state.procPid;
  }
  if (state.procPid) {
    state.procPid = null;
    clearPidFile();
  }
  return null;
}

const existingPid = await readPidFile();
if (existingPid && isPidRunning(existingPid)) {
  state.procPid = existingPid;
} else if (existingPid) {
  clearPidFile();
}

function json(res: ServerResponse, status: number, data: unknown) {
  const payload =
    data && typeof data === "object" && !Array.isArray(data)
      ? { schema_version: API_SCHEMA_VERSION, ...data }
      : { schema_version: API_SCHEMA_VERSION, data };
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) {
      throw new Error("Request body too large");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

async function listSaves(): Promise<string[]> {
  const entries = await fs.readdir(SAVES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".zip"))
    .map((e) => e.name)
    .sort();
}

function normalizeSaveFilename(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Missing save name");
  }
  const requested = value.trim();
  const base = requested.toLowerCase().endsWith(".zip") ? requested.slice(0, -4) : requested;
  if (!base || base === "." || base === ".." || base.length > 200 || /[\\/\0\r\n]/.test(base)) {
    throw new Error("Invalid save name");
  }
  return `${base}.zip`;
}

async function createSave(save: string): Promise<void> {
  const savePath = path.join(SAVES_DIR, save);
  if (fsSync.existsSync(savePath)) throw new Error("Save already exists");
  await createMap(savePath, MANAGER_PROFILE, { seed: 424242, peaceful_mode: true });
}

function rconConfigured(): boolean {
  return Boolean(RCON_HOST && RCON_PORT && RCON_PASSWORD);
}

function rconStatus(): RconStatus {
  const configured = rconConfigured();
  if (!configured) {
    return {
      configured: false,
      connected: false,
      host: RCON_HOST || null,
      port: RCON_PORT,
      note: "RCON not configured",
      lastError: null,
    };
  }
  return {
    configured: true,
    connected: state.rcon.connected,
    host: RCON_HOST,
    port: RCON_PORT,
    note: state.rcon.connected ? null : "RCON not connected",
    lastError: state.rcon.lastError,
  };
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

type EntityTarget = { x: number; y: number; kind?: "resource" | "entity"; name?: string };

async function moveNearEntity(target: EntityTarget) {
  return nativeAction({ kind: "approach", target: { ...target, kind: target.kind || "entity" } });
}

function movePlayerTo(x: number, y: number, timeoutMs?: number) {
  return nativeAction({ kind: "move", x, y, ...(timeoutMs ? { timeout_ms: timeoutMs } : {}) });
}

function statusPayload() {
  const pid = getRunningPid();
  const running = Boolean(pid);
  const uptimeSec = running && state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
  return {
    running,
    pid: running ? pid : null,
    save: state.save,
    startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
    uptimeSec,
    lastExit: state.lastExit,
    usage: state.usage,
    rcon: rconStatus(),
  };
}

function pushLog(stream: "stdout" | "stderr", chunk: Buffer) {
  const text = chunk.toString("utf8");
  const tail = state.logTail[stream] + text;
  const lines = tail.split(/\r?\n/);
  state.logTail[stream] = lines.pop() || "";

  const now = new Date().toISOString();
  for (const line of lines) {
    if (!line) continue;
    state.logs.push({ ts: now, stream, line });
  }

  if (state.logs.length > LOG_BUFFER_LIMIT) {
    state.logs.splice(0, state.logs.length - LOG_BUFFER_LIMIT);
  }
}

async function sampleUsage() {
  const pid = getRunningPid();
  if (!pid) {
    state.usage = { cpuPercent: null, rssBytes: null };
    return;
  }
  state.usage = await sampleProcessUsage(pid);
}

function encodeRconPacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, "utf8");
  const size = 4 + 4 + bodyBuf.length + 2;
  const buf = Buffer.alloc(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  buf.writeInt16LE(0, 12 + bodyBuf.length);
  return buf;
}

type RconPacket = { id: number; type: number; body: string };

function decodeRconPackets(buffer: Buffer): {
  packets: RconPacket[];
  rest: Buffer;
} {
  const packets: RconPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const size = buffer.readInt32LE(offset);
    if (offset + 4 + size > buffer.length) break;
    const id = buffer.readInt32LE(offset + 4);
    const type = buffer.readInt32LE(offset + 8);
    const bodyStart = offset + 12;
    const bodyEnd = offset + 4 + size - 2;
    const body = buffer.slice(bodyStart, bodyEnd).toString("utf8");
    packets.push({ id, type, body });
    offset += 4 + size;
  }
  return { packets, rest: buffer.slice(offset) };
}

function handleRconPacket(pkt: RconPacket) {
  if (pkt.id === -1 && state.rcon.pending.has(RCON_AUTH_ID)) {
    const pending = state.rcon.pending.get(RCON_AUTH_ID)!;
    clearTimeout(pending.timer);
    state.rcon.pending.delete(RCON_AUTH_ID);
    pending.reject(new Error("RCON auth failed"));
    return;
  }

  const pending = state.rcon.pending.get(pkt.id);
  if (pending) {
    clearTimeout(pending.timer);
    state.rcon.pending.delete(pkt.id);
    pending.resolve(pkt.body);
  }
}

function attachRconSocket(socket: net.Socket) {
  state.rcon.buffer = Buffer.alloc(0);

  socket.on("data", (data) => {
    state.rcon.buffer = Buffer.concat([state.rcon.buffer, data]);
    const decoded = decodeRconPackets(state.rcon.buffer);
    state.rcon.buffer = decoded.rest;
    for (const pkt of decoded.packets) handleRconPacket(pkt);
  });

  socket.on("close", () => {
    if (state.rcon.socket === socket) {
      state.rcon.socket = null;
      state.rcon.connected = false;
    }
    for (const pending of state.rcon.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("RCON connection closed"));
    }
    state.rcon.pending.clear();
  });
}

function rconSendInternal(id: number, type: number, body: string, timeoutMs: number) {
  if (!state.rcon.socket) throw new Error("RCON not connected");
  const socket = state.rcon.socket;

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.rcon.pending.delete(id);
      reject(new Error("RCON request timeout"));
    }, timeoutMs);

    state.rcon.pending.set(id, { resolve, reject, timer });
    socket.write(encodeRconPacket(id, type, body));
  });
}

async function connectRcon(): Promise<boolean> {
  if (!rconConfigured()) return false;
  if (!RCON_PORT) return false;

  const host = RCON_HOST;
  const port = RCON_PORT;
  state.rcon.lastAttemptAt = Date.now();
  state.rcon.lastError = null;

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let done = false;
    const timeout = setTimeout(() => {
      if (done) return;
      finish(false, "RCON auth timeout");
    }, 3000);

    const finish = (ok: boolean, err?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (!ok && err) state.rcon.lastError = err;
      if (!ok) {
        if (state.rcon.socket === socket) {
          state.rcon.socket = null;
          state.rcon.connected = false;
        }
        socket.destroy();
      }
      resolve(ok);
    };

    socket.on("connect", async () => {
      attachRconSocket(socket);
      state.rcon.socket = socket;
      state.rcon.connected = false;
      try {
        await rconSendInternal(RCON_AUTH_ID, 3, RCON_PASSWORD, 3000);
        state.rcon.connected = true;
        socket.setTimeout(0);
        finish(true);
      } catch (err: any) {
        finish(false, err?.message || "RCON auth failed");
      }
    });

    socket.on("error", (err) => finish(false, err.message));
  });
}

function disconnectRcon() {
  if (state.rcon.socket) {
    state.rcon.socket.destroy();
  }
  state.rcon.socket = null;
  state.rcon.connected = false;
}

let connectingRcon: Promise<void> | undefined;
async function ensureRconConnection() {
  if (!rconConfigured()) return;
  if (!getRunningPid()) {
    disconnectRcon();
    return;
  }
  if (state.rcon.connected) return;
  if (!connectingRcon)
    connectingRcon = connectRcon()
      .then(() => {})
      .finally(() => {
        connectingRcon = undefined;
      });
  await connectingRcon;
}

async function rconCommand(command: string, timeoutMs = 3000): Promise<string> {
  if (!state.rcon.connected) throw new Error("RCON not connected");
  const id = state.rcon.nextId++;
  return rconSendInternal(id, 2, command, timeoutMs);
}

const nativeController = new NativeController(rconCommand);
async function stopNativeController() {
  if (state.rcon.connected) await nativeController.stop().catch(() => {});
}
// Placement work is retried and moves only short distances, so a stuck native
// action is aborted quickly instead of holding the whole job for ten minutes.
const ACTION_TIMEOUT_MS = 120_000;
const BUILD_MOVE_TIMEOUT_MS = 120_000;
function nativeAction(payload: Record<string, unknown>) {
  const job = actionJobs.currentJob;
  const { timeout_ms, ...action } = payload as Record<string, any>;
  const timeout = typeof timeout_ms === "number" && timeout_ms > 0 ? timeout_ms : 600_000;
  return nativeController.run(action, () => actionJobs.isCancelled(job), timeout);
}

const actionJobs = new ActionJobQueue({
  port: PORT,
  internalKey: INTERNAL_JOB_KEY,
  nativeStop: stopNativeController,
  isCancelled: () => runManager.busy && !runManager.acceptingActions,
  onRecord: (event, record) => runManager.recordJob(event, record),
});

setInterval(() => {
  sampleUsage().catch(() => {});
}, USAGE_SAMPLE_MS);

setInterval(() => {
  ensureRconConnection().catch(() => {});
}, RCON_CHECK_MS);

let launchingGame = false;
async function startGame(savePath: string, profile: string, logFile?: string) {
  if (launchingGame || getRunningPid()) throw new Error("Game already running or launching");
  launchingGame = true;
  try {
    await factorioVersion();
    await requireSteam();
    await prepareProfile(profile);
    // Refuse to attach to a different game's RCON port.
    await new Promise<void>((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", () => reject(new Error(`RCON port ${RCON_PORT} is already in use`)));
      probe.listen(RCON_PORT, RCON_HOST, () => probe.close(() => resolve()));
    });
    disconnectRcon();
    state.logs = [];
    state.logTail = { stdout: "", stderr: "" };
    gameLog = logFile ? fsSync.createWriteStream(logFile, { flags: "a" }) : null;
    const args = [
      ...profileArgs(profile),
      "--host",
      savePath,
      "--server-settings",
      path.join(profile, "server-settings.json"),
      "--bind",
      "127.0.0.1:0",
      "--rcon-bind",
      `127.0.0.1:${RCON_PORT}`,
      "--rcon-password",
      RCON_PASSWORD,
      "--window-size",
      process.env.FACTORIO_WINDOW_SIZE || "1000x760",
    ];
    if (process.env.FACTORIO_DISABLE_AUDIO === "1") args.push("--disable-audio");
    const proc = spawnExecutable(FACTORIO_BIN, args, {
      cwd: ROOT,
      env: factorioEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    state.proc = proc;
    state.procPid = proc.pid ?? null;
    state.save = path.basename(savePath);
    state.startedAt = Date.now();
    state.lastExit = null;
    activeSavePath = savePath;
    activeProfile = profile;
    state.usage = { cpuPercent: null, rssBytes: null };
    for (const stream of ["stdout", "stderr"] as const)
      proc[stream]?.on("data", (chunk: Buffer) => {
        pushLog(stream, chunk);
        gameLog?.write(chunk);
      });
    proc.once("exit", (code, signal) => {
      state.lastExit = { code, signal, at: new Date().toISOString() };
      state.proc = null;
      state.procPid = null;
      state.save = null;
      state.startedAt = null;
      activeSavePath = null;
      activeProfile = null;
      state.usage = { cpuPercent: null, rssBytes: null };
      clearPidFile();
      disconnectRcon();
      gameLog?.end();
      gameLog = null;
    });
    await new Promise<void>((resolve, reject) => {
      proc.once("spawn", resolve);
      proc.once("error", reject);
    });
    if (proc.pid) writePidFile(proc.pid);
  } finally {
    launchingGame = false;
  }
}

async function stopGame() {
  const pid = getRunningPid();
  if (!pid) return;
  if (state.rcon.connected) await nativeController.stop().catch(() => {});
  if (IS_WINDOWS) {
    // Factorio only writes save state through RCON here, so the tree can be terminated.
    killProcessTree(pid, true);
    const until = Date.now() + 10_000;
    while (getRunningPid() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
  } else {
    process.kill(pid, "SIGTERM");
    const until = Date.now() + 10_000;
    while (getRunningPid() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
    if (getRunningPid()) {
      process.kill(pid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (state.procPid === pid && !isPidRunning(pid)) {
    state.procPid = null;
    clearPidFile();
  }
}

const runManager = new RunManager({
  running: () => Boolean(getRunningPid()),

  start: startGame,
  stop: stopGame,
  command: rconCommand,
  connect: ensureRconConnection,
  cancelJobs: async () => {
    actionJobs.cancelAll();
    await stopNativeController();
    const drained = await Promise.race([
      actionJobs.drain().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    if (!drained) {
      await stopGame();
      await actionJobs.drain();
    }
    actionJobs.clear();
  },
});

const TERMINAL_RUN_STATES = new Set(["completed", "failed", "stopped", "timed_out", "interrupted", "paused"]);
function activeRunSummary() {
  const run = runManager.list().find((entry) => !TERMINAL_RUN_STATES.has(entry.state));
  return run ? { id: run.id, state: run.state, agent: run.agent } : null;
}

async function handleApi(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/manager/stop" && req.method === "POST") {
    json(res, 202, { shutting_down: true });
    setTimeout(() => {
      void shutdown("SIGTERM");
    }, 100);
    return;
  }

  if (url.pathname === "/api/obs/status" && req.method === "GET") return json(res, 200, await obsStatus());
  if (url.pathname === "/api/benchmarks" && req.method === "GET")
    return json(res, 200, { benchmarks: runManager.benchmarks });
  if (url.pathname === "/api/runs" && req.method === "GET")
    return json(res, 200, { runs: runManager.list() });
  if (url.pathname === "/api/runs" && req.method === "POST") {
    try {
      return json(res, 202, runManager.start(await readJson(req)));
    } catch (error: any) {
      return json(res, 400, { error: error.message });
    }
  }
  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(stop|resume|pause|log|video))?$/);
  if (runMatch) {
    const run = runManager.get(runMatch[1]);
    if (!run) return json(res, 404, { error: "Run not found" });
    if (!runMatch[2] && req.method === "GET") return json(res, 200, run);
    if (runMatch[2] === "video" && req.method === "GET") {
      const file = runManager.videoFile(
        run.id,
        url.searchParams.has("segment") ? Number(url.searchParams.get("segment")) : undefined,
      );
      if (!file || !fsSync.existsSync(file)) return json(res, 404, { error: "Timelapse is not ready" });
      const size = fsSync.statSync(file).size,
        range = req.headers.range;
      const match = range?.match(/^bytes=(\d+)-(\d*)$/);
      if (range && !match) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        return res.end();
      }
      const start = match ? Number(match[1]) : 0,
        end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size || end < start) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        return res.end();
      }
      res.writeHead(match ? 206 : 200, {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      });
      const stream = fsSync.createReadStream(file, { start, end });
      stream.on("error", () => res.destroy());
      res.on("close", () => stream.destroy());
      return stream.pipe(res);
    }
    if (runMatch[2] === "log" && req.method === "GET") {
      const offset = Number(url.searchParams.get("offset") || 0);
      return json(
        res,
        200,
        runManager.log(
          run.id,
          Number.isFinite(offset) ? Math.floor(offset) : 0,
          url.searchParams.get("source") === "telemetry"
            ? "telemetry"
            : url.searchParams.get("source") === "events"
              ? "events"
              : url.searchParams.get("source") === "codex",
        ),
      );
    }
    if (runMatch[2] === "resume" && req.method === "POST") {
      try {
        return json(res, 202, runManager.resume(run.id));
      } catch (error: any) {
        return json(res, 409, { error: error.message });
      }
    }
    if (runMatch[2] === "pause" && req.method === "POST") {
      try {
        await runManager.pause();
        return json(res, 200, runManager.get(run.id));
      } catch (error: any) {
        return json(res, 409, { error: error.message });
      }
    }
    if (runMatch[2] === "stop" && req.method === "POST") {
      if (["preparing", "launching", "running", "saving"].includes(run.state)) {
        try {
          await runManager.stop();
        } catch (error: any) {
          return json(res, 409, { error: error.message });
        }
      }
      return json(res, 200, runManager.get(run.id));
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/jobs") {
    if (runManager.busy && !runManager.acceptingActions)
      return json(res, 409, { error: "Run is not accepting actions" });
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
    if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
    const action = body?.action as JobAction;
    if (!action || !(action in actionPaths)) {
      return json(res, 400, { error: "Unknown job action", allowed_actions: Object.keys(actionPaths) });
    }
    if (splitJobPayload(action, body?.payload).length === 0) {
      return json(res, 400, { error: "Action payload contains no work" });
    }
    const keyHeader = req.headers["idempotency-key"];
    const idempotencyKey =
      (typeof keyHeader === "string" ? keyHeader : null) ??
      (typeof body?.idempotency_key === "string" ? body.idempotency_key : null);
    const job = actionJobs.submit(action, body?.payload, idempotencyKey);
    return json(res, 202, actionJobs.publicJob(job.id));
  }

  const jobMatch = url.pathname.match(/^\/api\/agent\/jobs\/([^/]+)$/);
  if (jobMatch && req.method === "GET") {
    const job = actionJobs.publicJob(jobMatch[1]);
    if (!job) return json(res, 404, { error: "Job not found" });
    return json(res, 200, job);
  }
  const cancelJobMatch = url.pathname.match(/^\/api\/agent\/jobs\/([^/]+)\/cancel$/);
  if (cancelJobMatch && req.method === "POST") {
    const job = await actionJobs.cancel(cancelJobMatch[1]);
    if (!job) return json(res, 404, { error: "Job not found" });
    return json(res, 202, actionJobs.publicJob(job.id));
  }

  if (url.pathname.startsWith("/api/agent/act/") && req.headers["x-autorio-internal"] !== INTERNAL_JOB_KEY) {
    return json(res, 409, {
      error: "Actions must be submitted through POST /api/agent/jobs",
    });
  }

  if (url.pathname.startsWith("/api/agent/act/") && actionJobs.isCancelled()) {
    return json(res, 409, { error: "cancelled" });
  }

  if (req.method === "GET" && url.pathname === "/api/saves") {
    try {
      const saves = await listSaves();
      return json(res, 200, { saves });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "Failed to list saves" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/saves") {
    if (saveCreationInProgress) {
      return json(res, 409, { error: "A save is already being created" });
    }
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }

    let save: string;
    try {
      save = normalizeSaveFilename(body?.name);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid save name" });
    }

    saveCreationInProgress = true;
    try {
      await createSave(save);
      return json(res, 201, { ok: true, save });
    } catch (err: any) {
      const message = err?.message || "Failed to create save";
      const status = message === "Save already exists" ? 409 : 500;
      return json(res, status, { error: message });
    } finally {
      saveCreationInProgress = false;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/server/status") {
    return json(res, 200, statusPayload());
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    const payload = healthPayload({
      startedAt: managerStartedAt,
      game: () => ({ running: Boolean(getRunningPid()), rcon: state.rcon.connected }),
      activeRun: activeRunSummary,
      versions: { node: process.version, api_schema: API_SCHEMA_VERSION },
      schemaVersion: API_SCHEMA_VERSION,
    });
    return json(res, healthStatusCode(payload), payload);
  }

  if (req.method === "GET" && url.pathname === "/api/server/logs") {
    const limitRaw = url.searchParams.get("limit") || "200";
    const limit = Math.max(1, Math.min(1000, Number(limitRaw) || 200));
    const lines = state.logs.slice(-limit);
    return json(res, 200, { lines });
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/visual") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    try {
      return json(
        res,
        200,
        await visualObservation(typeof body?.title === "string" ? { title: body.title } : {}),
      );
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "Visual capture failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/world") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const window = body?.window || {};
    const include: string[] = Array.isArray(body?.include) ? body.include : ["tiles", "entities"];
    const includeTiles = include.includes("terrain");
    const includeEntities = include.includes("entities");
    const radius = clampInt(window.radius, AGENT_DEFAULT_RADIUS, 1, 200);
    const x = clampInt(window.x, 0, -1000000, 1000000);
    const y = clampInt(window.y, 0, -1000000, 1000000);
    try {
      const response = await rconCommand(
        agentCompactWorldCommand({
          x,
          y,
          radius,
          includeTiles,
          includeEntities,
        }),
      );
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      data = normalizeWorldData(data);
      const counts = data?.counts || {};
      const truncated =
        (includeTiles && counts.tiles_included < counts.tiles_total) ||
        (includeEntities && counts.entities_included < counts.entities_total);
      return json(res, 200, {
        ok: true,
        data,
        truncated,
      });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/map") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
    if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
    const window = body?.window || {};
    const x = clampInt(window.x, 0, -1000000, 1000000);
    const y = clampInt(window.y, 0, -1000000, 1000000);
    const radius = clampInt(window.radius, 48, 1, 96);
    try {
      const response = await rconCommand(agentMapCommand({ x, y, radius }));
      return json(res, 200, {
        ok: true,
        data: parseRconJson(response, "RCON map returned invalid JSON"),
      });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/player") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const limits = body?.limits || {};
    const inventoryLimit = clampInt(
      limits.inventory_slots,
      AGENT_MAX_INVENTORY_SLOTS,
      1,
      AGENT_MAX_INVENTORY_SLOTS,
    );
    const equipmentLimit = clampInt(
      limits.equipment_slots,
      AGENT_MAX_EQUIPMENT_SLOTS,
      1,
      AGENT_MAX_EQUIPMENT_SLOTS,
    );
    try {
      const response = await rconCommand(agentPlayerCommand({ inventoryLimit, equipmentLimit }));
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      const counts = data?.counts || {};
      const truncated =
        counts.inventory_included < counts.inventory_total ||
        counts.equipment_included < counts.equipment_total;
      return json(res, 200, { ok: true, data, truncated });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/research") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const limits = body?.limits || {};
    const availableLimit = clampInt(limits.available, 50, 0, AGENT_MAX_RESEARCH);
    const lockedLimit = clampInt(limits.locked, 50, 0, AGENT_MAX_RESEARCH);
    const completedLimit = clampInt(limits.completed, 50, 0, AGENT_MAX_RESEARCH);
    try {
      const response = await rconCommand(
        agentResearchCommand({ availableLimit, lockedLimit, completedLimit }),
      );
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      data = normalizeResearchData(data);
      const counts = data?.counts || {};
      const truncated = {
        available: counts.available_included < counts.available_total,
        locked: counts.locked_included < counts.locked_total,
        completed: counts.completed_included < counts.completed_total,
      };
      return json(res, 200, { ok: true, data, truncated });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/recipes") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const limits = body?.limits || {};
    const limit = clampInt(limits.recipes, AGENT_MAX_RECIPES, 1, AGENT_MAX_RECIPES);
    const filters = body?.filters || {};
    const unlockedOnly = Boolean(filters.unlocked);
    try {
      const response = await rconCommand(agentRecipesCommand({ limit, unlockedOnly }));
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      const counts = data?.counts || {};
      const truncated = counts.included < counts.total;
      return json(res, 200, { ok: true, data, truncated });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/build") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const entities: any[] = Array.isArray(body?.entities) ? body.entities : [];
    const limits = body?.limits || {};
    const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
    const trimmed = entities
      .slice(0, max)
      .filter(
        (e) => e?.name && Number.isFinite(Number(e?.anchor?.x)) && Number.isFinite(Number(e?.anchor?.y)),
      ) as BuildRequest[];
    try {
      const results: any[] = [];
      for (const entity of trimmed) {
        // Clear obstacles from the current position first: walking the
        // character through a forest to a staging tile is much slower than
        // mining the trees that are already within reach.
        const placement = parseRconJson<any>(
          await rconCommand(agentBuildDestinationCommand(entity, false)),
          "RCON build destination returned invalid JSON",
        );
        if (!placement?.ok) {
          results.push({
            ok: false,
            name: entity.name,
            requested_anchor: entity.anchor,
            error: placement?.error || "no_reachable_staging_position",
          });
          continue;
        }
        const movement = await movePlayerTo(
          Number(placement.position.x),
          Number(placement.position.y),
          BUILD_MOVE_TIMEOUT_MS,
        );
        if (!movement.ok) {
          results.push({
            ok: false,
            name: entity.name,
            requested_anchor: entity.anchor,
            error: movement.error || "movement_failed",
            movement: movement.movement,
          });
          continue;
        }
        let usedMovement = movement.movement;
        let clearing: any = null;
        const clearFootprint = async (acc: any) => {
          // Mining a tree leaves a stump that can still block placement, so
          // re-scan a few times until the footprint stops changing.
          for (let pass = 0; pass < 4; pass++) {
            const data = parseRconJson<any>(
              await rconCommand(agentClearBuildFootprintCommand(entity)),
              "RCON build clearing returned invalid JSON",
            );
            if (!data) break;
            acc.passes++;
            const cleared = Array.isArray(data.cleared) ? data.cleared : [];
            const pending = Array.isArray(data.pending) ? data.pending : [];
            acc.cleared.push(...cleared);
            acc.skipped = Array.isArray(data.skipped) ? data.skipped : [];
            let minedPending = 0;
            for (const target of pending.slice(0, 8)) {
              const mined = await nativeAction({
                kind: "mine",
                target: {
                  x: Number(target.x),
                  y: Number(target.y),
                  kind: "entity",
                  name: target.name,
                },
                timeout_ms: ACTION_TIMEOUT_MS,
              });
              if (mined?.ok) {
                acc.cleared.push({ name: target.name, type: target.type });
                minedPending++;
              } else {
                acc.skipped.push({
                  name: target.name,
                  type: target.type,
                  reason: mined?.error || "mine_failed",
                });
              }
            }
            acc.pending_remaining = Math.max(0, pending.length - minedPending);
            if (cleared.length === 0 && minedPending === 0 && pending.length === 0) break;
            if (cleared.length === 0 && minedPending === 0 && pending.length > 0) {
              // Everything left is out of mining reach: step to a staging tile
              // once and re-scan instead of chasing single trees.
              const staging = parseRconJson<any>(
                await rconCommand(agentBuildDestinationCommand(entity, true)),
                "RCON build staging destination returned invalid JSON",
              );
              if (!staging?.ok) break;
              const walked = await movePlayerTo(
                Number(staging.position.x),
                Number(staging.position.y),
                BUILD_MOVE_TIMEOUT_MS,
              );
              if (!walked.ok) break;
              usedMovement = walked.movement;
            }
          }
          acc.ok = acc.skipped.length === 0 && (acc.pending_remaining ?? 0) === 0;
        };
        if (body?.clear_obstacles !== false) {
          clearing = { ok: true, cleared: [], skipped: [], passes: 0, pending_remaining: 0 };
          await clearFootprint(clearing);
        }
        let response = await rconCommand(agentNativeBuildCommand(entity));
        let result = parseRconJson<any>(response, "RCON build returned invalid JSON");
        // A player standing on the new building's tiles also blocks placement:
        // step to a staging position, clear the opened footprint and retry.
        if (!result?.ok && result?.error === "cannot_build") {
          const retryDestination = parseRconJson<any>(
            await rconCommand(agentBuildDestinationCommand(entity, true)),
            "RCON build retry destination returned invalid JSON",
          );
          if (retryDestination?.ok) {
            const retryMovement = await movePlayerTo(
              Number(retryDestination.position.x),
              Number(retryDestination.position.y),
              BUILD_MOVE_TIMEOUT_MS,
            );
            if (retryMovement.ok) {
              usedMovement = retryMovement.movement;
              if (clearing) await clearFootprint(clearing);
              response = await rconCommand(agentNativeBuildCommand(entity));
              result = parseRconJson<any>(response, "RCON build retry returned invalid JSON");
            }
          }
        }
        results.push({ ...result, movement: usedMovement, ...(clearing ? { clearing } : {}) });
      }
      return json(res, 200, {
        ok: true,
        data: { results },
        truncated: entities.length > trimmed.length,
      });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/mine") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
    const limits = body?.limits || {};
    const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
    const trimmed = targets.slice(0, max).filter((t) => t?.x !== undefined && t?.y !== undefined);
    try {
      const results: any[] = [];
      for (const target of trimmed) {
        const result = await nativeAction({
          kind: "mine",
          target: { x: Number(target.x), y: Number(target.y), kind: target.kind, name: target.name },
        });
        results.push({ ...result, x: Number(target.x), y: Number(target.y) });
      }
      return json(res, 200, {
        ok: true,
        data: { results },
        truncated: targets.length > trimmed.length,
      });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/move") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
    const limits = body?.limits || {};
    const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
    const trimmed = targets.slice(0, max).filter((t) => t?.x !== undefined && t?.y !== undefined);
    try {
      const results: any[] = [];
      for (const target of trimmed) {
        const result = await movePlayerTo(Number(target.x) + 0.5, Number(target.y) + 0.5);
        results.push({
          ...result,
          x: Number(target.x),
          y: Number(target.y),
          moved_x: result.movement?.final_position?.x,
          moved_y: result.movement?.final_position?.y,
        });
      }
      return json(res, 200, {
        ok: true,
        data: { results },
        truncated: targets.length > trimmed.length,
      });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/rotate") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
    const limits = body?.limits || {};
    const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
    const trimmed = targets.slice(0, max).filter((t) => t?.x !== undefined && t?.y !== undefined);
    try {
      const results: any[] = [];
      for (const target of trimmed) {
        const movement = await moveNearEntity({
          x: Number(target.x),
          y: Number(target.y),
        });
        if (!movement?.ok) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: movement?.error || "movement_failed",
            movement: movement?.movement,
          });
          continue;
        }
        const response = await rconCommand(
          agentRotateCommand([{ x: Number(target.x), y: Number(target.y) }]),
        );
        const data = parseRconJson<any>(response, "RCON rotate returned invalid JSON");
        const entry = data?.results?.[0];
        if (!entry) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: "rotate_failed",
          });
        } else {
          results.push({ ...entry, movement: movement.movement });
        }
      }
      return json(res, 200, {
        ok: true,
        data: { results },
        truncated: targets.length > trimmed.length,
      });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/launch-rocket") {
    let body: any;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
    if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
    const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
    const max = clampInt(body?.limits?.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
    const trimmed = targets.slice(0, max);
    try {
      const results = [];
      const job = actionJobs.currentJob;
      for (const target of trimmed) {
        results.push(
          await launchRocket({ x: target?.x, y: target?.y }, moveNearEntity, rconCommand, () =>
            actionJobs.isCancelled(job),
          ),
        );
      }
      return json(res, 200, { ok: true, data: { results }, truncated: targets.length > trimmed.length });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/set-recipe") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
    const limits = body?.limits || {};
    const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
    const trimmed = targets
      .slice(0, max)
      .filter((t) => t?.x !== undefined && t?.y !== undefined && t?.recipe);
    try {
      const results: any[] = [];
      for (const target of trimmed) {
        const movement = await moveNearEntity({
          x: Number(target.x),
          y: Number(target.y),
        });
        if (!movement?.ok) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: movement?.error || "movement_failed",
            movement: movement?.movement,
          });
          continue;
        }
        const response = await rconCommand(
          agentSetRecipeCommand([{ x: Number(target.x), y: Number(target.y), recipe: target.recipe }]),
        );
        const data = parseRconJson<any>(response, "RCON set-recipe returned invalid JSON");
        const entry = data?.results?.[0];
        if (!entry) {
          results.push({
            x: Number(target.x),
            y: Number(target.y),
            ok: false,
            error: "set_recipe_failed",
          });
        } else {
          results.push({ ...entry, movement: movement.movement });
        }
      }
      return json(res, 200, {
        ok: true,
        data: { results },
        truncated: targets.length > trimmed.length,
      });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/craft") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const recipe = body?.item || body?.recipe;
    const count = clampInt(body?.count, 1, 1, 10000);
    if (!recipe || typeof recipe !== "string") {
      return json(res, 400, { error: "Missing recipe" });
    }
    try {
      const response = await rconCommand(agentCraftCommand(recipe, count));
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      if (data && typeof data === "object" && data.ok === false) {
        return json(res, 400, {
          error: data?.error || "Extract failed",
          data,
        });
      }
      return json(res, 200, { ok: true, data });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/insert") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const to = body?.to?.entity || body?.entity || {};
    const item = body?.item;
    const count = clampInt(body?.count, 1, 1, 100000);
    if (!item || typeof item !== "string") {
      return json(res, 400, { error: "Missing item" });
    }
    if (to?.x === undefined || to?.y === undefined) {
      return json(res, 400, { error: "Missing target" });
    }
    try {
      const movement = await moveNearEntity({ x: Number(to.x), y: Number(to.y) });
      if (!movement?.ok) {
        return json(res, 200, {
          ok: true,
          data: { ok: false, error: movement?.error || "movement_failed", movement: movement?.movement },
        });
      }
      const response = await rconCommand(
        agentInsertCommand({ x: Number(to.x), y: Number(to.y), item, count }),
      );
      const data = parseRconJson<any>(response, "RCON insert returned invalid JSON");
      return json(res, 200, { ok: true, data: { ...data, movement: movement.movement } });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/extract") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const from = body?.from?.entity || body?.entity || {};
    const item = body?.item;
    const rawCount = body?.count;
    const countAll = rawCount === "all" || rawCount === -1;
    const count: number | "all" = countAll ? "all" : clampInt(rawCount, 1, 1, 100000);
    if (!item || typeof item !== "string") {
      return json(res, 400, { error: "Missing item" });
    }
    if (from?.x === undefined || from?.y === undefined) {
      return json(res, 400, { error: "Missing target" });
    }
    try {
      const movement = await moveNearEntity({ x: Number(from.x), y: Number(from.y) });
      if (!movement?.ok) {
        return json(res, 200, {
          ok: true,
          data: { ok: false, error: movement?.error || "movement_failed", movement: movement?.movement },
        });
      }
      const response = await rconCommand(
        agentExtractCommand({
          x: Number(from.x),
          y: Number(from.y),
          item,
          count,
        }),
      );
      const data = parseRconJson<any>(response, "RCON extract returned invalid JSON");
      return json(res, 200, { ok: true, data: { ...data, movement: movement.movement } });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/connections") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const window = body?.window || {};
    const x = Number.isFinite(Number(window.x)) ? Number(window.x) : undefined;
    const y = Number.isFinite(Number(window.y)) ? Number(window.y) : undefined;
    const radius = clampInt(window.radius, 120, 1, 256);
    try {
      const response = await rconCommand(agentConnectionsCommand({ x, y, radius }));
      const data = normalizeConnectionsData(
        parseRconJson<any>(response, "RCON connection audit returned invalid JSON"),
      );
      return json(res, 200, { ok: true, data });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/layout") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const window = body?.window || {};
    const x = Number.isFinite(Number(window.x)) ? Number(window.x) : undefined;
    const y = Number.isFinite(Number(window.y)) ? Number(window.y) : undefined;
    const radius = clampInt(window.radius, 35, 1, 80);
    const step = clampInt(window.step, 1, 1, 8);
    try {
      const response = await rconCommand(agentLayoutCommand({ x, y, radius, step }));
      const data = normalizeLayoutData(
        parseRconJson<any>(response, "RCON layout observation returned invalid JSON"),
      );
      return json(res, 200, { ok: true, data });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/factory") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const window = body?.window || {};
    const x = Number.isFinite(Number(window.x)) ? Number(window.x) : undefined;
    const y = Number.isFinite(Number(window.y)) ? Number(window.y) : undefined;
    const radius = clampInt(window.radius, 120, 1, 256);
    try {
      const response = await rconCommand(agentFactoryCommand({ x, y, radius }));
      const data = normalizeFactoryData(
        parseRconJson<any>(response, "RCON factory observation returned invalid JSON"),
      );
      const plan = runManager.plan();
      if (plan) data.plan = plan;
      return json(res, 200, { ok: true, data });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/entity") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
    const limits = body?.limits || {};
    const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
    const trimmed = targets.slice(0, max).filter((t) => t?.x !== undefined && t?.y !== undefined);
    try {
      const response = await rconCommand(agentObserveEntityCommand(trimmed));
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      data = normalizeEntityData(data);
      return json(res, 200, {
        ok: true,
        data,
        truncated: targets.length > trimmed.length,
      });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/placement") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
    if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
    const placements = Array.isArray(body?.placements) ? body.placements : [];
    const valid = placements
      .slice(0, AGENT_MAX_ACTIONS)
      .filter(
        (item: any) =>
          typeof item?.name === "string" &&
          Number.isFinite(Number(item?.anchor?.x)) &&
          Number.isFinite(Number(item?.anchor?.y)),
      ) as BuildRequest[];
    try {
      const results = [];
      for (const item of valid) {
        const result = parseRconJson<any>(
          await rconCommand(agentNativeBuildCommand(item, true)),
          "RCON placement analysis returned invalid JSON",
        );
        const diagnostics = result?.diagnostics;
        if (diagnostics) {
          diagnostics.nearest_valid_positions = arrayOrEmpty(diagnostics.nearest_valid_positions);
          if (diagnostics.terrain)
            diagnostics.terrain.tile_names = arrayOrEmpty(diagnostics.terrain.tile_names);
          if (diagnostics.collision)
            diagnostics.collision.possible_blockers = arrayOrEmpty(diagnostics.collision.possible_blockers);
        }
        results.push(result);
      }
      return json(res, 200, {
        ok: true,
        data: { results },
        truncated: placements.length > valid.length,
      });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/resources") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const window = body?.window || {};
    const radius = clampInt(window.radius, 50, 1, 500);
    const x = clampInt(window.x, 0, -1000000, 1000000);
    const y = clampInt(window.y, 0, -1000000, 1000000);
    try {
      const response = await rconCommand(agentChartedResourcesCommand({ x, y, radius }), 15_000);
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      if (data && typeof data === "object") {
        data.patches = arrayOrEmpty(data.patches);
        data.shoreline_candidates = arrayOrEmpty(data.shoreline_candidates);
      }
      return json(res, 200, { ok: true, data });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/observe/entity-prototype") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const name = body?.name;
    if (!name || typeof name !== "string") {
      return json(res, 400, { error: "Missing entity name" });
    }
    try {
      const response = await rconCommand(agentEntityPrototypeCommand(name));
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      data = normalizePrototypeData(data);
      if (data && typeof data === "object" && data.ok === false) {
        return json(res, 400, { error: data?.error || "Unknown entity", data });
      }
      return json(res, 200, { ok: true, data });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/agent/act/research") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    const technology = body?.technology;
    if (!technology || typeof technology !== "string") {
      return json(res, 400, { error: "Missing technology" });
    }
    try {
      const response = await rconCommand(agentResearchStartCommand(technology));
      let data: any = response;
      try {
        data = JSON.parse(response);
      } catch {
        // Leave as raw string if it isn't JSON.
      }
      if (data && typeof data === "object" && data.ok === false) {
        return json(res, 400, { error: data?.error || "Research failed", data });
      }
      return json(res, 200, { ok: true, data });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/rcon/command") {
    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }
    const command = body?.command;
    if (!command || typeof command !== "string") {
      return json(res, 400, { error: "Missing command" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    try {
      const response = await rconCommand(command);
      return json(res, 200, { ok: true, response });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "RCON command failed" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/server/save") {
    if (runManager.busy) return json(res, 409, { error: "The run manager saves the game when the run ends" });
    if (!getRunningPid()) {
      return json(res, 409, { error: "Server not running" });
    }
    if (!rconConfigured()) {
      return json(res, 409, { error: "RCON not configured" });
    }
    if (!state.rcon.connected) {
      return json(res, 409, { error: "RCON not connected" });
    }
    try {
      if (!activeSavePath || !activeProfile)
        throw new Error(
          "This game was recovered after a restart; stop it and reload a save before saving through the API",
        );
      const saveName = `autorio-checkpoint-${randomUUID()}`;
      const checkpoint = path.join(activeProfile, "saves", `${saveName}.zip`);
      const response = await rconCommand(`/save ${saveName}`, 30_000);
      const until = Date.now() + 30_000;
      while (!fsSync.existsSync(checkpoint) && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 200));
      if (!fsSync.existsSync(checkpoint)) throw new Error("Checkpoint was not written");
      await fs.copyFile(checkpoint, activeSavePath);
      return json(res, 200, { ok: true, save: state.save, response });
    } catch (err: any) {
      return json(res, 500, { error: err?.message || "Failed to save game" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/server/start") {
    if (getRunningPid()) {
      return json(res, 409, { error: "Server already running" });
    }

    let body: any = null;
    try {
      body = await readJson(req);
    } catch (err: any) {
      return json(res, 400, { error: err?.message || "Invalid JSON" });
    }

    const save = body?.save;
    if (!save || typeof save !== "string" || path.basename(save) !== save) {
      return json(res, 400, { error: "Missing save" });
    }

    const savePath = path.join(SAVES_DIR, save);
    if (!save.endsWith(".zip")) {
      return json(res, 400, { error: "Save must be a .zip file" });
    }

    try {
      const stat = await fs.stat(savePath);
      if (!stat.isFile()) {
        return json(res, 400, { error: "Save not found" });
      }
    } catch {
      return json(res, 400, { error: "Save not found" });
    }

    if (runManager.busy) return json(res, 409, { error: "A benchmark run owns the game" });
    try {
      await startGame(savePath, MANAGER_PROFILE);
    } catch (error: any) {
      return json(res, 500, { error: error.message });
    }

    return json(res, 200, statusPayload());
  }

  if (req.method === "POST" && url.pathname === "/api/server/stop") {
    if (runManager.busy)
      return json(res, 409, { error: "Stop the benchmark run through /api/runs/:id/stop" });
    if (!getRunningPid()) return json(res, 409, { error: "Game not running" });
    try {
      await stopGame();
    } catch (error: any) {
      return json(res, 500, { error: error.message });
    }
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: "Not found" });
}

function contentType(p: string) {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".json")) return "application/json; charset=utf-8";
  if (p.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

async function handleStatic(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  let pathname = url.pathname;
  if (pathname === "/runs.html") {
    const id = url.searchParams.get("run");
    const target = url.searchParams.get("recording") === "1" ? "/recording.html" : id ? "/run.html" : "/";
    res.writeHead(302, { Location: target + (id ? `?run=${encodeURIComponent(id)}` : "") });
    return res.end();
  }
  if (pathname === "/") pathname = "/index.html";
  const relPath = pathname.replace(/^\/+/, "");
  const publicRoot = path.join(ROOT, "public");
  const filePath = path.join(publicRoot, relPath);
  if (!filePath.startsWith(publicRoot)) {
    res.writeHead(403);
    return res.end();
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const httpLog = logger.child({ component: "http" });

const server = createServer(async (req, res) => {
  const requestStartedAt = Date.now();
  res.once("finish", () => {
    if (!req.url || req.url.startsWith("/api/health")) return;
    httpLog.info("request", {
      method: req.method,
      path: req.url.split("?")[0],
      status: res.statusCode,
      duration_ms: Date.now() - requestStartedAt,
    });
  });

  if (!req.url) {
    res.writeHead(400);
    return res.end();
  }

  if (req.url.startsWith("/api/")) {
    try {
      return await handleApi(req, res);
    } catch (error: any) {
      return json(res, 500, { error: error.message || "Request failed" });
    }
  }

  return handleStatic(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  logger.info("Server listening", { url: `http://localhost:${PORT}`, port: PORT, data_dir: DATA_DIR });
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Shutting down", { signal });
  try {
    await runManager.shutdown();
    if (getRunningPid()) await stopGame();
  } catch (error) {
    logger.error("Shutdown failed", { error });
  }
  logger.info("Shutdown complete", { signal });
  server.close(() => process.exit(0));
  server.closeAllConnections();
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
