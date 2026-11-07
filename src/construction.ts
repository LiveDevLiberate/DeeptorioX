import { createHash } from "node:crypto";

export type ConstructionMode = "free" | "planned";
export type BlueprintPolicySource = "none" | "agent" | "preloaded";
export type ConstructionPlanKind = "build" | "mutation" | "cleanup" | "blueprint" | "expansion";
export type ConstructionPlanScope = "local_repair" | "in_cluster" | "cleanup" | "expansion";

export type ConstructionBlueprintPolicy = {
  enabled: boolean;
  source: BlueprintPolicySource;
  catalog: string;
};

/** Benchmark-level construction policy. */
export type ConstructionConfig = {
  default_mode: ConstructionMode;
  modes: ConstructionMode[];
  /** Optional stable benchmark variant stem; the run appends mode/policy. */
  variant?: string;
  blueprints: ConstructionBlueprintPolicy;
};

export type ConstructionEntity = {
  name: string;
  anchor: { x: number; y: number };
  direction?: number;
  underground_type?: "input" | "output";
  recipe?: string;
  [key: string]: unknown;
};

export type ConstructionTarget = {
  x: number;
  y: number;
  cleanup?: boolean;
  allow_buildings?: boolean;
  direction?: number;
  recipe?: string;
  [key: string]: unknown;
};

export type ConstructionPlan = {
  plan_id: string;
  run_id: string;
  mode: "planned";
  kind: ConstructionPlanKind;
  scope: ConstructionPlanScope;
  created_at: number;
  expires_at: number;
  audit_revision: number;
  refactor_revision: number;
  audit_invalid_before: number;
  targets_hash: string;
  bbox: { left: number; top: number; right: number; bottom: number };
  entities: ConstructionEntity[];
  targets: ConstructionTarget[];
  allowed_entity_names: string[];
  max_entities: number;
  blueprint_id?: string;
  blueprint_hash?: string;
  anchor?: { x: number; y: number };
  rotation?: number;
  mirror?: boolean;
  single_use: true;
  status: "issued" | "consumed" | "expired" | "invalidated";
  /** Blueprint plans are consumed after every expanded entity has been sent. */
  executed_entities?: string[];
  verification?: {
    result: "effective" | "neutral" | "ineffective" | "regressed";
    audit_before: number;
    audit_after: number;
    verified_at: string;
    error?: string;
  };
};

export type ConstructionPlanErrorCode =
  | "CONSTRUCTION_MODE_FREE"
  | "PLAN_REQUIRED"
  | "PLAN_EXPIRED"
  | "PLAN_TARGET_MISMATCH"
  | "PLAN_SCOPE_VIOLATION"
  | "PLAN_REVISION_CHANGED"
  | "PLAN_KIND_MISMATCH"
  | "PLAN_ALREADY_CONSUMED"
  | "PLAN_INEFFECTIVE"
  | "PLAN_BAD_REQUEST"
  | "BLUEPRINT_INVALID"
  | "BLUEPRINT_TARGET_MISMATCH";

export class ConstructionPlanError extends Error {
  readonly code: ConstructionPlanErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: ConstructionPlanErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    status = 409,
  ) {
    super(message);
    this.name = "ConstructionPlanError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON() {
    return { error: this.code, message: this.message, ...this.details };
  }
}

const CONSTRUCTION_MODES: ConstructionMode[] = ["free", "planned"];
const BLUEPRINT_SOURCES: BlueprintPolicySource[] = ["none", "agent", "preloaded"];

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function normalizeConstruction(raw: unknown, benchmarkId: string): ConstructionConfig {
  const record = objectRecord(raw) ?? {};
  const rawModes = Array.isArray(record.modes) ? record.modes : ["free"];
  const modes = rawModes.filter(
    (mode): mode is ConstructionMode =>
      typeof mode === "string" && CONSTRUCTION_MODES.includes(mode as ConstructionMode),
  );
  const allowed = modes.length ? [...new Set(modes)] : ["free" as ConstructionMode];
  const defaultMode =
    typeof record.default_mode === "string" &&
    CONSTRUCTION_MODES.includes(record.default_mode as ConstructionMode) &&
    allowed.includes(record.default_mode as ConstructionMode)
      ? (record.default_mode as ConstructionMode)
      : allowed[0];
  const rawBlueprints = objectRecord(record.blueprints) ?? {};
  const source =
    typeof rawBlueprints.source === "string" &&
    BLUEPRINT_SOURCES.includes(rawBlueprints.source as BlueprintPolicySource)
      ? (rawBlueprints.source as BlueprintPolicySource)
      : "none";
  const blueprints: ConstructionBlueprintPolicy = {
    enabled: rawBlueprints.enabled === true && source !== "none",
    source,
    catalog:
      typeof rawBlueprints.catalog === "string" && rawBlueprints.catalog.trim()
        ? rawBlueprints.catalog.trim()
        : "run",
  };
  const variant =
    typeof record.variant === "string" && record.variant.trim() ? record.variant.trim() : undefined;
  return {
    default_mode: defaultMode,
    modes: allowed,
    ...(variant ? { variant } : {}),
    blueprints,
  };
}

