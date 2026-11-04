import { Router } from "../http/router.js";
import { json } from "../http/plumbing.js";
import type { ApiContext } from "./context.js";

export function registerManagerRoutes(router: Router, ctx: ApiContext): void {
  const { shutdown } = ctx;

  router.add({
    method: "POST",
    path: "/api/manager/stop",
    name: "/api/manager/stop",
    handler: (request) => {
      const { res } = request;
      json(res, 202, { shutting_down: true });
      setTimeout(() => {
        void shutdown("SIGTERM");
      }, 100);
      return;
    },
  });
}
