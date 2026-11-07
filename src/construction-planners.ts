import type { ConstructionEntity } from "./construction.js";

export type LayoutPoint = { x: number; y: number };

export type PowerPoleName =
  "small-electric-pole" | "medium-electric-pole" | "big-electric-pole" | "substation";

const POLE_REACH: Record<PowerPoleName, number> = {
  "small-electric-pole": 7.5,
  "medium-electric-pole": 9,
  "big-electric-pole": 30,
  substation: 18,
};

const POLE_SUPPLY: Record<PowerPoleName, number> = {
  "small-electric-pole": 5,
  "medium-electric-pole": 5,
  "big-electric-pole": 4,
  substation: 18,
};

function integerPoint(value: unknown): LayoutPoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const x = Number(record.x ?? (Array.isArray(value) ? value[0] : undefined));
  const y = Number(record.y ?? (Array.isArray(value) ? value[1] : undefined));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x: Math.round(x), y: Math.round(y) };
}

function uniquePoints(points: LayoutPoint[]): LayoutPoint[] {
  const seen = new Set<string>();
  return points.filter((point) => {
    const key = `${point.x},${point.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function axisLine(from: LayoutPoint, to: LayoutPoint): LayoutPoint[] {
  const points: LayoutPoint[] = [];
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  if (dx !== 0 && dy !== 0) throw new Error("layout route must be horizontal or vertical");
  if (dx === 0 && dy === 0) return [{ ...from }];
  let x = from.x;
  let y = from.y;
  while (true) {
    points.push({ x, y });
    if (x === to.x && y === to.y) break;
    x += dx;
    y += dy;
  }
  return points;
}

/** Straight power trunk with wire-reach spacing; diagonal requests become an L route. */
export function planPowerLine(input: {
  from: unknown;
  to: unknown;
  pole?: string;
  spacing?: unknown;
}): ConstructionEntity[] {
  const from = integerPoint(input.from);
  const to = integerPoint(input.to);
  if (!from || !to) throw new Error("power layout needs finite from/to points");
  const pole =
    (input.pole ?? "big-electric-pole") in POLE_REACH ? (input.pole as PowerPoleName) : "big-electric-pole";
  const reach = POLE_REACH[pole];
  const requested = Number(input.spacing);
  const spacing =
    Number.isFinite(requested) && requested > 0
      ? Math.max(1, Math.min(Math.floor(requested), Math.floor(reach)))
      : Math.max(1, Math.floor(reach * 0.9));
  const points: LayoutPoint[] = [];
  const segments: Array<[LayoutPoint, LayoutPoint]> = [];
  if (from.x !== to.x && from.y !== to.y) {
    segments.push([from, { x: to.x, y: from.y }], [{ x: to.x, y: from.y }, to]);
  } else {
    segments.push([from, to]);
  }
  for (const [start, end] of segments) {
    const length = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
    const dx = Math.sign(end.x - start.x);
    const dy = Math.sign(end.y - start.y);
    for (let distance = 0; distance < length; distance += spacing) {
      points.push({ x: start.x + dx * distance, y: start.y + dy * distance });
    }
    points.push({ x: end.x, y: end.y });
  }
  return uniquePoints(points).map((anchor) => ({ name: pole, anchor }));
}

/** Poles covering the bbox of target points/areas, aligned to a supply-size grid. */
export function planPowerNetwork(input: {
  targets: unknown;
  pole?: string;
  spacing?: unknown;
}): ConstructionEntity[] {
  const raw = Array.isArray(input.targets) ? input.targets : [];
  const points: LayoutPoint[] = [];
  for (const value of raw) {
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const point = integerPoint(record);
    if (point) {
      points.push(point);
      continue;
    }
    const x = Number(record.x);
    const y = Number(record.y);
    const radius = Number(record.radius);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const r = Number.isFinite(radius) && radius > 0 ? Math.round(radius) : 2;
      points.push({ x: Math.round(x) - r, y: Math.round(y) - r });
      points.push({ x: Math.round(x) + r, y: Math.round(y) + r });
    }
  }
  if (!points.length) throw new Error("power network needs at least one target");
  const pole = (input.pole ?? "substation") in POLE_REACH ? (input.pole as PowerPoleName) : "substation";
  const supply = POLE_SUPPLY[pole];
  const requested = Number(input.spacing);
  const step =
    Number.isFinite(requested) && requested > 0
      ? Math.max(1, Math.min(Math.floor(requested), supply))
      : supply;
  const left = Math.min(...points.map((point) => point.x));
  const right = Math.max(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  const bottom = Math.max(...points.map((point) => point.y));
  const startX = left;
  const startY = top;
  const entities: ConstructionEntity[] = [];
  for (let y = startY; y <= bottom; y += step) {
    for (let x = startX; x <= right; x += step) {
      entities.push({ name: pole, anchor: { x, y } });
    }
  }
  return entities.length ? entities : [{ name: pole, anchor: { x: startX, y: startY } }];
}

/** Straight belt run; each tile faces the next tile. */
export function planBeltLine(input: { from: unknown; to: unknown; name?: string }): ConstructionEntity[] {
  const from = integerPoint(input.from);
  const to = integerPoint(input.to);
  if (!from || !to) throw new Error("belt layout needs finite from/to points");
  if (from.x !== to.x && from.y !== to.y) {
    throw new Error("belt layout must be horizontal or vertical; use an L route made of two calls");
  }
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : "transport-belt";
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  const direction = dx > 0 ? 4 : dx < 0 ? 12 : dy > 0 ? 8 : 0;
  return axisLine(from, to).map((anchor) => ({ name, anchor, direction }));
}

/** Straight pipe run with a surface pipe per tile; underground pairing stays a planner follow-up. */
export function planPipeLine(input: { from: unknown; to: unknown; name?: string }): ConstructionEntity[] {
  const from = integerPoint(input.from);
  const to = integerPoint(input.to);
  if (!from || !to) throw new Error("pipe layout needs finite from/to points");
  if (from.x !== to.x && from.y !== to.y) {
    throw new Error("pipe layout must be horizontal or vertical; use an L route made of two calls");
  }
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : "pipe";
  return axisLine(from, to).map((anchor) => ({ name, anchor }));
}

function integerPath(value: unknown): LayoutPoint[] {
  if (!Array.isArray(value)) throw new Error("path must be an array of points");
  const points: LayoutPoint[] = [];
  for (const entry of value) {
    const point = integerPoint(entry);
    if (!point) throw new Error("path points must have finite x/y");
    if (!points.length || points.at(-1)!.x !== point.x || points.at(-1)!.y !== point.y) {
      points.push(point);
    }
  }
  if (!points.length) throw new Error("path needs at least one point");
  for (let index = 1; index < points.length; index += 1) {
    const dx = Math.abs(points[index].x - points[index - 1].x);
    const dy = Math.abs(points[index].y - points[index - 1].y);
    if ((dx > 0 && dy > 0) || dx + dy === 0) {
      throw new Error("path segments must be axis-aligned and non-zero");
    }
  }
  return points;
}

function expandedPath(value: unknown): LayoutPoint[] {
  const waypoints = integerPath(value);
  const points: LayoutPoint[] = [];
  for (let index = 1; index < waypoints.length; index += 1) {
    const start = waypoints[index - 1];
    const end = waypoints[index];
    const dx = Math.sign(end.x - start.x);
    const dy = Math.sign(end.y - start.y);
    const length = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
    for (let distance = 0; distance < length; distance += 1) {
      points.push({ x: start.x + dx * distance, y: start.y + dy * distance });
    }
  }
  points.push({ ...waypoints.at(-1)! });
  return points;
}

type ExistingAsset = { x: number; y: number; type?: string; direction?: number };

function existingAssetTiles(value: unknown): Map<string, ExistingAsset> {
  const map = new Map<string, ExistingAsset>();
  for (const entry of Array.isArray(value) ? value : []) {
    const point = integerPoint(entry);
    if (!point) continue;
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    map.set(`${point.x},${point.y}`, {
      ...point,
      type: typeof record.type === "string" ? record.type : undefined,
      direction: Number.isFinite(Number(record.direction)) ? Number(record.direction) : undefined,
    });
  }
  return map;
}

/** Belt route: one belt per path tile, facing the next waypoint. */
export function planBeltPath(input: {
  path: unknown;
  name?: string;
  existing_assets?: unknown;
}): ConstructionEntity[] {
  const path = expandedPath(input.path);
  const existing = existingAssetTiles(input.existing_assets);
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : "transport-belt";
  return path.flatMap((anchor, index) => {
    const next = path[Math.min(index + 1, path.length - 1)];
    const previous = path[Math.max(0, index - 1)];
    const dx = index === path.length - 1 ? Math.sign(anchor.x - previous.x) : Math.sign(next.x - anchor.x);
    const dy = index === path.length - 1 ? Math.sign(anchor.y - previous.y) : Math.sign(next.y - anchor.y);
    const direction = dx > 0 ? 4 : dx < 0 ? 12 : dy > 0 ? 8 : 0;
    const asset = existing.get(`${anchor.x},${anchor.y}`);
    if (
      asset &&
      (asset.type === "transport-belt" || asset.type === "underground-belt" || asset.type === "splitter") &&
      asset.direction === direction
    ) {
      return [];
    }
    return [{ name, anchor, direction }];
  });
}

/** Pipe route: one surface pipe per path tile. */
export function planPipePath(input: {
  path: unknown;
  name?: string;
  existing_assets?: unknown;
}): ConstructionEntity[] {
  const path = expandedPath(input.path);
  const existing = existingAssetTiles(input.existing_assets);
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : "pipe";
  return path.flatMap((anchor) => {
    const asset = existing.get(`${anchor.x},${anchor.y}`);
    if (asset && (asset.type === "pipe" || asset.type === "pipe-to-ground")) return [];
    return [{ name, anchor }];
  });
}

/** Pole route: wire-reach spacing along cumulative path distance. */
export function planPowerPath(input: {
  path: unknown;
  pole?: string;
  spacing?: unknown;
  existing_poles?: unknown;
}): ConstructionEntity[] {
  const path = expandedPath(input.path);
  const existingPoles = (Array.isArray(input.existing_poles) ? input.existing_poles : [])
    .map((entry) => integerPoint(entry))
    .filter((entry): entry is LayoutPoint => Boolean(entry));
  const pole =
    (input.pole ?? "big-electric-pole") in POLE_REACH ? (input.pole as PowerPoleName) : "big-electric-pole";
  const reach = POLE_REACH[pole];
  const requested = Number(input.spacing);
  const spacing =
    Number.isFinite(requested) && requested > 0
      ? Math.max(1, Math.min(Math.floor(requested), Math.floor(reach)))
      : Math.max(1, Math.floor(reach * 0.9));
  const entities: ConstructionEntity[] = [];
  let sinceLast = spacing;
  for (let index = 0; index < path.length; index += 1) {
    const point = path[index];
    if (index > 0) {
      const previous = path[index - 1];
      sinceLast += Math.abs(point.x - previous.x) + Math.abs(point.y - previous.y);
    }
    const covered = existingPoles.some(
      (existing) => Math.abs(existing.x - point.x) + Math.abs(existing.y - point.y) <= 2,
    );
    if (index === 0 || index === path.length - 1 || (sinceLast >= spacing && !covered)) {
      entities.push({ name: pole, anchor: point });
      sinceLast = 0;
    }
  }
  return entities;
}