/** Append mode and blueprint policy so free/planned runs never share a variant. */
export function constructionVariant(
  benchmarkId: string,
  config: ConstructionConfig,
  mode: ConstructionMode,
): string {
  const stem = config.variant || benchmarkId;
  const blueprint = config.blueprints.enabled ? config.blueprints.source : "none";
  return `${stem}:${mode}:${blueprint}`;
}

export function normalizeConstructionEntity(value: unknown): ConstructionEntity | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const anchor = objectRecord(record.anchor);
  const x = finiteNumber(anchor?.x);
  const y = finiteNumber(anchor?.y);
  if (!name || x === undefined || y === undefined) return undefined;
  const entity: ConstructionEntity = { name, anchor: { x, y } };
  const direction = finiteNumber(record.direction);
  if (direction !== undefined) entity.direction = direction;
  if (record.underground_type === "input" || record.underground_type === "output") {
    entity.underground_type = record.underground_type;
  }
  if (typeof record.recipe === "string" && record.recipe.trim()) entity.recipe = record.recipe.trim();
  return entity;
}

export function normalizeConstructionTarget(value: unknown): ConstructionTarget | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const x = finiteNumber(record.x);
  const y = finiteNumber(record.y);
  if (x === undefined || y === undefined) return undefined;
  const target: ConstructionTarget = { x, y };
  if (record.cleanup === true) target.cleanup = true;
  if (record.allow_buildings === true) target.allow_buildings = true;
  const direction = finiteNumber(record.direction);
  if (direction !== undefined) target.direction = direction;
  if (typeof record.recipe === "string" && record.recipe.trim()) target.recipe = record.recipe.trim();
  return target;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function constructionHash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function planBBox(
  entities: ConstructionEntity[],
  targets: ConstructionTarget[],
): { left: number; top: number; right: number; bottom: number } {
  const points = [
    ...entities.map((entity) => ({ x: entity.anchor.x, y: entity.anchor.y })),
    ...targets.map((target) => ({ x: target.x, y: target.y })),
  ];
  if (!points.length) return { left: 0, top: 0, right: 0, bottom: 0 };
  return {
    left: Math.min(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    right: Math.max(...points.map((point) => point.x)),
    bottom: Math.max(...points.map((point) => point.y)),
  };
}

export function constructionPlanHash(input: {
  kind: ConstructionPlanKind;
  entities?: ConstructionEntity[];
  targets?: ConstructionTarget[];
  blueprint_id?: string;
  blueprint_hash?: string;
  anchor?: { x: number; y: number };
  rotation?: number;
  mirror?: boolean;
}): string {
  return constructionHash({
    kind: input.kind,
    entities: input.entities ?? [],
    targets: input.targets ?? [],
    blueprint_id: input.blueprint_id,
    blueprint_hash: input.blueprint_hash,
    anchor: input.anchor,
    rotation: input.rotation,
    mirror: input.mirror,
  });
}

export function constructionPlanPublic(plan: ConstructionPlan) {
  return {
    plan_id: plan.plan_id,
    kind: plan.kind,
    scope: plan.scope,
    created_at: plan.created_at,
    expires_at: plan.expires_at,
    audit_revision: plan.audit_revision,
    refactor_revision: plan.refactor_revision,
    audit_invalid_before: plan.audit_invalid_before,
    verification: plan.verification,
    targets_hash: plan.targets_hash,
    bbox: plan.bbox,
    allowed_entity_names: plan.allowed_entity_names,
    max_entities: plan.max_entities,
    blueprint_id: plan.blueprint_id,
    blueprint_hash: plan.blueprint_hash,
    anchor: plan.anchor,
    rotation: plan.rotation,
    mirror: plan.mirror,
    status: plan.status,
    ...(plan.kind === "blueprint"
      ? {
          blueprint_entities: plan.entities,
          executed_entity_count: plan.executed_entities?.length ?? 0,
        }
      : {}),
  };
}
