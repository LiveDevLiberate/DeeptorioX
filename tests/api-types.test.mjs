import assert from "node:assert/strict";
import test from "node:test";

const {
  parseRconObservation,
  finiteNumberOrUndefined,
  parseBuildRequests,
  parsePlacementRequests,
  parsePositionTargets,
  parseRecipeTargets,
  normalizeWorldData,
  normalizeResearchData,
  normalizeFactoryData,
  normalizeEntityData,
  normalizePrototypeData,
  registerAgentRoutes,
} = await import("../dist/api/agent.js");
const { Router } = await import("../dist/http/router.js");

test("parseRconObservation returns JSON or the raw reply", () => {
  assert.deepEqual(parseRconObservation('{"ok":true}'), { ok: true });
  assert.deepEqual(parseRconObservation("[1,2]"), [1, 2]);
  assert.equal(parseRconObservation("not json"), "not json");
  assert.equal(parseRconObservation(""), "");
});

test("finiteNumberOrUndefined keeps the historical Number() coercion", () => {
  assert.equal(finiteNumberOrUndefined(12), 12);
  assert.equal(finiteNumberOrUndefined("3.5"), 3.5);
  assert.equal(finiteNumberOrUndefined(null), 0);
  assert.equal(finiteNumberOrUndefined(undefined), undefined);
  assert.equal(finiteNumberOrUndefined("abc"), undefined);
  assert.equal(finiteNumberOrUndefined(Number.POSITIVE_INFINITY), undefined);
});

test("parseBuildRequests filters the historical way and respects max", () => {
  const entities = [
    { name: "stone-furnace", anchor: { x: 1, y: 2 } },
    { name: "", anchor: { x: 1, y: 2 } },
    { name: "transport-belt", anchor: { x: "3", y: "4" } },
    { name: "inserter", anchor: { x: 5 } },
    { nope: true },
    null,
  ];
  assert.deepEqual(parseBuildRequests(entities), [entities[0], entities[2]]);
  assert.deepEqual(parseBuildRequests(entities, 1), [entities[0]]);
  assert.deepEqual(parseBuildRequests("not an array"), []);
  assert.deepEqual(parseBuildRequests([{ name: "x", anchor: { x: 1, y: 2 } }], 0), []);
});

test("parsePlacementRequests requires a string name but still accepts numeric anchors", () => {
  const items = [
    { name: "chest", anchor: { x: 0, y: 0 } },
    { name: 5, anchor: { x: 0, y: 0 } },
    { anchor: { x: 0, y: 0 } },
    { name: "belt", anchor: { x: "1", y: 2 } },
  ];
  assert.deepEqual(parsePlacementRequests(items), [items[0], items[3]]);
});

test("parsePositionTargets keeps x/y !== undefined (null passes) and slices", () => {
  const targets = [{ x: 0, y: 0 }, { x: null, y: null }, { x: 1 }, { y: 2 }, null, "x"];
  assert.deepEqual(parsePositionTargets(targets), [targets[0], targets[1]]);
  assert.deepEqual(parsePositionTargets(targets, 1), [targets[0]]);
});

test("parseRecipeTargets additionally requires a truthy recipe", () => {
  const targets = [
    { x: 1, y: 1, recipe: "iron-gear-wheel" },
    { x: 1, y: 1, recipe: "" },
    { x: 1, y: 1 },
  ];
  assert.deepEqual(parseRecipeTargets(targets), [targets[0]]);
});

test("normalizeWorldData fills entity/terrain arrays in place and passes other values through", () => {
  const data = { entities: null, terrain: { rows: [{ runs: null }, null] } };
  const normalized = normalizeWorldData(data);
  assert.deepEqual(normalized.entities, []);
  assert.deepEqual(normalized.terrain.rows[0].runs, []);
  assert.equal(normalizeWorldData("raw"), "raw");
  assert.equal(normalizeWorldData(null), null);
});

test("normalizeResearchData fills technology arrays for current and lists", () => {
  const data = {
    current: { ingredients: null, prerequisites: null, missing_prerequisites: null },
    queue: [{ ingredients: null }],
    completed: null,
  };
  const normalized = normalizeResearchData(data);
  assert.deepEqual(normalized.current.ingredients, []);
  assert.deepEqual(normalized.current.prerequisites, []);
  assert.deepEqual(normalized.current.missing_prerequisites, []);
  assert.deepEqual(normalized.queue[0].ingredients, []);
  assert.deepEqual(normalized.completed, []);
  assert.deepEqual(normalized.available, []);
});

test("normalizeFactoryData fills counts/problems/totals/alerts defaults", () => {
  const data = { counts: { furnace: { statuses: null } }, problems: { no_fuel: null }, alerts: null };
  const normalized = normalizeFactoryData(data);
  assert.deepEqual(normalized.counts.furnace.statuses, {});
  assert.deepEqual(normalized.problems.no_fuel, []);
  assert.deepEqual(normalized.problems.no_power, []);
  assert.deepEqual(normalized.totals, {});
  assert.deepEqual(normalized.alerts, []);
});

test("normalizeEntityData and normalizePrototypeData fill nested lists", () => {
  const entity = normalizeEntityData({
    results: [{ inventories: [{ purposes: null, items: null }], fluid_boxes: [{ connections: null }] }],
  });
  assert.deepEqual(entity.results[0].inventories[0].purposes, []);
  assert.deepEqual(entity.results[0].inventories[0].items, []);
  assert.deepEqual(entity.results[0].fluid_boxes[0].connections, []);

  const prototype = normalizePrototypeData({
    placeable_by: null,
    fluid_boxes: [{ pipe_connections: [{ connection_category: null, positions: null }] }],
    fuel_categories: null,
  });
  assert.deepEqual(prototype.placeable_by, []);
  assert.deepEqual(prototype.fuel_categories, []);
  assert.deepEqual(prototype.fluid_boxes[0].pipe_connections[0].connection_category, []);
  assert.deepEqual(prototype.fluid_boxes[0].pipe_connections[0].positions, []);
});

test("parseBuildRequests passes valid underground subtypes and drops invalid ones", () => {
  const entities = [
    { name: "underground-belt", anchor: { x: 1, y: 2 }, direction: 4, underground_type: "input" },
    { name: "pipe-to-ground", anchor: { x: 3, y: 4 }, direction: 0, underground_type: "output" },
    { name: "underground-belt", anchor: { x: 5, y: 6 }, underground_type: "sideways" },
    { name: "transport-belt", anchor: { x: 7, y: 8 } },
  ];
  const parsed = parseBuildRequests(entities);
  assert.deepEqual(parsed, [entities[0], entities[1], entities[3]]);
  assert.equal(parsed[0].underground_type, "input");
});

test("registerAgentRoutes preserves the full agent route inventory", () => {
  const router = new Router();
  // Registration only stores handlers; the context is dereferenced at call time.
  registerAgentRoutes(router, {});
  const routes = router.list();
  const paths = routes.map((route) => `${route.method} ${route.path}`);
  assert.ok(routes.length >= 20, `expected the agent route group, got ${routes.length}`);
  for (const expected of [
    "POST /api/agent/observe/world",
    "POST /api/agent/observe/player",
    "POST /api/agent/observe/factory",
    "POST /api/agent/observe/layout",
    "POST /api/agent/observe/visual",
    "POST /api/agent/act/build",
    "POST /api/agent/act/mine",
  ]) {
    assert.ok(paths.includes(expected), `missing ${expected}`);
  }
});
