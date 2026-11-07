import fs from "node:fs";
import path from "node:path";
import { execExecutable } from "./platform.js";
import { DATA_DIR, ROOT, factorioEnv } from "./runtime.js";

const PREVIEW_DIR = path.join(DATA_DIR, "blueprint-previews");
const pending = new Map<string, Promise<string>>();

/** Render a registry blueprint to a cached PNG thumbnail using vendored fbp render. */
export async function ensureBlueprintPreview(blueprintId: string, wire: string): Promise<string> {
  if (!/^[a-f0-9]{16}$/.test(blueprintId)) throw new Error("invalid blueprint id");
  const png = path.join(PREVIEW_DIR, `${blueprintId}.png`);
  if (fs.existsSync(png) && fs.statSync(png).size > 0) return png;
  const running = pending.get(blueprintId);
  if (running) return running;
  const job = (async () => {
    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
    const wireFile = path.join(PREVIEW_DIR, `${blueprintId}.txt`);
    fs.writeFileSync(wireFile, wire, "utf8");
    const helper = path.join(ROOT, "tools", "blueprint_thumbnail.py");
    if (!fs.existsSync(helper)) throw new Error("blueprint thumbnail helper is missing");
    const python =
      process.env.AUTORIO_PYTHON ||
      process.env.PYTHON ||
      (process.platform === "win32" ? "python" : "python3");
    const result = await execExecutable(python, [helper, "--wire-file", wireFile, "--out", png], {
      cwd: ROOT,
      env: factorioEnv,
      timeout: 60_000,
    });
    if (!fs.existsSync(png) || fs.statSync(png).size === 0) {
      throw new Error(`blueprint thumbnail failed: ${result.stderr.slice(-1000)}`);
    }
    return png;
  })().finally(() => pending.delete(blueprintId));
  pending.set(blueprintId, job);
  return job;
}
