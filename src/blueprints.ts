import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

import { asNumber, asRecord, asString } from "./validation.js";

/** Compressed blueprint strings are already base64 text; keep a bounded read. */
export const BLUEPRINT_MAX_TEXT_BYTES = 16 * 1024 * 1024;
/** Match the Python client's decompression ceiling. */
export const BLUEPRINT_MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_TOP_ENTITIES = 12;

export type BlueprintType = "blueprint" | "blueprint_book";

export interface BlueprintSummary {
  blueprint_type: BlueprintType;
  label: string;
  description: string | null;
  version: number | null;
  entity_count: number;
  tile_count: number;
  width: number;
  height: number;
  top_entities: Array<{ name: string; count: number }>;
}

export interface DecodedBlueprint {
  payload: Record<string, unknown>;
  summary: BlueprintSummary;
  /** Hash of the whitespace-normalized wire string. */
  sha256: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return asRecord(value);
}

function nonEmptyText(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  return text ? text : undefined;
}

function decodePayloadBody(text: string): Record<string, unknown> {
  const compressed = Buffer.from(text, "base64");
  let data: Buffer;
  try {
    data = inflateSync(compressed, { maxOutputLength: BLUEPRINT_MAX_DECOMPRESSED_BYTES });
  } catch (error) {
    throw new Error(
      `blueprint data is not valid zlib: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (data.length > BLUEPRINT_MAX_DECOMPRESSED_BYTES) {
    throw new Error("blueprint is too large to expand");
  }
  if (data.length === 0) throw new Error("blueprint data is empty");
  // Factorio stores a version byte inside the inflated payload in some formats.
  if (data[0] === 0 || data[0] === 1) data = data.subarray(1);
  if (data[0] !== 0x7b) {
    throw new Error("blueprint data does not contain a JSON object");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString("utf8"));
  } catch (error) {
    throw new Error(`blueprint JSON is invalid: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  const body = record(parsed);
  if (!body) throw new Error("blueprint JSON must be an object");
  return body;
}

function decodeWire(cleaned: string): Record<string, unknown> {
  // Normal Factorio strings are "0" + base64(zlib(JSON)). Tolerate a missing
  // prefix and legacy version bytes, matching factorio.py.
  const prefixed = cleaned.length > 1 && /^[0-9]/.test(cleaned) ? cleaned.slice(1) : null;
  if (prefixed !== null) {
    try {
      return decodePayloadBody(prefixed);
    } catch (error) {
      // Fall back to the unprefixed form; preserve the prefixed error if both fail.
      try {
        return decodePayloadBody(cleaned);
      } catch {
        throw error;
      }
    }
  }
  return decodePayloadBody(cleaned);
}

function entityBounds(entities: Array<Record<string, unknown>>): { width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const entity of entities) {
    const position = record(entity.position);
    const x = asNumber(position?.x);
    const y = asNumber(position?.y);
    if (x === undefined || y === undefined) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { width: 0, height: 0 };
  }
  // Positions are entity centers and footprints vary; this is a compact display
  // estimate, not a buildable footprint calculation.
  return {
    width: Math.max(1, Math.ceil(maxX - minX) + 1),
    height: Math.max(1, Math.ceil(maxY - minY) + 1),
  };
}

function summarize(payload: Record<string, unknown>): BlueprintSummary {
  const blueprint = record(payload.blueprint);
  const book = record(payload.blueprint_book);
  if (!blueprint && !book) throw new Error("blueprint JSON has no blueprint object");
  const blueprintType: BlueprintType = blueprint ? "blueprint" : "blueprint_book";
  const root = blueprint ?? book ?? {};
  const entities = blueprint && Array.isArray(blueprint.entities) ? blueprint.entities : [];
  const tiles = blueprint && Array.isArray(blueprint.tiles) ? blueprint.tiles : [];
  const entityRecords = entities
    .map(record)
    .filter((entity): entity is Record<string, unknown> => Boolean(entity));
  const counts = new Map<string, number>();
  for (const entity of entityRecords) {
    const name = nonEmptyText(entity.name);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const topEntities = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_TOP_ENTITIES)
    .map(([name, count]) => ({ name, count }));
  const bounds = entityBounds(entityRecords);
  const label = nonEmptyText(root.label) || nonEmptyText(blueprint?.label) || "Untitled blueprint";
  return {
    blueprint_type: blueprintType,
    label: label.slice(0, 200),
    description: nonEmptyText(root.description)?.slice(0, 2000) ?? null,
    version: asNumber(root.version) ?? null,
    entity_count: blueprintType === "blueprint" ? entityRecords.length : 0,
    tile_count: blueprintType === "blueprint" ? tiles.length : 0,
    width: bounds.width,
    height: bounds.height,
    top_entities: topEntities,
  };
}

export type BlueprintPrototypeSize = { width: number; height: number };

function blueprintEntities(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const root = record(payload.blueprint);
  const effective = root ?? payload;
  if (!root && payload.blueprint_book !== undefined) {
    throw new Error("blueprint books are not supported; export a single blueprint");
  }
  const entities = effective.entities;
  if (entities === undefined || entities === null) return [];
  if (!Array.isArray(entities)) throw new Error("blueprint entities must be a list");
  return entities.map((entry, index) => {
    const value = record(entry);
    if (!value) throw new Error(`blueprint entity ${index} is not an object`);
    return value;
  });
}

function blueprintPoint(value: unknown, label: string): { x: number; y: number } {
  const point = record(value);
  const x = asNumber(point?.x ?? (Array.isArray(value) ? value[0] : undefined));
  const y = asNumber(point?.y ?? (Array.isArray(value) ? value[1] : undefined));
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`${label} must contain finite x/y numbers`);
  }
  return { x, y };
}

