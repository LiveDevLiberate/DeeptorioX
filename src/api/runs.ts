import fsSync from "node:fs";
import { Router } from "../http/router.js";
import { json, readJson } from "../http/plumbing.js";
import { asRecord, errorMessage } from "../validation.js";
import { BLUEPRINT_MAX_TEXT_BYTES } from "../blueprints.js";
import { mapConfigMeta } from "../map-config.js";
import { obsStatus } from "../obs.js";
import type { ApiContext } from "./context.js";

/** Options accepted by `RunManager.start` (validated there at runtime). */
type RunStartOptions = Parameters<ApiContext["runManager"]["start"]>[0];

export function registerRunsRoutes(router: Router, ctx: ApiContext): void {
  const { runManager } = ctx;

  router.add({
    method: "GET",
    path: "/api/obs/status",
    name: "/api/obs/status",
    handler: async (request) => {
      const { res } = request;
      return json(res, 200, await obsStatus());
    },
  });

  router.add({
    method: "GET",
    path: "/api/benchmarks",
    name: "/api/benchmarks",
    handler: (request) => {
      const { res } = request;
      return json(res, 200, { benchmarks: runManager.benchmarks });
    },
  });

  router.add({
    method: "GET",
    path: "/api/map-config",
    name: "/api/map-config",
    handler: (request) => {
      const { res } = request;
      return json(res, 200, mapConfigMeta());
    },
  });

  router.add({
    method: "GET",
    path: "/api/runs",
    name: "/api/runs",
    handler: (request) => {
      const { res } = request;
      return json(res, 200, { runs: runManager.list() });
    },
  });

  router.add({
    method: "POST",
    path: "/api/runs",
    name: "/api/runs",
    handler: async (request) => {
      const { req, res } = request;
      try {
        // `start()` re-validates every option at runtime, including non-object bodies
        // (it historically reports a TypeError message for null), so the payload is
        // passed through without pre-narrowing to keep those behaviours identical.
        return json(res, 202, runManager.start((await readJson(req)) as RunStartOptions));
      } catch (error) {
        return json(res, 400, { error: errorMessage(error) });
      }
    },
  });

  router.add({
    method: "GET",
    path: "/api/tool-calls",
    name: "/api/tool-calls",
    handler: (request) => {
      const { res } = request;
      const runId = runManager.activeRunId();
      if (!runId) return json(res, 200, { schema_version: 2, run_id: null, total: 0, calls: [] });
      const usage = runManager.toolCalls(runId) || { calls: [] };
      return json(res, 200, { ...usage, schema_version: 2, run_id: runId });
    },
  });

  router.add({
    path: /^\/api\/runs\/([^/]+)\/tool-calls$/,
    name: "runToolCalls",
    handler: (request) => {
      const { res, url } = request;
      const match = url.pathname.match(/^\/api\/runs\/([^/]+)\/tool-calls$/);
      if (!match) return false;
      const runId = decodeURIComponent(match[1]);
      if (!runManager.get(runId)) return json(res, 404, { error: "Run not found" });
      const usage = runManager.toolCalls(runId) || { total: 0, calls: [] };
      return json(res, 200, { ...usage, schema_version: 2, run_id: runId });
    },
  });

  router.add({
    method: "GET",
    path: "/api/blueprints",
    name: "/api/blueprints",
    handler: (request) => {
      const { res } = request;
      const runId = runManager.activeRunId();
      if (!runId) return json(res, 200, { schema_version: 2, run_id: null, count: 0, blueprints: [] });
      const blueprints = runManager.blueprints(runId) ?? [];
      return json(res, 200, { schema_version: 2, run_id: runId, count: blueprints.length, blueprints });
    },
  });

  router.add({
    method: "POST",
    path: "/api/blueprints",
    name: "/api/blueprints",
    handler: async (request) => {
      const { req, res } = request;
      const runId = runManager.activeRunId();
      if (!runId)
        return json(res, 409, { error: "No active run; start or resume a run before saving a blueprint" });
      try {
        const payload = asRecord(await readJson(req, BLUEPRINT_MAX_TEXT_BYTES + 1_000_000));
        if (!payload) throw new Error("Request body must be a JSON object");
        const blueprint = runManager.registerBlueprint(runId, {
          blueprint: payload.blueprint,
          label: payload.label,
          description: payload.description,
          source: payload.source,
        });
        return json(res, 201, { schema_version: 2, run_id: runId, blueprint });
      } catch (error) {
        return json(res, 400, { error: errorMessage(error) });
      }
    },
  });

  router.add({
    path: /^\/api\/runs\/([^/]+)\/blueprints(?:\/([a-f0-9]{16}))?$/,
    name: "runBlueprints",
    handler: async (request) => {
      const { req, res, url } = request;
      const match = url.pathname.match(/^\/api\/runs\/([^/]+)\/blueprints(?:\/([a-f0-9]{16}))?$/);
      if (!match) return false;
      const runId = decodeURIComponent(match[1]);
      if (!runManager.get(runId)) return json(res, 404, { error: "Run not found" });
      if (match[2]) {
        if (req.method === "GET") {
          const detail = runManager.blueprint(runId, match[2]);
          if (!detail) return json(res, 404, { error: "Blueprint not found" });
          return json(res, 200, { schema_version: 2, run_id: runId, ...detail });
        }
        if (req.method === "DELETE") {
          if (!runManager.deleteBlueprint(runId, match[2]))
            return json(res, 404, { error: "Blueprint not found" });
          return json(res, 200, { schema_version: 2, run_id: runId, deleted: match[2] });
        }
        if (req.method === "PATCH") {
          try {
            const payload = asRecord(await readJson(req));
            if (!payload) throw new Error("Request body must be a JSON object");
            const blueprint = runManager.updateBlueprint(runId, match[2], {
              label: payload.label,
              description: payload.description,
            });
            if (!blueprint) return json(res, 404, { error: "Blueprint not found" });
            return json(res, 200, { schema_version: 2, run_id: runId, blueprint });
          } catch (error) {
            return json(res, 400, { error: errorMessage(error) });
          }
        }
        return json(res, 405, { error: "Method not allowed" });
      }
      if (req.method === "GET") {
        const blueprints = runManager.blueprints(runId) ?? [];
        return json(res, 200, { schema_version: 2, run_id: runId, count: blueprints.length, blueprints });
      }
      if (req.method === "POST") {
        try {
          const payload = asRecord(await readJson(req, BLUEPRINT_MAX_TEXT_BYTES + 1_000_000));
          if (!payload) throw new Error("Request body must be a JSON object");
          const blueprint = runManager.registerBlueprint(runId, {
            blueprint: payload.blueprint,
            label: payload.label,
            description: payload.description,
            source: payload.source,
          });
          return json(res, 201, { schema_version: 2, run_id: runId, blueprint });
        } catch (error) {
          return json(res, 400, { error: errorMessage(error) });
        }
      }
      return json(res, 405, { error: "Method not allowed" });
    },
  });

  router.add({
    path: /^\/api\/runs\/([^/]+)(?:\/(stop|resume|pause|log|video))?$/,
    name: "runMatch",
    handler: async (request) => {
      const { req, res, url } = request;
      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(stop|resume|pause|log|video))?$/);
      if (runMatch) {
        const run = runManager.get(runMatch[1]);
        if (!run) return json(res, 404, { error: "Run not found" });
        if (!runMatch[2] && req.method === "GET") return json(res, 200, run);
        if (runMatch[2] === "video" && req.method === "GET") {
          const file = runManager.videoFile(
            run.id,
            url.searchParams.has("segment") ? Number(url.searchParams.get("segment")) : undefined,
          );
          if (!file || !fsSync.existsSync(file)) return json(res, 404, { error: "Timelapse is not ready" });
          const size = fsSync.statSync(file).size,
            range = req.headers.range;
          const match = range?.match(/^bytes=(\d+)-(\d*)$/);
          if (range && !match) {
            res.writeHead(416, { "Content-Range": `bytes */${size}` });
            return res.end();
          }
          const start = match ? Number(match[1]) : 0,
            end = match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
          if (start >= size || end < start) {
            res.writeHead(416, { "Content-Range": `bytes */${size}` });
            return res.end();
          }
          res.writeHead(match ? 206 : 200, {
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes",
            "Content-Length": end - start + 1,
            ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
          });
          const stream = fsSync.createReadStream(file, { start, end });
          stream.on("error", () => res.destroy());
          res.on("close", () => stream.destroy());
          return stream.pipe(res);
        }
        if (runMatch[2] === "log" && req.method === "GET") {
          const offset = Number(url.searchParams.get("offset") || 0);
          return json(
            res,
            200,
            runManager.log(
              run.id,
              Number.isFinite(offset) ? Math.floor(offset) : 0,
              url.searchParams.get("source") === "telemetry"
                ? "telemetry"
                : url.searchParams.get("source") === "events"
                  ? "events"
                  : url.searchParams.get("source") === "codex",
            ),
          );
        }
        if (runMatch[2] === "resume" && req.method === "POST") {
          try {
            return json(res, 202, runManager.resume(run.id));
          } catch (error) {
            return json(res, 409, { error: errorMessage(error) });
          }
        }
        if (runMatch[2] === "pause" && req.method === "POST") {
          try {
            await runManager.pause();
            return json(res, 200, runManager.get(run.id));
          } catch (error) {
            return json(res, 409, { error: errorMessage(error) });
          }
        }
        if (runMatch[2] === "stop" && req.method === "POST") {
          if (["preparing", "launching", "running", "saving"].includes(run.state)) {
            try {
              await runManager.stop();
            } catch (error) {
              return json(res, 409, { error: errorMessage(error) });
            }
          }
          return json(res, 200, runManager.get(run.id));
        }
      }
      return false;
    },
  });
}
