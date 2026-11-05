import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { asNumber, asRecord, asString } from "./validation.js";
import { decodeBlueprintString, type BlueprintSummary } from "./blueprints.js";

export type BlueprintSource = "saved" | "built";

export interface RunBlueprintSummary extends BlueprintSummary {
  id: string;
  sha256: string;
  source: BlueprintSource;
  created_at: string;
  size_bytes: number;
}

export interface RunBlueprintDetail extends RunBlueprintSummary {
  wire: string;
  payload: Record<string, unknown>;
}

export interface RegisterBlueprintInput {
  blueprint: unknown;
  label?: unknown;
  description?: unknown;
  source?: unknown;
}

interface BlueprintIndex {
  schema_version: 1;
  run_id: string;
  blueprints: RunBlueprintSummary[];
}

const SOURCES = new Set<BlueprintSource>(["saved", "built"]);

function indexFile(runDir: string): string {
  return path.join(runDir, "blueprints", "index.json");
}

function blueprintFile(runDir: string, sha256: string): string {
  return path.join(runDir, "blueprints", `${sha256}.txt`);
}

function readIndex(runDir: string, runId: string): BlueprintIndex {
  const file = indexFile(runDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema_version: 1, run_id: runId, blueprints: [] };
    }
    throw error;
  }
  const parsed = asRecord(JSON.parse(raw));
  if (!parsed || asNumber(parsed.schema_version) !== 1) {
    throw new Error("blueprint index is invalid");
  }
  const blueprints = Array.isArray(parsed.blueprints)
    ? parsed.blueprints
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
  return {
    schema_version: 1,
    run_id: asString(parsed.run_id) || runId,
    blueprints: blueprints
      .map((entry) => normalizeSummary(entry))
      .filter((entry): entry is RunBlueprintSummary => Boolean(entry)),
  };
}

function normalizeSummary(entry: Record<string, unknown>): RunBlueprintSummary | undefined {
  const id = asString(entry.id);
  const sha256 = asString(entry.sha256);
  const blueprintType = asString(entry.blueprint_type);
  if (!id || !sha256 || (blueprintType !== "blueprint" && blueprintType !== "blueprint_book"))
    return undefined;
  const source = asString(entry.source);
  const topEntities = Array.isArray(entry.top_entities)
    ? entry.top_entities
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map((item) => ({
          name: asString(item.name) || "unknown",
          count: Math.max(0, Math.trunc(asNumber(item.count) || 0)),
        }))
    : [];
  return {
    id,
    sha256,
    blueprint_type: blueprintType,
    label: asString(entry.label) || "Untitled blueprint",
    description: asString(entry.description) || null,
    version: asNumber(entry.version) ?? null,
    entity_count: Math.max(0, Math.trunc(asNumber(entry.entity_count) || 0)),
    tile_count: Math.max(0, Math.trunc(asNumber(entry.tile_count) || 0)),
    width: Math.max(0, Math.trunc(asNumber(entry.width) || 0)),
    height: Math.max(0, Math.trunc(asNumber(entry.height) || 0)),
    top_entities: topEntities,
    source: source === "built" ? "built" : "saved",
    created_at: asString(entry.created_at) || new Date(0).toISOString(),
    size_bytes: Math.max(0, Math.trunc(asNumber(entry.size_bytes) || 0)),
  };
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, file);
}

function writeIndex(runDir: string, index: BlueprintIndex): void {
  writeAtomic(indexFile(runDir), `${JSON.stringify(index, null, 2)}\n`);
}

function normalizeLabel(value: unknown, fallback: string): string {
  const text = asString(value)?.trim();
  return (text || fallback).slice(0, 200);
}

function normalizeDescription(value: unknown, fallback: string | null): string | null {
  const text = asString(value)?.trim();
  return (text || fallback || "").slice(0, 2000) || null;
}

function normalizeSource(value: unknown): BlueprintSource {
  const source = (asString(value) || "saved").trim().toLowerCase();
  if (!SOURCES.has(source as BlueprintSource)) {
    throw new Error('blueprint source must be "saved" or "built"');
  }
  return source as BlueprintSource;
}

/** List the blueprints registered for one run, newest first. */
export function listRunBlueprints(runDir: string, runId: string): RunBlueprintSummary[] {
  return readIndex(runDir, runId).blueprints;
}

/** Read one blueprint with its original wire string and decoded payload. */
export function readRunBlueprint(
  runDir: string,
  runId: string,
  blueprintId: string,
): RunBlueprintDetail | undefined {
  if (!/^[a-f0-9]{16}$/.test(blueprintId)) return undefined;
  const summary = readIndex(runDir, runId).blueprints.find((entry) => entry.id === blueprintId);
  if (!summary) return undefined;
  const wire = fs.readFileSync(blueprintFile(runDir, summary.sha256), "utf8");
  const decoded = decodeBlueprintString(wire);
  return { ...summary, wire, payload: decoded.payload };
}

/** Validate and persist a blueprint for one run; repeated hashes are idempotent. */
export function registerRunBlueprint(
  runDir: string,
  runId: string,
  input: RegisterBlueprintInput,
): { blueprint: RunBlueprintSummary; duplicate: boolean } {
  const wire = asString(input.blueprint)?.trim();
  if (!wire) throw new Error("blueprint must be a non-empty string");
  const decoded = decodeBlueprintString(wire);
  const source = normalizeSource(input.source);
  const index = readIndex(runDir, runId);
  const existing = index.blueprints.find((entry) => entry.sha256 === decoded.sha256);
  if (existing) return { blueprint: existing, duplicate: true };

  const summary: RunBlueprintSummary = {
    ...decoded.summary,
    id: decoded.sha256.slice(0, 16),
    sha256: decoded.sha256,
    label: normalizeLabel(input.label, decoded.summary.label),
    description: normalizeDescription(input.description, decoded.summary.description),
    source,
    created_at: new Date().toISOString(),
    size_bytes: Buffer.byteLength(wire, "utf8"),
  };
  writeAtomic(blueprintFile(runDir, decoded.sha256), wire);
  index.blueprints = [summary, ...index.blueprints];
  writeIndex(runDir, index);
  return { blueprint: summary, duplicate: false };
}