function prototypeSize(
  sizes: Record<string, BlueprintPrototypeSize> | undefined,
  name: string,
): { width: number; height: number } | undefined {
  const size = sizes?.[name];
  return size &&
    Number.isInteger(size.width) &&
    Number.isInteger(size.height) &&
    size.width > 0 &&
    size.height > 0
    ? size
    : undefined;
}

function blueprintUndergroundType(
  entity: Record<string, unknown>,
  index: number,
): "input" | "output" | undefined {
  const name = asString(entity.name);
  if (!name || !(name === "pipe-to-ground" || name.endsWith("underground-belt"))) return undefined;
  if (entity.type !== "input" && entity.type !== "output") {
    throw new Error(`blueprint entity ${index} (${name}) needs type 'input' or 'output'`);
  }
  return entity.type;
}

export type ExpandedBlueprintEntity = {
  name: string;
  anchor: { x: number; y: number };
  direction?: number;
  underground_type?: "input" | "output";
};

/**
 * Expand a decoded blueprint payload into manager build entities.
 *
 * Positions in blueprint JSON are entity centers; manager entities carry the
 * integer top-left anchor. Prototype footprints are required for multi-tile
 * entities; unknown names fall back to a 1x1 anchor.
 */
export function expandBlueprintPayload(
  payload: Record<string, unknown>,
  options: {
    anchor?: { x: number; y: number };
    offset?: { x: number; y: number };
    prototype_sizes?: Record<string, BlueprintPrototypeSize>;
  } = {},
): ExpandedBlueprintEntity[] {
  const entities = blueprintEntities(payload);
  const expanded: ExpandedBlueprintEntity[] = [];
  const numbers: number[] = [];
  for (const [index, entity] of entities.entries()) {
    const name = asString(entity.name);
    if (!name) throw new Error(`blueprint entity ${index} has no name`);
    const position = blueprintPoint(entity.position, `blueprint entity ${index} position`);
    const rawDirection = asNumber(entity.direction);
    let direction: number | undefined;
    if (rawDirection !== undefined) {
      if (!Number.isInteger(rawDirection) || rawDirection < 0 || rawDirection > 15) {
        throw new Error(`blueprint entity ${index} direction must be 0-15`);
      }
      direction = rawDirection;
    }
    const underground = blueprintUndergroundType(entity, index);
    const size = prototypeSize(options.prototype_sizes, name);
    let anchorX: number;
    let anchorY: number;
    if (size) {
      const width = direction === 4 || direction === 12 ? size.height : size.width;
      const height = direction === 4 || direction === 12 ? size.width : size.height;
      anchorX = Math.round(position.x - width / 2);
      anchorY = Math.round(position.y - height / 2);
    } else {
      anchorX = Math.floor(position.x);
      anchorY = Math.floor(position.y);
    }
    const item: ExpandedBlueprintEntity = { name, anchor: { x: anchorX, y: anchorY } };
    if (direction !== undefined) item.direction = direction;
    if (underground) item.underground_type = underground;
    expanded.push(item);
    numbers.push(Number.isInteger(entity.entity_number) ? Number(entity.entity_number) : index);
  }
  const anchor = options.anchor;
  if (anchor && expanded.length) {
    const minX = Math.min(...expanded.map((entity) => entity.anchor.x));
    const minY = Math.min(...expanded.map((entity) => entity.anchor.y));
    for (const entity of expanded) {
      entity.anchor.x = Math.round(entity.anchor.x + anchor.x - minX);
      entity.anchor.y = Math.round(entity.anchor.y + anchor.y - minY);
    }
  }
  const offset = options.offset;
  if (offset && (offset.x || offset.y)) {
    for (const entity of expanded) {
      entity.anchor.x = Math.round(entity.anchor.x + offset.x);
      entity.anchor.y = Math.round(entity.anchor.y + offset.y);
    }
  }
  const order = expanded
    .map((entity, index) => ({ entity, index, number: numbers[index] }))
    .sort(
      (left, right) =>
        left.entity.anchor.y - right.entity.anchor.y ||
        left.entity.anchor.x - right.entity.anchor.x ||
        left.number - right.number ||
        left.index - right.index,
    );
  return order.map((entry) => entry.entity);
}

