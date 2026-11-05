/**
 * Automation score: rewards automated production and penalises manual work.
 *
 * Positive components (transparent, tunable):
 * - production: weighted cumulative automated output since the run baseline
 *   (raw resources, plates, intermediates, advanced items; science counted
 *   separately),
 * - science: science-pack production per minute,
 * - power: share of satisfied power demand,
 * - research: progress on the current technology,
 * - rockets: cumulative rockets launched.
 *
 * Negative component: manual resource mining and hand-crafting. The counts are
 * persisted per run so the operator view can show a running penalty.
 */

/** Natural resources whose manual extraction is penalised (placed buildings are not). */
export const RAW_RESOURCES = new Set([
  "iron-ore",
  "copper-ore",
  "coal",
  "stone",
  "uranium-ore",
  "wood",
  "tree",
  "simple-entity",
]);

/** Relative value of automated output per item (science packs handled separately). */
const ITEM_WEIGHTS: Record<string, number> = {
  "iron-ore": 0.5,
  "copper-ore": 0.5,
  coal: 0.5,
  stone: 0.5,
  "iron-plate": 1,
  "copper-plate": 1,
  "stone-brick": 1,
  "steel-plate": 2,
  "iron-gear-wheel": 2,
  "copper-cable": 2,
  "electronic-circuit": 2,
  pipe: 1,
  "transport-belt": 2,
  inserter: 2,
  "automation-science-pack": 0,
  "logistic-science-pack": 0,
  "military-science-pack": 0,
  "chemical-science-pack": 0,
  "production-science-pack": 0,
  "utility-science-pack": 0,
  "space-science-pack": 0,
};

/** Extra points per hand-crafted item (mining is 1 point per resource unit). */
export const CRAFT_PENALTY_POINTS = 2;
/** Manual mining/crafting penalties are disabled for the opening 30 minutes. */
export const MANUAL_PENALTY_GRACE_SECONDS = 30 * 60;
/** Whether manual-work penalties are active at this active-play elapsed time. */
export function manualPenaltyGraceActive(elapsedSeconds: number): boolean {
  const elapsed = Number(elapsedSeconds);
  return Number.isFinite(elapsed) && elapsed >= MANUAL_PENALTY_GRACE_SECONDS;
}
/** Penalty while STATE.md is older than the soft/hard deadline. */
export const STATE_DUE_PENALTY = 25;
export const STATE_BLOCKED_PENALTY = 100;
/** Penalty for each full blackout after the first power generation is observed. */
export const BLACKOUT_PENALTY_POINTS = 500;

/** Best-effort electric-network summary returned in telemetry. */
export type SnapshotPower = {
  networks?: number;
  maximum_production?: number;
  maximum_consumption?: number;
  total_transfer?: number;
  satisfaction?: number;
};

export type PowerBlackoutState = {
  /** A power plant/generator has produced capacity at least once. */
  power_plant_seen: boolean;
  /** The previous sample was a blackout; only transitions are counted. */
  blackout_active: boolean;
  blackouts: number;
};

export type AutomationCounters = { manual_mines: number; manual_crafts: number };

export type AutomationBreakdown = {
  production: number;
  science: number;
  power: number;
  research: number;
  rockets: number;
};

export type AutomationScore = AutomationCounters & {
  /** Positive components minus penalty; may be negative early in a run. */
  score: number;
  positive: number;
  penalty: number;
  /** Part of the penalty caused by a stale/missing STATE.md. */
  state_penalty: number;
  /** Part of the penalty caused by full blackouts after power was established. */
  blackout_penalty: number;
  /** Count of full-blackout transitions counted for this penalty. */
  blackouts: number;
  breakdown: AutomationBreakdown;
};

export type AutomationScoreInput = {
  /** Cumulative automated production since the run baseline (science excluded). */
  productionTotals: Record<string, number>;
  powerSatisfaction?: number | null;
  researchProgress?: number | null;
  rocketsLaunched?: number;
  manualMines: number;
  manualCrafts: number;
  statePenalty?: number;
  blackouts?: number;
};

/**
 * Track full blackout transitions.
 *
 * A run becomes eligible once its electric network reports positive production
 * capacity. A blackout is a sample with real demand but satisfaction at or below
 * 0.5%; only the transition into the blackout is counted, so a long outage costs
 * one penalty.
 */
