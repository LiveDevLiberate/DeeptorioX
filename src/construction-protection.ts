/**
 * Pure production-chain working-block classification.
 *
 * Given a compact area observation (entities with name/type/x/y/status/bbox),
 * mark the tiles that belong to an active production block: the machine
 * footprint, its adjacent inserters, and the feeders immediately adjacent to
 * those inserters. The manager rejects cleanup targets that fall inside a
 * marked tile; free/legacy mode does not call this guard.
 */

type AreaEntity = {
  name?: unknown;
  type?: unknown;
  x?: unknown;
  y?: unknown;
  status?: unknown;
  bbox?: { left?: unknown; top?: unknown; right?: unknown; bottom?: unknown };
};

const MACHINE_TYPES = new Set([
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

const INACTIVE_STATUSES = new Set([
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

function finite(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function entityTile(entity: AreaEntity): { x: number; y: number } | undefined {
  const x = finite(entity.x);
  const y = finite(entity.y);
  return x === undefined || y === undefined ? undefined : { x: Math.floor(x), y: Math.floor(y) };
}

function entityBBox(entity: AreaEntity):
  | {
      left: number;
      top: number;
      right: number;
      bottom: number;
    }
  | undefined {
  const box = entity.bbox;
  const left = finite(box?.left);
  const top = finite(box?.top);
  const right = finite(box?.right);
  const bottom = finite(box?.bottom);
  if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
    const tile = entityTile(entity);
    return tile ? { left: tile.x, top: tile.y, right: tile.x, bottom: tile.y } : undefined;
  }
  return {
    left: Math.floor(left),
    top: Math.floor(top),
    right: Math.floor(right),
    bottom: Math.floor(bottom),
  };
}

function addBox(
  tiles: Set<string>,
  box: { left: number; top: number; right: number; bottom: number },
  margin = 0,
): void {
  for (let y = box.top - margin; y <= box.bottom + margin; y += 1) {
    for (let x = box.left - margin; x <= box.right + margin; x += 1) {
      tiles.add(`${x},${y}`);
    }
  }
}

function adjacentTiles(tile: { x: number; y: number }): Array<{ x: number; y: number }> {
  return [
    { x: tile.x + 1, y: tile.y },
    { x: tile.x - 1, y: tile.y },
    { x: tile.x, y: tile.y + 1 },
    { x: tile.x, y: tile.y - 1 },
  ];
}

/** Tile keys belonging to active production chains in one area observation. */
export function workingBlockTiles(entities: unknown): Set<string> {
  const list = Array.isArray(entities)
    ? entities.filter((entry): entry is AreaEntity => Boolean(entry) && typeof entry === "object")
    : [];
  const activeMachines = list.filter((entity) => {
    const type = typeof entity.type === "string" ? entity.type : "";
    const status = typeof entity.status === "string" ? entity.status : "none";
    return MACHINE_TYPES.has(type) && !INACTIVE_STATUSES.has(status);
  });
  const protectedTiles = new Set<string>();
  const activeMachineBoxes = activeMachines
    .map((machine) => {
      const box = entityBBox(machine);
      if (box) addBox(protectedTiles, box, 1);
      return box;
    })
    .filter((box): box is { left: number; top: number; right: number; bottom: number } => Boolean(box));

  const activeInserters = list.filter((entity) => {
    if ((typeof entity.type === "string" ? entity.type : "") !== "inserter") return false;
    const tile = entityTile(entity);
    if (!tile) return false;
    const touchesMachine = activeMachineBoxes.some(
      (box) =>
        tile.x >= box.left - 1 &&
        tile.x <= box.right + 1 &&
        tile.y >= box.top - 1 &&
        tile.y <= box.bottom + 1,
    );
    return touchesMachine;
  });
  const inserterTiles: Array<{ x: number; y: number }> = [];
  for (const inserter of activeInserters) {
    const tile = entityTile(inserter);
    if (!tile) continue;
    inserterTiles.push(tile);
    protectedTiles.add(`${tile.x},${tile.y}`);
    for (const adjacent of adjacentTiles(tile)) protectedTiles.add(`${adjacent.x},${adjacent.y}`);
  }

  const feeders = list.filter((entity) => {
    const type = typeof entity.type === "string" ? entity.type : "";
    if (
      !["transport-belt", "underground-belt", "splitter", "container", "logistic-container"].includes(type)
    ) {
      return false;
    }
    const tile = entityTile(entity);
    return Boolean(
      tile &&
      inserterTiles.some((inserter) =>
        adjacentTiles(inserter).some((adjacent) => adjacent.x === tile.x && adjacent.y === tile.y),
      ),
    );
  });
  for (const feeder of feeders) {
    const tile = entityTile(feeder);
    if (tile) protectedTiles.add(`${tile.x},${tile.y}`);
  }
  return protectedTiles;
}

export function isWorkingBlockTarget(entities: unknown, target: { x?: unknown; y?: unknown }): boolean {
  const x = finite(target.x);
  const y = finite(target.y);
  if (x === undefined || y === undefined) return false;
  return workingBlockTiles(entities).has(`${Math.floor(x)},${Math.floor(y)}`);
}
