/**
 * Belt-lane summariser for `POST /api/agent/observe/belts`.
 *
 * The Lua scan returns both transport lines of every belt tile (plus detected
 * feeders). This module maps the lines to the belt's left/right lanes (left and
 * right relative to the belt's travel direction), adds content saturation and
 * lane balance, and flags lane mix (one lane carrying two item types) and
 * side-load feeders.
 *
 * Capacity basis: a straight belt tile holds 4 items per lane for every belt
 * tier (Factorio wiki, "Transport belts/Physics": density is 4 items per tile
 * per lane). This is content saturation, not throughput.
 */

type JsonRecord = Record<string, unknown>;

/** Vanilla content density: 4 items per belt tile per lane (all belt tiers). */
export const BELT_LANE_CAPACITY_ITEMS = 4;
/** Both lanes of one belt tile. */
export const BELT_TILE_CAPACITY_ITEMS = BELT_LANE_CAPACITY_ITEMS * 2;

const DIRECTION_NAMES: Record<number, string> = {
  0: "north",
  4: "east",
  8: "south",
  12: "west",
};

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export type BeltLaneSide = "left" | "right";

export type BeltLaneItem = { name: string; count: number };

export type BeltLaneSummary = {
  side: BeltLaneSide;
  /** Raw `defines.transport_line` index used to read this lane. */
  index: number | null;
  items: BeltLaneItem[];
  item_count: number;
  capacity_items: number;
  saturation: number;
};

export type BeltLaneFeeder = { side: string; name: string; type: string };

export type BeltLaneBelt = {
  name: string;
  type: string;
  x: number;
  y: number;
  direction: number;
  direction_name: string;
  lanes: Record<BeltLaneSide, BeltLaneSummary>;
  item_count: number;
  saturation: number;
  lane_balance: { left: number; right: number; delta: number; ratio: number | null };
  lane_mix: boolean;
  lane_mix_lanes: BeltLaneSide[];
  feeder_sides: string[];
  side_load: "left" | "right" | "both" | null;
  feeders: BeltLaneFeeder[];
};

export type BeltLaneWarning = {
  kind: "lane_mix";
  x: number;
  y: number;
  lane: BeltLaneSide;
  items: BeltLaneItem[];
};

function laneItems(value: unknown): BeltLaneItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => record(entry))
    .filter((entry): entry is JsonRecord => Boolean(entry))
    .map((entry) => ({
      name: text(entry.name) ?? "unknown",
      count: Math.max(0, Math.round(num(entry.count))),
    }))
    .filter((entry) => entry.count > 0);
}

function summarizeLane(value: unknown, side: BeltLaneSide): BeltLaneSummary {
  const lane = record(value);
  const items = laneItems(lane?.items);
  const itemCount = items.reduce((sum, item) => sum + item.count, 0);
  const rawIndex = Number(lane?.index);
  return {
    side,
    index: Number.isFinite(rawIndex) ? Math.round(rawIndex) : null,
    items,
    item_count: itemCount,
    capacity_items: BELT_LANE_CAPACITY_ITEMS,
    saturation: round(Math.min(1, itemCount / BELT_LANE_CAPACITY_ITEMS)),
  };
}

/** Feeders reported by the Lua scan, in rear/left/right order. */
function summarizeFeeders(value: unknown): BeltLaneFeeder[] {
  const inputs = record(value) ?? {};
  const result: BeltLaneFeeder[] = [];
  for (const side of ["rear", "left", "right"]) {
    const feeder = record(inputs[side]);
    if (!feeder) continue;
    result.push({
      side,
      name: text(feeder.name) ?? "unknown",
      type: text(feeder.type) ?? "unknown",
    });
  }
  return result;
}

function summarizeBelt(value: unknown): BeltLaneBelt | undefined {
  const belt = record(value);
  if (!belt) return undefined;
  const left = summarizeLane(belt.left, "left");
  const right = summarizeLane(belt.right, "right");
  const direction = Math.round(num(belt.direction));
  const itemCount = left.item_count + right.item_count;
  const laneMixLanes: BeltLaneSide[] = [];
  if (left.items.length > 1) laneMixLanes.push("left");
  if (right.items.length > 1) laneMixLanes.push("right");
  const feeders = summarizeFeeders(belt.inputs);
  const sideSides = feeders
    .map((entry) => entry.side)
    .filter((side): side is "left" | "right" => side === "left" || side === "right");
  const sideLoad = sideSides.length === 2 ? "both" : (sideSides[0] ?? null);
  return {
    name: text(belt.name) ?? "unknown",
    type: text(belt.type) ?? "transport-belt",
    x: Math.floor(num(belt.x)),
    y: Math.floor(num(belt.y)),
    direction,
    direction_name: DIRECTION_NAMES[direction] ?? `direction_${direction}`,
    lanes: { left, right },
    item_count: itemCount,
    saturation: round(Math.min(1, itemCount / BELT_TILE_CAPACITY_ITEMS)),
    lane_balance: {
      left: left.item_count,
      right: right.item_count,
      delta: left.item_count - right.item_count,
      ratio: itemCount > 0 ? round(left.item_count / itemCount) : null,
    },
    lane_mix: laneMixLanes.length > 0,
    lane_mix_lanes: laneMixLanes,
    feeder_sides: feeders.map((entry) => entry.side),
    side_load: sideLoad,
    feeders,
  };
}

/**
 * Turn the raw Lua response into the agent-facing lane report.
 *
 * Belts are sorted north-to-south / west-to-east for stable output, lane-mix
 * warnings are capped to keep the payload small, and the raw lane index is kept
 * alongside the derived left/right side for debugging and backwards reference.
 */
export function summarizeBeltLanesData(value: unknown): unknown {
  const data = record(value);
  if (!data) return value;
  const belts = (Array.isArray(data.belts) ? data.belts : [])
    .map((entry) => summarizeBelt(entry))
    .filter((entry): entry is BeltLaneBelt => Boolean(entry))
    .sort((left, right) => left.y - right.y || left.x - right.x);

  const warnings: BeltLaneWarning[] = [];
  for (const belt of belts) {
    for (const lane of ["left", "right"] as const) {
      const laneData = belt.lanes[lane];
      if (laneData.items.length > 1) {
        warnings.push({ kind: "lane_mix", x: belt.x, y: belt.y, lane, items: laneData.items });
      }
    }
  }

  const scanned = Math.max(0, Math.round(num(record(data.counts)?.scanned)));
  return {
    window: {
      x: num(record(data.window)?.x),
      y: num(record(data.window)?.y),
      radius: num(record(data.window)?.radius),
    },
    mode: text(data.mode) ?? "window",
    counts: {
      belts: belts.length,
      scanned: scanned || belts.length,
      with_items: belts.filter((belt) => belt.item_count > 0).length,
      empty: belts.filter((belt) => belt.item_count === 0).length,
      lane_mix: warnings.length,
      one_lane_empty: belts.filter(
        (belt) =>
          belt.item_count > 0 && (belt.lanes.left.item_count === 0 || belt.lanes.right.item_count === 0),
      ).length,
      imbalanced: belts.filter((belt) => {
        const ratio = belt.lane_balance.ratio;
        return (
          belt.item_count >= BELT_LANE_CAPACITY_ITEMS && ratio !== null && (ratio <= 0.25 || ratio >= 0.75)
        );
      }).length,
      side_load: belts.filter((belt) => belt.side_load !== null).length,
    },
    belts,
    warnings: warnings.slice(0, 50),
    truncated: data.truncated === true,
  };
}
