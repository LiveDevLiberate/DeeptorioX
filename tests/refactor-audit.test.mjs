import test from "node:test";
import assert from "node:assert/strict";
import { buildRefactorAudit } from "../dist/refactor-audit.js";

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
