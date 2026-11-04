import { Router } from "../http/router.js";
import { json, readJson, clampInt, parseRconJson } from "../http/plumbing.js";
import { rconConfigured } from "./shared.js";
import { launchRocket } from "../rocket.js";
import { visualObservation } from "../vision.js";
import {
  agentBuildDestinationCommand,
  agentChartedResourcesCommand,
  agentClearBuildFootprintCommand,
  agentCompactWorldCommand,
  agentConnectionsCommand,
  agentCraftCommand,
  agentEntityPrototypeCommand,
  agentExtractCommand,
  agentFactoryCommand,
  agentInsertCommand,
  agentLayoutCommand,
  agentMapCommand,
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

function arrayOrEmpty(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function normalizeWorldData(data: any) {
  if (!data || typeof data !== "object") return data;
  data.entities = arrayOrEmpty(data.entities);
  if (data.terrain && typeof data.terrain === "object") {
    data.terrain.rows = arrayOrEmpty(data.terrain.rows);
    for (const row of data.terrain.rows) row.runs = arrayOrEmpty(row?.runs);
  }
  return data;
}

function normalizeResearchData(data: any) {
  if (!data || typeof data !== "object") return data;
  const normalizeTechnology = (technology: any) => {
    if (!technology || typeof technology !== "object") return;
    technology.ingredients = arrayOrEmpty(technology.ingredients);
    technology.prerequisites = arrayOrEmpty(technology.prerequisites);
    technology.missing_prerequisites = arrayOrEmpty(technology.missing_prerequisites);
  };
  normalizeTechnology(data.current);
  for (const key of ["queue", "available", "upgrades", "triggers", "locked", "completed"]) {
    data[key] = arrayOrEmpty(data[key]);
    for (const technology of data[key]) normalizeTechnology(technology);
  }
  return data;
}

function normalizeConnectionsData(data: any) {
  if (!data || typeof data !== "object") return data;
  data.counts = data.counts && typeof data.counts === "object" ? data.counts : {};
  data.inserters = arrayOrEmpty(data.inserters);
  data.belts = arrayOrEmpty(data.belts);
  data.machines = arrayOrEmpty(data.machines);
  data.issues = arrayOrEmpty(data.issues);
  return data;
}

function normalizeLayoutData(data: any) {
  if (!data || typeof data !== "object") return data;
  data.rows = arrayOrEmpty(data.rows);
  data.built_rows = arrayOrEmpty(data.built_rows);
  data.resource_rows = arrayOrEmpty(data.resource_rows);
  data.entities = arrayOrEmpty(data.entities);
  data.overlaps = arrayOrEmpty(data.overlaps);
  data.legend = data.legend && typeof data.legend === "object" ? data.legend : {};
  return data;
}

function normalizeFactoryData(data: any) {
  if (!data || typeof data !== "object") return data;
  data.counts = data.counts && typeof data.counts === "object" ? data.counts : {};
  for (const value of Object.values(data.counts as Record<string, any>)) {
    if (value && typeof value === "object")
      value.statuses = value.statuses && typeof value.statuses === "object" ? value.statuses : {};
  }
  data.problems = data.problems && typeof data.problems === "object" ? data.problems : {};
  for (const key of [
    "no_fuel",
    "no_power",
    "no_input_fluid",
    "no_minable_resources",
    "waiting_for_space_in_destination",
    "no_ingredients",
    "missing_science_packs",
  ]) {
    data.problems[key] = arrayOrEmpty(data.problems[key]);
  }
  data.totals = data.totals && typeof data.totals === "object" ? data.totals : {};
  data.alerts = arrayOrEmpty(data.alerts);
  return data;
}

function normalizeEntityData(data: any) {
  if (!data || typeof data !== "object") return data;
  data.results = arrayOrEmpty(data.results);
  for (const entity of data.results) {
    entity.inventories = arrayOrEmpty(entity?.inventories);
    entity.fluid_boxes = arrayOrEmpty(entity?.fluid_boxes);
    for (const inventory of entity.inventories) {
      inventory.purposes = arrayOrEmpty(inventory?.purposes);
      inventory.items = arrayOrEmpty(inventory?.items);
    }
    for (const fluidBox of entity.fluid_boxes) {
      fluidBox.connections = arrayOrEmpty(fluidBox?.connections);
    }
  }
  return data;
}

function normalizePrototypeData(data: any) {
  if (!data || typeof data !== "object") return data;
  data.placeable_by = arrayOrEmpty(data.placeable_by);
  data.fluid_boxes = arrayOrEmpty(data.fluid_boxes);
  data.fuel_categories = arrayOrEmpty(data.fuel_categories);
  for (const fluidBox of data.fluid_boxes) {
    fluidBox.pipe_connections = arrayOrEmpty(fluidBox?.pipe_connections);
    for (const connection of fluidBox.pipe_connections) {
      connection.connection_category = arrayOrEmpty(connection?.connection_category);
      connection.positions = arrayOrEmpty(connection?.positions);
    }
  }
  return data;
}

// Placement work is retried and moves only short distances, so a stuck native
// action is aborted quickly instead of holding the whole job for ten minutes.
const ACTION_TIMEOUT_MS = 120_000;
const BUILD_MOVE_TIMEOUT_MS = 120_000;

export function registerAgentRoutes(router: Router, ctx: ApiContext): void {
  const { state, runManager, actionJobs, nativeController, rconCommand } = ctx;

  const nativeAction = (payload: Record<string, unknown>) => {
    const job = actionJobs.currentJob;
    const { timeout_ms, ...action } = payload as Record<string, any>;
    const timeout = typeof timeout_ms === "number" && timeout_ms > 0 ? timeout_ms : 600_000;
    return nativeController.run(action, () => actionJobs.isCancelled(job), timeout);
  };
  type EntityTarget = { x: number; y: number; kind?: "resource" | "entity"; name?: string };

  async function moveNearEntity(target: EntityTarget) {
    return nativeAction({ kind: "approach", target: { ...target, kind: target.kind || "entity" } });
  }

  function movePlayerTo(x: number, y: number, timeoutMs?: number) {
    return nativeAction({ kind: "move", x, y, ...(timeoutMs ? { timeout_ms: timeoutMs } : {}) });
  }

  router.add({
    method: "POST",
    path: "/api/agent/observe/visual",
    name: "/api/agent/observe/visual",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      try {
        return json(
          res,
          200,
          await visualObservation(typeof body?.title === "string" ? { title: body.title } : {}),
        );
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "Visual capture failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/world",
    name: "/api/agent/observe/world",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const window = body?.window || {};
      const include: string[] = Array.isArray(body?.include) ? body.include : ["tiles", "entities"];
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
        let data: any = response;
        try {
          data = JSON.parse(response);
        } catch {
          // Leave as raw string if it isn't JSON.
        }
        data = normalizeWorldData(data);
        const counts = data?.counts || {};
        const truncated =
          (includeTiles && counts.tiles_included < counts.tiles_total) ||
          (includeEntities && counts.entities_included < counts.entities_total);
        return json(res, 200, {
          ok: true,
          data,
          truncated,
        });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/map",
    name: "/api/agent/observe/map",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const window = body?.window || {};
      const x = clampInt(window.x, 0, -1000000, 1000000);
      const y = clampInt(window.y, 0, -1000000, 1000000);
      const radius = clampInt(window.radius, 48, 1, 96);
      try {
        const response = await rconCommand(agentMapCommand({ x, y, radius }));
        return json(res, 200, {
          ok: true,
          data: parseRconJson(response, "RCON map returned invalid JSON"),
        });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/player",
    name: "/api/agent/observe/player",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const limits = body?.limits || {};
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
        let data: any = response;
        try {
          data = JSON.parse(response);
        } catch {
          // Leave as raw string if it isn't JSON.
        }
        const counts = data?.counts || {};
        const truncated =
          counts.inventory_included < counts.inventory_total ||
          counts.equipment_included < counts.equipment_total;
        return json(res, 200, { ok: true, data, truncated });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/research",
    name: "/api/agent/observe/research",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const limits = body?.limits || {};
      const availableLimit = clampInt(limits.available, 50, 0, AGENT_MAX_RESEARCH);
      const lockedLimit = clampInt(limits.locked, 50, 0, AGENT_MAX_RESEARCH);
      const completedLimit = clampInt(limits.completed, 50, 0, AGENT_MAX_RESEARCH);
      try {
        const response = await rconCommand(
          agentResearchCommand({ availableLimit, lockedLimit, completedLimit }),
        );
        let data: any = response;
        try {
          data = JSON.parse(response);
        } catch {
          // Leave as raw string if it isn't JSON.
        }
        data = normalizeResearchData(data);
        const counts = data?.counts || {};
        const truncated = {
          available: counts.available_included < counts.available_total,
          locked: counts.locked_included < counts.locked_total,
          completed: counts.completed_included < counts.completed_total,
        };
        return json(res, 200, { ok: true, data, truncated });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/recipes",
    name: "/api/agent/observe/recipes",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const limits = body?.limits || {};
      const limit = clampInt(limits.recipes, AGENT_MAX_RECIPES, 1, AGENT_MAX_RECIPES);
      const filters = body?.filters || {};
      const unlockedOnly = Boolean(filters.unlocked);
      try {
        const response = await rconCommand(agentRecipesCommand({ limit, unlockedOnly }));
        let data: any = response;
        try {
          data = JSON.parse(response);
        } catch {
          // Leave as raw string if it isn't JSON.
        }
        const counts = data?.counts || {};
        const truncated = counts.included < counts.total;
        return json(res, 200, { ok: true, data, truncated });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/build",
    name: "/api/agent/act/build",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const entities: any[] = Array.isArray(body?.entities) ? body.entities : [];
      const limits = body?.limits || {};
      const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
      const trimmed = entities
        .slice(0, max)
        .filter(
          (e) => e?.name && Number.isFinite(Number(e?.anchor?.x)) && Number.isFinite(Number(e?.anchor?.y)),
        ) as BuildRequest[];
      try {
        const results: any[] = [];
        for (const entity of trimmed) {
          // Clear obstacles from the current position first: walking the
          // character through a forest to a staging tile is much slower than
          // mining the trees that are already within reach.
          const placement = parseRconJson<any>(
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
          let usedMovement = movement.movement;
          let clearing: any = null;
          const clearFootprint = async (acc: any) => {
            // Mining a tree leaves a stump that can still block placement, so
            // re-scan a few times until the footprint stops changing.
            for (let pass = 0; pass < 4; pass++) {
              const data = parseRconJson<any>(
                await rconCommand(agentClearBuildFootprintCommand(entity)),
                "RCON build clearing returned invalid JSON",
              );
              if (!data) break;
              acc.passes++;
              const cleared = Array.isArray(data.cleared) ? data.cleared : [];
              const pending = Array.isArray(data.pending) ? data.pending : [];
              acc.cleared.push(...cleared);
              acc.skipped = Array.isArray(data.skipped) ? data.skipped : [];
              let minedPending = 0;
              for (const target of pending.slice(0, 8)) {
                const mined = await nativeAction({
                  kind: "mine",
                  target: {
                    x: Number(target.x),
                    y: Number(target.y),
                    kind: "entity",
                    name: target.name,
                  },
                  timeout_ms: ACTION_TIMEOUT_MS,
                });
                if (mined?.ok) {
                  acc.cleared.push({ name: target.name, type: target.type });
                  minedPending++;
                } else {
                  acc.skipped.push({
                    name: target.name,
                    type: target.type,
                    reason: mined?.error || "mine_failed",
                  });
                }
              }
              acc.pending_remaining = Math.max(0, pending.length - minedPending);
              if (cleared.length === 0 && minedPending === 0 && pending.length === 0) break;
              if (cleared.length === 0 && minedPending === 0 && pending.length > 0) {
                // Everything left is out of mining reach: step to a staging tile
                // once and re-scan instead of chasing single trees.
                const staging = parseRconJson<any>(
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
                usedMovement = walked.movement;
              }
            }
            acc.ok = acc.skipped.length === 0 && (acc.pending_remaining ?? 0) === 0;
          };
          if (body?.clear_obstacles !== false) {
            clearing = { ok: true, cleared: [], skipped: [], passes: 0, pending_remaining: 0 };
            await clearFootprint(clearing);
          }
          let response = await rconCommand(agentNativeBuildCommand(entity));
          let result = parseRconJson<any>(response, "RCON build returned invalid JSON");
          // A player standing on the new building's tiles also blocks placement:
          // step to a staging position, clear the opened footprint and retry.
          if (!result?.ok && result?.error === "cannot_build") {
            const retryDestination = parseRconJson<any>(
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
                usedMovement = retryMovement.movement;
                if (clearing) await clearFootprint(clearing);
                response = await rconCommand(agentNativeBuildCommand(entity));
                result = parseRconJson<any>(response, "RCON build retry returned invalid JSON");
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
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/mine",
    name: "/api/agent/act/mine",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
      const limits = body?.limits || {};
      const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
      const trimmed = targets.slice(0, max).filter((t) => t?.x !== undefined && t?.y !== undefined);
      try {
        const results: any[] = [];
        for (const target of trimmed) {
          const result = await nativeAction({
            kind: "mine",
            target: { x: Number(target.x), y: Number(target.y), kind: target.kind, name: target.name },
          });
          results.push({ ...result, x: Number(target.x), y: Number(target.y) });
        }
        return json(res, 200, {
          ok: true,
          data: { results },
          truncated: targets.length > trimmed.length,
        });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/move",
    name: "/api/agent/act/move",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
      const limits = body?.limits || {};
      const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
      const trimmed = targets.slice(0, max).filter((t) => t?.x !== undefined && t?.y !== undefined);
      try {
        const results: any[] = [];
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
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/rotate",
    name: "/api/agent/act/rotate",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
      const limits = body?.limits || {};
      const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
      const trimmed = targets.slice(0, max).filter((t) => t?.x !== undefined && t?.y !== undefined);
      try {
        const results: any[] = [];
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
            agentRotateCommand([{ x: Number(target.x), y: Number(target.y) }]),
          );
          const data = parseRconJson<any>(response, "RCON rotate returned invalid JSON");
          const entry = data?.results?.[0];
          if (!entry) {
            results.push({
              x: Number(target.x),
              y: Number(target.y),
              ok: false,
              error: "rotate_failed",
            });
          } else {
            results.push({ ...entry, movement: movement.movement });
          }
        }
        return json(res, 200, {
          ok: true,
          data: { results },
          truncated: targets.length > trimmed.length,
        });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/launch-rocket",
    name: "/api/agent/act/launch-rocket",
    handler: async (request) => {
      const { req, res } = request;
      let body: any;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
      const max = clampInt(body?.limits?.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
      const trimmed = targets.slice(0, max);
      try {
        const results = [];
        const job = actionJobs.currentJob;
        for (const target of trimmed) {
          results.push(
            await launchRocket({ x: target?.x, y: target?.y }, moveNearEntity, rconCommand, () =>
              actionJobs.isCancelled(job),
            ),
          );
        }
        return json(res, 200, { ok: true, data: { results }, truncated: targets.length > trimmed.length });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/set-recipe",
    name: "/api/agent/act/set-recipe",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
      const limits = body?.limits || {};
      const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
      const trimmed = targets
        .slice(0, max)
        .filter((t) => t?.x !== undefined && t?.y !== undefined && t?.recipe);
      try {
        const results: any[] = [];
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
            agentSetRecipeCommand([{ x: Number(target.x), y: Number(target.y), recipe: target.recipe }]),
          );
          const data = parseRconJson<any>(response, "RCON set-recipe returned invalid JSON");
          const entry = data?.results?.[0];
          if (!entry) {
            results.push({
              x: Number(target.x),
              y: Number(target.y),
              ok: false,
              error: "set_recipe_failed",
            });
          } else {
            results.push({ ...entry, movement: movement.movement });
          }
        }
        return json(res, 200, {
          ok: true,
          data: { results },
          truncated: targets.length > trimmed.length,
        });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/craft",
    name: "/api/agent/act/craft",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const recipe = body?.item || body?.recipe;
      const count = clampInt(body?.count, 1, 1, 10000);
      if (!recipe || typeof recipe !== "string") {
        return json(res, 400, { error: "Missing recipe" });
      }
      try {
        const response = await rconCommand(agentCraftCommand(recipe, count));
        let data: any = response;
        try {
          data = JSON.parse(response);
        } catch {
          // Leave as raw string if it isn't JSON.
        }
        if (data && typeof data === "object" && data.ok === false) {
          return json(res, 400, {
            error: data?.error || "Extract failed",
            data,
          });
        }
        return json(res, 200, { ok: true, data });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/insert",
    name: "/api/agent/act/insert",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const to = body?.to?.entity || body?.entity || {};
      const item = body?.item;
      const count = clampInt(body?.count, 1, 1, 100000);
      if (!item || typeof item !== "string") {
        return json(res, 400, { error: "Missing item" });
      }
      if (to?.x === undefined || to?.y === undefined) {
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
        const data = parseRconJson<any>(response, "RCON insert returned invalid JSON");
        return json(res, 200, { ok: true, data: { ...data, movement: movement.movement } });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/extract",
    name: "/api/agent/act/extract",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const from = body?.from?.entity || body?.entity || {};
      const item = body?.item;
      const rawCount = body?.count;
      const countAll = rawCount === "all" || rawCount === -1;
      const count: number | "all" = countAll ? "all" : clampInt(rawCount, 1, 1, 100000);
      if (!item || typeof item !== "string") {
        return json(res, 400, { error: "Missing item" });
      }
      if (from?.x === undefined || from?.y === undefined) {
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
        const data = parseRconJson<any>(response, "RCON extract returned invalid JSON");
        return json(res, 200, { ok: true, data: { ...data, movement: movement.movement } });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/connections",
    name: "/api/agent/observe/connections",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const window = body?.window || {};
      const x = Number.isFinite(Number(window.x)) ? Number(window.x) : undefined;
      const y = Number.isFinite(Number(window.y)) ? Number(window.y) : undefined;
      const radius = clampInt(window.radius, 120, 1, 256);
      try {
        const response = await rconCommand(agentConnectionsCommand({ x, y, radius }));
        const data = normalizeConnectionsData(
          parseRconJson<any>(response, "RCON connection audit returned invalid JSON"),
        );
        return json(res, 200, { ok: true, data });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/layout",
    name: "/api/agent/observe/layout",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const window = body?.window || {};
      const x = Number.isFinite(Number(window.x)) ? Number(window.x) : undefined;
      const y = Number.isFinite(Number(window.y)) ? Number(window.y) : undefined;
      const radius = clampInt(window.radius, 35, 1, 80);
      const step = clampInt(window.step, 1, 1, 8);
      try {
        const response = await rconCommand(agentLayoutCommand({ x, y, radius, step }));
        const data = normalizeLayoutData(
          parseRconJson<any>(response, "RCON layout observation returned invalid JSON"),
        );
        return json(res, 200, { ok: true, data });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/factory",
    name: "/api/agent/observe/factory",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const window = body?.window || {};
      const x = Number.isFinite(Number(window.x)) ? Number(window.x) : undefined;
      const y = Number.isFinite(Number(window.y)) ? Number(window.y) : undefined;
      const radius = clampInt(window.radius, 120, 1, 256);
      try {
        const response = await rconCommand(agentFactoryCommand({ x, y, radius }));
        const data = normalizeFactoryData(
          parseRconJson<any>(response, "RCON factory observation returned invalid JSON"),
        );
        const plan = runManager.plan();
        if (plan) data.plan = plan;
        return json(res, 200, { ok: true, data });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/entity",
    name: "/api/agent/observe/entity",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const targets: any[] = Array.isArray(body?.targets) ? body.targets : [];
      const limits = body?.limits || {};
      const max = clampInt(limits.max, AGENT_MAX_ACTIONS, 1, AGENT_MAX_ACTIONS);
      const trimmed = targets.slice(0, max).filter((t) => t?.x !== undefined && t?.y !== undefined);
      try {
        const response = await rconCommand(agentObserveEntityCommand(trimmed));
        let data: any = response;
        try {
          data = JSON.parse(response);
        } catch {
          // Leave as raw string if it isn't JSON.
        }
        data = normalizeEntityData(data);
        return json(res, 200, {
          ok: true,
          data,
          truncated: targets.length > trimmed.length,
        });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/placement",
    name: "/api/agent/observe/placement",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) return json(res, 409, { error: "RCON not configured" });
      if (!state.rcon.connected) return json(res, 409, { error: "RCON not connected" });
      const placements = Array.isArray(body?.placements) ? body.placements : [];
      const valid = placements
        .slice(0, AGENT_MAX_ACTIONS)
        .filter(
          (item: any) =>
            typeof item?.name === "string" &&
            Number.isFinite(Number(item?.anchor?.x)) &&
            Number.isFinite(Number(item?.anchor?.y)),
        ) as BuildRequest[];
      try {
        const results = [];
        for (const item of valid) {
          const result = parseRconJson<any>(
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
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/resources",
    name: "/api/agent/observe/resources",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const window = body?.window || {};
      const radius = clampInt(window.radius, 50, 1, 500);
      const x = clampInt(window.x, 0, -1000000, 1000000);
      const y = clampInt(window.y, 0, -1000000, 1000000);
      try {
        const response = await rconCommand(agentChartedResourcesCommand({ x, y, radius }), 15_000);
        let data: any = response;
        try {
          data = JSON.parse(response);
        } catch {
          // Leave as raw string if it isn't JSON.
        }
        if (data && typeof data === "object") {
          data.patches = arrayOrEmpty(data.patches);
          data.shoreline_candidates = arrayOrEmpty(data.shoreline_candidates);
        }
        return json(res, 200, { ok: true, data });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/observe/entity-prototype",
    name: "/api/agent/observe/entity-prototype",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const name = body?.name;
      if (!name || typeof name !== "string") {
        return json(res, 400, { error: "Missing entity name" });
      }
      try {
        const response = await rconCommand(agentEntityPrototypeCommand(name));
        let data: any = response;
        try {
          data = JSON.parse(response);
        } catch {
          // Leave as raw string if it isn't JSON.
        }
        data = normalizePrototypeData(data);
        if (data && typeof data === "object" && data.ok === false) {
          return json(res, 400, { error: data?.error || "Unknown entity", data });
        }
        return json(res, 200, { ok: true, data });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/act/research",
    name: "/api/agent/act/research",
    handler: async (request) => {
      const { req, res } = request;
      let body: any = null;
      try {
        body = await readJson(req);
      } catch (err: any) {
        return json(res, 400, { error: err?.message || "Invalid JSON" });
      }
      if (!rconConfigured()) {
        return json(res, 409, { error: "RCON not configured" });
      }
      if (!state.rcon.connected) {
        return json(res, 409, { error: "RCON not connected" });
      }
      const technology = body?.technology;
      if (!technology || typeof technology !== "string") {
        return json(res, 400, { error: "Missing technology" });
      }
      try {
        const response = await rconCommand(agentResearchStartCommand(technology));
        let data: any = response;
        try {
          data = JSON.parse(response);
        } catch {
          // Leave as raw string if it isn't JSON.
        }
        if (data && typeof data === "object" && data.ok === false) {
          return json(res, 400, { error: data?.error || "Research failed", data });
        }
        return json(res, 200, { ok: true, data });
      } catch (err: any) {
        return json(res, 500, { error: err?.message || "RCON command failed" });
      }
    },
  });
}
