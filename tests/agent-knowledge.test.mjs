import test from "node:test";
import assert from "node:assert/strict";

import { AGENT_KNOWLEDGE, knowledgeCatalog, knowledgeTopic } from "../dist/agent-knowledge.js";

test("knowledge base covers the requested engineering topics", () => {
  const ids = new Set(AGENT_KNOWLEDGE.map((topic) => topic.id));
  for (const id of [
    "inserters",
    "pipes",
    "trains",
    "power",
    "chemistry",
    "defense",
    "production",
    "blueprints",
  ]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  assert.equal(new Set(AGENT_KNOWLEDGE.map((topic) => topic.id)).size, AGENT_KNOWLEDGE.length);
  for (const topic of AGENT_KNOWLEDGE) {
    assert.ok(topic.rules.length >= 3, `${topic.id} needs rules`);
    assert.ok(topic.summary.length > 20);
  }
});

test("knowledge topic lookup accepts aliases and rejects unknown topics", () => {
  assert.equal(knowledgeTopic("inserters").id, "inserters");
  assert.equal(knowledgeTopic("mechanical-arm").id, "inserters");
  assert.equal(knowledgeTopic("railway").id, "trains");
  assert.equal(knowledgeTopic("power-grid").id, "power");
  assert.equal(knowledgeTopic("optimization").id, "production");
  assert.equal(knowledgeTopic("nope"), undefined);
  assert.equal(knowledgeCatalog().count, 8);
});
