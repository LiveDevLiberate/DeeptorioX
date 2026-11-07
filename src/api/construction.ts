import { Router } from "../http/router.js";
import { json, readJsonBody } from "../http/plumbing.js";
import { ConstructionPlanError } from "../construction.js";
import { agentFreeSpaceCommand } from "../command-builders.js";
import { observeAreaCommand } from "../area-edit.js";
import type { ApiContext } from "./context.js";

/**
 * Construction-mode discovery and plan-token issue/status endpoints.
 *
 * Free mode returns `CONSTRUCTION_MODE_FREE` from POST /plan so clients can
 * fall back to the legacy action path. Planned mode requires a plan token for
 * every construction/mutation/cleanup action.
 */
export function registerConstructionRoutes(router: Router, ctx: ApiContext): void {
  const { runManager, rconCommand } = ctx;

  /** BFS a free-space grid returned by the game, then ask the manager to lay it. */
  const planRoute = async (body: Record<string, unknown>) => {
    const kind = typeof body.kind === "string" ? body.kind : "";
    const from = body.from && typeof body.from === "object" ? (body.from as Record<string, unknown>) : {};
    const to = body.to && typeof body.to === "object" ? (body.to as Record<string, unknown>) : {};
    const fromX = Number(from.x);
    const fromY = Number(from.y);
    const toX = Number(to.x);
    const toY = Number(to.y);
    if (!["power", "pipe", "belt"].includes(kind)) {
      throw new ConstructionPlanError("PLAN_BAD_REQUEST", "route kind must be power, pipe or belt", {}, 400);
    }
    if (runManager.constructionStatus().mode !== "planned") {
      throw new ConstructionPlanError(
        "CONSTRUCTION_MODE_FREE",
        "This run uses free construction; no plan token is required.",
        { mode: "free" },
      );
    }
    if (![fromX, fromY, toX, toY].every(Number.isFinite)) {
      throw new ConstructionPlanError("PLAN_BAD_REQUEST", "route needs finite from/to points", {}, 400);
    }
    const midX = (fromX + toX) / 2;
    const midY = (fromY + toY) / 2;
    const distance = Math.abs(toX - fromX) + Math.abs(toY - fromY);
    const requestedRadius = Number(body.radius);
    const radius =
      Number.isFinite(requestedRadius) && requestedRadius > 0
        ? Math.min(512, Math.max(16, Math.floor(requestedRadius)))
        : Math.min(512, Math.max(32, Math.ceil(distance / 2 + 24)));
    const response = await rconCommand(
      agentFreeSpaceCommand({ x: Math.round(midX), y: Math.round(midY), radius, step: 1 }),
      15000,
    );
    const grid = JSON.parse(response) as {
      origin?: { x?: number; y?: number };
      rows?: string[];
      step?: number;
      width?: number;
      height?: number;
    };
    const rows = Array.isArray(grid.rows) ? grid.rows : [];
    const origin = grid.origin ?? {};
    const step = Number(grid.step) || 1;
    const ox = Number(origin.x);
    const oy = Number(origin.y);
    if (!rows.length || !Number.isFinite(ox) || !Number.isFinite(oy)) {
      throw new ConstructionPlanError("PLAN_ROUTE_FAILED", "free-space scan returned no walkable grid");
    }
    const toCell = (x: number, y: number) => ({
      col: Math.round((Math.round(x) - ox) / step),
      row: Math.round((Math.round(y) - oy) / step),
    });
    const start = toCell(fromX, fromY);
    const goal = toCell(toX, toY);
    const height = rows.length;
    const width = rows[0]?.length ?? 0;
    let existingAssets: Array<{ x: number; y: number; type?: string; direction?: number }> = [];
    if (kind === "belt" || kind === "pipe") {
      try {
        const assetTypes =
          kind === "belt" ? ["transport-belt", "underground-belt", "splitter"] : ["pipe", "pipe-to-ground"];
        const assetResponse = await rconCommand(
          observeAreaCommand({
            x: Math.round(midX),
            y: Math.round(midY),
            radius,
            limit: 400,
            playerOnly: false,
            types: assetTypes,
          }),
          8000,
        );
        const assetData = JSON.parse(assetResponse) as {
          entities?: Array<Record<string, unknown>>;
        };
        existingAssets = (assetData.entities ?? [])
          .map((entity) => ({
            x: Number(entity.x),
            y: Number(entity.y),
            type: typeof entity.type === "string" ? entity.type : undefined,
            direction: Number.isFinite(Number(entity.direction)) ? Number(entity.direction) : undefined,
          }))
          .filter((entity) => Number.isFinite(entity.x) && Number.isFinite(entity.y));
      } catch {
        // Reuse is an optimization; fall back to building the full corridor.
      }
    }
    const existingByTile = new Map(
      existingAssets.map((asset) => [`${Math.floor(asset.x)},${Math.floor(asset.y)}`, asset]),
    );
    const movementDirection = (dr: number, dc: number) => (dr === 1 ? 8 : dr === -1 ? 0 : dc === 1 ? 4 : 12);
    const passable = (row: number, col: number, direction?: number) => {
      if (row < 0 || row >= height || col < 0 || col >= width) return false;
      if (rows[row]?.[col] === ".") return true;
      const asset = existingByTile.get(`${ox + col * step},${oy + row * step}`);
      if (!asset) return false;
      if (kind === "pipe") return asset.type === "pipe" || asset.type === "pipe-to-ground";
      if (kind === "belt") {
        return (
          (asset.type === "transport-belt" ||
            asset.type === "underground-belt" ||
            asset.type === "splitter") &&
          (direction === undefined || asset.direction === direction)
        );
      }
      return false;
    };
    if (!passable(start.row, start.col) || !passable(goal.row, goal.col)) {
      throw new ConstructionPlanError(
        "PLAN_ROUTE_FAILED",
        "route start or goal is blocked in the free-space scan",
        { from: start, to: goal },
      );
    }
    // Cost-aware Dijkstra: shortest free-space path with a turn penalty, so the
    // generated trunk prefers one straight corridor over a stair-step route.
    const directions: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    type RouteState = { row: number; col: number; direction: number; cost: number; key: string };
    const requestedTurn = Number(body.turn_penalty);
    const turnPenalty =
      Number.isFinite(requestedTurn) && requestedTurn >= 0
        ? Math.min(10, requestedTurn)
        : kind === "pipe"
          ? 0.8
          : kind === "power"
            ? 0.5
            : 0.3;
    const stateKey = (row: number, col: number, direction: number) => `${row},${col},${direction}`;
    const best = new Map<string, number>();
    const previous = new Map<string, string | null>();
    const heap: RouteState[] = [];
    const pushHeap = (state: RouteState) => {
      heap.push(state);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (heap[parent].cost <= heap[index].cost) break;
        [heap[parent], heap[index]] = [heap[index], heap[parent]];
        index = parent;
      }
    };
    const popHeap = (): RouteState | undefined => {
      if (!heap.length) return undefined;
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        let index = 0;
        while (true) {
          const left = index * 2 + 1;
          const right = left + 1;
          let bestIndex = index;
          if (left < heap.length && heap[left].cost < heap[bestIndex].cost) bestIndex = left;
          if (right < heap.length && heap[right].cost < heap[bestIndex].cost) bestIndex = right;
          if (bestIndex === index) break;
          [heap[index], heap[bestIndex]] = [heap[bestIndex], heap[index]];
          index = bestIndex;
        }
      }
      return top;
    };
    for (let direction = 0; direction < directions.length; direction += 1) {
      const key = stateKey(start.row, start.col, direction);
      best.set(key, 0);
      previous.set(key, null);
      pushHeap({ row: start.row, col: start.col, direction, cost: 0, key });
    }
    let goalKey: string | null = null;
    while (true) {
      const current = popHeap();
      if (!current) break;
      if (current.row === goal.row && current.col === goal.col) {
        goalKey = current.key;
        break;
      }
      if (current.cost > (best.get(current.key) ?? Infinity)) continue;
      for (let direction = 0; direction < directions.length; direction += 1) {
        const [dr, dc] = directions[direction];
        const row = current.row + dr;
        const col = current.col + dc;
        if (!passable(row, col, movementDirection(dr, dc))) continue;
        const key = stateKey(row, col, direction);
        const cost = current.cost + 1 + (direction === current.direction ? 0 : turnPenalty);
        if (cost >= (best.get(key) ?? Infinity)) continue;
        best.set(key, cost);
        previous.set(key, current.key);
        pushHeap({ row, col, direction, cost, key });
      }
    }
    if (!goalKey) {
      throw new ConstructionPlanError("PLAN_ROUTE_FAILED", "no free-space route between from and to");
    }
    const cells: Array<[number, number]> = [];
    let cursor: string | null = goalKey;
    while (cursor) {
      const [row, col] = cursor.split(",").map(Number);
      cells.push([row, col]);
      cursor = previous.get(cursor) ?? null;
    }
    cells.reverse();
    const points = cells.map(([row, col]) => ({ x: ox + col * step, y: oy + row * step }));
    // Compact collinear cells to waypoints; the manager planner expands them.
    const waypoints = points.filter((point, index) => {
      if (index === 0 || index === points.length - 1) return true;
      const previousPoint = points[index - 1];
      const nextPoint = points[index + 1];
      return (
        Math.sign(point.x - previousPoint.x) !== Math.sign(nextPoint.x - point.x) ||
        Math.sign(point.y - previousPoint.y) !== Math.sign(nextPoint.y - point.y)
      );
    });
    let existingPoles: Array<{ x: number; y: number }> = [];
    if (kind === "power") {
      try {
        const poleResponse = await rconCommand(
          observeAreaCommand({
            x: Math.round(midX),
            y: Math.round(midY),
            radius,
            limit: 200,
            playerOnly: false,
            types: ["electric-pole", "substation"],
          }),
          8000,
        );
        const poleData = JSON.parse(poleResponse) as { entities?: Array<Record<string, unknown>> };
        existingPoles = (poleData.entities ?? [])
          .map((entity) => ({ x: Number(entity.x), y: Number(entity.y) }))
          .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      } catch {
        // Reuse is an optimization; fall back to a fresh trunk.
      }
    }
    return runManager.createConstructionPlan({
      ...body,
      path: waypoints,
      ...(existingPoles.length ? { existing_poles: existingPoles } : {}),
      ...(existingAssets.length ? { existing_assets: existingAssets } : {}),
    });
  };

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
    path: "/api/agent/plan/route",
    name: "/api/agent/plan/route",
    handler: async (request) => {
      const { req, res } = request;
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return json(res, 400, { error: "PLAN_BAD_REQUEST", message: parsed.error });
      try {
        const plan = await planRoute(parsed.body && typeof parsed.body === "object" ? parsed.body : {});
        return json(res, 201, { ok: true, data: plan });
      } catch (error) {
        if (error instanceof ConstructionPlanError) return json(res, error.status, error.toJSON());
        throw error;
      }
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
