/**
 * Structured pipeline graph built from the existing factory, connection and
 * area observations. It gives agents topology/ports/bboxes plus a prioritized
 * bottleneck list instead of making them infer the factory from raw text.
 */

import { BELT_TILE_CAPACITY_ITEMS } from "./belt-lanes.js";

type JsonRecord = Record<string, unknown>;

const MACHINE_TYPES = new Set([
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
]);
const PIPE_TYPES = new Set(["pipe", "pipe-to-ground", "pump", "offshore-pump", "storage-tank"]);
const POWER_TYPES = new Set(["electric-pole", "substation", "accumulator", "solar-panel"]);
const BELT_TYPES = new Set(["transport-belt", "underground-belt", "splitter"]);

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function num(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}
function list(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter((entry): entry is JsonRecord => Boolean(record(entry))) : [];
}
function tileKey(x: number, y: number): string {
  return `${Math.floor(x)},${Math.floor(y)}`;
}
function nodeId(name: string, x: number, y: number): string {
  return `${name}@${Math.floor(x)},${Math.floor(y)}`;
}
function roleOf(type: string | undefined): string {
  if (!type) return "other";
  if (MACHINE_TYPES.has(type)) return "machine";
  if (BELT_TYPES.has(type)) return "belt";
  if (PIPE_TYPES.has(type)) return "pipe";
  if (POWER_TYPES.has(type)) return "power";
  if (type === "inserter") return "inserter";
  if (type === "container" || type === "logistic-container") return "container";
  if (type === "resource") return "resource";
  return "other";
}

export type PipelineNode = {
  id: string;
  name: string;
  type: string;
  role: string;
  x: number;
  y: number;
  direction: number | null;
  recipe: string | null;
  status: string | null;
  tile_size: { width: number; height: number } | null;
  bbox: { left: number; top: number; right: number; bottom: number } | null;
  belt_items: Array<{ name: string; count: number }>;
  fluid: Record<string, number> | null;
  network_id: number | null;
};

export type PipelineEdge = {
  id: string;
  kind: "inserter" | "belt" | "pipe" | "power_range" | "power_network";
  from: string | null;
  to: string | null;
  from_tile: { x: number; y: number };
  to_tile: { x: number; y: number };
  inserter?: string;
  connection?: string;
  note?: string;
};

export type PipelineBottleneck = {
  id: string;
  kind: string;
  severity: "critical" | "warning";
  entity: string | null;
  node: string | null;
  x: number | null;
  y: number | null;
  count: number;
  reason: string;
  action: string;
};

/**
 * Build a compact graph. `area` should come from observe-area (machines,
 * pipes, power entities); `connections` and `factory` from their observations.
 */
