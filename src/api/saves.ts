import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "../http/router.js";
import { json, readJsonBody } from "../http/plumbing.js";
import { errorMessage } from "../validation.js";
import { SAVES_DIR, MANAGER_PROFILE, createMap } from "../runtime.js";
import type { ApiContext } from "./context.js";

async function listSaves(): Promise<string[]> {
  const entries = await fs.readdir(SAVES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".zip"))
    .map((e) => e.name)
    .sort();
}

/**
 * Validate and normalize a save name from an `unknown` request field. Mirrors
 * the historical inline rules and error messages exactly.
 */
export function normalizeSaveFilename(value: unknown): string {
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

export function registerSavesRoutes(router: Router, _ctx: ApiContext): void {
  let saveCreationInProgress = false;

  router.add({
    method: "GET",
    path: "/api/saves",
    name: "/api/saves",
    handler: async (request) => {
      const { res } = request;
      try {
        const saves = await listSaves();
        return json(res, 200, { saves });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "Failed to list saves" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/saves",
    name: "/api/saves",
    handler: async (request) => {
      const { req, res } = request;
      if (saveCreationInProgress) {
        return json(res, 409, { error: "A save is already being created" });
      }
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });

      let save: string;
      try {
        save = normalizeSaveFilename(parsedBody.body.name);
      } catch (err) {
        return json(res, 400, { error: errorMessage(err) || "Invalid save name" });
      }

      saveCreationInProgress = true;
      try {
        await createSave(save);
        return json(res, 201, { ok: true, save });
      } catch (err) {
        const message = errorMessage(err) || "Failed to create save";
        const status = message === "Save already exists" ? 409 : 500;
        return json(res, status, { error: message });
      } finally {
        saveCreationInProgress = false;
      }
    },
  });
}
