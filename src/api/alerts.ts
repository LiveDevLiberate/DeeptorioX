import { Router } from "../http/router.js";
import { json } from "../http/plumbing.js";
import type { ApiContext } from "./context.js";

/** Alert-state and acknowledgement routes. */
export function registerAlertRoutes(router: Router, ctx: ApiContext): void {
  const { alertStore, runManager } = ctx;

  router.add({
    method: "GET",
    path: "/api/agent/alerts",
    name: "/api/agent/alerts",
    handler: (request) => {
      const { res } = request;
      runManager.setAlertPenalty(alertStore.penalty());
      return json(res, 200, { ok: true, data: alertStore.envelope() });
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/alerts/ack",
    name: "/api/agent/alerts/ack",
    handler: (request) => {
      const { res } = request;
      const envelope = alertStore.ack();
      runManager.setAlertPenalty(envelope.penalty);
      return json(res, 200, { ok: true, data: envelope });
    },
  });
}
