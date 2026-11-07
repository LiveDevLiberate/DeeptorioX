import { Router } from "../http/router.js";
import { json, readJsonBody } from "../http/plumbing.js";
import { ConstructionPlanError } from "../construction.js";
import { agentFreeSpaceCommand } from "../command-builders.js";
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
    const passable = (row: number, col: number) =>
      row >= 0 && row < height && col >= 0 && col < width && rows[row]?.[col] === ".";
    if (!passable(start.row, start.col) || !passable(goal.row, goal.col)) {
      throw new ConstructionPlanError(
        "PLAN_ROUTE_FAILED",
        "route start or goal is blocked in the free-space scan",
        { from: start, to: goal },
      );
    }
    const queue: Array<[number, number]> = [[start.row, start.col]];
    const previous = new Map<string, [number, number] | null>([[`${start.row},${start.col}`, null]]);
    const directions: Array<[number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    let found = false;
    while (queue.length) {
      const current = queue.shift()!;
      if (current[0] === goal.row && current[1] === goal.col) {
        found = true;
        break;
      }
      for (const [dr, dc] of directions) {
        const row = current[0] + dr;
        const col = current[1] + dc;
        const key = `${row},${col}`;
        if (previous.has(key) || !passable(row, col)) continue;
        previous.set(key, current);
        queue.push([row, col]);
      }
    }
    if (!found) {
      throw new ConstructionPlanError("PLAN_ROUTE_FAILED", "no free-space route between from and to");
    }
    const cells: Array<[number, number]> = [];
    let cursor: [number, number] | null = [goal.row, goal.col];
    while (cursor) {
      cells.push(cursor);
      cursor = previous.get(`${cursor[0]},${cursor[1]}`) ?? null;
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
    return runManager.createConstructionPlan({
      ...body,
      path: waypoints,
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
        const plan = await planRoute(
          parsed.body && typeof parsed.body === "object" ? (parsed.body as Record<string, unknown>) : {},
        );
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
