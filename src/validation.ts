// Lightweight runtime validation for the dynamic boundaries of the manager:
// RCON/Lua JSON replies, HTTP request bodies and agent JSONL events. Zero
// dependencies; every helper narrows `unknown` and never throws, so callers stay
// in control of the fallback. Boundary code should use these instead of `: any`.
export type JsonObject = Record<string, unknown>;
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the value as a JSON object, or undefined for arrays/primitives/null. */
export function asRecord(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Narrows to a finite number or falls back; keeps NaN/Infinity out of the API. */
export function numberOr(value: unknown, fallback: number): number {
  return asNumber(value) ?? fallback;
}

export function stringOr(value: unknown, fallback: string): string {
  return asString(value) ?? fallback;
}

/** Reads one key of a JSON object with a guard; returns undefined when absent/invalid. */
export function pick<T>(
  record: unknown,
  key: string,
  guard: (value: unknown) => T | undefined,
): T | undefined {
  const object = asRecord(record);
  return object ? guard(object[key]) : undefined;
}

/** Reads and validates an array, dropping invalid entries. */
export function arrayOf<T>(value: unknown, guard: (item: unknown) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  const result: T[] = [];
  for (const item of value) {
    const parsed = guard(item);
    if (parsed !== undefined) result.push(parsed);
  }
  return result;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Safe JSON parse for RCON/Lua and agent output. Returns undefined instead of
 * throwing so a malformed reply becomes a typed error in the caller.
 */
export function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function parseJsonObject(text: unknown): JsonObject | undefined {
  return asRecord(parseJson(text));
}

/** Short type label for diagnostics ("object", "array", "null", "number", ...). */
export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Best-effort message for a caught `unknown`: Error instances and objects with a
 * non-empty string `message` report it; anything else returns undefined so the
 * caller can apply its own fallback (e.g. "Action job failed").
 */
export function errorMessage(value: unknown): string | undefined {
  const message = value instanceof Error ? value.message : isRecord(value) ? value.message : undefined;
  return typeof message === "string" && message ? message : undefined;
}

/** Collects the invalid fields of a record, for actionable error messages. */
export function missingFields(record: unknown, fields: string[]): string[] {
  const object = asRecord(record);
  if (!object) return fields;
  return fields.filter((field) => object[field] === undefined || object[field] === null);
}

type FieldGuard = (value: unknown) => boolean;

/** Validates required fields with guards; returns the list of invalid field names. */
export function invalidFields(record: unknown, schema: Record<string, FieldGuard>): string[] {
  const object = asRecord(record);
  if (!object) return Object.keys(schema);
  return Object.entries(schema)
    .filter(([key, guard]) => !guard(object[key]))
    .map(([key]) => key);
}

/** Throws a consistent Error for a boundary payload that failed validation. */
export function invalidPayload(label: string, fields: string[]): Error {
  return new Error(
    `${label} is invalid: ${fields.length > 0 ? fields.join(", ") : "expected a JSON object"}`,
  );
}
