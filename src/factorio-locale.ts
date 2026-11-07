import fs from "node:fs";
import path from "node:path";
import { execExecutable } from "./platform.js";
import { DATA_DIR, ROOT, factorioEnv } from "./runtime.js";

const LOCALE_FILE = path.join(DATA_DIR, "factorio-locale.json");
let cached: Record<string, unknown> | null = null;
let pending: Promise<Record<string, unknown>> | null = null;

/** Extract and cache technology/item names from the local Factorio locale. */
export async function ensureFactorioLocale(): Promise<Record<string, unknown>> {
  if (cached) return cached;
  if (fs.existsSync(LOCALE_FILE) && fs.statSync(LOCALE_FILE).size > 0) {
    cached = JSON.parse(fs.readFileSync(LOCALE_FILE, "utf8")) as Record<string, unknown>;
    return cached;
  }
  if (!pending) {
    pending = (async () => {
      const helper = path.join(ROOT, "tools", "factorio_locale.py");
      if (!fs.existsSync(helper)) throw new Error("Factorio locale helper is missing");
      const python =
        process.env.AUTORIO_PYTHON ||
        process.env.PYTHON ||
        (process.platform === "win32" ? "python" : "python3");
      fs.mkdirSync(path.dirname(LOCALE_FILE), { recursive: true });
      const result = await execExecutable(python, [helper, "--out", LOCALE_FILE], {
        cwd: ROOT,
        env: factorioEnv,
        timeout: 60_000,
      });
      if (!fs.existsSync(LOCALE_FILE)) {
        throw new Error(`Factorio locale extraction failed: ${result.stderr.slice(-1000)}`);
      }
      cached = JSON.parse(fs.readFileSync(LOCALE_FILE, "utf8")) as Record<string, unknown>;
      return cached;
    })().finally(() => {
      pending = null;
    });
  }
  return pending;
}
