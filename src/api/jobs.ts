import { Router } from "../http/router.js";
import { json, readJsonBody } from "../http/plumbing.js";
import { actionPaths, splitJobPayload, type JobAction } from "../action-jobs.js";
import { asString } from "../validation.js";
import { rconConfigured } from "./shared.js";
import type { ApiContext } from "./context.js";

/**
 * Narrow an `unknown` job action to the supported `JobAction` values. The
 * `in actionPaths` check is identical to the historical handler check (which
 * also accepted inherited keys like `"toString"`); unknown/non-string values
 * return undefined and produce the same 400 "Unknown job action" envelope.
 */
export function parseJobAction(value: unknown): JobAction | undefined {
  const action = asString(value);
  return action && action in actionPaths ? (action as JobAction) : undefined;
}

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
      const stateGate = runManager.stateGate();
      if (stateGate?.gate.blocked) {
        return json(res, 409, {
          error: "STATE_UPDATE_REQUIRED",
          message: stateGate.gate.hint,
          state: stateGate.status,
        });
      }
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const action = parseJobAction(body.action);
      if (!action) {
        return json(res, 400, { error: "Unknown job action", allowed_actions: Object.keys(actionPaths) });
      }
      if (splitJobPayload(action, body.payload).length === 0) {
        return json(res, 400, { error: "Action payload contains no work" });
      }
      const internal = req.headers["x-autorio-internal"] === internalKey;
      if (!internal && action === "build") {
        const gate = runManager.refactorGate();
        if (gate?.blocked) {
          return json(res, 409, {
            error: "REFACTOR_REQUIRED",
            message: gate.message,
            refactor: gate.state,
            nudge: {
              reason: "refactor_debt",
              first_step: "factory-audit",
              message:
                "Clean the listed invalid belt/inserter/machine problems with deconstruct-area/relayout-belts, re-audit, then resume building.",
            },
          });
        }
      }
      if (!internal && action === "build") {
        const blueprintGate = runManager.blueprintGate();
        if (blueprintGate?.blocked) {
          return json(res, 409, {
            error: "BLUEPRINT_REQUIRED",
            message: blueprintGate.message,
            blueprints: blueprintGate.blueprints,
            nudge: {
              reason: "no_blueprint",
              first_step: "blueprint-capture",
              message:
                "Capture the validated current cell with blueprint-capture --label ..., then retry the build.",
            },
          });
        }
      }
      const keyHeader = req.headers["idempotency-key"];
      const idempotencyKey =
        (typeof keyHeader === "string" ? keyHeader : null) ??
        (typeof body.idempotency_key === "string" ? body.idempotency_key : null);
      const job = actionJobs.submit(action, body.payload, idempotencyKey);
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
