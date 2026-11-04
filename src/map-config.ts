import type { Benchmark } from "./benchmarks.js";

/**
 * Map-generation settings accepted by the launch API.
 *
 * A custom `map_gen` is a full override derived from the selected benchmark:
 * seed/peaceful_mode/starting_area are validated scalars and
 * `autoplace_controls` replaces the benchmark's controls. Only the fields
 * exposed by the launch UI are accepted; unknown keys are rejected so typos
 * cannot silently change a run.
 */
export const MAP_RESOURCES = [
  { id: "iron-ore", label: "Iron ore" },
  { id: "copper-ore", label: "Copper ore" },
  { id: "coal", label: "Coal" },
  { id: "stone", label: "Stone" },
  { id: "crude-oil", label: "Crude oil" },
  { id: "uranium-ore", label: "Uranium ore" },
  { id: "water", label: "Water" },
  { id: "trees", label: "Trees" },
  { id: "rocks", label: "Rocks" },
  { id: "enemy-base", label: "Enemy bases" },
] as const;

export const MAP_PRESETS = [
  { value: 0, label: "None" },
  { value: 0.5, label: "Very low" },
  { value: 0.75, label: "Low" },
  { value: 1, label: "Normal" },
  { value: 1.5, label: "High" },
  { value: 2, label: "Very high" },
  { value: 4, label: "Extreme" },
] as const;

export const MAP_CONTROL_FIELDS = ["frequency", "size", "richness"] as const;
export type MapControlField = (typeof MAP_CONTROL_FIELDS)[number];

const RESOURCE_IDS = new Set<string>(MAP_RESOURCES.map((resource) => resource.id));
const TOP_LEVEL_KEYS = new Set(["seed", "peaceful_mode", "autoplace_controls", "starting_area"]);
const CONTROL_VALUE_MIN = 0;
const CONTROL_VALUE_MAX = 10;
const SEED_MIN = 0;
const SEED_MAX = 4294967295;
const STARTING_AREA_MIN = 0.5;
const STARTING_AREA_MAX = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapConfigMeta() {
  return {
    resources: MAP_RESOURCES,
    presets: MAP_PRESETS,
    fields: MAP_CONTROL_FIELDS,
    limits: {
      seed: { min: SEED_MIN, max: SEED_MAX },
      control: { min: CONTROL_VALUE_MIN, max: CONTROL_VALUE_MAX },
      starting_area: { min: STARTING_AREA_MIN, max: STARTING_AREA_MAX },
    },
  };
}

/**
 * Validate and merge a launch-time map generation override onto a benchmark.
 * Returns a new map_gen object; `base` is never mutated.
 */
export function normalizeMapGen(value: unknown, base: Benchmark["map_gen"]): Benchmark["map_gen"] {
  if (!isRecord(value)) throw new Error("map_gen must be an object");
  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw new Error(`Unsupported map_gen field: ${key}`);
  }

  const seed = value.seed ?? base.seed;
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < SEED_MIN || seed > SEED_MAX) {
    throw new Error(`map_gen.seed must be an integer between ${SEED_MIN} and ${SEED_MAX}`);
  }
  const next: Record<string, unknown> = { ...base, seed };

  if ("peaceful_mode" in value) {
    if (typeof value.peaceful_mode !== "boolean") throw new Error("map_gen.peaceful_mode must be a boolean");
    next.peaceful_mode = value.peaceful_mode;
  }

  if ("starting_area" in value) {
    const startingArea = value.starting_area;
    if (
      typeof startingArea !== "number" ||
      !Number.isFinite(startingArea) ||
      startingArea < STARTING_AREA_MIN ||
      startingArea > STARTING_AREA_MAX
    ) {
      throw new Error(
        `map_gen.starting_area must be a number between ${STARTING_AREA_MIN} and ${STARTING_AREA_MAX}`,
      );
    }
    next.starting_area = startingArea;
  }

  if ("autoplace_controls" in value) {
    if (!isRecord(value.autoplace_controls)) throw new Error("map_gen.autoplace_controls must be an object");
    const controls: Record<string, Record<string, number>> = {};
    for (const [resource, rawControl] of Object.entries(value.autoplace_controls)) {
      if (!RESOURCE_IDS.has(resource)) throw new Error(`Unknown map resource: ${resource}`);
      if (!isRecord(rawControl)) throw new Error(`map_gen.autoplace_controls.${resource} must be an object`);
      const control: Record<string, number> = {};
      for (const [field, rawValue] of Object.entries(rawControl)) {
        if (!(MAP_CONTROL_FIELDS as readonly string[]).includes(field)) {
          throw new Error(`Unsupported control field: ${resource}.${field}`);
        }
        if (
          typeof rawValue !== "number" ||
          !Number.isFinite(rawValue) ||
          rawValue < CONTROL_VALUE_MIN ||
          rawValue > CONTROL_VALUE_MAX
        ) {
          throw new Error(
            `${resource}.${field} must be a number between ${CONTROL_VALUE_MIN} and ${CONTROL_VALUE_MAX}`,
          );
        }
        control[field] = rawValue;
      }
      controls[resource] = control;
    }
    next.autoplace_controls = controls;
  }

  return next as Benchmark["map_gen"];
}
