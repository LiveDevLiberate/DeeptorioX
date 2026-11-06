import test from "node:test";
import assert from "node:assert/strict";
import { encodeCapturedBlueprint } from "../dist/blueprint-capture.js";
import { evaluateBlueprint } from "../dist/blueprint-evaluate.js";

test("evaluates structural density and dynamic output metrics", () => {
  const entity = (name, x, y) => ({ name, position: { x: x + 0.5, y: y + 0.5 } });
  const wire = encodeCapturedBlueprint(
    [
      entity("assembling-machine-2", 0, 0),
      entity("assembling-machine-2", 3, 0),
      entity("transport-belt", 1, 0),
      entity("transport-belt", 2, 0),
      entity("inserter", 1, 1),
      entity("small-electric-pole", 2, 2),
      entity("pipe", 0, 2),
    ],
    "eval cell",
  ).wire;
  const result = evaluateBlueprint({
    wire,
    outputs: { "iron-gear-wheel": 60 },
    powerKw: 30,
    buildSeconds: 120,
  });
  assert.equal(result.metrics.entity_count, 7);
  assert.equal(result.metrics.machines, 2);
  assert.equal(result.metrics.belts, 2);
  assert.equal(result.metrics.inserters, 1);
  assert.equal(result.metrics.poles, 1);
  assert.equal(result.metrics.pipes, 1);
  assert.ok(result.metrics.machine_share > 0);
  assert.equal(result.dynamic.total_output_per_minute, 60);
  assert.equal(result.dynamic.output_per_machine, 30);
  assert.equal(result.dynamic.output_per_kw, 2);
  assert.equal(result.dynamic.seconds_per_entity, 17.14);
  assert.equal(typeof result.scores.structural, "number");
  assert.equal(typeof result.scores.dynamic, "number");
});

test("evaluation without output omits dynamic score", () => {
  const wire = encodeCapturedBlueprint(
    [{ name: "transport-belt", position: { x: 0.5, y: 0.5 } }],
    "static",
  ).wire;
  const result = evaluateBlueprint({ wire });
  assert.equal(result.dynamic, null);
  assert.equal(result.scores.dynamic, null);
});
