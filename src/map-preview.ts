import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR, FACTORIO_BIN, ROOT, factorioEnv, prepareProfile } from "./runtime.js";
import { execExecutable } from "./platform.js";

const PREVIEW_DIR = path.join(DATA_DIR, "map-previews");
const PROFILE_DIR = path.join(DATA_DIR, "map-preview-profile");
const PROFILE_DIR_SPACE_AGE = path.join(DATA_DIR, "map-preview-profile-space-age");
const pending = new Map<string, Promise<MapPreviewResult>>();

export const MAP_PREVIEW_PLANETS = ["nauvis", "vulcanus", "gleba", "fulgora", "aquilo"] as const;

export type MapPreviewSettings = Record<string, unknown> & { seed: number };
export type MapPreviewResult = {
  file: string;
  url: string;
  seed: number;
  size: number;
  planet: string;
  generated_at: string;
};

function fileId(settings: MapPreviewSettings, size: number, planet: string): string {
  return createHash("sha256")
    .update(`${JSON.stringify(settings)}:${size}:${planet}:toolkit-v1`)
    .digest("hex")
    .slice(0, 16);
}

function settingsForPlanet(settings: MapPreviewSettings): MapPreviewSettings {
  const controls = settings.autoplace_controls;
  if (!controls || typeof controls !== "object" || Array.isArray(controls)) return settings;
  const otherPlanet =
    /^(?:vulcanus_|gleba_|fulgora_|aquilo_|calcite$|tungsten_ore$|lithium_brine$|scrap$|sulfuric_acid_geyser$|fluorine_vent$)/;
  const filtered: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(controls as Record<string, unknown>)) {
    if (!otherPlanet.test(name)) filtered[name] = value;
  }
  return { ...settings, autoplace_controls: filtered };
}

function clampSize(value: unknown): number {
  const size = Math.round(Number(value));
  if (!Number.isFinite(size)) return 2048;
  return Math.min(4096, Math.max(512, size));
}

/** Generate a terrain preview PNG with an isolated Factorio profile. */
export async function generateMapPreview(
  settings: MapPreviewSettings,
  options: { size?: unknown; planet?: unknown; spaceAge?: unknown } = {},
): Promise<MapPreviewResult> {
  const seed = Number(settings.seed);
  if (!Number.isInteger(seed) || seed < 0) throw new Error("map preview requires an integer seed");
  const normalized = { ...settings, seed };
  const size = clampSize(options.size);
  const planet = typeof options.planet === "string" && options.planet ? options.planet : "nauvis";
  const spaceAge = options.spaceAge === true;
  const planetSettings = spaceAge ? normalized : settingsForPlanet(normalized);
  const id = fileId(planetSettings, size, `${planet}:${spaceAge ? "sa" : "base"}`);
  const existing = path.join(PREVIEW_DIR, `${id}.png`);
  if (fs.existsSync(existing) && fs.statSync(existing).size > 0) {
    return {
      file: existing,
      url: `/api/map-previews/${id}.png`,
      seed,
      size,
      planet,
      generated_at: new Date().toISOString(),
    };
  }
  const running = pending.get(id);
  if (running) return running;
  const job = (async () => {
    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
    const profileDir = spaceAge ? PROFILE_DIR_SPACE_AGE : PROFILE_DIR;
    fs.mkdirSync(path.join(profileDir, "data"), { recursive: true });
    await prepareProfile(profileDir, "en", { spaceAge });
    const settingsPath = path.join(PREVIEW_DIR, `${id}-map-gen-settings.json`);
    fs.writeFileSync(settingsPath, JSON.stringify(planetSettings, null, 2));
    const output = path.join(PREVIEW_DIR, `${id}.png`);
    const helper = path.join(ROOT, "tools", "preview_toolkit_render.py");
    const python =
      process.env.AUTORIO_PYTHON ||
      process.env.PYTHON ||
      (process.platform === "win32" ? "python" : "python3");
    const logPath = path.join(PREVIEW_DIR, `${id}.log`);
    let stdout = "";
    let stderr = "";
    try {
      const result = await execExecutable(
        python,
        [helper, FACTORIO_BIN, settingsPath, output, profileDir, planet, String(size)],
        { cwd: ROOT, env: factorioEnv, timeout: 180_000 },
      );
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error);
    }
    fs.writeFileSync(logPath, `${stdout}\n${stderr}`.slice(-6000));
    if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
      throw new Error(`toolkit preview failed: ${(stderr || stdout).slice(-1000)}`);
    }
    return {
      file: output,
      url: `/api/map-previews/${id}.png`,
      seed,
      size,
      planet,
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
