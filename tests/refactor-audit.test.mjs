import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRefactorAudit,
  coversDefaultRefactorScope,
  DEFAULT_REFACTOR_SCOPE,
  MAX_REFACTOR_CLUSTERS,
  observationCenter,
  pointInRefactorCluster,
} from "../dist/refactor-audit.js";

test("refactor audit prioritizes factory failures and suggests belt relayout", () => {
  const factory = {
    counts: { "stone-furnace": { total: 4, statuses: { no_fuel: 4 } } },
    totals: { no_fuel: 4, waiting_for_space_in_destination: 2 },
    problems: {
      no_fuel: [{ name: "stone-furnace", x: 10, y: 20 }],
      waiting_for_space_in_destination: [{ name: "inserter", x: 12, y: 22 }],
    },
  };
  const connections = {
    counts: { belts: 10, issues: 5, inserters: 2, machines: 1 },
    belts: [
      { x: 1, y: 2, direction: 4, next_connection: "straight" },
      { x: 2, y: 2, direction: 4, next_connection: "side_load", parallel_belts: 1 },
    ],
    issues: [
      { kind: "belt_no_input", x: 1, y: 2 },
      { kind: "belt_no_input", x: 2, y: 2 },
      { kind: "belt_no_input", x: 3, y: 2 },
      { kind: "belt_dead_end", x: 4, y: 2 },
    ],
  };
  const audit = buildRefactorAudit(factory, connections, { center: { x: 20, y: 30 }, radius: 40 });
  assert.ok(audit.actions.length >= 2);
  assert.equal(audit.actions[0].kind, "no_fuel");
  assert.ok(audit.actions.some((action) => /relayout-belts/.test(String(action.action))));
  assert.ok(audit.actions.some((action) => action.kind === "belt_no_input"));
  assert.ok(audit.summary.factory_problems >= 6);
  assert.ok(audit.fingerprint.length === 16);
  assert.match(audit.link_counts.side_load ? "side_load" : "", /side_load/);
});

test("audit returns no actions for a clean factory", () => {
  const audit = buildRefactorAudit(
    { counts: {}, totals: {}, problems: {} },
    { counts: {}, belts: [], issues: [] },
  );
  assert.equal(audit.actions.length, 0);
  assert.equal(audit.summary.buildings, 0);
});

test("refactor scope includes power and pipes by default, rail only on demand", () => {
  const factory = {
    counts: {},
    totals: { no_power: 2, no_input_fluid: 1, no_fuel: 3 },
    problems: {
      no_power: [{ name: "assembling-machine-1", x: 1, y: 1 }],
      no_input_fluid: [{ name: "chemical-plant", x: 2, y: 2 }],
      no_fuel: [{ name: "stone-furnace", x: 3, y: 3 }],
    },
  };
  const connections = {
    counts: { belts: 1, issues: 1, inserters: 0, machines: 0 },
    belts: [],
    issues: [{ kind: "belt_no_input", x: 4, y: 4 }],
    rail_issues: [{ kind: "rail_signal_missing", x: 9, y: 9 }],
  };
  const all = buildRefactorAudit(factory, connections);
  assert.ok(all.actions.some((action) => action.kind === "no_power"));
  assert.ok(all.actions.some((action) => action.kind === "no_input_fluid"));
  assert.ok(all.actions.some((action) => action.kind === "belt_no_input"));
  assert.ok(!all.actions.some((action) => action.kind === "rail_issues"));
  assert.equal(all.summary.scope.includes("power"), true);
  assert.equal(all.summary.scope.includes("pipes"), true);
  assert.equal(all.summary.invalid_count, 7);

  const powerOnly = buildRefactorAudit(factory, connections, { scope: ["power"] });
  assert.equal(powerOnly.summary.invalid_count, 2);
  assert.ok(!powerOnly.actions.some((action) => action.kind === "no_input_fluid"));

  const withRail = buildRefactorAudit(factory, connections, { includeRail: true });
  assert.ok(withRail.actions.some((action) => action.kind === "rail_issues"));
  assert.equal(withRail.summary.invalid_count, 8);
});

test("fingerprint ignores coordinates so the same debt escalates after 3 audits", () => {
  const factory = { counts: {}, totals: {}, problems: {} };
  const connections = {
    counts: { belts: 4, issues: 3, inserters: 0, machines: 0 },
    belts: [],
    issues: [
      { kind: "belt_no_input", x: 1, y: 2 },
      { kind: "belt_no_input", x: 2, y: 2 },
      { kind: "belt_no_input", x: 3, y: 2 },
    ],
  };
  const first = buildRefactorAudit(factory, connections);
  const moved = buildRefactorAudit(factory, {
    ...connections,
    issues: connections.issues.map((issue) => ({ ...issue, x: issue.x + 100, y: issue.y - 40 })),
  });
  assert.equal(first.fingerprint, moved.fingerprint);
  // A count change is still a different fingerprint.
  const more = buildRefactorAudit(factory, {
    ...connections,
    issues: [...connections.issues, { kind: "belt_no_input", x: 4, y: 2 }],
  });
  assert.notEqual(first.fingerprint, more.fingerprint);
});