function addItemMap(target: Record<string, number>, value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) addItemCounts(target, entry);
    return;
  }
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  if (!record) return;
  if (asString(record.name)) {
    addItemCounts(target, record);
    return;
  }
  for (const [name, rawCount] of Object.entries(record)) {
    const count = asNumber(rawCount);
    if (count !== undefined && count > 0) target[name] = (target[name] ?? 0) + count;
  }
}

function addItemCounts(target: Record<string, number>, value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) addItemCounts(target, entry);
    return;
  }
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  if (!record) return;
  const name = asString(record.name);
  const count = asNumber(record.count);
  if (name && count !== undefined && count > 0) target[name] = (target[name] ?? 0) + count;
}

/** Approximate item bill for a decoded blueprint including stored entity contents/modules. */
export function blueprintRequiredItems(payload: Record<string, unknown>): Record<string, number> {
  const required: Record<string, number> = {};
  for (const entity of blueprintEntities(payload)) {
    const name = asString(entity.name);
    if (name) required[name] = (required[name] ?? 0) + 1;
    for (const field of ["items", "items_in_inventory"]) {
      const contents = entity[field];
      if (Array.isArray(contents)) {
        for (const inventory of contents) {
          const record =
            inventory && typeof inventory === "object" ? (inventory as Record<string, unknown>) : undefined;
          addItemMap(required, record?.items);
        }
      } else {
        addItemMap(required, contents);
      }
    }
    addItemCounts(required, entity.modules);
  }
  return required;
}

/**
 * Decode a Factorio blueprint wire string and produce the run-page summary.
 *
 * The string is one format digit (normally "0") followed by
 * base64(zlib(JSON)). Whitespace is ignored; missing padding and older
 * unprefixed formats are tolerated like the Python client.
 */
