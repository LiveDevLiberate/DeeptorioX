import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR, FACTORIO_BIN, factorioEnv, prepareProfile, profileArgs } from "./runtime.js";
import { spawnExecutable } from "./platform.js";

const PREVIEW_DIR = path.join(DATA_DIR, "map-previews");
const PROFILE_DIR = path.join(DATA_DIR, "map-preview-profile");
const pending = new Map<string, Promise<MapPreviewResult>>();

export type MapPreviewSettings = Record<string, unknown> & { seed: number };
export type MapPreviewResult = {
  file: string;
  url: string;
  seed: number;
  size: number;
  generated_at: string;
};

function fileId(settings: MapPreviewSettings, size: number): string {
  return createHash("sha256")
    .update(`${JSON.stringify(settings)}:${size}`)
    .digest("hex")
    .slice(0, 16);
}

function clampSize(value: unknown): number {
  const size = Math.round(Number(value));
  if (!Number.isFinite(size)) return 2048;
  return Math.min(4096, Math.max(512, size));
}

/** Generate a terrain preview PNG with an isolated Factorio profile. */
export async function generateMapPreview(
  settings: MapPreviewSettings,
  options: { size?: unknown } = {},
): Promise<MapPreviewResult> {
  const seed = Number(settings.seed);
  if (!Number.isInteger(seed) || seed < 0) throw new Error("map preview requires an integer seed");
  const normalized = { ...settings, seed };
  const size = clampSize(options.size);
  const id = fileId(normalized, size);
  const existing = path.join(PREVIEW_DIR, `${id}.png`);
  if (fs.existsSync(existing) && fs.statSync(existing).size > 0) {
    return {
      file: existing,
      url: `/api/map-previews/${id}.png`,
      seed,
      size,
      generated_at: new Date().toISOString(),
    };
  }
  const running = pending.get(id);
  if (running) return running;
  const job = (async () => {
    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
    fs.mkdirSync(path.join(PROFILE_DIR, "data"), { recursive: true });
    await prepareProfile(PROFILE_DIR);
    const settingsPath = path.join(PREVIEW_DIR, `${id}-map-gen-settings.json`);
    fs.writeFileSync(settingsPath, JSON.stringify(normalized, null, 2));
    const output = path.join(PREVIEW_DIR, `${id}.png`);
    const args = [
      ...profileArgs(PROFILE_DIR),
      `--generate-map-preview=${output}`,
      `--map-gen-settings=${settingsPath}`,
      `--map-preview-size=${size}`,
      "--map-preview-planet=nauvis",
    ];
    const logPath = path.join(PREVIEW_DIR, `${id}.log`);
    await new Promise<void>((resolve, reject) => {
      let log = "";
      const child = spawnExecutable(FACTORIO_BIN, args, { env: factorioEnv });
      const capture = (chunk: Buffer) => {
        log = (log + chunk.toString()).slice(-6000);
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("map preview generation timed out"));
      }, 180_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        fs.writeFileSync(logPath, log);
        if (code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0) resolve();
        else reject(new Error(`map preview failed (${signal || code}): ${log.slice(-1000)}`));
      });
    });
    return {
      file: output,
      url: `/api/map-previews/${id}.png`,
      seed,
      size,
      generated_at: new Date().toISOString(),
    };
  })().finally(() => pending.delete(id));
  pending.set(id, job);
  return job;
}

export function mapPreviewFile(id: string): { file: string; id: string } | undefined {
  if (!/^[a-f0-9]{16}$/.test(id)) return undefined;
  const file = path.join(PREVIEW_DIR, `${id}.png`);
  return fs.existsSync(file) ? { file, id } : undefined;
}

export const MAP_PREVIEW_DIR = PREVIEW_DIR;
