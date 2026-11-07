import test from "node:test";
import assert from "node:assert/strict";
import { displayModel, duration, renderProgress } from "../public/run-view.js";

class FakeNode {
  constructor() {
    this.textContent = "";
    this.className = "";
    this.disabled = false;
    this.children = [];
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
}

function setupDocument() {
  const ids = ["runTitle", "state", "elapsed", "gameTime", "agent", "reason", "stop", "milestones"];
  const nodes = Object.fromEntries(ids.map((id) => [id, new FakeNode()]));
  globalThis.document = {
    getElementById: (id) => nodes[id],
    createElement: () => new FakeNode(),
  };
  return nodes;
}

test("renderProgress fills every run header field and milestone chip", () => {
  const nodes = setupDocument();
  try {
    renderProgress({
      name: "Pacific run",
      benchmark: { title: "bench", milestones: [{ id: "first", label: "First plate" }, { id: "second" }] },
      state: "running",
      elapsed_seconds: 65,
      latest: { tick: 600 },
      baseline_tick: 0,
      model_label: "vendor/model",
      model: "fallback-model",
      agent: "codex",
      reason: "retrying",
      warnings: ["quota low"],
      milestones: { first: { wall_seconds: 125 } },
    });
    assert.equal(nodes.runTitle.textContent, "Pacific run");
    assert.equal(nodes.state.textContent, "running");
    assert.equal(nodes.elapsed.textContent, "1m 05s");
    assert.equal(nodes.gameTime.textContent, "0m 10s");
    assert.equal(nodes.agent.textContent, "model");
    assert.equal(nodes.reason.textContent, "retrying · quota low");
    assert.equal(nodes.stop.disabled, false);
    assert.equal(nodes.milestones.children.length, 2);
    assert.equal(nodes.milestones.children[0].textContent, "✓ First plate · 2m 05s");
    assert.equal(nodes.milestones.children[0].className, "milestone done");
    assert.equal(nodes.milestones.children[1].textContent, "○ second");
    assert.equal(nodes.milestones.children[1].className, "milestone");
  } finally {
    delete globalThis.document;
  }
});

test("renderProgress falls back for unnamed and saving runs", () => {
  const nodes = setupDocument();
  try {
    renderProgress({
      benchmark: { title: "Fallback bench", milestones: [] },
      state: "saving",
      elapsed_seconds: 0,
      latest: null,
      agent: "opencode",
      milestones: {},
    });
    assert.equal(nodes.runTitle.textContent, "Fallback bench");
    assert.equal(nodes.elapsed.textContent, "0m 00s");
    assert.equal(nodes.gameTime.textContent, "—");
    assert.equal(nodes.agent.textContent, "opencode");
    assert.equal(nodes.reason.textContent, "");
    assert.equal(nodes.stop.disabled, true);
    assert.deepEqual(nodes.milestones.children, []);
  } finally {
    delete globalThis.document;
  }
});

test("run-view helpers format models, durations and links", () => {
  assert.equal(displayModel(""), "");
  assert.equal(displayModel("plain-model"), "plain-model");
  assert.equal(displayModel("vendor/model"), "model");
  assert.equal(displayModel("a/b/c"), "c");
  assert.equal(duration(0), "0m 00s");
  assert.equal(duration(undefined), "0m 00s");
  assert.equal(duration(61), "1m 01s");
});
