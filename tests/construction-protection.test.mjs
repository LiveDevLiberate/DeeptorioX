import test from "node:test";
import assert from "node:assert/strict";
import { isWorkingBlockTarget, workingBlockTiles } from "../dist/construction-protection.js";

const machine = {
  name: "assembling-machine-2",
  type: "assembling-machine",
  x: 1,
  y: 1,
  status: "working",
  bbox: { left: 0, top: 0, right: 2, bottom: 2 },
};

test("production-chain guard marks machine, inserter and feeder neighbors", () => {
  const entities = [
    machine,
    { name: "inserter", type: "inserter", x: 3, y: 1, status: "working" },
    { name: "transport-belt", type: "transport-belt", x: 4, y: 1, status: "normal" },
    { name: "transport-belt", type: "transport-belt", x: 9, y: 9, status: "normal" },
    { name: "stone-furnace", type: "furnace", x: 8, y: 8, status: "no_power" },
  ];
  const tiles = workingBlockTiles(entities);
  assert.ok(tiles.has("1,1"), "machine tile");
  assert.ok(tiles.has("3,1"), "adjacent inserter");
  assert.ok(tiles.has("4,1"), "feeder belt next to inserter");
  assert.deepEqual([...tiles].includes("9,9"), false);
  assert.deepEqual([...tiles].includes("8,8"), false, "broken furnace is not protected");
  assert.equal(isWorkingBlockTarget(entities, { x: 4, y: 1 }), true);
  assert.equal(isWorkingBlockTarget(entities, { x: 9, y: 9 }), false);
});