test("belt relayout cleanup targets the issue cluster instead of the full window", () => {
  const connections = {
    counts: { belts: 3, issues: 3, inserters: 0, machines: 0 },
    belts: [],
    issues: [
      { kind: "belt_head_on", x: 30, y: 40 },
      { kind: "belt_head_on", x: 31, y: 40 },
      { kind: "belt_head_on", x: 32, y: 40 },
    ],
  };
  const audit = buildRefactorAudit({ counts: {}, totals: {}, problems: {} }, connections, {
    center: { x: 0, y: 0 },
    radius: 120,
  });
  const action = audit.actions.find((entry) => entry.kind === "belt_head_on");
  assert.ok(action, "belt issue action should be present");
  assert.ok(action.cleanup, "a repeated belt issue should carry a cleanup window");
  assert.ok(action.cleanup.radius >= 8 && action.cleanup.radius <= 24);
  assert.equal(action.cleanup.x, 31);
  assert.match(String(action.action), /relayout-belts around 31,40 radius 8/);
  assert.doesNotMatch(String(action.action), /radius 120/);
});

test("observationCenter uses the Lua-resolved scan window", () => {
  assert.deepEqual(observationCenter({ window: { x: 12, y: -3, radius: 120 } }), { x: 12, y: -3 });
  assert.equal(observationCenter({ window: { radius: 120 } }), undefined);
  assert.equal(observationCenter(undefined), undefined);
});

test("full refactor audits must cover the default scope", () => {
  assert.equal(coversDefaultRefactorScope(undefined), true);
  assert.equal(coversDefaultRefactorScope([...DEFAULT_REFACTOR_SCOPE]), true);
  assert.equal(coversDefaultRefactorScope([...DEFAULT_REFACTOR_SCOPE, "rail"]), true);
  assert.equal(coversDefaultRefactorScope(["power"]), false);
});

test("empty chests are default refactor debt but can be scoped out", () => {
  const factory = {
    counts: {},
    totals: {},
    problems: {},
    containers: { total: 3, empty: 2 },
    empty_containers: [
      { name: "wooden-chest", x: 1, y: 1 },
      { name: "steel-chest", x: 2, y: 2 },
    ],
  };
  const connections = { counts: {}, belts: [], issues: [] };
  const withEmpty = buildRefactorAudit(factory, connections);
  assert.ok(withEmpty.actions.some((action) => action.kind === "empty_containers"));
  assert.equal(withEmpty.summary.empty_containers, 2);
  assert.equal(withEmpty.summary.invalid_count, 2);
  const withoutContainers = buildRefactorAudit(factory, connections, { scope: ["belts", "power"] });
  assert.equal(withoutContainers.summary.invalid_count, 0);
  assert.ok(!withoutContainers.actions.some((action) => action.kind === "empty_containers"));
});

test("audit reports bounded rebuild clusters for flagged tiles", () => {
  const factory = {
    counts: { "stone-furnace": { total: 4, statuses: { no_fuel: 4 } } },
    totals: { no_fuel: 4, waiting_for_space_in_destination: 2 },
    problems: {
      no_fuel: [
        { name: "stone-furnace", x: 10, y: 20 },
        { name: "stone-furnace", x: 11, y: 20 },
      ],
      waiting_for_space_in_destination: [{ name: "inserter", x: 12, y: 22 }],
    },
  };
  const connections = {
    counts: { belts: 3, issues: 3, inserters: 0, machines: 0 },
    belts: [],
    issues: [
      { kind: "belt_head_on", x: 30, y: 40 },
      { kind: "belt_head_on", x: 31, y: 40 },
      { kind: "belt_head_on", x: 32, y: 40 },
    ],
  };
  const audit = buildRefactorAudit(factory, connections);
  assert.ok(Array.isArray(audit.clusters));
  assert.ok(audit.clusters.length >= 2, "separate problem areas become separate clusters");
  assert.ok(audit.clusters.length <= MAX_REFACTOR_CLUSTERS);
  const beltCluster = audit.clusters.find((cluster) => cluster.kinds.includes("belt_head_on"));
  assert.ok(beltCluster, "belt issues should get a rebuild cluster");
  assert.equal(beltCluster.x, 31);
  assert.equal(beltCluster.radius, 8);
  assert.ok(beltCluster.count >= 3);
  for (const cluster of audit.clusters) {
    assert.ok(Number.isFinite(cluster.x) && Number.isFinite(cluster.y));
    assert.ok(cluster.radius >= 4 && cluster.radius <= 40);
    assert.ok(Array.isArray(cluster.kinds) && cluster.kinds.length > 0);
  }
  assert.equal(pointInRefactorCluster(beltCluster, 31, 40), true);
  assert.equal(pointInRefactorCluster(beltCluster, 100, 100), false);
  assert.equal(pointInRefactorCluster(beltCluster, 31, 50), true, "cluster tolerance applies");
  assert.equal(pointInRefactorCluster(undefined, 0, 0), false);
});

test("clean factories report no rebuild clusters", () => {
  const audit = buildRefactorAudit(
    { counts: {}, totals: {}, problems: {} },
    { counts: {}, belts: [], issues: [] },
  );
  assert.deepEqual(audit.clusters, []);
});
