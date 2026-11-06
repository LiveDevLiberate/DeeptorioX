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

export type RefactorScope = "belts" | "power" | "pipes" | "machines" | "rail";

/** Default refactor scope: production, power and fluid infrastructure. Rail is opt-in. */
export const DEFAULT_REFACTOR_SCOPE: RefactorScope[] = ["belts", "power", "pipes", "machines"];

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

  let scopedFactoryProblems = 0;
  for (const [kind, meta] of Object.entries(FACTORY_PROBLEMS)) {
    const problemScope = FACTORY_SCOPE[kind] ?? "machines";
    if (!scope.has(problemScope)) continue;
    const count = number(totals[kind]) || (Array.isArray(problems[kind]) ? problems[kind].length : 0);
    if (count <= 0) continue;
    scopedFactoryProblems += count;
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
    const meta = BELT_ACTIONS[kind];
    const isBelt = kind.startsWith("belt_");
    const action =
      isBelt && count >= 3
        ? `Run relayout-belts around ${Math.round(center.x)},${Math.round(center.y)} radius ${radius}, then rebuild a validated route.`
        : isBelt
          ? "Rotate/repair the listed belt tiles."
          : kind.startsWith("inserter_")
            ? "Fix the inserter source/target or remove it."
            : "Inspect the listed coordinates and repair the connection.";
    addAction({
      id: `connection:${kind}`,
      kind,
      severity: meta?.severity ?? "warning",
      label: kind.replaceAll("_", " "),
      count,
      priority: (isBelt ? 200 : 150) + count,
      action: isBelt && count >= 3 ? action : (meta?.action ?? action),
      examples: samples,
      ...(isBelt && count >= 3 ? { cleanup: { x: center.x, y: center.y, radius } } : {}),
    });
  }

  let railIssues = 0;
  if (scope.has("rail")) {
    const rail = Array.isArray(connectionData.rail_issues) ? connectionData.rail_issues : [];
    railIssues = rail.length;
    if (railIssues > 0) {
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
  const fingerprintSource = actions
    .map(
      (action) => `${String(action.kind)}:${number(action.count)}:${JSON.stringify(action.examples ?? [])}`,
    )
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
      rail_issues: railIssues,
      invalid_count: scopedFactoryProblems + scopedConnectionIssues + railIssues,
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
    action_summary: actions.slice(0, 12).map((action) => ({
      kind: action.kind,
      severity: action.severity,
      count: action.count,
      action: action.action,
    })),
  };
}
