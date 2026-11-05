import { createServer, IncomingMessage, ServerResponse } from "http";
import type { ChildProcess } from "node:child_process";
import fsSync from "fs";
import path from "path";
import net from "net";
import { randomUUID } from "crypto";

import {
  ROOT,
  PORT,
  DATA_DIR,
  FACTORIO_BIN,
  RCON_HOST,
  RCON_PORT,
  RCON_PASSWORD,
  factorioEnv,
  prepareProfile,
  profileArgs,
  factorioVersion,
  requireSteam,
} from "./runtime.js";
import { NativeController } from "./native-control.js";
import { ActionJobQueue } from "./action-jobs.js";
import { RunManager } from "./runs.js";
import {
  IS_WINDOWS,
  isProcessExecutable,
  isProcessRunning,
  killProcessTree,
  sampleProcessUsage,
  spawnExecutable,
} from "./platform.js";
import { configureLogger, logger } from "./logger.js";
import { Router } from "./http/router.js";
import { json } from "./http/plumbing.js";
import { handleStatic } from "./http/static.js";
import { rconConfigured } from "./api/shared.js";
import { asRecord, errorMessage } from "./validation.js";
import type { ApiContext } from "./api/context.js";
import { registerAgentRoutes } from "./api/agent.js";
import { registerAreaEditRoutes } from "./api/area-edit.js";
import { registerJobsRoutes } from "./api/jobs.js";
import { registerStateRoutes } from "./api/state.js";
import { registerToolsRoutes } from "./api/tools.js";
import { registerManagerRoutes } from "./api/manager.js";
import { registerRunsRoutes } from "./api/runs.js";
import { registerSavesRoutes } from "./api/saves.js";
import { registerServerRoutes } from "./api/server.js";
import { registerTelemetryRoutes } from "./api/telemetry.js";
import { createTelemetrySampler } from "./telemetry-sampler.js";

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
  } catch (err) {
    if (asRecord(err)?.code === "ESRCH") return false;
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
      } catch (err) {
        finish(false, errorMessage(err) || "RCON auth failed");
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
async function startGame(savePath: string, profile: string, logFile?: string, options?: { locale?: string }) {
  if (launchingGame || getRunningPid()) throw new Error("Game already running or launching");
  launchingGame = true;
  try {
    await factorioVersion();
    await requireSteam();
    await prepareProfile(profile, options?.locale);
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

const PUBLIC_DIR = path.join(ROOT, "public");

// The API surface lives in src/api/*; server.ts owns process lifecycle, RCON and
// the run manager, and hands the route groups exactly what they need.
const apiContext: ApiContext = {
  state,
  runManager,
  actionJobs,
  nativeController,
  internalKey: INTERNAL_JOB_KEY,
  rconCommand,
  getRunningPid,
  statusPayload,
  managerStartedAt,
  activeRunSummary,
  getActiveSavePath: () => activeSavePath,
  getActiveProfile: () => activeProfile,
  startGame,
  stopGame,
  shutdown,
};

const telemetrySampler = createTelemetrySampler({
  command: (lua) => rconCommand(lua),
  logger,
  shouldSample: () => state.rcon.connected,
});

const apiRouter = new Router();
registerManagerRoutes(apiRouter, apiContext);
registerRunsRoutes(apiRouter, apiContext);
// Register the quick area-edit group before the /act/ job guard so the synchronous
// copy-settings action is reachable from clients (see src/api/area-edit.ts).
registerAreaEditRoutes(apiRouter, apiContext);
registerJobsRoutes(apiRouter, apiContext);
registerStateRoutes(apiRouter, apiContext);
registerToolsRoutes(apiRouter);
registerSavesRoutes(apiRouter, apiContext);
registerServerRoutes(apiRouter, apiContext);
registerAgentRoutes(apiRouter, apiContext);
registerTelemetryRoutes(apiRouter, apiContext, telemetrySampler);
telemetrySampler.start();

async function handleApi(req: IncomingMessage, res: ServerResponse) {
  if (req.url) {
    try {
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      runManager.recordToolCall(req.method || "GET", pathname);
    } catch {
      /* malformed URL is handled by the router */
    }
  }
  if (await apiRouter.dispatch(req, res)) return;
  return json(res, 404, { error: "Not found" });
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
    } catch (error) {
      return json(res, 500, { error: errorMessage(error) || "Request failed" });
    }
  }

  return handleStatic(req, res, { publicDir: PUBLIC_DIR });
});

server.listen(PORT, "127.0.0.1", () => {
  logger.info("Server listening", { url: `http://localhost:${PORT}`, port: PORT, data_dir: DATA_DIR });
  const resumed = runManager.autoResumeInterrupted();
  if (resumed) logger.info("Auto-resumed interrupted run", { run_id: resumed });
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  telemetrySampler.stop();
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
