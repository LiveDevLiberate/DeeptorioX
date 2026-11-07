import test from "node:test";
import assert from "node:assert/strict";
import {
  blueprintRequiredItems,
  expandBlueprintPayload,
  transformBlueprintEntities,
} from "../dist/blueprints.js";

test("manager-side blueprint expansion converts centers to anchors and shifts to a target anchor", () => {
  const payload = {
    blueprint: {
      entities: [
        {
          entity_number: 1,
          name: "assembling-machine-2",
          position: { x: 3, y: 2 },
          direction: 4,
        },
        {
          entity_number: 2,
          name: "transport-belt",
          position: { x: 1, y: 1 },
          direction: 4,
        },
        {
          entity_number: 3,
          name: "pipe-to-ground",
          position: { x: 5, y: 1 },
          type: "input",
        },
      ],
    },
  };
  const expanded = expandBlueprintPayload(payload, {
    anchor: { x: 10, y: 20 },
    prototype_sizes: {
      "assembling-machine-2": { width: 3, height: 3 },
      "transport-belt": { width: 1, height: 1 },
      "pipe-to-ground": { width: 1, height: 1 },
    },
  });
  assert.deepEqual(expanded, [
    { name: "transport-belt", anchor: { x: 10, y: 20 }, direction: 4 },
    // center 3,2 with a 3x3 footprint -> anchor 2,1; shifted by (9,19).
    { name: "assembling-machine-2", anchor: { x: 11, y: 20 }, direction: 4 },
    { name: "pipe-to-ground", anchor: { x: 14, y: 20 }, underground_type: "input" },
  ]);
});

test("manager-side blueprint expansion rejects books and unsupported underground subtypes", () => {
  assert.throws(
    () => expandBlueprintPayload({ blueprint_book: { blueprints: [] } }),
    /blueprint books are not supported/,
  );
  assert.throws(
    () =>
      expandBlueprintPayload({
        blueprint: {
          entities: [{ name: "underground-belt", position: { x: 1, y: 1 } }],
        },
      }),
    /needs type 'input' or 'output'/,
  );
});

test("manager blueprint item bill includes stored inventory contents and modules", () => {
  const required = blueprintRequiredItems({
    blueprint: {
      entities: [
        {
          name: "iron-chest",
          position: { x: 1, y: 1 },
          items: [{ id: 1, items: { "iron-plate": 10 } }],
        },
        {
          name: "assembling-machine-1",
          position: { x: 3, y: 3 },
          items_in_inventory: [{ id: 1, items: [{ name: "copper-plate", count: 4 }] }],
          modules: [{ name: "speed-module", count: 2 }],
        },
      ],
    },
  });
  assert.deepEqual(required, {
    "iron-chest": 1,
    "iron-plate": 10,
    "assembling-machine-1": 1,
    "copper-plate": 4,
    "speed-module": 2,
  });
});

test("manager blueprint rotation and mirror transform anchors and directions", () => {
  const entities = [
    { name: "transport-belt", anchor: { x: 0, y: 0 }, direction: 4 },
    { name: "transport-belt", anchor: { x: 1, y: 0 }, direction: 4 },
  ];
  const rotated = transformBlueprintEntities(entities, { "transport-belt": { width: 1, height: 1 } }, {
    rotation: 2,
  });
  assert.deepEqual(rotated, [
    { name: "transport-belt", anchor: { x: 0, y: 0 }, direction: 8 },
    { name: "transport-belt", anchor: { x: 0, y: 1 }, direction: 8 },
  ]);
  const mirrored = transformBlueprintEntities(entities, { "transport-belt": { width: 1, height: 1 } }, {
    mirror: true,
  });
  assert.deepEqual(mirrored, [
    { name: "transport-belt", anchor: { x: 1, y: 0 }, direction: 12 },
    { name: "transport-belt", anchor: { x: 0, y: 0 }, direction: 12 },
  ]);
});
