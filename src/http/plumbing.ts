import type { IncomingMessage, ServerResponse } from "node:http";
import { asRecord, errorMessage, parseJson, type JsonObject } from "../validation.js";

/** Envelope schema version shared by every JSON response and `/api/health`. */
export const API_SCHEMA_VERSION = 2;

/**
 * Sends the manager's standard JSON envelope: objects are spread after
 * `schema_version`, everything else is wrapped in `data`. Status code and
 * `Content-Type`/`Content-Length` headers are identical to the legacy helper.
 */
export function json(res: ServerResponse, status: number, data: unknown) {
  const payload =
    data && typeof data === "object" && !Array.isArray(data)
      ? { schema_version: API_SCHEMA_VERSION, ...data }
      : { schema_version: API_SCHEMA_VERSION, data };
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Reads a JSON request body; empty bodies return null and oversized ones fail. */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1_000_000) {
      throw new Error("Request body too large");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

/** Result of reading a JSON request body as an object (non-objects become `{}`). */
export type BodyRead = { ok: true; body: JsonObject } | { ok: false; error: string };

/**
 * Reads a JSON body and narrows it to an object. Non-object bodies become `{}`
 * so the route handlers' optional-property fallbacks stay byte-identical, and a
 * malformed body reports the same 400 message as the legacy inline try/catch.
 */
export async function readJsonBody(req: IncomingMessage): Promise<BodyRead> {
  try {
    return { ok: true, body: asRecord(await readJson(req)) ?? {} };
  } catch (error) {
    return { ok: false, error: errorMessage(error) || "Invalid JSON" };
  }
}

/** Coerces an arbitrary value into an integer clamped to `[min, max]`. */
export function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

/**
 * Parses an RCON/Lua JSON reply through the shared safe parser, but keeps the
 * manager's historical contract: malformed text throws the caller's message.
 */
export function parseRconJson<T>(response: string, errorMessage: string): T {
  const parsed = parseJson(response);
  if (parsed === undefined) throw new Error(errorMessage);
  return parsed as T;
}
