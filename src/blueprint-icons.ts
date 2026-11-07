import fs from "node:fs";
import path from "node:path";
import { execExecutable } from "./platform.js";
import { DATA_DIR, ROOT, factorioEnv } from "./runtime.js";

const ICON_DIR = path.join(DATA_DIR, "blueprint-icons");
let pending: Promise<void> | null = null;

/**
 * Build (once) an icon atlas from the local Factorio installation using the
 * vendored factorio-blueprint-tools `icons` implementation.
 */
export async function ensureBlueprintIcons(): Promise<{ js: string; png: string }> {
  const js = path.join(ICON_DIR, "icons.js");
  const png = path.join(ICON_DIR, "icons.png");
  if (!(fs.existsSync(js) && fs.statSync(js).size > 0 && fs.existsSync(png) && fs.statSync(png).size > 0)) {
    if (!pending) {
      pending = (async () => {
        fs.mkdirSync(ICON_DIR, { recursive: true });
        const helper = path.join(ROOT, "tools", "blueprint_icons.py");
        if (!fs.existsSync(helper)) throw new Error("blueprint icon helper is missing");
        const python =
          process.env.AUTORIO_PYTHON ||
          process.env.PYTHON ||
          (process.platform === "win32" ? "python" : "python3");
        const result = await execExecutable(python, [helper, "--out-dir", ICON_DIR], {
          cwd: ROOT,
          env: factorioEnv,
          timeout: 120_000,
        });
        if (!fs.existsSync(js) || !fs.existsSync(png)) {
          throw new Error(`icon atlas generation failed: ${result.stderr.slice(-1000)}`);
        }
      })().finally(() => {
        pending = null;
      });
    }
    await pending;
  }
  return { js, png };
}

export function iconFile(kind: "js" | "png"): string {
  return path.join(ICON_DIR, `icons.${kind}`);
}
