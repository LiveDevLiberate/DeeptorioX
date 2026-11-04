import { Router } from "../http/router.js";
import { json, readJsonBody } from "../http/plumbing.js";
import { asRecord, asString } from "../validation.js";
import type { ApiContext } from "./context.js";
import type { StateWriteInput } from "../state-file.js";

/** Small helper: read an optional trimmed string field with a length cap. */
function optionalString(value: unknown, max = 2000): string | undefined {
  const text = asString(value)?.trim();
  return text ? text.slice(0, max) : undefined;
}

export function registerStateRoutes(router: Router, ctx: ApiContext): void {
  const { runManager } = ctx;

  router.add({
    method: "GET",
    path: "/api/agent/state",
    name: "/api/agent/state",
    handler: (_request) => {
      const { res } = _request;
      const status = runManager.stateStatus();
      if (!status) return json(res, 409, { error: "No active run" });
      return json(res, 200, { ok: true, data: status });
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/state",
    name: "/api/agent/state",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      const current = optionalString(body.current, 500);
      const markdown = optionalString(body.markdown, 8000);
      if (!current && !markdown) return json(res, 400, { error: "Missing current or markdown" });
      const scores: Record<string, number> = {};
      const scoreRecord = asRecord(body.scores);
      if (scoreRecord) {
        for (const [key, value] of Object.entries(scoreRecord)) {
          const score = Number(value);
          if (Number.isFinite(score)) scores[key] = score;
        }
      }
      const input: StateWriteInput = {
        current: current || "state update",
        markdown,
        objective: optionalString(body.objective),
        done_when: optionalString(body.done_when),
        next: optionalString(body.next),
        timebox: optionalString(body.timebox),
        progress: optionalString(body.progress),
        notes: optionalString(body.notes),
        scores,
      };
      try {
        const status = runManager.writeState(input);
        return json(res, 200, { ok: true, data: status });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json(res, message === "No active run" ? 409 : 400, { error: message });
      }
    },
  });
}
