import { Router } from "../http/router.js";
import { json, readJsonBody } from "../http/plumbing.js";
import { actionPaths, splitJobPayload, type JobAction } from "../action-jobs.js";
import { asRecord, asString } from "../validation.js";
import { ConstructionPlanError } from "../construction.js";
import { agentObserveEntityCommand, agentPlayerCommand } from "../command-builders.js";
import { observeAreaCommand } from "../area-edit.js";
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
  const { state, runManager, actionJobs, internalKey, rconCommand } = ctx;

  /** Build targets from the per-entity job items produced by `splitJobPayload`. */
  const buildTargets = (items: unknown[]): Array<{ x: number; y: number }> => {
    const targets: Array<{ x: number; y: number }> = [];
    for (const item of items) {
      const record = asRecord(item);
      const entities = record?.entities;
      const entity = asRecord(Array.isArray(entities) ? entities[0] : undefined);
      const anchor = asRecord(entity?.anchor);
      const x = Number(anchor?.x);
      const y = Number(anchor?.y);
      if (Number.isFinite(x) && Number.isFinite(y)) targets.push({ x, y });
    }
    return targets;
  };

  /** Flatten per-item build entities into the original request shape. */
  const buildEntities = (items: unknown[]): unknown[] => {
    const entities: unknown[] = [];
    for (const item of items) {
      const record = asRecord(item);
      const entries = record?.entities;
      if (Array.isArray(entries)) entities.push(...entries);
    }
    return entities;
  };

  /** Flatten per-item target arrays (mine/rotate/set-recipe). */
  const itemTargets = (items: unknown[]): unknown[] => {
    const targets: unknown[] = [];
    for (const item of items) {
      const record = asRecord(item);
      const entries = record?.targets;
      if (Array.isArray(entries)) targets.push(...entries);
    }
    return targets;
  };

  const hasBuildingTarget = (targets: unknown[]): boolean =>
    targets.some((target) => asRecord(target)?.allow_buildings === true);

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
      const items = splitJobPayload(action, body.payload);
      if (items.length === 0) {
        return json(res, 400, { error: "Action payload contains no work" });
      }
      const internal = req.headers["x-autorio-internal"] === internalKey;
      if (!internal && action === "build") {
        // The refactor gate blocks expansion, not refactoring: in-cluster
        // rebuilds are allowed while rebuild credits last (1 credit/entity).
        const targets = buildTargets(items);
        const check = runManager.refactorBuildCheck(targets);
        if (check?.blocked) {
          return json(res, 409, {
            error: "REFACTOR_REQUIRED",
            message: check.message,
            tier: check.tier,
            build_credits: check.build_credits,
            allowed_clusters: check.allowed_clusters,
            out_of_cluster: check.out_of_cluster,
            actions: check.actions ?? [],
            nudge: {
              reason: "refactor_debt",
              first_step: "factory-audit",
              message:
                "Expansion is blocked while refactor debt persists. Repairs and local rebuilds inside the flagged clusters are free; clean only flagged/obsolete entities, re-audit, then expand. relayout-belts is for a belt section that still fails after 3 audits.",
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
      const preflightPlanId = asString(asRecord(body.payload)?.plan_id);
      if (!internal && action === "build" && typeof preflightPlanId === "string") {
        const plan = runManager.constructionPlan(preflightPlanId);
        const executedEntityCount =
          plan && "executed_entity_count" in plan ? Number(plan.executed_entity_count ?? 0) : 0;
        if (
          plan?.kind === "blueprint" &&
          plan.required_items &&
          executedEntityCount === 0 &&
          runManager.constructionStatus().mode === "planned"
        ) {
          try {
            const response = await rconCommand(
              agentPlayerCommand({ inventoryLimit: 200, equipmentLimit: 50 }),
              8000,
            );
            const parsed = JSON.parse(response) as {
              player?: { inventories?: Array<{ slots?: Array<{ name?: string; count?: number }> }> };
            };
            const available: Record<string, number> = {};
            for (const inventory of parsed.player?.inventories ?? []) {
              for (const slot of inventory.slots ?? []) {
                if (typeof slot.name === "string" && Number(slot.count) > 0) {
                  available[slot.name] = (available[slot.name] ?? 0) + Number(slot.count);
                }
              }
            }
            const missing = Object.entries(plan.required_items)
              .map(([name, required]) => ({
                name,
                required,
                available: available[name] ?? 0,
                missing: required - (available[name] ?? 0),
              }))
              .filter((entry) => entry.missing > 0)
              .sort((left, right) => left.name.localeCompare(right.name));
            if (missing.length) {
              return json(res, 409, {
                error: plan.kind === "blueprint" ? "BLUEPRINT_MATERIAL_SHORTAGE" : "PLAN_MATERIAL_SHORTAGE",
                message: "The plan needs items that are not in the player inventory.",
                missing,
                plan_id: preflightPlanId,
              });
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              return json(res, 409, {
                error: plan.kind === "blueprint" ? "BLUEPRINT_MATERIAL_SHORTAGE" : "PLAN_MATERIAL_SHORTAGE",
                message: "Could not read the player inventory for plan preflight.",
              });
            }
            // RCON/observation failure: do not block; the build result reports missing items.
          }
        }
      }
      if (!internal) {
        const payloadRecord = asRecord(body.payload) ?? {};
        const planId = asString(payloadRecord.plan_id);
        const actionTargets = itemTargets(items);
        const allowedKinds =
          action === "build"
            ? (["build", "blueprint", "power", "pipe", "belt"] as const)
            : action === "rotate" || action === "set-recipe"
              ? (["mutation"] as const)
              : action === "mine" && hasBuildingTarget(actionTargets)
                ? (["cleanup"] as const)
                : undefined;
        if (allowedKinds) {
          try {
            runManager.requireConstructionPlan({
              plan_id: planId,
              allowed_kinds: [...allowedKinds],
              ...(action === "build" ? { entities: buildEntities(items) } : { targets: actionTargets }),
            });
          } catch (error) {
            if (error instanceof ConstructionPlanError) {
              return json(res, error.status, error.toJSON());
            }
            throw error;
          }
        }
      }
      if (!internal && action === "mine") {
        const targets = itemTargets(items).filter((target) => asRecord(target)?.allow_buildings === true);
        if (targets.length && runManager.constructionStatus().mode === "planned") {
          const protectedTypes = new Set([
            "assembling-machine",
            "furnace",
            "chemical-plant",
            "oil-refinery",
            "lab",
            "mining-drill",
            "boiler",
            "generator",
            "rocket-silo",
            "pumpjack",
            "centrifuge",
            "recycler",
          ]);
          const inactive = new Set([
            "no_power",
            "no_fuel",
            "no_ingredients",
            "no_input_fluid",
            "no_minable_resources",
            "waiting_for_space_in_destination",
            "disabled_by_script",
            "marked_for_deconstruction",
            "none",
            "normal",
            "idle",
          ]);
          try {
            // Production-chain guard: look at the local machine neighborhood, not
            // only the target tile. A feeder belt/inserter/chest next to an active
            // machine is part of the working block and must not be cleaned.
            const xs = targets.map((target) => Number(asRecord(target)?.x)).filter(Number.isFinite);
            const ys = targets.map((target) => Number(asRecord(target)?.y)).filter(Number.isFinite);
            if (xs.length && ys.length) {
              const centerX = Math.round((Math.min(...xs) + Math.max(...xs)) / 2);
              const centerY = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
              const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
              const areaRadius = Math.min(64, Math.max(6, Math.ceil(span / 2 + 4)));
              const areaResponse = await rconCommand(
                observeAreaCommand({
                  x: centerX,
                  y: centerY,
                  radius: areaRadius,
                  limit: 300,
                  playerOnly: false,
                  order: "near",
                }),
                8000,
              );
              const area = JSON.parse(areaResponse) as {
                entities?: Array<Record<string, unknown>>;
              };
              const activeMachines = (area.entities ?? []).filter((entity) => {
                const type = String(entity.type ?? "");
                const status = String(entity.status ?? "none");
                return protectedTypes.has(type) && !inactive.has(status);
              });
              const chainHit = targets.find((target) => {
                const record = asRecord(target) ?? {};
                const x = Number(record.x);
                const y = Number(record.y);
                return activeMachines.some((machine) => {
                  const mx = Number(machine.x);
                  const my = Number(machine.y);
                  return (
                    Number.isFinite(mx) &&
                    Number.isFinite(my) &&
                    Math.abs(mx - x) <= 4 &&
                    Math.abs(my - y) <= 4
                  );
                });
              });
              if (chainHit && activeMachines.length) {
                return json(res, 409, {
                  error: "REFACTOR_WORKING_BLOCK",
                  message:
                    "Cleanup target is part of an active production chain. Mark the chain obsolete or let it finish before cleanup.",
                  working: activeMachines.slice(0, 10).map((machine) => ({
                    name: machine.name,
                    x: machine.x,
                    y: machine.y,
                    status: machine.status,
                  })),
                });
              }
            }
          } catch {
            // Neighborhood scan is advisory; the per-target guard below still runs.
          }
          try {
            const response = await rconCommand(
              agentObserveEntityCommand(
                targets.slice(0, 50).map((target) => {
                  const record = asRecord(target) ?? {};
                  return {
                    x: Number(record.x),
                    y: Number(record.y),
                    kind: "entity",
                    ...(asString(record.name) ? { name: asString(record.name) } : {}),
                  };
                }),
              ),
              8000,
            );
            const parsed = JSON.parse(response) as { results?: Array<Record<string, unknown>> };
            const working = (parsed.results ?? []).filter((result) => {
              const type = typeof result.type === "string" ? result.type : "";
              const status = typeof result.status === "string" ? result.status : "none";
              if (!protectedTypes.has(type)) return false;
              if (!inactive.has(status)) return true;
              const inventories = Array.isArray(result.inventories) ? result.inventories : [];
              const hasItems = inventories.some((inventory) => {
                const record =
                  inventory && typeof inventory === "object"
                    ? (inventory as Record<string, unknown>)
                    : undefined;
                return Array.isArray(record?.slots) && record.slots.length > 0;
              });
              const fluids = Array.isArray(result.fluid_boxes) ? result.fluid_boxes : [];
              const hasFluid = fluids.some((box) => {
                const record = box && typeof box === "object" ? (box as Record<string, unknown>) : undefined;
                const fluid =
                  record?.fluid && typeof record.fluid === "object"
                    ? (record.fluid as Record<string, unknown>)
                    : undefined;
                return Number(fluid?.amount) > 0;
              });
              const contents = Array.isArray(result.fluid_contents) ? result.fluid_contents : [];
              return hasItems || hasFluid || contents.length > 0;
            });
            if (working.length) {
              return json(res, 409, {
                error: "REFACTOR_WORKING_BLOCK",
                message:
                  "Cleanup targets a working production machine. Let it run or mark it obsolete/deconstruct it explicitly; planned mode protects working blocks.",
                working: working.map((result) => {
                  const tile =
                    result.occupied_tile && typeof result.occupied_tile === "object"
                      ? (result.occupied_tile as Record<string, unknown>)
                      : undefined;
                  return {
                    name: result.name,
                    x: tile?.x ?? null,
                    y: tile?.y ?? null,
                    status: result.status,
                  };
                }),
              });
            }
          } catch {
            // Observation failure must not block cleanup; the action still runs
            // through the normal scope and cleanup guards.
          }
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
