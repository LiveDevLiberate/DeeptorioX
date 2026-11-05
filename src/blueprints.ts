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
