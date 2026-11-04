import fsSync from "node:fs";
import { Router } from "../http/router.js";
import { json, readJson } from "../http/plumbing.js";
import { errorMessage } from "../validation.js";
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
