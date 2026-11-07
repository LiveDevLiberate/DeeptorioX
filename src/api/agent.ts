import { Router } from "../http/router.js";
import { json, clampInt, parseRconJson, readJsonBody } from "../http/plumbing.js";
import { asRecord, asString, errorMessage, type JsonObject } from "../validation.js";
import { rconConfigured } from "./shared.js";
import { launchRocket } from "../rocket.js";
import { visualObservation } from "../vision.js";
import { mapOverviewPng, mapOverviewSvg } from "../map-overview.js";
import { entityUsage, entityUsageCatalog } from "../entity-usage.js";
import { summarizeConnectionsData } from "../connection-summary.js";
import { summarizeBeltLanesData } from "../belt-lanes.js";
import {
  buildRefactorAudit,
  coversDefaultRefactorScope,
  observationCenter,
  REFACTOR_DEBT_MIN_RADIUS,
  type RefactorScope,
} from "../refactor-audit.js";
import { buildPipelineGraph } from "../pipeline-graph.js";
import { encodeCapturedBlueprint } from "../blueprint-capture.js";
import { evaluateBlueprint } from "../blueprint-evaluate.js";
import { observeAreaCommand } from "../area-edit.js";
import { knowledgeCatalog, knowledgeTopic } from "../agent-knowledge.js";
import {
  agentBeltLanesCommand,
  agentBuildDestinationCommand,
  agentChartedResourcesCommand,
  agentClearBuildFootprintCommand,
  agentCompactWorldCommand,
  agentConnectionsCommand,
  agentCraftCommand,
  agentDescriptionCommand,
  agentEntityPrototypeCommand,
  agentExtractCommand,
  agentFactoryCommand,
  agentFreeSpaceCommand,
  agentInsertCommand,
  agentLayoutCommand,
  agentMapCommand,
  agentMapOverviewCommand,
  agentNativeBuildCommand,
  agentObserveEntityCommand,
  agentPlayerCommand,
  agentRecipesCommand,
  agentResearchCommand,
  agentResearchStartCommand,
  agentRotateCommand,
  agentSetRecipeCommand,
  type BuildRequest,
} from "../command-builders.js";
import type { ApiContext } from "./context.js";

const AGENT_DEFAULT_RADIUS = 12;
const AGENT_MAX_INVENTORY_SLOTS = 200;
const AGENT_MAX_EQUIPMENT_SLOTS = 50;
const AGENT_MAX_RECIPES = 300;
const AGENT_MAX_RESEARCH = 200;
const AGENT_MAX_ACTIONS = 50;
const BELT_LANES_DEFAULT_RADIUS = 32;
const BELT_LANES_MAX_RADIUS = 120;
const BELT_LANES_DEFAULT_LIMIT = 100;
const BELT_LANES_MAX_LIMIT = 300;

/** Short cache for the expensive charted-map scan (UI opens can overlap). */
const mapOverviewCache = new Map<string, { at: number; data: Record<string, unknown> }>();
const MAP_OVERVIEW_CACHE_MS = Math.max(0, Number(process.env.AUTORIO_MAP_CACHE_MS ?? 2000));

/** Raw JSON array or empty array; keeps the handlers' historical `[]` fallback. */
function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** JSON object or `{}`; keeps optional body access falling back identically. */
function recordOrEmpty(value: unknown): JsonObject {
  return asRecord(value) ?? {};
}

/**
 * `left < right` for values that are numbers at runtime. The assertion keeps the
 * exact JavaScript comparison semantics (NaN is still false, no coercion code).
 */
function lessThan(left: unknown, right: unknown): boolean {
  return (left as number) < (right as number);
}

/** `JSON.parse` for an RCON/Lua reply, keeping the raw text when it is not JSON. */
export function parseRconObservation(response: string): unknown {
  try {
    return JSON.parse(response);
  } catch {
    return response;
  }
}

/**
 * Historical window/coordinate coercion shared by the observe handlers:
 * numeric strings and null are accepted via `Number(value)`; non-finite values
 * become undefined (`null` becomes `0`, exactly like the original `Number(...)`).
 */
