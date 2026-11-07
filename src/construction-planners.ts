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
