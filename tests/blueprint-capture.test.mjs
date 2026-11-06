import test from "node:test";
import assert from "node:assert/strict";
import { encodeCapturedBlueprint } from "../dist/blueprint-capture.js";
import { decodeBlueprintString } from "../dist/blueprints.js";

test("captured layout becomes a valid importable blueprint", () => {
  const captured = encodeCapturedBlueprint(
    [
      { name: "transport-belt", position: { x: 0.5, y: 0.5 }, direction: 4 },
      { name: "assembling-machine-2", position: { x: 3.5, y: 2.5 }, recipe: "iron-gear-wheel" },
    ],
    "gear cell v1",
    "compact test layout",
  );
  const decoded = decodeBlueprintString(captured.wire);
  assert.equal(decoded.summary.label, "gear cell v1");
  assert.equal(decoded.summary.entity_count, 2);
  assert.equal(decoded.payload.blueprint.entities[0].direction, 4);
  assert.equal(decoded.payload.blueprint.entities[1].recipe, "iron-gear-wheel");
});

test("capture rejects an empty entity list", () => {
  assert.throws(() => encodeCapturedBlueprint([], "empty"), /no placeable entities/);
});