export function finiteNumberOrUndefined(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * Build requests from `{entities:[...]}`: entries need a truthy name and a
 * finite-convertible anchor, exactly like the historical inline filter. An
 * optional `underground_type` must be "input" or "output" when present.
 */
export function parseBuildRequests(value: unknown, max = AGENT_MAX_ACTIONS): BuildRequest[] {
  return arrayOrEmpty(value)
    .slice(0, max)
    .filter((entity) => {
      const record = asRecord(entity);
      const anchor = asRecord(record?.anchor);
      const underground = record?.underground_type;
      return (
        Boolean(record?.name) &&
        Number.isFinite(Number(anchor?.x)) &&
        Number.isFinite(Number(anchor?.y)) &&
        (underground === undefined || underground === "input" || underground === "output")
      );
    }) as BuildRequest[];
}

/** Placement analysis requests need a string name and a finite anchor, sliced to `max`. */
export function parsePlacementRequests(value: unknown, max = AGENT_MAX_ACTIONS): BuildRequest[] {
  return arrayOrEmpty(value)
    .slice(0, max)
    .filter((item) => {
      const record = asRecord(item);
      const anchor = asRecord(record?.anchor);
      return (
        typeof record?.name === "string" &&
        Number.isFinite(Number(anchor?.x)) &&
        Number.isFinite(Number(anchor?.y))
      );
    }) as BuildRequest[];
}

/** Targets with explicit x/y coordinates (the historical `!== undefined` check; null passes). */
export function parsePositionTargets(value: unknown, max = AGENT_MAX_ACTIONS): JsonObject[] {
  const hasPosition = (target: unknown): boolean => {
    const record = asRecord(target);
    return record?.x !== undefined && record?.y !== undefined;
  };
  return arrayOrEmpty(value).slice(0, max).filter(hasPosition) as JsonObject[];
}

/** `set-recipe` targets additionally require a truthy `recipe`. */
export function parseRecipeTargets(value: unknown, max = AGENT_MAX_ACTIONS): JsonObject[] {
  const hasRecipe = (target: unknown): boolean => {
    const record = asRecord(target);
    return record?.x !== undefined && record?.y !== undefined && Boolean(record.recipe);
  };
  return arrayOrEmpty(value).slice(0, max).filter(hasRecipe) as JsonObject[];
}

// Placement work is retried and moves only short distances, so a stuck native
// action is aborted quickly instead of holding the whole job for ten minutes.
const ACTION_TIMEOUT_MS = 120_000;
const BUILD_MOVE_TIMEOUT_MS = 120_000;
// The native move action finishes on the first tick at the goal; wait a couple
// of ticks before using the cursor so a running character cannot place a build
// from a stale cursor/movement frame.
const BUILD_SETTLE_MS = 120;
const settleBeforeBuild = () => new Promise<void>((resolve) => setTimeout(resolve, BUILD_SETTLE_MS));

// Observation normalizers: the Lua builders always send these arrays/objects,
// but older manager/game combinations can omit them. Each normalizer keeps the
// historical defaults for a JSON object and passes anything else through.

export function normalizeWorldData(data: unknown): unknown {
  const record = asRecord(data);
  if (!record) return data;
  record.entities = arrayOrEmpty(record.entities);
  const terrain = asRecord(record.terrain);
  if (terrain) {
    const rows = arrayOrEmpty(terrain.rows);
    terrain.rows = rows;
    for (const row of rows) {
      const rowRecord = asRecord(row);
      if (rowRecord) rowRecord.runs = arrayOrEmpty(rowRecord.runs);
    }
  }
  return record;
}

export function normalizeResearchData(data: unknown): unknown {
  const record = asRecord(data);
  if (!record) return data;
  const normalizeTechnology = (technology: unknown): void => {
    const tech = asRecord(technology);
    if (!tech) return;
    tech.ingredients = arrayOrEmpty(tech.ingredients);
    tech.prerequisites = arrayOrEmpty(tech.prerequisites);
    tech.missing_prerequisites = arrayOrEmpty(tech.missing_prerequisites);
  };
  normalizeTechnology(record.current);
  for (const key of ["queue", "available", "upgrades", "triggers", "locked", "completed"]) {
    const technologies = arrayOrEmpty(record[key]);
    record[key] = technologies;
    for (const technology of technologies) normalizeTechnology(technology);
  }
  return record;
}

export function normalizeConnectionsData(data: unknown): unknown {
  const record = asRecord(data);
  if (!record) return data;
  record.counts = asRecord(record.counts) ?? {};
  record.inserters = arrayOrEmpty(record.inserters);
  record.belts = arrayOrEmpty(record.belts);
  record.machines = arrayOrEmpty(record.machines);
  record.issues = arrayOrEmpty(record.issues);
  return record;
}

export function normalizeLayoutData(data: unknown): unknown {
  const record = asRecord(data);
  if (!record) return data;
  record.rows = arrayOrEmpty(record.rows);
  record.built_rows = arrayOrEmpty(record.built_rows);
  record.resource_rows = arrayOrEmpty(record.resource_rows);
  record.entities = arrayOrEmpty(record.entities);
  record.overlaps = arrayOrEmpty(record.overlaps);
  record.legend = asRecord(record.legend) ?? {};
  return record;
}

export function normalizeFactoryData(data: unknown): unknown {
  const record = asRecord(data);
  if (!record) return data;
  const counts = asRecord(record.counts) ?? {};
  record.counts = counts;
  for (const value of Object.values(counts)) {
    const entry = asRecord(value);
    if (entry) entry.statuses = asRecord(entry.statuses) ?? {};
  }
  const problems = asRecord(record.problems) ?? {};
  record.problems = problems;
  for (const key of [
    "no_fuel",
    "no_power",
    "no_input_fluid",
    "no_minable_resources",
    "waiting_for_space_in_destination",
    "no_ingredients",
    "missing_science_packs",
  ]) {
    problems[key] = arrayOrEmpty(problems[key]);
  }
  record.totals = asRecord(record.totals) ?? {};
  record.containers = asRecord(record.containers) ?? { total: 0, empty: 0 };
  record.empty_containers = arrayOrEmpty(record.empty_containers);
  record.alerts = arrayOrEmpty(record.alerts);
  return record;
}

export function normalizeEntityData(data: unknown): unknown {
  const record = asRecord(data);
  if (!record) return data;
  const results = arrayOrEmpty(record.results);
  record.results = results;
  for (const entity of results) {
    const item = asRecord(entity);
    if (!item) continue;
    const inventories = arrayOrEmpty(item.inventories);
    item.inventories = inventories;
    const fluidBoxes = arrayOrEmpty(item.fluid_boxes);
    item.fluid_boxes = fluidBoxes;
    for (const inventory of inventories) {
      const inv = asRecord(inventory);
      if (!inv) continue;
      inv.purposes = arrayOrEmpty(inv.purposes);
      inv.items = arrayOrEmpty(inv.items);
    }
    for (const fluidBox of fluidBoxes) {
      const box = asRecord(fluidBox);
      if (box) box.connections = arrayOrEmpty(box.connections);
    }
  }
  return record;
}

export function normalizePrototypeData(data: unknown): unknown {
  const record = asRecord(data);
  if (!record) return data;
  record.placeable_by = arrayOrEmpty(record.placeable_by);
  const fluidBoxes = arrayOrEmpty(record.fluid_boxes);
  record.fluid_boxes = fluidBoxes;
  record.fuel_categories = arrayOrEmpty(record.fuel_categories);
  for (const fluidBox of fluidBoxes) {
    const box = asRecord(fluidBox);
    if (!box) continue;
    const connections = arrayOrEmpty(box.pipe_connections);
    box.pipe_connections = connections;
    for (const connection of connections) {
      const conn = asRecord(connection);
      if (!conn) continue;
      conn.connection_category = arrayOrEmpty(conn.connection_category);
      conn.positions = arrayOrEmpty(conn.positions);
    }
  }
  return record;
}

/** Result of one native-control action (`NativeController.run` reply). */
type NativeActionResult = {
  ok?: unknown;
  error?: unknown;
  movement?: {
    final_position?: { x?: unknown; y?: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** `agentBuildDestinationCommand` reply: `{ok, position}` or `{ok:false,error}`. */
type BuildDestinationResult = {
  ok?: unknown;
  error?: unknown;
  in_reach?: unknown;
  staging?: unknown;
  position: { x?: unknown; y?: unknown };
};

/** `agentClearBuildFootprintCommand` reply. */
type ClearFootprintResult = {
  ok?: unknown;
  cleared?: unknown;
  pending?: unknown;
  skipped?: unknown;
};

/** `agentNativeBuildCommand` reply (success or `{ok:false,error,...}`). */
type RconBuildResult = {
  ok?: unknown;
  error?: unknown;
  [key: string]: unknown;
};

/** `agentRotateCommand` / `agentSetRecipeCommand` reply: `{results:[...]}`. */
type CommandResultsReply = { results?: unknown[]; [key: string]: unknown };

/** `agentInsertCommand` / `agentExtractCommand` reply. */
type ItemTransferResult = Record<string, unknown>;

/** `observe-placement` dry-run reply (diagnostics arrays are normalized below). */
type PlacementAnalysisResult = {
  ok?: unknown;
  can_place?: unknown;
  error?: unknown;
  diagnostics?: {
    nearest_valid_positions?: unknown;
    terrain?: { tile_names?: unknown } | null;
    collision?: { possible_blockers?: unknown } | null;
  } | null;
  [key: string]: unknown;
};

/** Accumulator for the build-footprint clearing passes. */
type ClearingSummary = {
  ok: boolean;
  cleared: unknown[];
  skipped: unknown[];
  passes: number;
  pending_remaining: number;
};

export function registerAgentRoutes(router: Router, ctx: ApiContext): void {
  const { state, runManager, actionJobs, nativeController, rconCommand } = ctx;

  const nativeAction = (payload: Record<string, unknown>): Promise<NativeActionResult> => {
    const job = actionJobs.currentJob;
    const { timeout_ms, ...action } = payload;
    const timeout = typeof timeout_ms === "number" && timeout_ms > 0 ? timeout_ms : 600_000;
    return nativeController.run(action, () => actionJobs.isCancelled(job), timeout);
  };
  type EntityTarget = { x: number; y: number; kind?: "resource" | "entity"; name?: string };

  async function moveNearEntity(target: EntityTarget): Promise<NativeActionResult> {
    return nativeAction({ kind: "approach", target: { ...target, kind: target.kind || "entity" } });
  }

  function movePlayerTo(x: number, y: number, timeoutMs?: number): Promise<NativeActionResult> {
    return nativeAction({ kind: "move", x, y, ...(timeoutMs ? { timeout_ms: timeoutMs } : {}) });
  }

  router.add({
    method: "POST",
    path: "/api/agent/observe/visual",
    name: "/api/agent/observe/visual",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      try {
        return json(
          res,
          200,
          await visualObservation(typeof body.title === "string" ? { title: body.title } : {}),
        );
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "Visual capture failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/world",
    name: "/api/agent/observe/world",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const window = recordOrEmpty(body.window);
      const include = Array.isArray(body.include) ? body.include : ["tiles", "entities"];
      const includeTiles = include.includes("terrain");
      const includeEntities = include.includes("entities");
      const radius = clampInt(window.radius, AGENT_DEFAULT_RADIUS, 1, 200);
      const x = clampInt(window.x, 0, -1000000, 1000000);
      const y = clampInt(window.y, 0, -1000000, 1000000);
      try {
        const response = await rconCommand(
          agentCompactWorldCommand({
            x,
            y,
            radius,
            includeTiles,
            includeEntities,
          }),
        );
        const data = parseRconObservation(response);
        const normalized = normalizeWorldData(data);
        const counts = recordOrEmpty(asRecord(normalized)?.counts);
        const truncated =
          (includeTiles && lessThan(counts.tiles_included, counts.tiles_total)) ||
          (includeEntities && lessThan(counts.entities_included, counts.entities_total));
        return json(res, 200, {
          ok: true,
          data: normalized,
          truncated,
        });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/map-overview",
    name: "/api/agent/observe/map-overview",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const window = recordOrEmpty(body.window);
      const x = clampInt(window.x, 0, -1000000, 1000000);
      const y = clampInt(window.y, 0, -1000000, 1000000);
      const radius = clampInt(window.radius, 128, 1, 1024);
      const size = clampInt(body.size, 96, 8, 160);
      try {
        const cacheKey = `${x},${y},${radius},${size}`;
        const cached = mapOverviewCache.get(cacheKey);
        let data: Record<string, unknown>;
        if (cached && Date.now() - cached.at < MAP_OVERVIEW_CACHE_MS) {
          data = cached.data;
        } else {
          const response = await rconCommand(agentMapOverviewCommand({ x, y, radius, size }));
          data = parseRconJson<Record<string, unknown>>(response, "RCON map overview returned invalid JSON");
          if (MAP_OVERVIEW_CACHE_MS > 0) {
            mapOverviewCache.set(cacheKey, { at: Date.now(), data });
            while (mapOverviewCache.size > 32) {
              const oldest = mapOverviewCache.keys().next().value;
              if (oldest === undefined) break;
              mapOverviewCache.delete(oldest);
            }
          }
        }
        if (body.format === "svg") {
          return json(res, 200, {
            ok: true,
            data: { ...data, format: "svg", svg: mapOverviewSvg(data) },
          });
        }
        if (body.format === "png") {
          return json(res, 200, {
            ok: true,
            data: { ...data, format: "png", png_base64: mapOverviewPng(data).toString("base64") },
          });
        }
        return json(res, 200, { ok: true, data });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/map",
    name: "/api/agent/observe/map",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const window = recordOrEmpty(body.window);
      const x = clampInt(window.x, 0, -1000000, 1000000);
      const y = clampInt(window.y, 0, -1000000, 1000000);
      const radius = clampInt(window.radius, 48, 1, 96);
      try {
        const response = await rconCommand(agentMapCommand({ x, y, radius }));
        return json(res, 200, {
          ok: true,
          data: parseRconJson(response, "RCON map returned invalid JSON"),
        });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/player",
    name: "/api/agent/observe/player",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const limits = recordOrEmpty(body.limits);
      const inventoryLimit = clampInt(
        limits.inventory_slots,
        AGENT_MAX_INVENTORY_SLOTS,
        1,
        AGENT_MAX_INVENTORY_SLOTS,
      );
      const equipmentLimit = clampInt(
        limits.equipment_slots,
        AGENT_MAX_EQUIPMENT_SLOTS,
        1,
        AGENT_MAX_EQUIPMENT_SLOTS,
      );
      try {
        const response = await rconCommand(agentPlayerCommand({ inventoryLimit, equipmentLimit }));
        const data = parseRconObservation(response);
        const counts = recordOrEmpty(asRecord(data)?.counts);
        const truncated =
          lessThan(counts.inventory_included, counts.inventory_total) ||
          lessThan(counts.equipment_included, counts.equipment_total);
        return json(res, 200, { ok: true, data, truncated });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/research",
    name: "/api/agent/observe/research",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const limits = recordOrEmpty(body.limits);
      const availableLimit = clampInt(limits.available, 50, 0, AGENT_MAX_RESEARCH);
      const lockedLimit = clampInt(limits.locked, 50, 0, AGENT_MAX_RESEARCH);
      const completedLimit = clampInt(limits.completed, 50, 0, AGENT_MAX_RESEARCH);
      try {
        const response = await rconCommand(
          agentResearchCommand({ availableLimit, lockedLimit, completedLimit }),
        );
        const data = parseRconObservation(response);
        const normalized = normalizeResearchData(data);
        const counts = recordOrEmpty(asRecord(normalized)?.counts);
        const truncated = {
          available: lessThan(counts.available_included, counts.available_total),
          locked: lessThan(counts.locked_included, counts.locked_total),
          completed: lessThan(counts.completed_included, counts.completed_total),
        };
        return json(res, 200, { ok: true, data: normalized, truncated });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/recipes",
    name: "/api/agent/observe/recipes",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const limits = recordOrEmpty(body.limits);
      const limit = clampInt(limits.recipes, AGENT_MAX_RECIPES, 1, AGENT_MAX_RECIPES);
      const filters = recordOrEmpty(body.filters);
      const unlockedOnly = Boolean(filters.unlocked);
      try {
        const response = await rconCommand(agentRecipesCommand({ limit, unlockedOnly }));
        const data = parseRconObservation(response);
        const counts = recordOrEmpty(asRecord(data)?.counts);
        const truncated = lessThan(counts.included, counts.total);
        return json(res, 200, { ok: true, data, truncated });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/build",
    name: "/api/agent/act/build",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const entities = arrayOrEmpty(body.entities);
      const limits = recordOrEmpty(body.limits);
      const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
      const trimmed = parseBuildRequests(entities, max);
      const refactorGate = runManager.refactorGate();
      if (refactorGate?.blocked) {
        return json(res, 409, {
          error: "REFACTOR_REQUIRED",
          message: refactorGate.message,
          refactor: refactorGate.state,
          nudge: {
            reason: "refactor_debt",
            first_step: "factory-audit",
            message:
              "Fix the highest-priority audit action (repair/rotate/connect the flagged tiles) and re-audit; deconstruct only flagged or obsolete entities and relayout a belt section only after 3 failed audits.",
          },
        });
      }
      const blueprintGate = runManager.blueprintGate();
      if (blueprintGate?.blocked) {
        return json(res, 409, {
          error: "BLUEPRINT_REQUIRED",
          message: blueprintGate.message,
          nudge: {
            reason: "no_blueprint",
            first_step: "blueprint-capture",
            message: "Capture the validated current cell before rebuilding.",
          },
        });
      }
      if (entities.length > 0 && trimmed.length === 0) {
        return json(res, 400, {
          error: "No valid build entities; each entity needs a name and anchor {x,y} (or x/y shorthand)",
        });
      }
      try {
        const results: Record<string, unknown>[] = [];
        for (const entity of trimmed) {
          // Clear obstacles from the current position first: walking the
          // character through a forest to a staging tile is much slower than
          // mining the trees that are already within reach.
          const placement = parseRconJson<BuildDestinationResult>(
            await rconCommand(agentBuildDestinationCommand(entity, false)),
            "RCON build destination returned invalid JSON",
          );
          if (!placement?.ok) {
            results.push({
              ok: false,
              name: entity.name,
              requested_anchor: entity.anchor,
              error: placement?.error || "no_reachable_staging_position",
            });
            continue;
          }
          const movement = await movePlayerTo(
            Number(placement.position.x),
            Number(placement.position.y),
            BUILD_MOVE_TIMEOUT_MS,
          );
          if (!movement.ok) {
            results.push({
              ok: false,
              name: entity.name,
              requested_anchor: entity.anchor,
              error: movement.error || "movement_failed",
              movement: movement.movement,
            });
            continue;
          }
          await settleBeforeBuild();
          let usedMovement = movement.movement;
          let clearing: ClearingSummary | null = null;
          const clearFootprint = async (acc: ClearingSummary) => {
            // Mining a tree leaves a stump that can still block placement, so
            // re-scan a few times until the footprint stops changing.
            for (let pass = 0; pass < 4; pass++) {
              const data = parseRconJson<ClearFootprintResult>(
                await rconCommand(agentClearBuildFootprintCommand(entity)),
                "RCON build clearing returned invalid JSON",
              );
              if (!data) break;
              acc.passes++;
              const cleared = arrayOrEmpty(data.cleared);
              const pending = arrayOrEmpty(data.pending);
              acc.cleared.push(...cleared);
              acc.skipped = arrayOrEmpty(data.skipped);
              let minedPending = 0;
              for (const target of pending.slice(0, 8)) {
                const targetRecord = asRecord(target) ?? {};
                const mined = await nativeAction({
                  kind: "mine",
                  target: {
                    x: Number(targetRecord.x),
                    y: Number(targetRecord.y),
                    kind: "entity",
                    name: targetRecord.name,
                  },
                  timeout_ms: ACTION_TIMEOUT_MS,
                });
                if (mined?.ok) {
                  acc.cleared.push({ name: targetRecord.name, type: targetRecord.type });
                  minedPending++;
                } else {
                  acc.skipped.push({
                    name: targetRecord.name,
                    type: targetRecord.type,
                    reason: mined?.error || "mine_failed",
                  });
                }
              }
              acc.pending_remaining = Math.max(0, pending.length - minedPending);
              if (cleared.length === 0 && minedPending === 0 && pending.length === 0) break;
              if (cleared.length === 0 && minedPending === 0 && pending.length > 0) {
                // Everything left is out of mining reach: step to a staging tile
                // once and re-scan instead of chasing single trees.
                const staging = parseRconJson<BuildDestinationResult>(
                  await rconCommand(agentBuildDestinationCommand(entity, true)),
                  "RCON build staging destination returned invalid JSON",
                );
                if (!staging?.ok) break;
                const walked = await movePlayerTo(
                  Number(staging.position.x),
                  Number(staging.position.y),
                  BUILD_MOVE_TIMEOUT_MS,
                );
                if (!walked.ok) break;
                await settleBeforeBuild();
                usedMovement = walked.movement;
              }
            }
            acc.ok = acc.skipped.length === 0 && (acc.pending_remaining ?? 0) === 0;
          };
          if (body.clear_obstacles !== false) {
            clearing = { ok: true, cleared: [], skipped: [], passes: 0, pending_remaining: 0 };
            await clearFootprint(clearing);
          }
          let response = await rconCommand(agentNativeBuildCommand(entity));
          let result = parseRconJson<RconBuildResult>(response, "RCON build returned invalid JSON");
          // A player standing on the new building's tiles also blocks placement:
          // step to a staging position, clear the opened footprint and retry.
          if (!result?.ok && result?.error === "cannot_build") {
            const retryDestination = parseRconJson<BuildDestinationResult>(
              await rconCommand(agentBuildDestinationCommand(entity, true)),
              "RCON build retry destination returned invalid JSON",
            );
            if (retryDestination?.ok) {
              const retryMovement = await movePlayerTo(
                Number(retryDestination.position.x),
                Number(retryDestination.position.y),
                BUILD_MOVE_TIMEOUT_MS,
              );
              if (retryMovement.ok) {
                await settleBeforeBuild();
                usedMovement = retryMovement.movement;
                if (clearing) await clearFootprint(clearing);
                response = await rconCommand(agentNativeBuildCommand(entity));
                result = parseRconJson<RconBuildResult>(response, "RCON build retry returned invalid JSON");
              }
            }
          }
          results.push({ ...result, movement: usedMovement, ...(clearing ? { clearing } : {}) });
        }
        return json(res, 200, {
          ok: true,
          data: { results },
          truncated: entities.length > trimmed.length,
        });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/mine",
    name: "/api/agent/act/mine",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const targets = arrayOrEmpty(body.targets);
      const limits = recordOrEmpty(body.limits);
      const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
      const trimmed = parsePositionTargets(targets, max);
      try {
        const results: Record<string, unknown>[] = [];
        for (const target of trimmed) {
          const result = await nativeAction({
            kind: "mine",
            target: {
              x: Number(target.x),
              y: Number(target.y),
              kind: target.kind,
              name: target.name,
              ...(target.allow_buildings === true ? { allow_buildings: true } : {}),
            },
          });
          results.push({ ...result, x: Number(target.x), y: Number(target.y) });
        }
        const automation = runManager.plan()?.automation;
        return json(res, 200, {
          ok: true,
          data: { results, ...(automation ? { automation } : {}) },
          truncated: targets.length > trimmed.length,
        });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/move",
    name: "/api/agent/act/move",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const targets = arrayOrEmpty(body.targets);
      const limits = recordOrEmpty(body.limits);
      const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
      const trimmed = parsePositionTargets(targets, max);
      try {
        const results: Record<string, unknown>[] = [];
        for (const target of trimmed) {
          const result = await movePlayerTo(Number(target.x) + 0.5, Number(target.y) + 0.5);
          results.push({
            ...result,
            x: Number(target.x),
            y: Number(target.y),
            moved_x: result.movement?.final_position?.x,
            moved_y: result.movement?.final_position?.y,
          });
        }
        return json(res, 200, {
          ok: true,
          data: { results },
          truncated: targets.length > trimmed.length,
        });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/path",
    name: "/api/agent/act/path",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const targets = parsePositionTargets(arrayOrEmpty(body.targets), 1);
      if (!targets.length) return json(res, 400, { error: "Missing target" });
      const target = targets[0];
      try {
        const result = await nativeAction({
          kind: "path",
          x: Number(target.x) + 0.5,
          y: Number(target.y) + 0.5,
        });
        return json(res, 200, {
          ok: true,
          data: { results: [{ ...result, x: Number(target.x), y: Number(target.y) }] },
          truncated: false,
        });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/rotate",
    name: "/api/agent/act/rotate",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const targets = arrayOrEmpty(body.targets);
      const limits = recordOrEmpty(body.limits);
      const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
      const trimmed = parsePositionTargets(targets, max).map((target) => {
        const record = asRecord(target);
        const direction = Number(record?.direction);
        return {
          x: Number(target.x),
          y: Number(target.y),
          ...([0, 4, 8, 12].includes(direction) ? { direction } : {}),
        };
      });
      try {
        const results: Record<string, unknown>[] = [];
        for (const target of trimmed) {
          const movement = await moveNearEntity({
            x: Number(target.x),
            y: Number(target.y),
          });
          if (!movement?.ok) {
            results.push({
              x: Number(target.x),
              y: Number(target.y),
              ...(target.direction !== undefined ? { direction: target.direction } : {}),
              ok: false,
              error: movement?.error || "movement_failed",
              movement: movement?.movement,
            });
            continue;
          }
          const response = await rconCommand(agentRotateCommand([target]));
          const data = parseRconJson<CommandResultsReply>(response, "RCON rotate returned invalid JSON");
          const entry = data?.results?.[0];
          if (!entry) {
            results.push({
              x: Number(target.x),
              y: Number(target.y),
              ...(target.direction !== undefined ? { direction: target.direction } : {}),
              ok: false,
              error: "rotate_failed",
            });
          } else {
            results.push({ ...(entry as Record<string, unknown>), movement: movement.movement });
          }
        }
        return json(res, 200, {
          ok: true,
          data: { results },
          truncated: targets.length > trimmed.length,
        });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/launch-rocket",
    name: "/api/agent/act/launch-rocket",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const targets = arrayOrEmpty(body.targets);
      const max = clampInt(recordOrEmpty(body.limits).max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
      const trimmed = targets.slice(0, max);
      try {
        const results = [];
        const job = actionJobs.currentJob;
        for (const target of trimmed) {
          const targetRecord = asRecord(target);
          results.push(
            await launchRocket({ x: targetRecord?.x, y: targetRecord?.y }, moveNearEntity, rconCommand, () =>
              actionJobs.isCancelled(job),
            ),
          );
        }
        return json(res, 200, { ok: true, data: { results }, truncated: targets.length > trimmed.length });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/set-recipe",
    name: "/api/agent/act/set-recipe",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const targets = arrayOrEmpty(body.targets);
      const limits = recordOrEmpty(body.limits);
      const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
      const trimmed = parseRecipeTargets(targets, max);
      try {
        const results: Record<string, unknown>[] = [];
        for (const target of trimmed) {
          const movement = await moveNearEntity({
            x: Number(target.x),
            y: Number(target.y),
          });
          if (!movement?.ok) {
            results.push({
              x: Number(target.x),
              y: Number(target.y),
              ok: false,
              error: movement?.error || "movement_failed",
              movement: movement?.movement,
            });
            continue;
          }
          const response = await rconCommand(
            agentSetRecipeCommand([
              { x: Number(target.x), y: Number(target.y), recipe: target.recipe as string },
            ]),
          );
          const data = parseRconJson<CommandResultsReply>(response, "RCON set-recipe returned invalid JSON");
          const entry = data?.results?.[0];
          if (!entry) {
            results.push({
              x: Number(target.x),
              y: Number(target.y),
              ok: false,
              error: "set_recipe_failed",
            });
          } else {
            results.push({ ...(entry as Record<string, unknown>), movement: movement.movement });
          }
        }
        return json(res, 200, {
          ok: true,
          data: { results },
          truncated: targets.length > trimmed.length,
        });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/craft",
    name: "/api/agent/act/craft",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const recipe = asString(body.item) || asString(body.recipe);
      const count = clampInt(body.count, 1, 1, 10000);
      if (!recipe) {
        return json(res, 400, { error: "Missing recipe" });
      }
      try {
        const response = await rconCommand(agentCraftCommand(recipe, count));
        const data = parseRconObservation(response);
        const record = asRecord(data);
        if (record && record.ok === false) {
          return json(res, 400, {
            error: record.error || "Extract failed",
            data,
          });
        }
        const automation = runManager.plan()?.automation;
        return json(res, 200, { ok: true, data: automation ? { ...(data as object), automation } : data });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/insert",
    name: "/api/agent/act/insert",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const to = recordOrEmpty(asRecord(body.to)?.entity || body.entity);
      const item = asString(body.item);
      const count = clampInt(body.count, 1, 1, 100000);
      if (!item) {
        return json(res, 400, { error: "Missing item" });
      }
      if (to.x === undefined || to.y === undefined) {
        return json(res, 400, { error: "Missing target" });
      }
      try {
        const movement = await moveNearEntity({ x: Number(to.x), y: Number(to.y) });
        if (!movement?.ok) {
          return json(res, 200, {
            ok: true,
            data: { ok: false, error: movement?.error || "movement_failed", movement: movement?.movement },
          });
        }
        const response = await rconCommand(
          agentInsertCommand({ x: Number(to.x), y: Number(to.y), item, count }),
        );
        const data = parseRconJson<ItemTransferResult>(response, "RCON insert returned invalid JSON");
        return json(res, 200, { ok: true, data: { ...data, movement: movement.movement } });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/extract",
    name: "/api/agent/act/extract",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const from = recordOrEmpty(asRecord(body.from)?.entity || body.entity);
      const item = asString(body.item);
      const rawCount = body.count;
      const countAll = rawCount === "all" || rawCount === -1;
      const count: number | "all" = countAll ? "all" : clampInt(rawCount, 1, 1, 100000);
      if (!item) {
        return json(res, 400, { error: "Missing item" });
      }
      if (from.x === undefined || from.y === undefined) {
        return json(res, 400, { error: "Missing target" });
      }
      try {
        const movement = await moveNearEntity({ x: Number(from.x), y: Number(from.y) });
        if (!movement?.ok) {
          return json(res, 200, {
            ok: true,
            data: { ok: false, error: movement?.error || "movement_failed", movement: movement?.movement },
          });
        }
        const response = await rconCommand(
          agentExtractCommand({
            x: Number(from.x),
            y: Number(from.y),
            item,
            count,
          }),
        );
        const data = parseRconJson<ItemTransferResult>(response, "RCON extract returned invalid JSON");
        return json(res, 200, { ok: true, data: { ...data, movement: movement.movement } });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/connections",
    name: "/api/agent/observe/connections",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const window = recordOrEmpty(body.window);
      const x = finiteNumberOrUndefined(window.x);
      const y = finiteNumberOrUndefined(window.y);
      const radius = clampInt(window.radius, 120, 1, 256);
      try {
        const response = await rconCommand(agentConnectionsCommand({ x, y, radius }));
        const data = summarizeConnectionsData(
          normalizeConnectionsData(
            parseRconJson<unknown>(response, "RCON connection audit returned invalid JSON"),
          ),
        );
        return json(res, 200, { ok: true, data });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/belts",
    name: "/api/agent/observe/belts",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const window = recordOrEmpty(body.window);
      const x = finiteNumberOrUndefined(window.x);
      const y = finiteNumberOrUndefined(window.y);
      const radius = clampInt(window.radius, BELT_LANES_DEFAULT_RADIUS, 1, BELT_LANES_MAX_RADIUS);
      const limit = clampInt(body.limit, BELT_LANES_DEFAULT_LIMIT, 1, BELT_LANES_MAX_LIMIT);
      const targets = parsePositionTargets(body.targets, AGENT_MAX_ACTIONS)
        .map((target) => ({ x: Number(target.x), y: Number(target.y) }))
        .filter((target) => Number.isFinite(target.x) && Number.isFinite(target.y));
      try {
        const response = await rconCommand(agentBeltLanesCommand({ x, y, radius, limit, targets }));
        const data = summarizeBeltLanesData(
          parseRconJson<unknown>(response, "RCON belt lane observation returned invalid JSON"),
        );
        return json(res, 200, { ok: true, data });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/blueprints/evaluate",
    name: "/api/agent/blueprints/evaluate",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      const runId = runManager.activeRunId();
      let wire = asString(body.blueprint)?.trim();
      let label = asString(body.label)?.trim();
      const blueprintId = asString(body.blueprint_id)?.trim();
      if (!wire && blueprintId) {
        if (!runId) return json(res, 409, { error: "No active run" });
        const stored = runManager.blueprint(runId, blueprintId);
        if (!stored) return json(res, 404, { error: "Blueprint not found" });
        wire = stored.wire;
        label = label || stored.label;
      }
      if (!wire) return json(res, 400, { error: "Missing blueprint or blueprint_id" });
      const outputs: Record<string, number> = {};
      const rawOutputs = asRecord(body.outputs);
      if (rawOutputs) {
        for (const [item, value] of Object.entries(rawOutputs)) {
          const rate = Number(value);
          if (Number.isFinite(rate)) outputs[item] = rate;
        }
      }
      try {
        const evaluation = evaluateBlueprint({
          wire,
          blueprintId: blueprintId || undefined,
          label,
          outputs,
          powerKw: Number(body.power_kw) || 0,
          buildSeconds: Number(body.build_seconds) || 0,
        });
        return json(res, 200, { ok: true, data: evaluation });
      } catch (error) {
        return json(res, 400, { error: errorMessage(error) });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/blueprints/capture",
    name: "/api/agent/blueprints/capture",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const runId = runManager.activeRunId();
      if (!runId) return json(res, 409, { error: "No active run" });
      const window = recordOrEmpty(body.window);
      const x = finiteNumberOrUndefined(window.x) ?? 0;
      const y = finiteNumberOrUndefined(window.y) ?? 0;
      const radius = clampInt(window.radius, 80, 1, 200);
      const label = asString(body.label)?.trim() || "Captured layout";
      const description = asString(body.description)?.trim() || "";
      try {
        const response = await rconCommand(
          observeAreaCommand({
            x,
            y,
            radius,
            limit: 500,
            types: [],
            filters: [],
            playerOnly: true,
          }),
          15_000,
        );
        const area = parseRconJson<unknown>(response, "RCON blueprint capture returned invalid JSON");
        const record = asRecord(area);
        const entities = Array.isArray(record?.entities) ? record.entities : [];
        const captured = encodeCapturedBlueprint(entities, label, description);
        const blueprint = runManager.registerBlueprint(runId, {
          blueprint: captured.wire,
          label,
          description,
          source: "built",
        });
        return json(res, 201, {
          ok: true,
          data: { blueprint, entity_count: captured.payload.blueprint.entities.length, wire: captured.wire },
        });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "Blueprint capture failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/pipeline",
    name: "/api/agent/observe/pipeline",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const window = recordOrEmpty(body.window);
      const x = finiteNumberOrUndefined(window.x) ?? 0;
      const y = finiteNumberOrUndefined(window.y) ?? 0;
      const radius = clampInt(window.radius, 80, 1, 200);
      const areaTypes = [
        "furnace",
        "assembling-machine",
        "chemical-plant",
        "oil-refinery",
        "lab",
        "mining-drill",
        "pumpjack",
        "centrifuge",
        "boiler",
        "generator",
        "rocket-silo",
        "recycler",
        "pipe",
        "pipe-to-ground",
        "pump",
        "offshore-pump",
        "storage-tank",
        "electric-pole",
        "substation",
        "accumulator",
        "solar-panel",
        "transport-belt",
        "underground-belt",
        "splitter",
      ];
      try {
        const [factoryResponse, connectionsResponse, areaResponse] = await Promise.all([
          rconCommand(agentFactoryCommand({ x, y, radius })),
          rconCommand(agentConnectionsCommand({ x, y, radius })),
          rconCommand(
            observeAreaCommand({
              x,
              y,
              radius,
              limit: 500,
              types: areaTypes,
              filters: [],
              playerOnly: true,
            }),
          ),
        ]);
        const factory = normalizeFactoryData(
          parseRconJson<unknown>(factoryResponse, "RCON factory observation returned invalid JSON"),
        );
        const connections = normalizeConnectionsData(
          parseRconJson<unknown>(connectionsResponse, "RCON connection observation returned invalid JSON"),
        );
        const area = parseRconJson<unknown>(areaResponse, "RCON area observation returned invalid JSON");
        const flows: Record<string, number> = {};
        const rawFlows = recordOrEmpty(body.flows);
        for (const [id, value] of Object.entries(rawFlows)) {
          const rate = Number(value);
          if (Number.isFinite(rate)) flows[id] = rate;
        }
        const graph = buildPipelineGraph(factory, connections, area, { x, y, radius, flows });
        return json(res, 200, { ok: true, data: graph });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/audit",
    name: "/api/agent/observe/audit",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const window = recordOrEmpty(body.window);
      const x = finiteNumberOrUndefined(window.x);
      const y = finiteNumberOrUndefined(window.y);
      const radius = clampInt(window.radius, 120, 1, 200);
      try {
        const [factoryResponse, connectionsResponse] = [
          await rconCommand(agentFactoryCommand({ x, y, radius })),
          await rconCommand(agentConnectionsCommand({ x, y, radius })),
        ];
        const factory = normalizeFactoryData(
          parseRconJson<unknown>(factoryResponse, "RCON factory audit returned invalid JSON"),
        );
        const connections = normalizeConnectionsData(
          parseRconJson<unknown>(connectionsResponse, "RCON connection audit returned invalid JSON"),
        );
        const requestedScope = Array.isArray(body.scope)
          ? body.scope.filter((entry): entry is string => typeof entry === "string")
          : undefined;
        // The Lua scan defaults omitted coordinates to the player position; use
        // that echoed window for cleanup hints and debt bookkeeping instead of
        // pinning the audit to the map origin.
        const scanCenter = observationCenter(factory) ?? observationCenter(connections);
        const center = { x: x ?? scanCenter?.x ?? 0, y: y ?? scanCenter?.y ?? 0 };
        const audit = buildRefactorAudit(factory, connections, {
          center,
          radius,
          scope: requestedScope as RefactorScope[] | undefined,
          includeRail: body.include_rail === true,
        });
        // A narrow scope or a small local window must not clear the run's global
        // debt by scanning a clean corner; those audits stay advisory only.
        const debtRecorded = coversDefaultRefactorScope(requestedScope) && radius >= REFACTOR_DEBT_MIN_RADIUS;
        if (debtRecorded) {
          runManager.recordRefactorAudit({
            invalid_count: audit.summary.invalid_count,
            factory_problems: audit.summary.factory_problems,
            connection_issues: audit.summary.connection_issues,
            fingerprint: audit.fingerprint,
          });
        }
        return json(res, 200, { ok: true, data: { ...audit, debt_recorded: debtRecorded } });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/free-space",
    name: "/api/agent/observe/free-space",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const window = recordOrEmpty(body.window);
      const x = finiteNumberOrUndefined(window.x);
      const y = finiteNumberOrUndefined(window.y);
      const radius = clampInt(window.radius, 60, 1, 120);
      const step = clampInt(body.step, 1, 1, 8);
      try {
        const response = await rconCommand(agentFreeSpaceCommand({ x, y, radius, step }), 15_000);
        const data = parseRconJson<unknown>(response, "RCON free-space observation returned invalid JSON");
        return json(res, 200, { ok: true, data });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/layout",
    name: "/api/agent/observe/layout",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const window = recordOrEmpty(body.window);
      const x = finiteNumberOrUndefined(window.x);
      const y = finiteNumberOrUndefined(window.y);
      const radius = clampInt(window.radius, 35, 1, 80);
      const step = clampInt(window.step, 1, 1, 8);
      try {
        const response = await rconCommand(agentLayoutCommand({ x, y, radius, step }));
        const data = normalizeLayoutData(
          parseRconJson<unknown>(response, "RCON layout observation returned invalid JSON"),
        );
        return json(res, 200, { ok: true, data });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/factory",
    name: "/api/agent/observe/factory",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const window = recordOrEmpty(body.window);
      const x = finiteNumberOrUndefined(window.x);
      const y = finiteNumberOrUndefined(window.y);
      const radius = clampInt(window.radius, 120, 1, 256);
      try {
        const response = await rconCommand(agentFactoryCommand({ x, y, radius }));
        const data = normalizeFactoryData(
          parseRconJson<unknown>(response, "RCON factory observation returned invalid JSON"),
        );
        ctx.alertStore.ingest(data);
        ctx.runManager.setAlertPenalty(ctx.alertStore.penalty());
        const plan = runManager.plan();
        if (plan) (data as JsonObject).plan = plan;
        const state = runManager.stateStatus();
        if (state) (data as JsonObject).state = state;
        return json(res, 200, { ok: true, data });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/entity",
    name: "/api/agent/observe/entity",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const targets = arrayOrEmpty(body.targets);
      const limits = recordOrEmpty(body.limits);
      const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
      const trimmed = parsePositionTargets(targets, max);
      try {
        const response = await rconCommand(
          agentObserveEntityCommand(trimmed as Array<{ x: number; y: number; kind?: string; name?: string }>),
        );
        const data = parseRconObservation(response);
        const normalized = normalizeEntityData(data);
        return json(res, 200, {
          ok: true,
          data: normalized,
          truncated: targets.length > trimmed.length,
        });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/placement",
    name: "/api/agent/observe/placement",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const placements = arrayOrEmpty(body.placements);
      const valid = parsePlacementRequests(placements);
      try {
        const results = [];
        for (const item of valid) {
          const result = parseRconJson<PlacementAnalysisResult>(
            await rconCommand(agentNativeBuildCommand(item, true)),
            "RCON placement analysis returned invalid JSON",
          );
          const diagnostics = result?.diagnostics;
          if (diagnostics) {
            diagnostics.nearest_valid_positions = arrayOrEmpty(diagnostics.nearest_valid_positions);
            if (diagnostics.terrain)
              diagnostics.terrain.tile_names = arrayOrEmpty(diagnostics.terrain.tile_names);
            if (diagnostics.collision)
              diagnostics.collision.possible_blockers = arrayOrEmpty(diagnostics.collision.possible_blockers);
          }
          results.push(result);
        }
        return json(res, 200, {
          ok: true,
          data: { results },
          truncated: placements.length > valid.length,
        });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/resources",
    name: "/api/agent/observe/resources",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const window = recordOrEmpty(body.window);
      const radius = clampInt(window.radius, 50, 1, 500);
      const x = clampInt(window.x, 0, -1000000, 1000000);
      const y = clampInt(window.y, 0, -1000000, 1000000);
      try {
        const response = await rconCommand(agentChartedResourcesCommand({ x, y, radius }), 15_000);
        const data = parseRconObservation(response);
        const record = asRecord(data);
        if (record) {
          record.patches = arrayOrEmpty(record.patches);
          record.shoreline_candidates = arrayOrEmpty(record.shoreline_candidates);
        }
        return json(res, 200, { ok: true, data });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "GET",
    path: "/api/agent/knowledge",
    name: "/api/agent/knowledge",
    handler: ({ res, url }) => {
      const topic = url.searchParams.get("topic");
      if (topic) {
        const entry = knowledgeTopic(topic);
        if (!entry) {
          const known = knowledgeCatalog().topics.map((item) => item.id);
          return json(res, 404, { error: "Unknown knowledge topic", topic, known });
        }
        return json(res, 200, { ok: true, data: entry });
      }
      return json(res, 200, { ok: true, data: knowledgeCatalog() });
    },
  });

  router.add({
    method: "GET",
    path: "/api/agent/observe/entity-usage-catalog",
    name: "/api/agent/observe/entity-usage-catalog",
    handler: (request) => {
      const { res } = request;
      return json(res, 200, { ok: true, data: entityUsageCatalog() });
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/entity-usage",
    name: "/api/agent/observe/entity-usage",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const name = asString(body.name)?.trim();
      if (!name) return json(res, 400, { error: "Missing entity name" });
      try {
        const response = await rconCommand(agentEntityPrototypeCommand(name));
        const data = normalizePrototypeData(parseRconObservation(response));
        const record = asRecord(data);
        if (!record || record.ok === false) return json(res, 404, { error: "Unknown entity", name });
        return json(res, 200, {
          ok: true,
          data: {
            ...entityUsage({ name: record.name, type: record.type }),
            limits: {
              tile_size: record.tile_size ?? null,
              rotatable: record.rotatable ?? null,
              energy_source: record.energy_source ?? null,
              fluid_boxes: Array.isArray(record.fluid_boxes) ? record.fluid_boxes.length : 0,
              placeable_by: record.placeable_by ?? [],
              max_health: record.max_health ?? null,
            },
            prototype: data,
          },
        });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/description",
    name: "/api/agent/observe/description",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const kind = asString(body.kind)?.trim().toLowerCase();
      const name = asString(body.name)?.trim();
      if (kind !== "entity" && kind !== "technology")
        return json(res, 400, { error: 'kind must be "entity" or "technology"' });
      if (!name) return json(res, 400, { error: "Missing prototype name" });
      try {
        const response = await rconCommand(agentDescriptionCommand(kind, name));
        if (response.trim() === "__AUTORIO_UNKNOWN__")
          return json(res, 404, { error: "Prototype not found", kind, name });
        const lines = response.replace(/\r\n/g, "\n").split("\n");
        const meta = parseRconJson<Record<string, unknown>>(
          lines.shift() || "{}",
          "prototype description returned invalid JSON",
        );
        const text = lines.join("\n").trim();
        const missing = /^Unknown key:/.test(text);
        return json(res, 200, {
          ok: true,
          data: {
            kind,
            name: asString(meta.name) || name,
            description_key: meta.raw ?? null,
            description: missing || !text ? null : text,
            missing_translation: missing || !text,
          },
        });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/entity-prototype",
    name: "/api/agent/observe/entity-prototype",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const name = asString(body.name);
      if (!name) {
        return json(res, 400, { error: "Missing entity name" });
      }
      try {
        const response = await rconCommand(agentEntityPrototypeCommand(name));
        const data = parseRconObservation(response);
        const normalized = normalizePrototypeData(data);
        const record = asRecord(normalized);
        if (record && record.ok === false) {
          return json(res, 400, { error: record.error || "Unknown entity", data: normalized });
        }
        return json(res, 200, { ok: true, data: normalized });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/research",
    name: "/api/agent/act/research",
    handler: async (request) => {
      const { req, res } = request;
      const parsedBody = await readJsonBody(req);
      if (!parsedBody.ok) return json(res, 400, { error: parsedBody.error });
      const body = parsedBody.body;
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const technology = asString(body.technology);
      if (!technology) {
        return json(res, 400, { error: "Missing technology" });
      }
      try {
        const response = await rconCommand(agentResearchStartCommand(technology));
        const data = parseRconObservation(response);
        const record = asRecord(data);
        if (record && record.ok === false) {
          return json(res, 400, { error: record.error || "Research failed", data });
        }
        return json(res, 200, { ok: true, data });
      } catch (err) {
        return json(res, 500, { error: errorMessage(err) || "RCON command failed" });
      }
    },
  });
}
