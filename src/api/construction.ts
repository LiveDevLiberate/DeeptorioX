import { Router } from "../http/router.js";
import { json, readJsonBody } from "../http/plumbing.js";
import { ConstructionPlanError } from "../construction.js";
import type { ApiContext } from "./context.js";

/**
 * Construction-mode discovery and plan-token issue/status endpoints.
 *
 * Free mode returns `CONSTRUCTION_MODE_FREE` from POST /plan so clients can
 * fall back to the legacy action path. Planned mode requires a plan token for
 * every construction/mutation/cleanup action.
 */
export function registerConstructionRoutes(router: Router, ctx: ApiContext): void {
  const { runManager } = ctx;

  router.add({
    method: "GET",
    path: "/api/agent/construction",
    name: "/api/agent/construction",
    handler: (request) => {
      const { res } = request;
      return json(res, 200, { ok: true, data: runManager.constructionStatus() });
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/plan",
    name: "/api/agent/plan",
    handler: async (request) => {
      const { req, res } = request;
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return json(res, 400, { error: "PLAN_BAD_REQUEST", message: parsed.error });
      try {
        const plan = runManager.createConstructionPlan(parsed.body);
        return json(res, 201, { ok: true, data: plan });
      } catch (error) {
        if (error instanceof ConstructionPlanError) {
          return json(res, error.status, error.toJSON());
        }
        throw error;
      }
    },
  });

  router.add({
    method: "GET",
    path: /^\/api\/agent\/plan\/([^/]+)$/,
    name: "/api/agent/plan/:id",
    handler: (request) => {
      const { res, url } = request;
      const match = url.pathname.match(/^\/api\/agent\/plan\/([^/]+)$/);
      const plan = match ? runManager.constructionPlan(decodeURIComponent(match[1])) : undefined;
      if (!plan) return json(res, 404, { error: "PLAN_NOT_FOUND", message: "Plan not found" });
      return json(res, 200, { ok: true, data: plan });
    },
  });

  router.add({
    method: "POST",
    path: /^\/api\/agent\/plan\/([^/]+)\/cancel$/,
    name: "/api/agent/plan/:id/cancel",
    handler: (request) => {
      const { res, url } = request;
      const match = url.pathname.match(/^\/api\/agent\/plan\/([^/]+)\/cancel$/);
      if (!match) return json(res, 404, { error: "PLAN_NOT_FOUND" });
      try {
        return json(res, 200, {
          ok: true,
          data: runManager.cancelConstructionPlan(decodeURIComponent(match[1])),
        });
      } catch (error) {
        if (error instanceof ConstructionPlanError) return json(res, error.status, error.toJSON());
        throw error;
      }
    },
  });
}
