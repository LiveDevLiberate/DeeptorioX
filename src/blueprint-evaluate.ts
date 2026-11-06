import { decodeBlueprintString } from "./blueprints.js";

export type BlueprintEvaluationInput = {
  wire: string;
  blueprintId?: string;
  label?: string;
  outputs?: Record<string, number>;
  powerKw?: number;
  buildSeconds?: number;
};

const MACHINE_PATTERNS = [
  "assembling-machine",
  "chemical-plant",
  "oil-refinery",
  "furnace",
  "lab",
  "mining-drill",
  "pumpjack",
  "centrifuge",
  "recycler",
  "boiler",
  "steam-engine",
  "generator",
  "reactor",
  "heat-exchanger",
  "steam-turbine",
  "rocket-silo",
];
const BELT_PATTERNS = ["transport-belt", "underground-belt", "splitter"];
const POLE_PATTERNS = ["electric-pole", "substation"];

function countByName(names: string[], patterns: string[], exclude: string[] = []): number {
  return names.filter(
    (name) =>
      patterns.some((pattern) => name.includes(pattern)) &&
      !exclude.some((pattern) => name.includes(pattern)),
  ).length;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Evaluate a blueprint's structural efficiency and, when supplied, dynamic
 * production/power/build metrics. Dynamic metrics must come from the built cell;
 * static metrics alone are only a layout-density comparison.
 */
export function evaluateBlueprint(input: BlueprintEvaluationInput) {
  const decoded = decodeBlueprintString(input.wire);
  const root = decoded.payload.blueprint as Record<string, unknown> | undefined;
  const entities: unknown[] = Array.isArray(root?.entities) ? root.entities : [];
  const names = entities
    .map((entity) =>
      entity && typeof entity === "object" ? (entity as Record<string, unknown>).name : undefined,
    )
    .filter((name): name is string => typeof name === "string");
  const machines = countByName(names, MACHINE_PATTERNS);
  const belts = countByName(names, BELT_PATTERNS);
  const inserters = countByName(names, ["inserter"]);
  const poles = countByName(names, POLE_PATTERNS);
  const pipes = countByName(names, ["pipe"]);
  const tileCount = Math.max(1, decoded.summary.tile_count || decoded.summary.width * decoded.summary.height);
  const entityCount = names.length;
  const support = belts + inserters + poles + pipes;
  const outputs = input.outputs ?? {};
  const totalOutputPerMinute = Object.values(outputs).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const powerKw = Number(input.powerKw) || 0;
  const buildSeconds = Number(input.buildSeconds) || 0;

  const metrics = {
    entity_count: entityCount,
    tile_count: tileCount,
    width: decoded.summary.width,
    height: decoded.summary.height,
    machines,
    belts,
    inserters,
    poles,
    pipes,
    entities_per_tile: round(entityCount / tileCount, 3),
    machines_per_100_tiles: round((machines / tileCount) * 100, 2),
    machine_share: round(machines / Math.max(1, entityCount), 3),
    support_per_machine: round(support / Math.max(1, machines), 2),
    belts_per_machine: round(belts / Math.max(1, machines), 2),
    inserters_per_machine: round(inserters / Math.max(1, machines), 2),
    poles_per_machine: round(poles / Math.max(1, machines), 2),
  };

  const dynamic =
    totalOutputPerMinute > 0
      ? {
          total_output_per_minute: round(totalOutputPerMinute, 2),
          outputs,
          output_per_tile: round(totalOutputPerMinute / tileCount, 3),
          output_per_entity: round(totalOutputPerMinute / Math.max(1, entityCount), 3),
          output_per_machine: round(totalOutputPerMinute / Math.max(1, machines), 2),
          output_per_kw: powerKw > 0 ? round(totalOutputPerMinute / powerKw, 3) : null,
          power_kw: powerKw || null,
          build_seconds: buildSeconds || null,
          seconds_per_entity: buildSeconds > 0 ? round(buildSeconds / Math.max(1, entityCount), 2) : null,
        }
      : null;

  // A transparent static index: machine density rewarded, support overhead
  // penalised, normalized to 0-100. Dynamic metrics are reported separately and
  // must not be mixed into this number.
  const structural = (100 * (machines / tileCount)) / (1 + 0.1 * (support / Math.max(1, machines)));
  const dynamicScore = dynamic
    ? 100 *
      ((dynamic.output_per_tile || 0) / 10 +
        (dynamic.output_per_machine || 0) / 100 +
        (dynamic.output_per_kw ? Math.min(2, dynamic.output_per_kw) : 0))
    : null;

  return {
    blueprint_id: input.blueprintId ?? decoded.sha256.slice(0, 16),
    label: input.label ?? decoded.summary.label,
    blueprint_type: decoded.summary.blueprint_type,
    metrics,
    dynamic,
    scores: {
      structural: round(Math.min(100, structural), 1),
      dynamic: dynamicScore === null ? null : round(dynamicScore, 1),
      note: "structural rewards machine density and penalises support overhead; dynamic uses output/tile + output/machine + output/kW. Compare like-for-like blueprints (same recipe/output).",
    },
  };
}
