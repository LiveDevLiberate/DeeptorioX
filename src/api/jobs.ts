import { Router } from "../http/router.js";
import { json, readJson } from "../http/plumbing.js";
import { actionPaths, splitJobPayload, type JobAction } from "../action-jobs.js";
import { rconConfigured } from "./shared.js";
import type { ApiContext } from "./context.js";

export function registerJobsRoutes(router: Router, ctx: ApiContext): void {
  const { state, runManager, actionJobs, internalKey } = ctx;

  router.add({
    method: "POST",
    path: "/api/agent/jobs",
    name: "/api/agent/jobs",
    handler: async (request) => {
      const { req, res } = request;
      if (runManager.busy && !runManager.acceptingActions)
        return json(res, 409, { error: "Run is not accepting actions" });
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const action = body?.action as JobAction;
      if (!action || !(action in actionPaths)) {
        return json(res, 400, { error: "Unknown job action", allowed_actions: Object.keys(actionPaths) });
      }
      if (splitJobPayload(action, body?.payload).length === 0) {
        return json(res, 400, { error: "Action payload contains no work" });
      }
      const keyHeader = req.headers["idempotency-key"];
      const idempotencyKey =
        (typeof keyHeader === "string" ? keyHeader : null) ??
        (typeof body?.idempotency_key === "string" ? body.idempotency_key : null);
      const job = actionJobs.submit(action, body?.payload, idempotencyKey);
      return json(res, 202, actionJobs.publicJob(job.id));
    },
  });

  router.add({
    method: "GET",
    path: /^\/api\/agent\/jobs\/([^/]+)$/,
    name: "jobMatch",
    handler: (request) => {
      const { req, res, url } = request;
      const jobMatch = url.pathname.match(/^\/api\/agent\/jobs\/([^/]+)$/);
      if (jobMatch && req.method === "GET") {
        const job = actionJobs.publicJob(jobMatch[1]);
        if (!job) return json(res, 404, { error: "Job not found" });
        return json(res, 200, job);
      }
    },
  });

  router.add({
    method: "POST",
    path: /^\/api\/agent\/jobs\/([^/]+)\/cancel$/,
    name: "cancelJobMatch",
    handler: async (request) => {
      const { req, res, url } = request;
      const cancelJobMatch = url.pathname.match(/^\/api\/agent\/jobs\/([^/]+)\/cancel$/);
      if (cancelJobMatch && req.method === "POST") {
        const job = await actionJobs.cancel(cancelJobMatch[1]);
        if (!job) return json(res, 404, { error: "Job not found" });
        return json(res, 202, actionJobs.publicJob(job.id));
      }
    },
  });

  router.add({
    path: /^\/api\/agent\/act\//,
    name: "act-guard",
    handler: (request) => {
      const { req, res, url } = request;
      if (url.pathname.startsWith("/api/agent/act/") && req.headers["x-autorio-internal"] !== internalKey) {
        return json(res, 409, {
          error: "Actions must be submitted through POST /api/agent/jobs",
        });
      }
      return false;
    },
  });

  router.add({
    path: /^\/api\/agent\/act\//,
    name: "act-guard",
    handler: (request) => {
      const { res, url } = request;
      if (url.pathname.startsWith("/api/agent/act/") && actionJobs.isCancelled()) {
        return json(res, 409, { error: "cancelled" });
      }
      return false;
    },
  });
}
