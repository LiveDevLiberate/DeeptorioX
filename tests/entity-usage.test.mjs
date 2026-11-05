import test from "node:test";
import assert from "node:assert/strict";

import { entityUsage } from "../dist/entity-usage.js";

test("curated belt usage explains one-way flow and crossing mistakes", () => {
  const belt = entityUsage({ name: "transport-belt", type: "transport-belt" });
  assert.equal(belt.source, "curated");
  assert.match(belt.summary, /one direction/i);
  assert.ok(belt.common_mistakes.some((note) => /cross/i.test(note)));
  assert.ok(belt.rules.some((rule) => /underground-belt|splitter/i.test(rule)));
});

test("curated splitter usage is one input and two forward outputs", () => {
  const splitter = entityUsage({ name: "splitter", type: "splitter" });
  assert.equal(splitter.source, "curated");
  assert.match(splitter.flow.input, /rear/i);
  assert.match(splitter.flow.output, /two front|left-right/i);
  assert.ok(splitter.common_mistakes.some((note) => /both directions/i.test(note)));
});

test("unknown entities fall back to prototype-driven guidance", () => {
  const unknown = entityUsage({ name: "modded-cross", type: "modded-machine" });
  assert.equal(unknown.source, "type_fallback");
  assert.match(unknown.summary, /No curated usage/);
  assert.ok(unknown.rules.some((rule) => /observe-entity-prototype/.test(rule)));
});
