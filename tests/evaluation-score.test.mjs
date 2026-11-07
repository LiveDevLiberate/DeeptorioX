import test from "node:test";
import assert from "node:assert/strict";

const { computeCapabilityScore, computeDiscipline, milestoneAchieved } =
  await import("../dist/evaluation-score.js");
const { normalizeScoring } = await import("../dist/benchmarks.js");

const snapshot = (production = {}, extra = {}) => ({
  tick: 60,
  speed: 1,
  paused: false,
  character: true,
  player: "Autorio",
  production,
  consumption: {},
  fluids_produced: {},
  fluids_consumed: {},
  research: {},
  rockets: 0,
  ...extra,
});

const benchmark = (overrides = {}) => ({
  id: "test",
  title: "test",
  task: "test",
  map_gen: { seed: 1 },
  always_day: false,
  starting_items: {},
  max_seconds: 3600,
  sample_seconds: 5,
  milestones: [
    { id: "first-plate", kind: "production", name: "iron-plate", count: 1 },
    { id: "twenty", kind: "production", name: "iron-plate", count: 20 },
  ],
  completion: "twenty",
  scoring: {
    version: 2,
    ranked: true,
    completion_basis: "milestone_first_seen",
    par_seconds: 600,
    par_source: "test",
    progress_weights: { "first-plate": 0.3, twenty: 0.7 },
  },
  ...overrides,
});

test("unfinished runs get weighted progress capped below completed runs", () => {
  const capability = computeCapabilityScore({
    benchmark: benchmark(),
    milestones: {},
    latest: snapshot({ "iron-plate": 10 }),
    baseline: snapshot({}),
    activeSeconds: 300,
  });
  assert.equal(capability.completed, false);
  assert.ok(Math.abs(capability.progress - 0.65) < 1e-9);
  assert.equal(capability.score, Math.round(499 * 0.65));
  assert.deepEqual(capability.milestones, { completed: 1, total: 2 });
  assert.equal(capability.next_milestone, "twenty");
  assert.equal(capability.par_seconds, 600);
});

test("completed runs use milestone first-seen time against par", () => {
  const run = (completionSeconds) =>
    computeCapabilityScore({
      benchmark: benchmark(),
      milestones: {
        "first-plate": { wall_seconds: 100 },
        twenty: { wall_seconds: completionSeconds },
      },
      latest: snapshot({ "iron-plate": 40 }),
      baseline: snapshot({}),
      activeSeconds: completionSeconds + 30,
    });
  const atPar = run(600);
  assert.equal(atPar.completed, true);
  assert.equal(atPar.completion_seconds, 600);
  assert.equal(atPar.score, 750);
  const fast = run(300);
  const slow = run(1200);
  assert.equal(fast.score, 833);
  assert.equal(slow.score, 667);
  assert.ok(fast.score > atPar.score && atPar.score > slow.score);
  assert.equal(atPar.milestones.completed, 2);
});

test("research and rocket milestones achieve fractionally", () => {
  const research = { id: "automation", kind: "research", name: "automation" };
  assert.equal(
    milestoneAchieved(research, {}, snapshot({}, { research: { automation: true } }), snapshot({})),
    1,
  );
  assert.equal(milestoneAchieved(research, {}, snapshot({}, { research: {} }), snapshot({})), 0);
  const rockets = { id: "launch", kind: "rockets", count: 2 };
  assert.equal(
    milestoneAchieved(rockets, {}, snapshot({}, { rockets: 1 }), snapshot({}, { rockets: 0 })),
    0.5,
  );
  assert.equal(milestoneAchieved(rockets, {}, snapshot({}, { rockets: 2 }), snapshot({}, { rockets: 0 })), 1);
});

test("normalizeScoring fills v1 defaults and validates explicit weights", () => {
  const raw = { milestones: benchmark().milestones, completion: "twenty", max_seconds: 3600 };
  const defaults = normalizeScoring(undefined, raw);
  assert.equal(defaults.version, 1);
  assert.equal(defaults.ranked, true);
  assert.equal(defaults.par_seconds, 1200);
  assert.match(defaults.par_source, /fallback/);
  assert.deepEqual(defaults.progress_weights, { "first-plate": 1, twenty: 1 });

  const explicit = normalizeScoring(
    {
      version: 2,
      ranked: false,
      par_seconds: 600,
      par_source: "median_completed:2026-11-08",
      progress_weights: { twenty: 1 },
    },
    raw,
  );
  assert.equal(explicit.ranked, false);
  assert.deepEqual(explicit.progress_weights, { twenty: 1 });

  assert.throws(() => normalizeScoring({ progress_weights: { missing: 1 } }, raw), /unknown milestone/);
  assert.throws(
    () => normalizeScoring({ progress_weights: { "first-plate": 1 } }, raw),
    /completion milestone must be scored/,
  );
  assert.throws(() => normalizeScoring({ progress_weights: { twenty: 0 } }, raw), /bad weight/);
});

test("discipline metrics are reported separately with flags", () => {
  const discipline = computeDiscipline({
    manualMines: 12,
    manualCrafts: 3,
    blackouts: 2,
    alertPenalty: 75,
    stateMetrics: { due_seconds: 40, blocked_seconds: 90 },
    refactor: {
      debt_peak: 35,
      invalid_count: 4,
      cleanup_units: 6,
      escalation_tier: "relayout_only",
      audits_with_debt: 3,
    },
  });
  assert.equal(discipline.manual_mines, 12);
  assert.equal(discipline.blackouts, 2);
  assert.equal(discipline.state_blocked_seconds, 90);
  assert.deepEqual(discipline.flags, [
    "manual_work",
    "blackouts",
    "alerts_ignored",
    "state_blocked",
    "refactor_debt",
  ]);
});
