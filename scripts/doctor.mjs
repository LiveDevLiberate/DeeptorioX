// Cross-platform prerequisite check. Run after `npm ci`: npm run doctor
import fs from "node:fs";
import { FACTORIO_BIN, FACTORIO_DATA, factorioVersion } from "../dist/runtime.js";
import { IS_WINDOWS, codexExecutable, execExecutable, findBrowser, findOnPath } from "../dist/platform.js";
import {
  nativeOpenCodeBin,
  opencodeModel,
  opencodeTransport,
  opencodeVersionCommand,
  wslDistro,
} from "../dist/opencode.js";

const rows = [];
async function check(name, fn, optional = false) {
  try {
    rows.push([name, optional ? "optional-ok" : "ok", await fn()]);
  } catch (error) {
    rows.push([
      name,
      optional ? "optional-fail" : "FAIL",
      error instanceof Error ? error.message : String(error),
    ]);
  }
}

await check("Node", async () => `${process.version} (${process.platform}/${process.arch})`);
await check("Factorio executable", async () => {
  if (!fs.existsSync(FACTORIO_BIN)) throw new Error(`not found: ${FACTORIO_BIN} (set FACTORIO_BIN in .env)`);
  return `${await factorioVersion()} · ${FACTORIO_BIN}`;
});
await check("Factorio data", async () => {
  if (!fs.existsSync(FACTORIO_DATA))
    throw new Error(`not found: ${FACTORIO_DATA} (set FACTORIO_DATA in .env)`);
  return FACTORIO_DATA;
});
await check("OpenCode CLI", async () => {
  const { bin, args } = opencodeVersionCommand();
  const { stdout } = await execExecutable(bin, args, { timeout: 20_000 });
  const where = opencodeTransport() === "wsl" ? `WSL ${wslDistro()}` : nativeOpenCodeBin() || "opencode";
  return `${stdout.trim()} · ${where}`;
});
await check("OpenCode model", async () => opencodeModel(process.env.AUTORIO_OPENCODE_MODEL));
await check(
  "Codex CLI (optional)",
  async () => {
    const { stdout } = await execExecutable(codexExecutable(), ["--version"], { timeout: 20_000 });
    return `${stdout.trim()} · ${codexExecutable()}`;
  },
  true,
);
await check(
  "Codex login (optional)",
  async () => {
    if (process.env.AUTORIO_CODEX_PROVIDER) {
      const envKey = process.env.AUTORIO_CODEX_ENV_KEY || "OPENCODE_API_KEY";
      if (!process.env[envKey])
        throw new Error(`${envKey} is not set for provider ${process.env.AUTORIO_CODEX_PROVIDER}`);
      return `custom provider ${process.env.AUTORIO_CODEX_PROVIDER} (${envKey} set)`;
    }
    await execExecutable(codexExecutable(), ["login", "status"], { timeout: 20_000 });
    return "signed in";
  },
  true,
);
await check("Python 3", async () => {
  const candidates = IS_WINDOWS
    ? [
        ["py", ["-3"]],
        ["python", []],
        ["python3", []],
      ]
    : [
        ["python3", []],
        ["python", []],
      ];
  for (const [command, prefix] of candidates) {
    try {
      const { stdout } = await execExecutable(command, [...prefix, "--version"], { timeout: 10_000 });
      return `${stdout.trim()} · ${command}`;
    } catch {
      /* try the next launcher */
    }
  }
  throw new Error("Python 3 was not found on PATH");
});
await check("Recording window browser", async () => {
  const browser = findBrowser();
  if (!browser) throw new Error("install Microsoft Edge or Google Chrome, or set AUTORIO_BROWSER");
  return browser;
});
await check(
  "FFmpeg (for --video)",
  async () => {
    const ffmpeg = process.env.FFMPEG_BIN || findOnPath("ffmpeg");
    if (!ffmpeg) throw new Error("not installed; set FFMPEG_BIN or install FFmpeg to use --video");
    const { stdout } = await execExecutable(ffmpeg, ["-version"], { timeout: 10_000 });
    return `${stdout.trim().split(/\r?\n/)[0]} · ${ffmpeg}`;
  },
  true,
);
await check(
  "OBS WebSocket (for --video)",
  async () => {
    const { obsStatus } = await import("../dist/obs.js");
    const status = await obsStatus();
    if (!status.connected) throw new Error(status.message || "OBS WebSocket is not connected");
    return `OBS ${status.version}${status.recording ? " (recording now)" : ""}`;
  },
  true,
);

const width = Math.max(...rows.map(([name]) => name.length));
for (const [name, status, detail] of rows)
  console.log(`${name.padEnd(width)}  ${status.padEnd(13)}  ${detail}`);
if (rows.some(([, status]) => status === "FAIL")) process.exitCode = 1;
