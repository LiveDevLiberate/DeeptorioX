import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanupMineUnits,
  computeAutomationScore,
  manualCraftUnits,
  manualMineUnits,
  productionPoints,
  sciencePoints,
  trackPowerBlackout,
  MANUAL_PENALTY_GRACE_SECONDS,
  manualPenaltyGraceActive,
} from "../dist/automation-score.js";

test("manual mining counts only natural resources, not deconstructed buildings", () => {
  const units = manualMineUnits([
    { ok: true, name: "iron-ore", mined_count: 2 },
    { ok: true, name: "tree", items: { wood: 1 }, mined_count: 1 },
    { ok: true, name: "stone-furnace", items: { "stone-furnace": 1 }, mined_count: 1 },
    { ok: false, name: "coal", mined_count: 5 },
  ]);
  assert.equal(units, 3);
  assert.equal(manualMineUnits([]), 0);
});

test("manual crafting counts crafted products, falling back to the payload count", () => {
  assert.equal(
    manualCraftUnits({ item: "iron-gear-wheel", count: 3 }, [
      { ok: true, products: [{ name: "iron-gear-wheel", amount: 3 }] },
    ]),
    3,
  );
  assert.equal(manualCraftUnits({ item: "stone-furnace", count: 2 }, [{ ok: true }]), 2);
  assert.equal(manualCraftUnits({}, [{ ok: false }]), 0);
});

test("cleanup targets count only successful explicit cleanup removals", () => {
  const payload = {
    targets: [
      { x: 1, y: 1, cleanup: true },
      { x: 2, y: 2, cleanup: true },
      { x: 3, y: 3 },
    ],
  };
  assert.equal(cleanupMineUnits(payload, [{ ok: true }, { ok: false }, { ok: true }]), 1);
  assert.equal(cleanupMineUnits({}, []), 0);
});

test("automation score rewards automated production and subtracts manual penalties", () => {
  const production = { "iron-plate": 540, "iron-gear-wheel": 100, "automation-science-pack": 40 };
  assert.equal(productionPoints(production), 74);
  assert.equal(sciencePoints(production), 200);
  const score = computeAutomationScore({
    productionTotals: production,
    powerSatisfaction: 0.8,
    researchProgress: 0.5,
    rocketsLaunched: 0,
    manualMines: 3,
    manualCrafts: 2,
  });
  assert.deepEqual(score.breakdown, {
    production: 74,
    science: 200,
    power: 40,
    research: 5,
    rockets: 0,
    refactor: 0,
  });
  assert.equal(score.state_penalty, 0);
  assert.equal(score.positive, 319);
  assert.equal(score.penalty, 3 + 2 * 2);
  assert.equal(score.score, 312);
  assert.equal(score.manual_mines, 3);
  assert.equal(score.manual_crafts, 2);
  // Early manual-heavy runs can be negative; the operator view shows the penalty.
  const manual = computeAutomationScore({
    productionTotals: {},
    manualMines: 10,
    manualCrafts: 5,
  });
  assert.equal(manual.score, -20);
  const stale = computeAutomationScore({
    productionTotals: {},
    manualMines: 0,
    manualCrafts: 0,
    statePenalty: 100,
  });
  assert.equal(stale.penalty, 100);
  assert.equal(stale.state_penalty, 100);
  assert.equal(stale.score, -100);
});

test("counts one 500-point penalty per full blackout after power is established", () => {
  let state = { power_plant_seen: false, blackout_active: false, blackouts: 0 };
  // No power plant yet: demand/no satisfaction is not a countable blackout.
  let tick = trackPowerBlackout(state, { maximum_production: 0, maximum_consumption: 10 });
  assert.equal(tick.blackout_started, false);
  assert.equal(tick.state.blackouts, 0);
  assert.equal(tick.state.power_plant_seen, false);
  state = tick.state;
  // First generator capacity is observed.
  tick = trackPowerBlackout(state, { maximum_production: 100, maximum_consumption: 20, satisfaction: 1 });
  assert.equal(tick.state.power_plant_seen, true);
  assert.equal(tick.blackout_started, false);
  state = tick.state;
  // One continuous outage counts exactly once.
  tick = trackPowerBlackout(state, { maximum_production: 100, maximum_consumption: 30, satisfaction: 0 });
  assert.equal(tick.blackout_started, true);
  assert.equal(tick.state.blackouts, 1);
  state = tick.state;
  tick = trackPowerBlackout(state, { maximum_production: 100, maximum_consumption: 30, satisfaction: 0 });
  assert.equal(tick.blackout_started, false);
  assert.equal(tick.state.blackouts, 1);
  state = tick.state;
  // Recovery, then a second outage.
  tick = trackPowerBlackout(state, { maximum_production: 100, maximum_consumption: 30, satisfaction: 1 });
  assert.equal(tick.blackout_started, false);
  state = tick.state;
  tick = trackPowerBlackout(state, { maximum_production: 100, maximum_consumption: 30, satisfaction: 0.004 });
  assert.equal(tick.blackout_started, true);
  assert.equal(tick.state.blackouts, 2);
  const score = computeAutomationScore({
    productionTotals: {},
    powerSatisfaction: 1,
    researchProgress: 0,
    rocketsLaunched: 0,
    manualMines: 0,
    manualCrafts: 0,
    blackouts: 2,
  });
  assert.equal(score.blackouts, 2);
  assert.equal(score.blackout_penalty, 1000);
  assert.equal(score.penalty, 1000);
  assert.equal(score.score, -950); // power 50 - 1000
});

test("cleanup and refactor debt reduction add positive rewards", () => {
  const score = computeAutomationScore({
    productionTotals: {},
    manualMines: 0,
    manualCrafts: 0,
    cleanupUnits: 2,
    refactorReward: 30,
  });
  assert.equal(score.breakdown.refactor, 40);
  assert.equal(score.cleanup_units, 2);
  assert.equal(score.refactor_reward, 30);
  assert.equal(score.positive, 40);
  assert.equal(score.score, 40);
});

test("manual penalties start only after the 30-minute opening grace", () => {
  assert.equal(MANUAL_PENALTY_GRACE_SECONDS, 1800);
  assert.equal(manualPenaltyGraceActive(0), false);
  assert.equal(manualPenaltyGraceActive(1799), false);
  assert.equal(manualPenaltyGraceActive(1800), true);
});

test("alert penalties are added to the automation penalty", () => {
  const score = computeAutomationScore({
    productionTotals: {},
    manualMines: 0,
    manualCrafts: 0,
    alertPenalty: 75,
  });
  assert.equal(score.alert_penalty, 75);
  assert.equal(score.penalty, 75);
  assert.equal(score.score, -75);
});
