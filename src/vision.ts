import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execExecutable } from "./platform.js";

/**
 * Visual observation for the manager: capture the visible Factorio game window
 * as a PNG so an agent can look at the game instead of only reading RCON data.
 *
 * The manager runs as a native Windows process and launches the graphical game,
 * so capture shells out to scripts/capture-window.ps1. That script only reads the
 * desktop and never brings the game to the foreground by default, so a capture
 * cannot steal keyboard focus from native control or from the operator.
 *
 * Importing this module has no side effects. The Windows-only process execution
 * is injectable (see CaptureDeps) so tests never launch PowerShell or Factorio.
 */

export type CaptureOptions = {
  /** Case-insensitive substring of the game window title. Defaults to "Factorio". */
  title?: string;
  /** Wall-clock timeout for the capture process. Defaults to 20 seconds. */
  timeoutMs?: number;
};

export type VisualCapture = {
  format: "png";
  base64: string;
  width: number;
  height: number;
  /** "window" is a desktop capture of the game window; "obs" is reserved for an optional OBS source. */
  source: "window" | "obs";
};

/** Process runner shape shared with platform.ts execExecutable. */
export type CaptureExec = (
  bin: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** Test seam: no test should depend on the host being Windows or on a real game window. */
export type CaptureDeps = {
  platform?: NodeJS.Platform;
  exec?: CaptureExec;
  scriptPath?: string;
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Magic (8) + IHDR length (4) + "IHDR" (4) + width/height (8) + 5 format bytes + CRC (4). */
const PNG_HEADER_BYTES = 33;
const MAX_PNG_BYTES = 64 * 1024 * 1024;
const DEFAULT_TITLE = "Factorio";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 120_000;

/** scripts/capture-window.ps1 next to the compiled or source module. */
export function captureScriptPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "capture-window.ps1");
}

function powershellExecutable(): string {
  // Prefer Windows PowerShell 5.1 so System.Drawing is always available, even
  // when PATH has an unusual shape. Checked at call time, never at import time.
  return process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

function normalizeTitle(title: unknown): string {
  const value = typeof title === "string" ? title.trim() : "";
  if (!value) return DEFAULT_TITLE;
  // The title is passed as one argv entry to PowerShell; keep it plain text.
  if (value.length > 200 || value.startsWith("-") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("invalid_capture_title: window title must be 1-200 plain characters");
  }
  return value;
}

function clampTimeout(timeoutMs: unknown): number {
  const value =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(value, 2_000), MAX_TIMEOUT_MS);
}

/** Validate the PNG signature/IHDR and read its dimensions without an image library. */
function pngDimensions(data: Buffer): { width: number; height: number } {
  if (data.length < PNG_HEADER_BYTES || !data.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error("visual_capture_invalid_png: capture is not a PNG image");
  }
  if (data.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("visual_capture_invalid_png: PNG is missing its IHDR header");
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw new Error("visual_capture_invalid_png: PNG has empty dimensions");
  }
  return { width, height };
}

/**
 * Capture one PNG frame of the visible game window.
 *
 * Windows only: spawns PowerShell to find the window and write a temporary PNG,
 * then reads and validates it. The temporary directory is always removed.
 */
export async function captureGameWindow(
  options: CaptureOptions = {},
  deps: CaptureDeps = {},
): Promise<VisualCapture> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") {
    throw new Error(
      "visual_capture_unsupported_platform: visual capture requires the Windows graphical Factorio window",
    );
  }
  const title = normalizeTitle(options.title);
  const timeoutMs = clampTimeout(options.timeoutMs);
  const exec = deps.exec ?? execExecutable;
  const scriptPath = deps.scriptPath ?? captureScriptPath();
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`visual_capture_missing_script: ${scriptPath}`);
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "autorio-visual-"));
  const capturePath = path.join(tempDir, "capture.png");
  try {
    try {
      await exec(
        powershellExecutable(),
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
          "-Out",
          capturePath,
          "-Title",
          title,
        ],
        { timeout: timeoutMs },
      );
    } catch (error) {
      throw new Error(`visual_capture_failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }

    let data: Buffer;
    try {
      const stat = await fs.promises.stat(capturePath);
      if (stat.size > MAX_PNG_BYTES) throw new Error("capture PNG is too large");
      data = await fs.promises.readFile(capturePath);
    } catch (error) {
      throw new Error(
        `visual_capture_failed: ${error instanceof Error ? error.message : "PowerShell did not write a PNG"}`,
        { cause: error },
      );
    }
    const { width, height } = pngDimensions(data);
    return { format: "png", base64: data.toString("base64"), width, height, source: "window" };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Response body for POST /api/agent/observe/visual. Kept here so the server
 * route stays a one-line wrapper and the {ok, data} contract is testable
 * without starting the manager (whose module import starts the HTTP server).
 */
export async function visualObservation(
  options: CaptureOptions = {},
  deps: CaptureDeps = {},
): Promise<{ ok: true; data: VisualCapture }> {
  return { ok: true, data: await captureGameWindow(options, deps) };
}
