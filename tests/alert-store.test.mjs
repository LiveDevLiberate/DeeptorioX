import test from "node:test";
import assert from "node:assert/strict";
import { AlertStore } from "../dist/alert-store.js";

const factory = (problems = {}, totals = {}, power = {}) => ({ problems, totals, power, alerts: [] });

test("critical alerts gate, ack, and re-arm when the alert set changes", () => {
  const store = new AlertStore(0, 0, 1, 10);
  const first = store.ingest(
    factory({ no_fuel: [{ name: "stone-furnace", x: 1, y: 2 }] }, { no_fuel: 1 }),
    1000,
  );
  assert.equal(first.revision, 1);
  assert.equal(first.counts.critical, 1);
  assert.equal(first.items[0].first_seen_ms, 1000);
  assert.equal(store.gate(1000).blocked, true);
  store.ack(1000);
  assert.equal(store.gate(1000).blocked, false);
  const countChanged = store.ingest(
    factory(
      {
        no_fuel: [
          { name: "stone-furnace", x: 1, y: 2 },
          { name: "boiler", x: 3, y: 4 },
        ],
      },
      { no_fuel: 2 },
    ),
    1100,
  );
  assert.equal(countChanged.revision, 1, "count fluctuations must not re-arm the ack");
  assert.equal(store.gate(1100).blocked, false);
  const changed = store.ingest(
    factory(
      { no_fuel: [{ name: "stone-furnace", x: 1, y: 2 }], no_power: [{ name: "assembler" }] },
      { no_fuel: 2, no_power: 1 },
    ),
    1200,
  );
  assert.equal(changed.revision, 2);
  assert.equal(store.gate(1200).blocked, true);
});

test("warnings do not gate; critical penalties accrue by interval and persist", () => {
  const store = new AlertStore(0, 0, 1, 10);
  store.ingest(
    factory(
      { waiting_for_space_in_destination: [{ name: "furnace" }] },
      { waiting_for_space_in_destination: 1 },
    ),
    1000,
  );
  assert.equal(store.gate(1000).blocked, false);
  store.ingest(factory({ no_power: [{ name: "assembler" }] }, { no_power: 1 }), 2000);
  store.accrue(3000);
  assert.equal(store.penalty(), 20);
  store.ingest(factory({}, {}), 3000);
  assert.equal(store.penalty(4000), 20, "resolved-alert penalties stay recorded");
  assert.equal(store.gate(4000).blocked, false);
});

test("attach adds a compact envelope to agent payloads", () => {
  const store = new AlertStore();
  store.ingest(factory({ no_power: [{ name: "assembler" }] }, { no_power: 1 }), 1000);
  const attached = store.attach({ ok: true, data: { x: 1 } });
  assert.equal(attached.ok, true);
  assert.equal(attached.alerts.counts.critical, 1);
  assert.equal(attached.alerts.items[0].message, "entities have no power");
  assert.equal(
    "penalty" in attached.alerts,
    false,
    "the agent envelope must not leak the internal score component",
  );
});
