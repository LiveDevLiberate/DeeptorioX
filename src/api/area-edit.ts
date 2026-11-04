import { Router } from "../http/router.js";
import { json, readJsonBody, clampInt, parseRconJson } from "../http/plumbing.js";
import { arrayOf, asBoolean, asRecord, asString, errorMessage } from "../validation.js";
import { rconConfigured } from "./shared.js";
import {
  AREA_EDIT_DEFAULT_LIMIT,
  AREA_EDIT_DEFAULT_RADIUS,
  AREA_EDIT_MAX_LIMIT,
  AREA_EDIT_MAX_RADIUS,
  copySettingsCommand,
  normalizeCopyTargets,
  observeAreaCommand,
} from "../area-edit.js";
import type { ApiContext } from "./context.js";

/** Validated deconstruction-planner filter list (entity names/types). */
function filterList(value: unknown): string[] {
  return arrayOf(value, (item) => asString(item)).slice(0, 100);
}

/** Add the manager-style `truncated` flag to the Lua payload when it is an object. */
function withTruncated(data: unknown, truncated: boolean): unknown {
  const record = asRecord(data);
  return record ? { ...record, truncated } : data;
}

/**
 * P0-4 area-edit route group.
 *
 * Routes:
 *   POST /api/agent/observe/area         - deconstruct-planning entity list
 *   POST /api/agent/observe/copy-settings - dry-run: locate/reach/compat only
 *   POST /api/agent/act/copy-settings     - quick, reach-checked settings copy
 *
 * The copy endpoint is deliberately synchronous (no walking, no job queue): the
 * client observes reach, walks with `act-move`, then calls this route to paste
 * settings for entities the character can reach. Unreachable/incompatible pairs
 * are reported per target and never mutated. Register this group before
 * `registerJobsRoutes` so the quick action runs ahead of the `/act/` job guard.
 */
export function registerAreaEditRoutes(router: Router, ctx: ApiContext): void {
  const { state, rconCommand } = ctx;

  router.add({
    method: "POST",
    path: "/api/agent/observe/area",
    name: "/api/agent/observe/area",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const window = asRecord(body.window) ?? {};
      const x = clampInt(window.x, 0, -1000000, 1000000);
      const y = clampInt(window.y, 0, -1000000, 1000000);
      const radius = clampInt(window.radius, AREA_EDIT_DEFAULT_RADIUS, 1, AREA_EDIT_MAX_RADIUS);
      const limit = clampInt(body.limit, AREA_EDIT_DEFAULT_LIMIT, 1, AREA_EDIT_MAX_LIMIT);
      const types = filterList(body.types);
      const filters = filterList(body.filters);
      const playerOnly = asBoolean(body.player_only) === true;
      try {
        const response = await rconCommand(
          observeAreaCommand({ x, y, radius, types, filters, limit, playerOnly }),
          15_000,
        );
        const data = parseRconJson(response, "RCON area observation returned invalid JSON");
        return json(res, 200, { ok: true, data });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/copy-settings",
    name: "/api/agent/observe/copy-settings",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const requested = body.targets;
      if (!Array.isArray(requested)) return json(res, 400, { error: "Missing targets" });
      const targets = normalizeCopyTargets(requested);
      try {
        const response = await rconCommand(copySettingsCommand(targets, { dryRun: true }), 15_000);
        const data = parseRconJson(response, "RCON copy-settings analysis returned invalid JSON");
        return json(res, 200, { ok: true, data: withTruncated(data, requested.length > targets.length) });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/copy-settings",
    name: "/api/agent/act/copy-settings",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const requested = body.targets;
      if (!Array.isArray(requested)) return json(res, 400, { error: "Missing targets" });
      const targets = normalizeCopyTargets(requested);
      // `dry_run:true` is accepted here as an alias for the observe dry-run so a
      // client can preview and execute through the same action shape.
      const dryRun = asBoolean(body.dry_run) === true;
      try {
        const response = await rconCommand(copySettingsCommand(targets, { dryRun }), 15_000);
        const data = parseRconJson(response, "RCON copy-settings returned invalid JSON");
        return json(res, 200, { ok: true, data: withTruncated(data, requested.length > targets.length) });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });
}
