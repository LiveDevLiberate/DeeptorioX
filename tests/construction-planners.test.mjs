import test from "node:test";
import assert from "node:assert/strict";
import {
  planBeltLine,
  planPipeLine,
  planPowerLine,
  planPowerNetwork,
} from "../dist/construction-planners.js";

test("manager power line places wire-reach spaced poles and supports an L route", () => {
  const line = planPowerLine({
    from: { x: 0, y: 0 },
    to: { x: 60, y: 0 },
    pole: "big-electric-pole",
  });
  assert.equal(line[0].name, "big-electric-pole");
  assert.deepEqual(line[0].anchor, { x: 0, y: 0 });
  assert.deepEqual(line.at(-1).anchor, { x: 60, y: 0 });
  for (let index = 1; index < line.length; index += 1) {
    const dx = line[index].anchor.x - line[index - 1].anchor.x;
    const dy = line[index].anchor.y - line[index - 1].anchor.y;
    assert.ok(Math.abs(dx) <= 30 && Math.abs(dy) <= 30);
  }
  const l = planPowerLine({
    from: { x: 2, y: 3 },
    to: { x: 22, y: 13 },
    pole: "medium-electric-pole",
  });
  assert.ok(l.some((entry) => entry.anchor.y === 3 && entry.anchor.x > 2));
  assert.ok(l.some((entry) => entry.anchor.x === 22 && entry.anchor.y === 13));
});

test("manager power network generates an aligned cover grid", () => {
  const entities = planPowerNetwork({
    targets: [
      { x: 0, y: 0, radius: 3 },
      { x: 20, y: 20, radius: 3 },
    ],
    pole: "substation",
  });
  assert.ok(entities.length >= 4);
  for (const entity of entities) {
    assert.equal(entity.name, "substation");
    assert.equal(entity.anchor.x % 18, entities[0].anchor.x % 18);
    assert.equal(entity.anchor.y % 18, entities[0].anchor.y % 18);
  }
});

test("manager belt/pipe lines generate one entity per tile and reject diagonals", () => {
  const belt = planBeltLine({ from: { x: 1, y: 2 }, to: { x: 1, y: 5 } });
  assert.equal(belt.length, 4);
  assert.deepEqual(
    belt.map((entry) => entry.direction),
    [8, 8, 8, 8],
  );
  const pipe = planPipeLine({ from: { x: 3, y: 3 }, to: { x: 6, y: 3 } });
  assert.equal(pipe.length, 4);
  assert.ok(pipe.every((entry) => entry.name === "pipe"));
  assert.throws(() => planBeltLine({ from: { x: 0, y: 0 }, to: { x: 2, y: 2 } }), /horizontal or vertical/);
  assert.throws(() => planPipeLine({ from: { x: 0, y: 0 }, to: { x: 2, y: 2 } }), /horizontal or vertical/);
});

test("path-aware plans follow native waypoints for belts, pipes and poles", async () => {
  const { planBeltPath, planPipePath, planPowerPath } = await import("../dist/construction-planners.js");
  const path = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
  ];
  const belts = planBeltPath({ path });
  assert.deepEqual(
    belts.map((entry) => entry.direction),
    [4, 4, 8, 8, 8],
  );
  assert.equal(planPipePath({ path }).length, 5);
  const power = planPowerPath({ path, pole: "small-electric-pole", spacing: 2 });
  assert.deepEqual(power[0].anchor, { x: 0, y: 0 });
  assert.deepEqual(power.at(-1).anchor, { x: 2, y: 2 });
  assert.throws(
    () =>
      planBeltPath({
        path: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      }),
    /axis-aligned/,
  );
});

test("route planners skip matching existing belt/pipe assets", async () => {
  const { planBeltPath, planPipePath } = await import("../dist/construction-planners.js");
  const path = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 0 },
  ];
  const belts = planBeltPath({
    path,
    existing_assets: [{ x: 1, y: 0, type: "transport-belt", direction: 4 }],
  });
  assert.deepEqual(
    belts.map((entry) => entry.anchor),
    [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
    ],
  );
  const wrongDirection = planBeltPath({
    path,
    existing_assets: [{ x: 1, y: 0, type: "transport-belt", direction: 12 }],
  });
  assert.equal(wrongDirection.length, 3);
  const pipes = planPipePath({
    path,
    existing_assets: [{ x: 1, y: 0, type: "pipe" }],
  });
  assert.deepEqual(
    pipes.map((entry) => entry.anchor),
    [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
    ],
  );
});
