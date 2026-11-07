import { createHash } from "node:crypto";

/**
 * Refactor audit: turn the factory/connection observations into a short,
 * prioritized action list. The agent should repair the highest-impact item,
 * verify, and re-audit instead of endlessly adding new buildings.
 */

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function number(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

const FACTORY_PROBLEMS: Record<string, { severity: "critical" | "warning"; label: string; action: string }> =
  {
    no_power: {
      severity: "critical",
      label: "entities have no power",
      action: "Restore power/pole coverage.",
    },
    no_fuel: {
      severity: "critical",
      label: "entities have no fuel",
      action: "Refuel or automate fuel delivery.",
    },
    no_input_fluid: {
      severity: "critical",
      label: "entities have no input fluid",
      action: "Fix pipe/pump connection or supply.",
    },
    no_minable_resources: {
      severity: "critical",
      label: "drills have no minable resources",
      action: "Move drill to ore or remove it.",
    },
    waiting_for_space_in_destination: {
      severity: "warning",
      label: "entities are waiting for output space",
      action: "Clear the output/backpressure or add consumer/storage.",
    },
    no_ingredients: {
      severity: "warning",
      label: "furnaces have no ingredients",
      action: "Feed the machine/check upstream belt.",
    },
    missing_science_packs: {
      severity: "warning",
      label: "labs are missing science packs",
      action: "Connect science-pack supply to the labs.",
    },
  };

export type RefactorScope = "belts" | "power" | "pipes" | "machines" | "containers" | "rail";

/** A spatial group of flagged invalid tiles the agent may rebuild inside. */
export type RefactorCluster = {
  x: number;
  y: number;
  radius: number;
  /** Sampled invalid entries in the cluster (used for ordering, not exact debt). */
  count: number;
  kinds: string[];
};

/** Clusters are advisory windows, so an entity near the edge still counts. */
export const REFACTOR_CLUSTER_TOLERANCE = 2;
/** Bound the cluster list so the run record and 409 payload stay compact. */
export const MAX_REFACTOR_CLUSTERS = 8;

/** Default scope: belts, power, pipes, machines and empty containers. Rail is opt-in. */
export const DEFAULT_REFACTOR_SCOPE: RefactorScope[] = ["belts", "power", "pipes", "machines", "containers"];

/**
 * Minimum scan radius for an audit to update the run's global refactor debt.
 * Smaller local audits are still returned to the caller but must not clear a
 * `REFACTOR_REQUIRED` gate by scanning a clean corner.
 */
export const REFACTOR_DEBT_MIN_RADIUS = 120;

/** True when the audit scope covers every default refactor category (full audit). */
export function coversDefaultRefactorScope(scope: readonly string[] | undefined): boolean {
  if (!scope || scope.length === 0) return true;
  return DEFAULT_REFACTOR_SCOPE.every((entry) => scope.includes(entry));
}

/**
 * Center of the scan echoed by an observation (`window:{x,y,radius}`).
 *
 * The Lua builders resolve omitted coordinates to the player position, so this
 * is the authoritative center for cleanup hints and debt bookkeeping. Recording
 * the map origin instead makes the audit report and its cleanup window drift
 * away from the area that was actually scanned.
 */
export function observationCenter(value: unknown): { x: number; y: number } | undefined {
  const window = asRecord(asRecord(value)?.window);
  const x = Number(window?.x);
  const y = Number(window?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

const FACTORY_SCOPE: Record<string, RefactorScope> = {
  no_power: "power",
  no_input_fluid: "pipes",
  no_fuel: "machines",
  no_minable_resources: "machines",
  waiting_for_space_in_destination: "machines",
  no_ingredients: "machines",
  missing_science_packs: "machines",
};

function issueScope(kind: string): RefactorScope {
  if (kind.startsWith("belt_") || kind === "parallel_belts") return "belts";
  if (kind.startsWith("inserter_")) return "machines";
  if (kind.startsWith("machine_") || kind.startsWith("factory:")) return "machines";
  if (kind.startsWith("pipe_")) return "pipes";
  if (kind.startsWith("empty_chest") || kind.startsWith("container_")) return "containers";
  if (kind.startsWith("power_") || kind.startsWith("pole_")) return "power";
  if (kind.startsWith("rail_") || kind.startsWith("train_")) return "rail";
  return "machines";
}

const BELT_ACTIONS: Record<string, { severity: "critical" | "warning"; action: string }> = {
  belt_no_input: { severity: "warning", action: "Connect a feeder/side-load or remove the orphan belt." },
  belt_dead_end: { severity: "warning", action: "Extend/rotate/remove the dead-end belt." },
  belt_opposite: { severity: "warning", action: "Rotate one belt or replace the head-on junction." },
  belt_head_on: { severity: "warning", action: "Rotate one belt or replace the head-on junction." },
  belt_points_to_non_belt: {
    severity: "warning",
    action: "Put an inserter between the belt and the building.",
  },
};

function examples(value: unknown, limit = 3): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is JsonRecord => Boolean(asRecord(entry))).slice(0, limit)
    : [];
}

/** Whether a world tile lies inside a flagged cluster (plus a small tolerance). */
export function pointInRefactorCluster(
  cluster: { x?: unknown; y?: unknown; radius?: unknown } | undefined,
  x: number,
  y: number,
  tolerance = REFACTOR_CLUSTER_TOLERANCE,
): boolean {
  if (!cluster) return false;
  const cx = Number(cluster.x);
  const cy = Number(cluster.y);
  const radius = Number(cluster.radius);
  if (![cx, cy, radius, x, y].every(Number.isFinite)) return false;
  const slack = Number.isFinite(tolerance) ? Math.max(0, tolerance) : 0;
  return Math.hypot(x - cx, y - cy) <= radius + slack;
}

const CLUSTER_GRID = 24;

/**
 * Group the sampled invalid tiles into a few rebuild windows.
 *
 * Audit actions already carry example coordinates (and belts carry a tight
 * `cleanup` window). Bucketing them keeps the gate cheap: while expansion is
 * blocked, the agent may still rebuild inside these windows.
 */
function buildRefactorClusters(actions: Array<Record<string, unknown>>): RefactorCluster[] {
  type Entry = { x: number; y: number; kind: string; count: number; radius?: number };
  const entries: Entry[] = [];
  for (const action of actions) {
    const kind = typeof action.kind === "string" ? action.kind : "unknown";
    const count = Math.max(1, Math.round(number(action.count)));
    const cleanup = asRecord(action.cleanup);
    const windowX = Number(cleanup?.x);
    const windowY = Number(cleanup?.y);
    const windowRadius = Number(cleanup?.radius);
    if (cleanup && [windowX, windowY, windowRadius].every(Number.isFinite)) {
      entries.push({
        x: windowX,
        y: windowY,
        kind,
        count,
        radius: Math.max(4, Math.min(32, Math.round(windowRadius))),
      });
      continue;
    }
    for (const sample of examples(action.examples)) {
      const x = Number(sample.x);
      const y = Number(sample.y);
      if (Number.isFinite(x) && Number.isFinite(y)) entries.push({ x, y, kind, count });
    }
  }
  if (entries.length === 0) return [];

  const clusters: RefactorCluster[] = [];
  const buckets = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (entry.radius) {
      clusters.push({
        x: Math.round(entry.x),
        y: Math.round(entry.y),
        radius: entry.radius,
        count: entry.count,
        kinds: [entry.kind],
      });
      continue;
    }
    const key = `${Math.floor(entry.x / CLUSTER_GRID)}:${Math.floor(entry.y / CLUSTER_GRID)}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(entry);
    buckets.set(key, bucket);
  }
  for (const points of buckets.values()) {
    const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const spread = Math.max(...points.map((point) => Math.hypot(point.x - x, point.y - y)));
    clusters.push({
      x: Math.round(x),
      y: Math.round(y),
      radius: Math.max(8, Math.min(40, Math.ceil(spread + 6))),
      count: points.length,
      kinds: [...new Set(points.map((point) => point.kind))].slice(0, 4),
    });
  }
  clusters.sort((left, right) => right.count - left.count || left.x - right.x || left.y - right.y);
  return clusters.slice(0, MAX_REFACTOR_CLUSTERS);
}

/**
 * Tight relayout window around the sampled issue tiles. A broad repair hint
 * (the whole audit window) made agents recycle every belt in a large base after
 * a handful of bad links, so cleanup stays local unless the debt is widespread.
 */
function issueCluster(samples: JsonRecord[]): { x: number; y: number; radius: number } | undefined {
  const points = samples
    .map((sample) => ({ x: Number(sample.x), y: Number(sample.y) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (points.length === 0) return undefined;
  const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const spread = Math.max(...points.map((point) => Math.hypot(point.x - x, point.y - y)));
  return {
    x: Math.round(x),
    y: Math.round(y),
    radius: Math.max(8, Math.min(24, Math.ceil(spread + 4))),
  };
}

/**
 * Build a compact, prioritized refactor plan from factory + connection data.
 * Inputs may be the normalized observation `data` objects.
 */
export function buildRefactorAudit(
  factory: unknown,
  connections: unknown,
  options: {
    center?: { x: number; y: number };
    radius?: number;
    scope?: RefactorScope[];
    includeRail?: boolean;
  } = {},
) {
  const factoryData = asRecord(factory) ?? {};
  const connectionData = asRecord(connections) ?? {};
  const totals = asRecord(factoryData.totals) ?? {};
  const problems = asRecord(factoryData.problems) ?? {};
  const counts = asRecord(factoryData.counts) ?? {};
  const connectionCounts = asRecord(connectionData.counts) ?? {};
  const issues = Array.isArray(connectionData.issues) ? connectionData.issues : [];
  const belts = Array.isArray(connectionData.belts) ? connectionData.belts : [];
  const center = options.center ?? { x: 0, y: 0 };
  const radius = Math.max(1, Math.floor(options.radius ?? 120));
  const scope = new Set<RefactorScope>(
    options.includeRail
      ? [...(options.scope ?? DEFAULT_REFACTOR_SCOPE), "rail"]
      : (options.scope ?? DEFAULT_REFACTOR_SCOPE),
  );

  const actions: Array<Record<string, unknown>> = [];
  const addAction = (entry: Record<string, unknown>) => {
    if (actions.length >= 24) return;
    actions.push(entry);
  };
  // Scoped debt by kind, used for the stable fingerprint. Coordinates and
  // example tiles are deliberately excluded: they move with every repair, so
  // including them made the "same audit three times" escalation unreachable.
  const debtCounts = new Map<string, number>();

  let scopedFactoryProblems = 0;
  for (const [kind, meta] of Object.entries(FACTORY_PROBLEMS)) {
    const problemScope = FACTORY_SCOPE[kind] ?? "machines";
    if (!scope.has(problemScope)) continue;
    const count = number(totals[kind]) || (Array.isArray(problems[kind]) ? problems[kind].length : 0);
    if (count <= 0) continue;
    scopedFactoryProblems += count;
    debtCounts.set(`factory:${kind}`, count);
    addAction({
      id: `factory:${kind}`,
      kind,
      severity: meta.severity,
      label: meta.label,
      count,
      priority: (meta.severity === "critical" ? 1000 : 300) + count,
      action: meta.action,
      examples: examples(problems[kind]),
    });
  }

  const emptyContainers = Array.isArray(factoryData.empty_containers) ? factoryData.empty_containers : [];
  const containerStats = asRecord(factoryData.containers) ?? {};
  const emptyChestCount = number(containerStats.empty) || emptyContainers.length;
  let scopedEmptyContainers = 0;
  if (scope.has("containers") && emptyChestCount > 0) {
    scopedEmptyContainers = emptyChestCount;
    debtCounts.set("factory:empty_containers", emptyChestCount);
    addAction({
      id: "factory:empty_containers",
      kind: "empty_containers",
      severity: "warning",
      label: "empty chests/containers on the map",
      count: emptyChestCount,
      priority: 250 + emptyChestCount,
      action: "Remove empty containers or reuse them for storage; empty chests are refactor debt.",
      examples: emptyContainers.slice(0, 3),
    });
  }

  const issueGroups = new Map<string, JsonRecord[]>();
  for (const raw of issues) {
    const issue = asRecord(raw);
    if (!issue) continue;
    const kind = typeof issue.kind === "string" ? issue.kind : "unknown";
    const group = issueGroups.get(kind) ?? [];
    if (group.length < 3) group.push(issue);
    issueGroups.set(kind, group);
  }
  let scopedConnectionIssues = 0;
  for (const [kind, samples] of issueGroups) {
    const issueCategory = issueScope(kind);
    if (!scope.has(issueCategory)) continue;
    const count = issues.filter((raw) => asRecord(raw)?.kind === kind).length;
    scopedConnectionIssues += count;
    debtCounts.set(`connection:${kind}`, count);
    const meta = BELT_ACTIONS[kind];
    const isBelt = kind.startsWith("belt_");
    // Repair the sampled tiles first. A relayout is only suggested for a belt
    // section that keeps failing, and it targets the issue cluster instead of
    // the full audit window: recycling every belt in a large base after a few
    // bad links is worse than the original problem.
    const cleanup = isBelt && count >= 3 ? issueCluster(samples) : undefined;
    const action = cleanup
      ? `Repair the listed belt tiles in place; only if this section still fails after 3 audits, run relayout-belts around ${cleanup.x},${cleanup.y} radius ${cleanup.radius}.`
      : kind.startsWith("inserter_")
        ? "Fix the inserter source/target or remove it."
        : (meta?.action ?? "Inspect the listed coordinates and repair the connection.");
    addAction({
      id: `connection:${kind}`,
      kind,
      severity: meta?.severity ?? "warning",
      label: kind.replaceAll("_", " "),
      count,
      priority: (isBelt ? 200 : 150) + count,
      action,
      examples: samples,
      ...(cleanup ? { cleanup } : {}),
    });
  }

  let railIssues = 0;
  if (scope.has("rail")) {
    const rail = Array.isArray(connectionData.rail_issues) ? connectionData.rail_issues : [];
    railIssues = rail.length;
    if (railIssues > 0) {
      debtCounts.set("connection:rail_issues", railIssues);
      addAction({
        id: "connection:rail_issues",
        kind: "rail_issues",
        severity: "warning",
        label: "rail/train connection problems",
        count: railIssues,
        priority: 180 + railIssues,
        action: "Repair rail blocks/signals or remove the unused rail; rail is opt-in refactor scope.",
        examples: rail.slice(0, 3),
      });
    }
  }

  for (const raw of belts.slice(0, 500)) {
    const belt = asRecord(raw);
    if (!belt || number(belt.parallel_belts) === 0) continue;
    addAction({
      id: `parallel:${number(belt.x)}:${number(belt.y)}`,
      kind: "parallel_belts",
      severity: "warning",
      label: "same-direction belts side by side",
      count: 1,
      priority: 20,
      action:
        "Parallel side-by-side belts do not exchange items; add a splitter/underground if a connection was intended.",
      examples: [{ x: belt.x, y: belt.y, direction: belt.direction }],
    });
  }

  actions.sort((a, b) => number(b.priority) - number(a.priority));
  const fingerprintSource = [...debtCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind}:${count}`)
    .join("|");
  const fingerprint = createHash("sha256").update(fingerprintSource).digest("hex").slice(0, 16);
  const buildings = Object.values(counts).reduce<number>((sum, raw) => sum + number(asRecord(raw)?.total), 0);

  return {
    schema_version: 1,
    fingerprint,
    generated_at: new Date().toISOString(),
    window: { x: center.x, y: center.y, radius },
    summary: {
      buildings,
      factory_problems: Object.entries(FACTORY_PROBLEMS).reduce(
        (sum, [kind]) => sum + number(totals[kind]),
        0,
      ),
      connection_issues: issues.length,
      belts: number(connectionCounts.belts),
      inserters: number(connectionCounts.inserters),
      machines: number(connectionCounts.machines),
      scoped_factory_problems: scopedFactoryProblems,
      scoped_connection_issues: scopedConnectionIssues,
      empty_containers: emptyChestCount,
      scoped_empty_containers: scopedEmptyContainers,
      rail_issues: railIssues,
      invalid_count: scopedFactoryProblems + scopedConnectionIssues + scopedEmptyContainers + railIssues,
      scope: [...scope],
    },
    link_counts: (() => {
      const result: Record<string, number> = {};
      for (const raw of belts) {
        const belt = asRecord(raw);
        const link = typeof belt?.next_connection === "string" ? belt.next_connection : "unknown";
        result[link] = (result[link] ?? 0) + 1;
      }
      return result;
    })(),
    actions: actions.slice(0, 12),
    clusters: buildRefactorClusters(actions),
    action_summary: actions.slice(0, 12).map((action) => ({
      kind: typeof action.kind === "string" ? action.kind : "unknown",
      severity: action.severity === "critical" ? ("critical" as const) : ("warning" as const),
      count: number(action.count),
      action: typeof action.action === "string" ? action.action : "",
    })),
  };
}