export function decodeBlueprintString(value: unknown): DecodedBlueprint {
  if (typeof value !== "string") throw new Error("blueprint must be a string");
  const cleaned = value.replace(/\s+/g, "");
  if (!cleaned) throw new Error("blueprint string is empty");
  if (Buffer.byteLength(cleaned, "utf8") > BLUEPRINT_MAX_TEXT_BYTES) {
    throw new Error(`blueprint string is too large (limit ${BLUEPRINT_MAX_TEXT_BYTES} bytes)`);
  }
  if (!BASE64.test(cleaned)) throw new Error("blueprint string is not valid base64");
  const padded = cleaned + "=".repeat((4 - (cleaned.length % 4)) % 4);
  const payload = decodeWire(padded);
  const summary = summarize(payload);
  const sha256 = createHash("sha256").update(cleaned).digest("hex");
  return { payload, summary, sha256 };
}

/**
 * Rotate/mirror manager-expanded blueprint entities around the blueprint
 * bounding box. `rotation` is quarter-turn*2: 2=90, 4=180, 6=270 degrees.
 */
export function transformBlueprintEntities(
  entities: ExpandedBlueprintEntity[],
  prototypeSizes: Record<string, BlueprintPrototypeSize>,
  options: { rotation?: number; mirror?: boolean } = {},
): ExpandedBlueprintEntity[] {
  const rotation = [0, 2, 4, 6].includes(Number(options.rotation)) ? Number(options.rotation) : 0;
  if (!rotation && !options.mirror)
    return entities.map((entity) => ({ ...entity, anchor: { ...entity.anchor } }));
  const withSize = entities.map((entity) => {
    const size = prototypeSizes[entity.name] ?? { width: 1, height: 1 };
    const rotated = entity.direction === 4 || entity.direction === 12;
    return {
      entity,
      width: rotated ? size.height : size.width,
      height: rotated ? size.width : size.height,
    };
  });
  const minX = Math.min(...withSize.map((entry) => entry.entity.anchor.x));
  const minY = Math.min(...withSize.map((entry) => entry.entity.anchor.y));
  const maxX = Math.max(...withSize.map((entry) => entry.entity.anchor.x + entry.width));
  const maxY = Math.max(...withSize.map((entry) => entry.entity.anchor.y + entry.height));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const transformed = withSize.map(({ entity, width, height }) => {
    let centerX = entity.anchor.x + width / 2;
    let centerY = entity.anchor.y + height / 2;
    let outWidth = width;
    let outHeight = height;
    let direction = entity.direction;
    if (options.mirror) {
      centerX = 2 * cx - centerX;
      if (direction === 4) direction = 12;
      else if (direction === 12) direction = 4;
    }
    for (let turn = 0; turn < rotation / 2; turn += 1) {
      const dx = centerX - cx;
      const dy = centerY - cy;
      centerX = cx - dy;
      centerY = cy + dx;
      [outWidth, outHeight] = [outHeight, outWidth];
      direction = direction === undefined ? undefined : (direction + 4) % 16;
    }
    const next: ExpandedBlueprintEntity = {
      name: entity.name,
      anchor: {
        x: Math.round(centerX - outWidth / 2),
        y: Math.round(centerY - outHeight / 2),
      },
    };
    if (direction !== undefined) next.direction = direction;
    if (entity.underground_type) next.underground_type = entity.underground_type;
    return next;
  });
  const newMinX = Math.min(...transformed.map((entity) => entity.anchor.x));
  const newMinY = Math.min(...transformed.map((entity) => entity.anchor.y));
  const shiftX = minX - newMinX;
  const shiftY = minY - newMinY;
  for (const entity of transformed) {
    entity.anchor.x += shiftX;
    entity.anchor.y += shiftY;
  }
  return transformed;
}
