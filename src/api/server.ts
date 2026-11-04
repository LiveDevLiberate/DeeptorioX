import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Router } from "../http/router.js";
import { json, readJson, API_SCHEMA_VERSION } from "../http/plumbing.js";
import { SAVES_DIR, MANAGER_PROFILE } from "../runtime.js";
import { rconConfigured } from "./shared.js";
import { healthPayload, healthStatusCode } from "../health.js";
import type { ApiContext } from "./context.js";

export function registerServerRoutes(router: Router, ctx: ApiContext): void {
  const {
    state,
    runManager,
    rconCommand,
    getRunningPid,
    statusPayload,
    managerStartedAt,
    activeRunSummary,
    getActiveSavePath,
    getActiveProfile,
    startGame,
    stopGame,
  } = ctx;

  router.add({
    method: "GET",
    path: "/api/server/status",
    name: "/api/server/status",
    handler: (request) => {
      const { res } = request;
      return json(res, 200, statusPayload());
    },
  });

  router.add({
    method: "GET",
    path: "/api/health",
    name: "/api/health",
    handler: (request) => {
      const { res } = request;
      const payload = healthPayload({
        startedAt: managerStartedAt,
        game: () => ({ running: Boolean(getRunningPid()), rcon: state.rcon.connected }),
        activeRun: activeRunSummary,
        versions: { node: process.version, api_schema: API_SCHEMA_VERSION },
        schemaVersion: API_SCHEMA_VERSION,
      });
      return json(res, healthStatusCode(payload), payload);
    },
  });

  router.add({
    method: "GET",
    path: "/api/server/logs",
    name: "/api/server/logs",
    handler: (request) => {
      const { res, url } = request;
      const limitRaw = url.searchParams.get("limit") || "200";
      const limit = Math.max(1, Math.min(1000, Number(limitRaw) || 200));
      const lines = state.logs.slice(-limit);
      return json(res, 200, { lines });
    },
  });

  router.add({
    method: "POST",
    path: "/api/rcon/command",
    name: "/api/rcon/command",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      const command = body?.command;
      if (!command || typeof command !== "string") {
        return json(res, 400, { error: "Missing command" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      try {
        const response = await rconCommand(command);
        return json(res, 200, { ok: true, response });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/server/save",
    name: "/api/server/save",
    handler: async (request) => {
      const { res } = request;
      if (runManager.busy)
        return json(res, 409, { error: "The run manager saves the game when the run ends" });
      if (!getRunningPid()) {
        return json(res, 409, { error: "Server not running" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      try {
        const activeSavePath = getActiveSavePath();
        const activeProfile = getActiveProfile();
        if (!activeSavePath || !activeProfile)
          throw new Error(
            "This game was recovered after a restart; stop it and reload a save before saving through the API",
          );
        const saveName = `autorio-checkpoint-${randomUUID()}`;
        const checkpoint = path.join(activeProfile, "saves", `${saveName}.zip`);
        const response = await rconCommand(`/save ${saveName}`, 30_000);
        const until = Date.now() + 30_000;
        while (!fsSync.existsSync(checkpoint) && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 200));
        if (!fsSync.existsSync(checkpoint)) throw new Error("Checkpoint was not written");
        await fs.copyFile(checkpoint, activeSavePath);
        return json(res, 200, { ok: true, save: state.save, response });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "Failed to save game" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/server/start",
    name: "/api/server/start",
    handler: async (request) => {
      const { req, res } = request;
      if (getRunningPid()) {
        return json(res, 409, { error: "Server already running" });
      }

      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }

      const save = body?.save;
      if (!save || typeof save !== "string" || path.basename(save) !== save) {
        return json(res, 400, { error: "Missing save" });
      }

      const savePath = path.join(SAVES_DIR, save);
      if (!save.endsWith(".zip")) {
        return json(res, 400, { error: "Save must be a .zip file" });
      }

      try {
        const stat = await fs.stat(savePath);
        if (!stat.isFile()) {
          return json(res, 400, { error: "Save not found" });
        }
      } catch {
        return json(res, 400, { error: "Save not found" });
      }

      if (runManager.busy) return json(res, 409, { error: "A benchmark run owns the game" });
      try {
        await startGame(savePath, MANAGER_PROFILE);
      } catch (error: any) {
        return json(res, 500, { error: error.message });
      }

      return json(res, 200, statusPayload());
    },
  });

  router.add({
    method: "POST",
    path: "/api/server/stop",
    name: "/api/server/stop",
    handler: async (request) => {
      const { res } = request;
      if (runManager.busy)
        return json(res, 409, { error: "Stop the benchmark run through /api/runs/:id/stop" });
      if (!getRunningPid()) return json(res, 409, { error: "Game not running" });
      try {
        await stopGame();
      } catch (error: any) {
        return json(res, 500, { error: error.message });
      }
      return json(res, 200, { ok: true });
    },
  });
}