export function buildPipelineGraph(
  factory: unknown,
  connections: unknown,
  area: unknown,
  options: {
    x: number;
    y: number;
    radius: number;
    /** Optional externally measured item/fluid rates keyed by node/segment id. */
    flows?: Record<string, number>;
  },
) {
  const factoryData = record(factory) ?? {};
  const connectionData = record(connections) ?? {};
  const areaData = record(area) ?? {};
  const nodes = new Map<string, PipelineNode>();
  const edges = new Map<string, PipelineEdge>();
  const bottlenecks: PipelineBottleneck[] = [];

  const addNode = (input: JsonRecord): PipelineNode | null => {
    const name = text(input.name);
    const x = num(input.x ?? record(input.position)?.x);
    const y = num(input.y ?? record(input.position)?.y);
    if (!name) return null;
    const id = nodeId(name, x, y);
    const existing = nodes.get(id);
    const direction = Number.isFinite(Number(input.direction)) ? Number(input.direction) : null;
    const tileSizeRecord = record(input.tile_size);
    const tileSize = tileSizeRecord
      ? { width: num(tileSizeRecord.width), height: num(tileSizeRecord.height) }
      : null;
    const bboxRecord = record(input.bbox);
    const bbox = bboxRecord
      ? {
          left: num(bboxRecord.left),
          top: num(bboxRecord.top),
          right: num(bboxRecord.right),
          bottom: num(bboxRecord.bottom),
        }
      : null;
    const rawBeltItems = Array.isArray(input.belt_items) ? input.belt_items : [];
    const beltItems = rawBeltItems
      .map((entry) => record(entry))
      .filter((entry): entry is JsonRecord => Boolean(entry))
      .map((entry) => ({ name: text(entry.name) ?? "unknown", count: num(entry.count) }));
    const fluidRecord = record(input.fluid);
    const fluid = fluidRecord
      ? Object.fromEntries(Object.entries(fluidRecord).map(([name, count]) => [name, num(count)]))
      : null;
    const networkId = Number.isFinite(Number(input.network_id)) ? Number(input.network_id) : null;
    const node: PipelineNode = {
      id,
      name,
      type: text(input.type) ?? existing?.type ?? "unknown",
      role: roleOf(text(input.type) ?? existing?.type),
      x: Math.floor(x),
      y: Math.floor(y),
      direction: direction ?? existing?.direction ?? null,
      recipe: text(input.recipe) ?? existing?.recipe ?? null,
      status: text(input.status) ?? existing?.status ?? null,
      tile_size: tileSize ?? existing?.tile_size ?? null,
      bbox: bbox ?? existing?.bbox ?? null,
      belt_items: beltItems.length > 0 ? beltItems : (existing?.belt_items ?? []),
      fluid: fluid ?? existing?.fluid ?? null,
      network_id: networkId ?? existing?.network_id ?? null,
    };
    nodes.set(id, node);
    return node;
  };

  const addEdge = (edge: PipelineEdge) => {
    if (!edges.has(edge.id)) edges.set(edge.id, edge);
  };

  // Area observation carries per-entity status, recipe, footprint and bbox.
  for (const entity of list(areaData.entities)) addNode(entity);

  // Connection observation carries belts, inserters and machine nodes.
  for (const machine of list(connectionData.machines))
    addNode({ ...machine, type: machine.name === "lab" ? "lab" : machine.type });
  for (const belt of list(connectionData.belts)) addNode({ ...belt, type: "transport-belt" });

  const inserters: JsonRecord[] = [];
  for (const raw of list(connectionData.inserters)) {
    const x = num(raw.x);
    const y = num(raw.y);
    const name = text(raw.name) ?? "inserter";
    const sourceRecord = record(raw.source);
    const targetRecord = record(raw.target);
    const source = sourceRecord ? addNode(sourceRecord) : null;
    const target = targetRecord ? addNode(targetRecord) : null;
    const id = nodeId(name, x, y);
    inserters.push({
      id,
      name,
      x: Math.floor(x),
      y: Math.floor(y),
      direction: Number.isFinite(Number(raw.direction)) ? Number(raw.direction) : null,
      source: source?.id ?? null,
      target: target?.id ?? null,
      status: text(raw.status) ?? null,
    });
    if (source && target) {
      addEdge({
        id: `inserter:${id}`,
        kind: "inserter",
        from: source.id,
        to: target.id,
        from_tile: { x: source.x, y: source.y },
        to_tile: { x: target.x, y: target.y },
        inserter: id,
      });
    }
  }

  const beltCapacity = (name: string): number => {
    if (name.startsWith("express-")) return 45;
    if (name.startsWith("fast-")) return 30;
    return 15;
  };

  const belts = list(connectionData.belts).map((raw) => {
    const x = Math.floor(num(raw.x));
    const y = Math.floor(num(raw.y));
    const next = record(raw.next);
    return {
      id: nodeId(text(raw.name) ?? "transport-belt", x, y),
      name: text(raw.name) ?? "transport-belt",
      x,
      y,
      direction: Number.isFinite(Number(raw.direction)) ? Number(raw.direction) : 0,
      next: next
        ? { x: Math.floor(num(next.x)), y: Math.floor(num(next.y)), node: null as string | null }
        : null,
      next_connection: text(raw.next_connection) ?? null,
      parallel_belts: num(raw.parallel_belts),
      items: nodes.get(nodeId(text(raw.name) ?? "transport-belt", x, y))?.belt_items ?? [],
      capacity_items_per_second: beltCapacity(text(raw.name) ?? "transport-belt"),
      actual_flow: Number.isFinite(Number(options.flows?.[nodeId(text(raw.name) ?? "transport-belt", x, y)]))
        ? Number(options.flows?.[nodeId(text(raw.name) ?? "transport-belt", x, y)])
        : null,
    };
  });
  for (const belt of belts) {
    const itemCount = belt.items.reduce((sum, item) => sum + item.count, 0);
    (belt as Record<string, unknown>).item_count = itemCount;
    // Two lanes * 4 items per tile is the vanilla belt-tile content capacity
    // (all belt tiers); this is an estimate, not measured throughput.
    (belt as Record<string, unknown>).saturation_estimate = Math.min(1, itemCount / BELT_TILE_CAPACITY_ITEMS);
    (belt as Record<string, unknown>).capacity_basis =
      "static_tier_capacity; throughput needs production sampling";
  }

  const beltByTile = new Map(belts.map((belt) => [tileKey(belt.x, belt.y), belt]));
  for (const belt of belts) {
    if (!belt.next) continue;
    const nextBelt = beltByTile.get(tileKey(belt.next.x, belt.next.y));
    if (nextBelt) belt.next.node = nextBelt.id;
    addEdge({
      id: `belt:${belt.id}->${tileKey(belt.next.x, belt.next.y)}`,
      kind: "belt",
      from: belt.id,
      to: nextBelt?.id ?? null,
      from_tile: { x: belt.x, y: belt.y },
      to_tile: { x: belt.next.x, y: belt.next.y },
      connection: belt.next_connection ?? undefined,
    });
  }

  // Group belts into maximal directed segments for a compact line view.
  const assigned = new Set<string>();
  const beltSegments: Array<Record<string, unknown>> = [];
  for (const belt of belts) {
    if (assigned.has(belt.id)) continue;
    const tiles: Array<{ x: number; y: number }> = [];
    let cursor: typeof belt | undefined = belt;
    while (cursor && !assigned.has(cursor.id)) {
      assigned.add(cursor.id);
      tiles.push({ x: cursor.x, y: cursor.y });
      cursor = cursor.next?.node ? belts.find((entry) => entry.id === cursor?.next?.node) : undefined;
    }
    if (tiles.length > 0) {
      beltSegments.push({
        id: `belt_segment:${belt.id}`,
        name: belt.name,
        length: tiles.length,
        head: tiles[0],
        tail: tiles[tiles.length - 1],
        direction: belt.direction,
        tiles,
      });
    }
  }

  for (const segment of beltSegments) {
    const segmentFlows = (segment.tiles as Array<{ x: number; y: number }>)
      .map((tile) => belts.find((belt) => belt.x === tile.x && belt.y === tile.y)?.actual_flow)
      .filter((value): value is number => typeof value === "number");
    segment.actual_flow = segmentFlows.length > 0 ? Math.max(...segmentFlows) : null;
  }

  // Pipe connectivity by cardinal adjacency (pipes, pumps, tanks).
  const pipes = [...nodes.values()].filter((node) => node.role === "pipe" && node.type !== "offshore-pump");
  const pipeTiles = new Map(pipes.map((node) => [tileKey(node.x, node.y), node]));
  for (const pipe of pipes) {
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      const neighbor = pipeTiles.get(tileKey(pipe.x + dx, pipe.y + dy));
      if (!neighbor) continue;
      const [from, to] = pipe.id < neighbor.id ? [pipe, neighbor] : [neighbor, pipe];
      addEdge({
        id: `pipe:${from.id}->${to.id}`,
        kind: "pipe",
        from: from.id,
        to: to.id,
        from_tile: { x: from.x, y: from.y },
        to_tile: { x: to.x, y: to.y },
      });
    }
  }

  // Pipe topology summary: connected components, dead ends, branches and
  // surface-vs-underground clutter. This is advisory for pipeline-audit.
  const pipeByTile = new Map<string, PipelineNode>();
  for (const pipe of pipes) pipeByTile.set(tileKey(pipe.x, pipe.y), pipe);
  const serviceTiles = new Set<string>();
  for (const node of nodes.values()) {
    if (
      node.role === "machine" ||
      node.type === "pump" ||
      node.type === "offshore-pump" ||
      node.type === "storage-tank"
    ) {
      serviceTiles.add(tileKey(node.x, node.y));
    }
  }
  const pipeNeighbors = new Map<string, string[]>();
  for (const pipe of pipes) {
    const neighbors: string[] = [];
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      const neighbor = pipeByTile.get(tileKey(pipe.x + dx, pipe.y + dy));
      if (neighbor) neighbors.push(neighbor.id);
    }
    pipeNeighbors.set(pipe.id, neighbors);
  }
  const pipeComponents: Array<{
    id: number;
    size: number;
    x: number;
    y: number;
    fluids: string[];
    dead_ends: number;
    branches: number;
  }> = [];
  const pipeSeen = new Set<string>();
  for (const pipe of pipes) {
    if (pipeSeen.has(pipe.id)) continue;
    const componentId = pipeComponents.length;
    const stack = [pipe];
    pipeSeen.add(pipe.id);
    const members: PipelineNode[] = [];
    while (stack.length) {
      const node = stack.pop()!;
      members.push(node);
      for (const neighborId of pipeNeighbors.get(node.id) ?? []) {
        if (pipeSeen.has(neighborId)) continue;
        pipeSeen.add(neighborId);
        const neighbor = pipeByTile.get(neighborId.split("@").pop() ?? "");
        const found = neighbor ?? pipes.find((candidate) => candidate.id === neighborId);
        if (found) stack.push(found);
      }
    }
    const fluids = [...new Set(members.flatMap((node) => Object.keys(node.fluid ?? {})))];
    let deadEnds = 0;
    let branches = 0;
    for (const member of members) {
      const degree = (pipeNeighbors.get(member.id) ?? []).length;
      if (degree >= 3) branches += 1;
      if (degree !== 1) continue;
      const touchesService = [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ].some(([dx, dy]) => serviceTiles.has(tileKey(member.x + dx, member.y + dy)));
      if (!touchesService) deadEnds += 1;
    }
    pipeComponents.push({
      id: componentId,
      size: members.length,
      x: Math.round(members.reduce((sum, node) => sum + node.x, 0) / members.length),
      y: Math.round(members.reduce((sum, node) => sum + node.y, 0) / members.length),
      fluids,
      dead_ends: deadEnds,
      branches,
    });
  }
  const pipeDeadEnds = pipeComponents.reduce((sum, component) => sum + component.dead_ends, 0);
  const pipeBranches = pipeComponents.reduce((sum, component) => sum + component.branches, 0);
  const surfacePipes = pipes.filter((node) => node.type === "pipe").length;
  const undergroundPipes = pipes.filter((node) => node.type === "pipe-to-ground").length;
  const powerPoles = [...nodes.values()].filter((node) => node.role === "power");
  const powerNetworkGroups = new Map<number, Array<{ id: string; name: string; x: number; y: number }>>();
  for (const pole of powerPoles) {
    if (pole.network_id === null) continue;
    const group = powerNetworkGroups.get(pole.network_id) ?? [];
    group.push({ id: pole.id, name: pole.name, x: pole.x, y: pole.y });
    powerNetworkGroups.set(pole.network_id, group);
  }
  // Pairwise power edges explode on a large base (N poles in one network).
  // Represent the network as a group; only range heuristics for unnetworked poles.
  for (const pole of powerPoles) {
    if (pole.network_id !== null) continue;
    for (const other of powerPoles) {
      if (pole.id >= other.id || other.network_id !== null) continue;
      const distance = Math.hypot(pole.x - other.x, pole.y - other.y);
      if (distance > 7.5) continue;
      addEdge({
        id: `power:${pole.id}->${other.id}`,
        kind: "power_range",
        from: pole.id,
        to: other.id,
        from_tile: { x: pole.x, y: pole.y },
        to_tile: { x: other.x, y: other.y },
        note: "within small-pole wire range; actual network may differ",
      });
    }
  }

  const machines = [...nodes.values()]
    .filter((node) => node.role === "machine")
    .map((machine) => {
      const inputs = inserters.filter((entry) => entry.target === machine.id);
      const outputs = inserters.filter((entry) => entry.source === machine.id);
      return {
        ...machine,
        input_inserters: inputs.map((entry) => entry.id),
        output_inserters: outputs.map((entry) => entry.id),
        input_count: inputs.length,
        output_count: outputs.length,
        actual_flow: Number.isFinite(Number(options.flows?.[machine.id]))
          ? Number(options.flows?.[machine.id])
          : null,
      };
    });

  const addBottleneck = (entry: Omit<PipelineBottleneck, "count"> & { count?: number }) => {
    const existing = bottlenecks.find(
      (item) =>
        item.kind === entry.kind && item.node === entry.node && item.x === entry.x && item.y === entry.y,
    );
    if (existing) existing.count += entry.count ?? 1;
    else bottlenecks.push({ ...entry, count: entry.count ?? 1 });
  };

  if (pipes.length >= 2) {
    const fluidOwners = new Map<string, number>();
    for (const component of pipeComponents) {
      for (const fluid of component.fluids) fluidOwners.set(fluid, (fluidOwners.get(fluid) ?? 0) + 1);
    }
    const splitFluids = [...fluidOwners.entries()].filter(([, count]) => count > 1).map(([fluid]) => fluid);
    if (splitFluids.length) {
      addBottleneck({
        id: `pipe:split-network:${splitFluids.join(",")}`,
        kind: "pipe_split_network",
        severity: "warning",
        entity: null,
        node: null,
        x: pipeComponents[0]?.x ?? null,
        y: pipeComponents[0]?.y ?? null,
        count: splitFluids.length,
        reason: `Same fluid is split across disconnected networks: ${splitFluids.join(", ")}`,
        action:
          "Merge the disconnected runs with build-line --kind pipe --route auto; use underground pipes for crossings.",
      });
    }
    if (pipeDeadEnds > 0) {
      addBottleneck({
        id: "pipe:dead-ends",
        kind: "pipe_dead_end",
        severity: "warning",
        entity: null,
        node: null,
        x: pipeComponents[0]?.x ?? null,
        y: pipeComponents[0]?.y ?? null,
        count: pipeDeadEnds,
        reason: `${pipeDeadEnds} pipe dead end(s) not attached to a machine, pump or tank`,
        action:
          "Remove the stub or connect it to a valid port; prefer one planned trunk with short branches over ad-hoc pipe patches.",
      });
    }
    if (pipeBranches >= 6) {
      addBottleneck({
        id: "pipe:branches",
        kind: "pipe_branching",
        severity: "warning",
        entity: null,
        node: null,
        x: pipeComponents[0]?.x ?? null,
        y: pipeComponents[0]?.y ?? null,
        count: pipeBranches,
        reason: `${pipeBranches} pipe branch node(s); topology looks patched rather than trunk-and-branch`,
        action:
          "Run build-line --kind pipe --route auto for the trunk and underground-pipe-line for crossings; keep LAYOUT.md's pipe corridor aligned.",
      });
    }
    if (surfacePipes >= 20 && undergroundPipes <= surfacePipes * 0.15) {
      addBottleneck({
        id: "pipe:surface-clutter",
        kind: "pipe_surface_clutter",
        severity: "warning",
        entity: null,
        node: null,
        x: pipeComponents[0]?.x ?? null,
        y: pipeComponents[0]?.y ?? null,
        count: surfacePipes,
        reason: `${surfacePipes} surface pipes vs ${undergroundPipes} underground pipes`,
        action:
          "Replace crossings and long runs with pipe-to-ground; use build-line --kind pipe --route auto instead of hand-placing single tiles.",
      });
    }
  }

  for (const issue of list(connectionData.issues)) {
    const kind = text(issue.kind) ?? "unknown";
    const coords = nodeId(text(issue.name) ?? "entity", num(issue.x), num(issue.y));
    addBottleneck({
      id: `issue:${kind}:${coords}`,
      kind,
      severity:
        String(issue.kind).startsWith("belt_") || String(issue.kind).startsWith("inserter_")
          ? "warning"
          : "critical",
      entity: text(issue.name) ?? null,
      node: nodes.get(coords)?.id ?? null,
      x: Math.floor(num(issue.x)),
      y: Math.floor(num(issue.y)),
      reason: kind.replaceAll("_", " "),
      action: kind.startsWith("belt_")
        ? "Repair/rotate/remove this belt link."
        : kind.startsWith("inserter_")
          ? "Fix the inserter source/target."
          : "Inspect the connection.",
    });
  }

  const problems = record(factoryData.problems) ?? {};
  const factoryActions: Record<string, string> = {
    no_fuel: "Refuel or automate fuel delivery.",
    no_power: "Restore pole coverage/power.",
    no_input_fluid: "Fix pipe/pump connection or supply.",
    no_minable_resources: "Move/remove the drill.",
    waiting_for_space_in_destination: "Clear output/backpressure.",
    no_ingredients: "Feed the machine/check upstream.",
    missing_science_packs: "Connect science-pack supply.",
  };
  for (const [kind, samples] of Object.entries(problems)) {
    for (const sample of list(samples)) {
      const id = nodeId(text(sample.name) ?? "entity", num(sample.x), num(sample.y));
      addBottleneck({
        id: `factory:${kind}:${id}`,
        kind,
        severity: ["no_fuel", "no_power", "no_input_fluid", "no_minable_resources"].includes(kind)
          ? "critical"
          : "warning",
        entity: text(sample.name) ?? null,
        node: nodes.get(id)?.id ?? null,
        x: Math.floor(num(sample.x)),
        y: Math.floor(num(sample.y)),
        reason: kind.replaceAll("_", " "),
        action: factoryActions[kind] ?? "Inspect the machine.",
      });
    }
  }

  for (const machine of machines) {
    if (!machine.status || ["working", "normal", "none", "idle"].includes(machine.status)) continue;
    addBottleneck({
      id: `machine_status:${machine.id}:${machine.status}`,
      kind: machine.status,
      severity:
        machine.status.includes("no_power") || machine.status.includes("no_fuel") ? "critical" : "warning",
      entity: machine.name,
      node: machine.id,
      x: machine.x,
      y: machine.y,
      reason: machine.status.replaceAll("_", " "),
      action: "Inspect machine inputs/outputs and status.",
    });
  }

  bottlenecks.sort(
    (a, b) =>
      (a.severity === "critical" ? 0 : 1) - (b.severity === "critical" ? 0 : 1) ||
      b.count - a.count ||
      a.kind.localeCompare(b.kind),
  );

  return {
    schema_version: 1,
    window: { x: options.x, y: options.y, radius: options.radius },
    counts: {
      nodes: nodes.size,
      machines: machines.length,
      inserters: inserters.length,
      belts: belts.length,
      belt_segments: beltSegments.length,
      pipes: pipes.length,
      pipe_components: pipeComponents.length,
      pipe_dead_ends: pipeDeadEnds,
      pipe_branches: pipeBranches,
      power_poles: powerPoles.length,
      edges: edges.size,
      power_networks: powerNetworkGroups.size,
      bottlenecks: bottlenecks.length,
    },
    machines,
    inserters,
    belts,
    belt_segments: beltSegments,
    pipes: pipes.map((node) => ({
      id: node.id,
      name: node.name,
      x: node.x,
      y: node.y,
      fluid: node.fluid,
    })),
    pipe_components: pipeComponents,
    pipe_topology: {
      components: pipeComponents.length,
      dead_ends: pipeDeadEnds,
      branches: pipeBranches,
      surface_pipes: surfacePipes,
      underground_pipes: undergroundPipes,
    },
    power_poles: powerPoles.map((node) => ({
      id: node.id,
      name: node.name,
      x: node.x,
      y: node.y,
      network_id: node.network_id,
    })),
    power_network_groups: [...powerNetworkGroups.entries()].map(([id, poles]) => ({
      id,
      count: poles.length,
      poles,
    })),
    edges: [...edges.values()],
    bottlenecks: bottlenecks.slice(0, 60),
    bottleneck_actions: bottlenecks.slice(0, 20).map((entry) => ({
      kind: entry.kind,
      severity: entry.severity,
      count: entry.count,
      action: entry.action,
      node: entry.node,
    })),
  };
}
