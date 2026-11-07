import fsSync from "node:fs";
import { Router } from "../http/router.js";
import { json, readJson } from "../http/plumbing.js";
import { asRecord, asString, errorMessage } from "../validation.js";

function isUploadMethod(value: string): value is "skip" | "local_sync" | "rclone" {
  return value === "skip" || value === "local_sync" || value === "rclone";
}
import { BLUEPRINT_MAX_TEXT_BYTES } from "../blueprints.js";
import { mapConfigMeta } from "../map-config.js";
import {
  generateMapPreview,
  mapPreviewFile,
  MAP_PREVIEW_PLANETS,
  type MapPreviewSettings,
} from "../map-preview.js";
import { parseMapExchange } from "../preview-exchange.js";
import { uploadMapPreview } from "../map-preview-upload.js";
import { ensureBlueprintIcons, iconFile } from "../blueprint-icons.js";
import { ensureBlueprintPreview } from "../blueprint-preview.js";
import { ensureFactorioLocale } from "../factorio-locale.js";
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
    path: /^\/api\/runs\/([^/]+)\/state\/history$/,
    name: "runStateHistory",
    handler: (request) => {
      const { res, url } = request;
      const match = url.pathname.match(/^\/api\/runs\/([^/]+)\/state\/history$/);
      if (!match) return false;
      const runId = decodeURIComponent(match[1]);
      if (!runManager.get(runId)) return json(res, 404, { error: "Run not found" });
      return json(res, 200, { schema_version: 2, ...(runManager.stateHistory(runId) || { revisions: [] }) });
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
    method: "POST",
    path: "/api/map-previews/upload",
    name: "/api/map-previews/upload",
    handler: async (request) => {
      const { req, res } = request;
      try {
        const payload = asRecord(await readJson(req));
        const id = asString(payload?.id);
        const method = asString(payload?.method);
        if (!id) throw new Error("id is required");
        if (!method || !isUploadMethod(method)) {
          throw new Error("method must be skip, local_sync or rclone");
        }
        const result = await uploadMapPreview({
          id,
          method,
          target: asString(payload?.target) ?? undefined,
          remote: asString(payload?.remote) ?? undefined,
          rcloneExecutable: asString(payload?.rclone_executable) ?? undefined,
        });
        return json(res, 200, result);
      } catch (error) {
        return json(res, 400, { error: errorMessage(error) });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/map-preview/exchange",
    name: "/api/map-preview/exchange",
    handler: async (request) => {
      const { req, res } = request;
      try {
        const payload = asRecord(await readJson(req));
        const mapString = asString(payload?.map_string);
        if (!mapString) throw new Error("map_string is required");
        const parsed = await parseMapExchange(mapString);
        const requested = Array.isArray(payload?.planets)
          ? payload.planets.filter((entry): entry is string => typeof entry === "string")
          : [];
        const planets = (requested.length ? requested : parsed.planets).slice(0, 8);
        const previews = [];
        for (const planet of planets) {
          const preview = await generateMapPreview(parsed.mapGen, {
            size: payload?.size,
            planet,
            spaceAge: parsed.planets.length > 1,
          });
          previews.push({
            planet,
            seed: preview.seed,
            size: preview.size,
            url: preview.url,
            generated_at: preview.generated_at,
          });
        }
        return json(res, 200, {
          ok: true,
          seed: parsed.mapGen.seed,
          planets: previews,
          map_gen: parsed.mapGen,
        });
      } catch (error) {
        return json(res, 400, { error: errorMessage(error) });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/map-preview",
    name: "/api/map-preview",
    handler: async (request) => {
      const { req, res } = request;
      try {
        const payload = asRecord(await readJson(req));
        const mapGen = asRecord(payload?.map_gen);
        if (!mapGen) throw new Error("map_gen must be an object");
        if (payload?.all_planets === true) {
          const planets = [];
          for (const planet of MAP_PREVIEW_PLANETS) {
            const preview = await generateMapPreview(mapGen as MapPreviewSettings, {
              size: payload?.size,
              planet,
              spaceAge: true,
            });
            planets.push({ planet, url: preview.url, size: preview.size });
          }
          return json(res, 200, {
            ok: true,
            seed: mapGen.seed,
            planets,
            url: planets[0]?.url,
          });
        }
        const preview = await generateMapPreview(mapGen as MapPreviewSettings, {
          size: payload?.size,
        });
        return json(res, 200, {
          ok: true,
          seed: preview.seed,
          size: preview.size,
          planet: preview.planet,
          url: preview.url,
          generated_at: preview.generated_at,
        });
      } catch (error) {
        return json(res, 400, { error: errorMessage(error) });
      }
    },
  });

  router.add({
    method: "GET",
    path: "/api/factorio-locale",
    name: "/api/factorio-locale",
    handler: async (request) => {
      const { res } = request;
      try {
        return json(res, 200, await ensureFactorioLocale());
      } catch (error) {
        return json(res, 404, { error: errorMessage(error) });
      }
    },
  });

  router.add({
    method: "GET",
    path: "/api/blueprint-icons.js",
    name: "/api/blueprint-icons.js",
    handler: async (request) => {
      const { req, res } = request;
      try {
        await ensureBlueprintIcons();
        const file = iconFile("js");
        const body = fsSync.readFileSync(file);
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Content-Length": body.length,
          "Cache-Control": "no-cache",
        });
        if (req.method === "HEAD") return res.end();
        res.end(body);
      } catch (error) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`blueprint icons unavailable: ${errorMessage(error)}`);
      }
      return undefined;
    },
  });

  router.add({
    method: "GET",
    path: "/api/blueprint-icons.png",
    name: "/api/blueprint-icons.png",
    handler: async (request) => {
      const { req, res } = request;
      try {
        await ensureBlueprintIcons();
        const file = iconFile("png");
        const stat = fsSync.statSync(file);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": stat.size,
          "Cache-Control": "public, max-age=86400",
        });
        if (req.method === "HEAD") return res.end();
        fsSync.createReadStream(file).pipe(res);
      } catch (error) {
        return json(res, 404, { error: errorMessage(error) });
      }
      return undefined;
    },
  });

  router.add({
    method: "GET",
    path: /^\/api\/map-previews\/([a-f0-9]{16})\.png$/,
    name: "mapPreviewImage",
    handler: (request) => {
      const { req, res, url } = request;
      const match = url.pathname.match(/^\/api\/map-previews\/([a-f0-9]{16})\.png$/);
      if (!match) return false;
      const preview = mapPreviewFile(match[1]);
      if (!preview) return json(res, 404, { error: "Map preview not found" });
      const stat = fsSync.statSync(preview.file);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": stat.size,
        "Cache-Control": "public, max-age=86400",
      });
      if (req.method === "HEAD") return res.end();
      fsSync.createReadStream(preview.file).pipe(res);
    },
  });

  router.add({
    method: "POST",
    path: /^\/api\/runs\/([^/]+)\/map-preview$/,
    name: "runMapPreview",
    handler: async (request) => {
      const { req, res, url } = request;
      const match = url.pathname.match(/^\/api\/runs\/([^/]+)\/map-preview$/);
      if (!match) return false;
      const run = runManager.get(decodeURIComponent(match[1]));
      if (!run) return json(res, 404, { error: "Run not found" });
      try {
        const payload = asRecord(await readJson(req));
        if (payload?.all_planets === true) {
          const planets = [];
          for (const planet of MAP_PREVIEW_PLANETS) {
            const preview = await generateMapPreview(run.benchmark.map_gen, {
              size: payload?.size,
              planet,
              spaceAge: true,
            });
            planets.push({ planet, url: preview.url, size: preview.size });
          }
          return json(res, 200, {
            ok: true,
            seed: run.benchmark.map_gen.seed,
            planets,
            url: planets[0]?.url,
          });
        }
        const preview = await generateMapPreview(run.benchmark.map_gen, {
          size: payload?.size,
        });
        return json(res, 200, {
          ok: true,
          seed: preview.seed,
          size: preview.size,
          planet: preview.planet,
          url: preview.url,
          generated_at: preview.generated_at,
        });
      } catch (error) {
        return json(res, 400, { error: errorMessage(error) });
      }
    },
  });

  router.add({
    method: "GET",
    path: /^\/api\/runs\/([^/]+)\/blueprints\/([a-f0-9]{16})\/preview\.png$/,
    name: "runBlueprintPreview",
    handler: async (request) => {
      const { req, res, url } = request;
      const match = url.pathname.match(/^\/api\/runs\/([^/]+)\/blueprints\/([a-f0-9]{16})\/preview\.png$/);
      if (!match) return false;
      const runId = decodeURIComponent(match[1]);
      const blueprint = runManager.blueprint(runId, match[2]);
      if (!blueprint) return json(res, 404, { error: "Blueprint not found" });
      try {
        const file = await ensureBlueprintPreview(match[2], blueprint.wire);
        const stat = fsSync.statSync(file);
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": stat.size,
          "Cache-Control": "public, max-age=86400",
        });
        if (req.method === "HEAD") return res.end();
        fsSync.createReadStream(file).pipe(res);
      } catch (error) {
        return json(res, 500, { error: errorMessage(error) });
      }
      return undefined;
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
          if (url.searchParams.get("download") === "1") {
            res.writeHead(200, {
              "Content-Type": "text/plain; charset=utf-8",
              "Content-Disposition": `attachment; filename="blueprint-${match[2]}.txt"`,
              "Cache-Control": "no-store",
            });
            res.end(detail.wire);
            return;
          }
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
    path: /^\/api\/runs\/([^/]+)(?:\/(stop|resume|pause|extend|log|video))?$/,
    name: "runMatch",
    handler: async (request) => {
      const { req, res, url } = request;
      const runMatch = url.pathname.match(
        /^\/api\/runs\/([^/]+)(?:\/(stop|resume|pause|extend|log|video))?$/,
      );
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
        if (runMatch[2] === "extend" && req.method === "POST") {
          try {
            const payload = asRecord(await readJson(req));
            const seconds = Number(payload?.seconds);
            if (!Number.isFinite(seconds) || seconds <= 0)
              return json(res, 400, { error: "seconds must be a positive number" });
            return json(res, 200, runManager.extend(run.id, seconds));
          } catch (error) {
            return json(res, 400, { error: errorMessage(error) });
          }
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
