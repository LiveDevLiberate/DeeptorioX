import { trackedMilestones, type Benchmark, type Milestone, type Snapshot } from "./benchmarks.js";

/**
 * Evaluation scoring v2.
 *
 * The capability score replaces the single mixed automation score for ranking:
 * it is a per-benchmark, time-normalised, monotonic 0..1000 score. Discipline
 * metrics (manual work, stale plans, blackouts, ignored alerts, refactor debt)
 * are reported separately and never folded into the ranking score.
 */

export type CapabilityBreakdown = {
  id: string;
  label: string;
  weight: number;
  achieved: number;
};

export type CapabilityScore = {
  score: number;
  max: 1000;
  completed: boolean;
  /** Weighted milestone progress, 0..1. */
  progress: number;
  milestones: { completed: number; total: number };
  next_milestone?: string;
  next_milestone_label?: string;
  completion_seconds?: number;
  par_seconds: number;
  par_source: string;
  scoring_version: number;
  breakdown: CapabilityBreakdown[];
};

export type DisciplineMetrics = {
  manual_mines: number;
  manual_crafts: number;
  blackouts: number;
  alert_penalty: number;
  state_due_seconds: number;
  state_blocked_seconds: number;
  refactor: {
    debt_peak: number;
    invalid_count: number;
    cleanup_units: number;
    tier: string;
    audits_with_debt: number;
  };
  flags: string[];
};

export type CapabilityInput = {
  benchmark: Benchmark;
  /** run.milestones: milestone id -> first-observed timing. */
  milestones: Record<string, unknown>;
  latest: Snapshot | null | undefined;
  baseline: Snapshot | null | undefined;
  activeSeconds: number;
};

export type DisciplineInput = {
  manualMines?: number;
  manualCrafts?: number;
  blackouts?: number;
  alertPenalty?: number;
  stateMetrics?: { due_seconds?: number; blocked_seconds?: number };
  refactor?: {
    debt_peak?: number;
    invalid_count?: number;
    cleanup_units?: number;
    escalation_tier?: string;
    audits_with_debt?: number;
  };
};

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Fractional achievement of one milestone from game statistics (0..1). */
export function milestoneAchieved(
  milestone: Milestone,
  milestones: Record<string, unknown>,
  latest: Snapshot | null | undefined,
  baseline: Snapshot | null | undefined,
): number {
  if (milestones?.[milestone.id]) return 1;
  if (!latest) return 0;
  const base = baseline ?? latest;
  if (milestone.kind === "research") {
    return milestone.name && latest.research?.[milestone.name] === true ? 1 : 0;
  }
  if (milestone.kind === "rockets") {
    const target = finite(milestone.count);
    return target > 0 ? clamp01((finite(latest.rockets) - finite(base.rockets)) / target) : 0;
  }
  const name = milestone.name;
  if (!name) return 0;
  const target = finite(milestone.count);
  if (target <= 0) return 0;
  const produced = finite(latest.production?.[name]) - finite(base.production?.[name]);
  return clamp01(produced / target);
}

function labelOf(milestone: Milestone): string {
  return milestone.label || milestone.name || milestone.id;
}

/**
 * Capability score for one benchmark.
 *
 * Completed runs: `500 + 500 * r / (1 + r)` with `r = par / completion_seconds`,
 * so finishing at par scores 750 and completes always rank above unfinished
 * runs. Unfinished runs: `499 * weighted progress`.
 */
export function computeCapabilityScore(input: CapabilityInput): CapabilityScore {
  const { benchmark, milestones, latest, baseline } = input;
  const scoring = benchmark.scoring;
  const weights = scoring.progress_weights;
  const breakdown: CapabilityBreakdown[] = [];
  let weighted = 0;
  let weightSum = 0;
  for (const milestone of trackedMilestones(benchmark)) {
    const weight = weights[milestone.id];
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const achieved = milestoneAchieved(milestone, milestones, latest ?? null, baseline ?? null);
    breakdown.push({ id: milestone.id, label: labelOf(milestone), weight, achieved });
    weighted += weight * achieved;
    weightSum += weight;
  }
  const progress = weightSum > 0 ? clamp01(weighted / weightSum) : 0;
  const completion = milestones?.[benchmark.completion] as { wall_seconds?: unknown } | undefined;
  const completed = Boolean(completion);
  const completionSeconds = completed ? Math.max(0, finite(completion?.wall_seconds)) : undefined;
  const par = Math.max(1, finite(scoring.par_seconds));
  let score: number;
  if (completed && completionSeconds !== undefined) {
    const ratio = par / Math.max(1, completionSeconds);
    score = Math.round(500 + (500 * ratio) / (1 + ratio));
    score = Math.max(500, Math.min(1000, score));
  } else {
    score = Math.max(0, Math.min(499, Math.round(499 * progress)));
  }
  const scored = breakdown;
  const completedCount = scored.filter((entry) => entry.achieved >= 1).length;
  const next = scored.find((entry) => entry.achieved < 1);
  return {
    score,
    max: 1000,
    completed,
    progress,
    milestones: { completed: completedCount, total: scored.length },
    ...(next ? { next_milestone: next.id, next_milestone_label: next.label } : {}),
    ...(completionSeconds !== undefined ? { completion_seconds: completionSeconds } : {}),
    par_seconds: par,
    par_source: scoring.par_source,
    scoring_version: scoring.version,
    breakdown,
  };
}

/** Discipline metrics are reported separately; they never change the capability score. */
export function computeDiscipline(input: DisciplineInput): DisciplineMetrics {
  const manualMines = Math.max(0, Math.round(finite(input.manualMines)));
  const manualCrafts = Math.max(0, Math.round(finite(input.manualCrafts)));
  const blackouts = Math.max(0, Math.round(finite(input.blackouts)));
  const alertPenalty = Math.max(0, Math.round(finite(input.alertPenalty)));
  const dueSeconds = Math.max(0, finite(input.stateMetrics?.due_seconds));
  const blockedSeconds = Math.max(0, finite(input.stateMetrics?.blocked_seconds));
  const refactor = {
    debt_peak: Math.max(0, Math.round(finite(input.refactor?.debt_peak))),
    invalid_count: Math.max(0, Math.round(finite(input.refactor?.invalid_count))),
    cleanup_units: Math.max(0, Math.round(finite(input.refactor?.cleanup_units))),
    tier: String(input.refactor?.escalation_tier || "normal"),
    audits_with_debt: Math.max(0, Math.round(finite(input.refactor?.audits_with_debt))),
  };
  const flags: string[] = [];
  if (manualMines + manualCrafts > 0) flags.push("manual_work");
  if (blackouts > 0) flags.push("blackouts");
  if (alertPenalty > 0) flags.push("alerts_ignored");
  if (blockedSeconds >= 60) flags.push("state_blocked");
  if (dueSeconds >= 60) flags.push("state_stale");
  if (refactor.debt_peak > 0) flags.push("refactor_debt");
  return {
    manual_mines: manualMines,
    manual_crafts: manualCrafts,
    blackouts,
    alert_penalty: alertPenalty,
    state_due_seconds: Math.round(dueSeconds),
    state_blocked_seconds: Math.round(blockedSeconds),
    refactor,
    flags,
  };
}