export function trackPowerBlackout(
  state: PowerBlackoutState,
  power: SnapshotPower | null | undefined,
): { state: PowerBlackoutState; blackout_started: boolean } {
  const capacity = Number(power?.maximum_production);
  const demand = Number(power?.maximum_consumption);
  const satisfaction = Number(power?.satisfaction);
  const seen = state.power_plant_seen || (Number.isFinite(capacity) && capacity > 0);
  const eligible = seen && Number.isFinite(demand) && demand > 0;
  const blackout = eligible && (!Number.isFinite(satisfaction) || satisfaction <= 0.005);
  const blackoutStarted = eligible && blackout && !state.blackout_active;
  return {
    state: {
      power_plant_seen: seen,
      blackout_active: blackout,
      blackouts: state.blackouts + (blackoutStarted ? 1 : 0),
    },
    blackout_started: blackoutStarted,
  };
}

/** Count natural-resource units mined by hand from finished mine job results. */
export function manualMineUnits(results: unknown[]): number {
  let units = 0;
  for (const raw of Array.isArray(results) ? results : []) {
    if (!raw || typeof raw !== "object") continue;
    const result = raw as Record<string, unknown>;
    if (result.ok === false) continue;
    const items =
      result.items && typeof result.items === "object" ? (result.items as Record<string, unknown>) : {};
    const names = new Set<string>([typeof result.name === "string" ? result.name : ""]);
    for (const name of Object.keys(items)) names.add(name);
    const mined = Number(result.mined_count);
    if ([...names].some((name) => RAW_RESOURCES.has(name))) {
      units += Number.isFinite(mined) && mined > 0 ? mined : 1;
    }
  }
  return units;
}

/** Count hand-crafted items from a finished craft job payload/results. */
export function manualCraftUnits(payload: unknown, results: unknown[]): number {
  let units = 0;
  for (const raw of Array.isArray(results) ? results : []) {
    if (!raw || typeof raw !== "object") continue;
    const result = raw as Record<string, unknown>;
    if (result.ok === false) continue;
    const products = Array.isArray(result.products) ? result.products : [];
    for (const product of products) {
      const amount = Number((product as Record<string, unknown>)?.amount);
      if (Number.isFinite(amount) && amount > 0) units += amount;
    }
  }
  if (!units && payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const hasItem = typeof record.item === "string" || typeof record.recipe === "string";
    if (hasItem) {
      const count = Number(record.count);
      units = Number.isFinite(count) && count > 0 ? count : 1;
    }
  }
  return units;
}

/** Weighted cumulative automated output since the baseline (science excluded); 10 value = 1 point. */
export function productionPoints(productionTotals: Record<string, number>): number {
  let weighted = 0;
  for (const [item, raw] of Object.entries(productionTotals || {})) {
    const total = Number(raw);
    if (!Number.isFinite(total) || total <= 0) continue;
    if (/-science-pack$/.test(item)) continue;
    weighted += total * (ITEM_WEIGHTS[item] ?? 1);
  }
  return Math.round(weighted / 10);
}

/** Science-pack production points (all packs are equally valuable here). */
export function sciencePoints(productionTotals: Record<string, number>): number {
  let packs = 0;
  for (const [item, raw] of Object.entries(productionTotals || {})) {
    if (!/-science-pack$/.test(item)) continue;
    const total = Number(raw);
    if (Number.isFinite(total) && total > 0) packs += total;
  }
  return Math.round(packs * 5);
}

export function computeAutomationScore(input: AutomationScoreInput): AutomationScore {
  const production = productionPoints(input.productionTotals);
  const science = sciencePoints(input.productionTotals);
  const satisfaction = Number(input.powerSatisfaction);
  const power =
    Number.isFinite(satisfaction) && satisfaction !== null
      ? Math.round(Math.max(0, Math.min(1, satisfaction)) * 50)
      : 0;
  const progress = Number(input.researchProgress);
  const research = Number.isFinite(progress) ? Math.round(Math.max(0, Math.min(1, progress)) * 10) : 0;
  const rockets = Math.max(0, Math.round(Number(input.rocketsLaunched) || 0)) * 500;
  const breakdown = { production, science, power, research, rockets };
  const positive = production + science + power + research + rockets;
  const manualMines = Math.max(0, Math.round(Number(input.manualMines) || 0));
  const manualCrafts = Math.max(0, Math.round(Number(input.manualCrafts) || 0));
  const manualPenalty = manualMines + manualCrafts * CRAFT_PENALTY_POINTS;
  const statePenalty = Math.max(0, Math.round(Number(input.statePenalty) || 0));
  const blackouts = Math.max(0, Math.round(Number(input.blackouts) || 0));
  const blackoutPenalty = blackouts * BLACKOUT_PENALTY_POINTS;
  const penalty = manualPenalty + statePenalty + blackoutPenalty;
  return {
    score: positive - penalty,
    positive,
    penalty,
    state_penalty: statePenalty,
    blackout_penalty: blackoutPenalty,
    blackouts,
    manual_mines: manualMines,
    manual_crafts: manualCrafts,
    breakdown,
  };
}
