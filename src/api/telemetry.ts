// Telemetry / extended observation routes for the manager:
//   POST /api/agent/observe/production -> sampler window (rates, deltas, research, rockets)
//   POST /api/agent/observe/fluids     -> fluid networks/levels around a window
//   POST /api/agent/observe/combat     -> enemy/turret/player read-only scan
//
// The routes follow the existing `/api/agent/observe/*` conventions: JSON
// schema v2 envelope, `{ok, data}` on success, 400 for malformed JSON bodies,
// 409 when RCON is not configured/connected and 500 for RCON failures.

import type { Router } from "../http/router.js";
import { clampInt, json, parseRconJson, readJsonBody } from "../http/plumbing.js";
import { asRecord, errorMessage, type JsonObject } from "../validation.js";
import { combatScanCommand, fluidNetworkCommand } from "../observation-builders.js";
import type { TelemetrySampler } from "../telemetry-sampler.js";
import { rconConfigured } from "./shared.js";

/** The manager surface these routes need; structurally a subset of `ApiContext`. */
export type TelemetryRouteContext = {
  state: { rcon: { connected: boolean } };
  rconCommand: (command: string, timeoutMs?: number) => Promise<string>;
};

const FLUID_DEFAULT_RADIUS = 32;
const FLUID_MAX_RADIUS = 128;
const COMBAT_DEFAULT_RADIUS = 64;
const COMBAT_MAX_RADIUS = 256;
const OBSERVE_TIMEOUT_MS = 15_000;

function recordOrEmpty(value: unknown): JsonObject {
  return asRecord(value) ?? {};
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Center/radius from the request body. `{x,y,radius}` is the documented form;
 * the legacy nested `{window:{x,y,radius}}` shape is accepted for consistency
 * with the other observe endpoints.
 */
function observationWindow(body: JsonObject): JsonObject {
  return asRecord(body.window) ?? body;
}

/** Historical `Number()` coercion: undefined/NaN -> omitted, null/invalid strings -> 0. */
function finiteNumberOrUndefined(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : undefined;
}

/** Ensures the fluid scan reply has the documented arrays/objects/primitive defaults. */
export function normalizeFluidData(value: unknown): JsonObject {
  const data = recordOrEmpty(value);
  data.window = recordOrEmpty(data.window);
  data.counts = recordOrEmpty(data.counts);
  data.fluids = recordOrEmpty(data.fluids);
  data.entities = arrayOrEmpty(data.entities);
  if (typeof data.scanned !== "number") data.scanned = 0;
  if (typeof data.truncated !== "boolean") data.truncated = false;
  return data;
}

/** Ensures the combat scan reply has the documented defaults (recent damage is not derivable). */
export function normalizeCombatData(value: unknown): JsonObject {
  const data = recordOrEmpty(value);
  data.window = recordOrEmpty(data.window);
  const counts = recordOrEmpty(data.counts);
  counts.by_force = recordOrEmpty(counts.by_force);
  counts.by_type = recordOrEmpty(counts.by_type);
  if (typeof counts.enemy_total !== "number") counts.enemy_total = 0;
  if (typeof counts.turrets !== "number") counts.turrets = 0;
  data.counts = counts;
  data.nests = arrayOrEmpty(data.nests);
  data.turrets = arrayOrEmpty(data.turrets);
  data.player = asRecord(data.player) ?? null;
  if (data.recent_damage === undefined) data.recent_damage = null;
  if (typeof data.recent_damage_note !== "string")
    data.recent_damage_note =
      "compare player.health across observe-combat calls; one RCON reply cannot derive recent damage";
  if (typeof data.scanned !== "number") data.scanned = 0;
  return data;
}

/**
 * Registers the telemetry/observation route group. `sampler` is the manager-wide
 * `createTelemetrySampler()` instance; handlers only dereference it at call time,
 * so registration itself has no side effects.
 */
export function registerTelemetryRoutes(
  router: Router,
  ctx: TelemetryRouteContext,
  sampler: TelemetrySampler,
): void {
  router.add({
    method: "POST",
    path: "/api/agent/observe/production",
    name: "/api/agent/observe/production",
    handler: async ({ req, res }) => {
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      let current = sampler.snapshot();
      if (current.samples === 0) {
        // A live sample makes the first call useful; failures still report 409.
        try {
          await sampler.sampleOnce();
        } catch {
          /* the sampler is fail-soft; report "not ready" below */
        }
        current = sampler.snapshot();
      }
      if (current.samples === 0) return json(res, 409, { error: "telemetry not ready" });
      return json(res, 200, {
        ok: true,
        data: {
          window_seconds: current.window_seconds,
          production_per_minute: current.production_per_minute,
          deltas: current.deltas,
          research: current.research,
          rockets: current.rockets,
          samples: current.samples,
          generated_at: new Date().toISOString(),
        },
      });
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/fluids",
    name: "/api/agent/observe/fluids",
    handler: async ({ req, res }) => {
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!ctx.state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const window = observationWindow(parsedBody.body);
      const x = finiteNumberOrUndefined(window.x);
      const y = finiteNumberOrUndefined(window.y);
      const radius = clampInt(window.radius, FLUID_DEFAULT_RADIUS, 1, FLUID_MAX_RADIUS);
      try {
        const response = await ctx.rconCommand(fluidNetworkCommand({ x, y, radius }), OBSERVE_TIMEOUT_MS);
        const data = normalizeFluidData(
          parseRconJson<unknown>(response, "RCON fluid scan returned invalid JSON"),
        );
        return json(res, 200, { ok: true, data });
      } catch (error) {
        return json(res, 500, { error: errorMessage(error) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/combat",
    name: "/api/agent/observe/combat",
    handler: async ({ req, res }) => {
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!ctx.state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const window = observationWindow(parsedBody.body);
      const x = finiteNumberOrUndefined(window.x);
      const y = finiteNumberOrUndefined(window.y);
      const radius = clampInt(window.radius, COMBAT_DEFAULT_RADIUS, 1, COMBAT_MAX_RADIUS);
      try {
        const response = await ctx.rconCommand(combatScanCommand({ x, y, radius }), OBSERVE_TIMEOUT_MS);
        const data = normalizeCombatData(
          parseRconJson<unknown>(response, "RCON combat scan returned invalid JSON"),
        );
        return json(res, 200, { ok: true, data });
      } catch (error) {
        return json(res, 500, { error: errorMessage(error) || "RCON command failed" });
      }
    },
  });
}
