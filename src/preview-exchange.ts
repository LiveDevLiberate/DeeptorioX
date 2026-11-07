import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execExecutable } from "./platform.js";
import { DATA_DIR, FACTORIO_BIN, ROOT, factorioEnv } from "./runtime.js";

const MAP_STRING = /^>>>eN[\sA-Za-z0-9+/=]+<<<$/;

export type ParsedMapExchange = {
  mapString: string;
  mapGen: Record<string, unknown> & { seed: number };
  planets: string[];
  outDir: string;
};

/**
 * Decode a Factorio map exchange string with the vendored
 * FactorioPreviewToolkit dummy-save/Lua pipeline.
 */
export async function parseMapExchange(mapString: string): Promise<ParsedMapExchange> {
  const trimmed = mapString.trim();
  if (trimmed.length < 20 || trimmed.length > 200_000 || !MAP_STRING.test(trimmed)) {
    throw new Error("invalid map exchange string (expected >>>eN...<<<)");
  }
  const helper = path.join(ROOT, "tools", "preview_toolkit_exchange.py");
  if (!fs.existsSync(helper)) throw new Error("preview toolkit exchange helper is missing");
  const hash = createHash("sha256").update(trimmed).digest("hex").slice(0, 16);
  const outDir = path.join(DATA_DIR, "map-previews", `exchange-${hash}`);
  fs.mkdirSync(outDir, { recursive: true });
  const python =
    process.env.AUTORIO_PYTHON || process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  const result = await execExecutable(python, [helper, FACTORIO_BIN, trimmed, "--out", outDir], {
    cwd: ROOT,
    env: factorioEnv,
    timeout: 180_000,
  });
  const settingsPath = path.join(outDir, "map-gen-settings.json");
  const planetsPath = path.join(outDir, "planets.json");
  if (!fs.existsSync(settingsPath) || !fs.existsSync(planetsPath)) {
    throw new Error(`map exchange decode failed: ${result.stderr.slice(-1000)}`);
  }
  const mapGen = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown> & {
    seed: number;
  };
  const rawPlanets = JSON.parse(fs.readFileSync(planetsPath, "utf8")) as unknown;
  const planets = Array.isArray(rawPlanets)
    ? rawPlanets.filter((entry): entry is string => typeof entry === "string" && /^[a-z0-9-]+$/.test(entry))
    : ["nauvis"];
  if (!Number.isInteger(mapGen.seed)) throw new Error("decoded map settings have no integer seed");
  return { mapString: trimmed, mapGen, planets: planets.length ? planets : ["nauvis"], outDir };
}
