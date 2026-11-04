import test from "node:test";
import assert from "node:assert/strict";
import {
  computeAutomationScore,
  manualCraftUnits,
  manualMineUnits,
  productionPoints,
  sciencePoints,
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
  assert.deepEqual(score.breakdown, { production: 74, science: 200, power: 40, research: 5, rockets: 0 });
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
});
