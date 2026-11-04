import test from "node:test";
import assert from "node:assert/strict";
import { evaluateStateGate, renderStateMarkdown } from "../dist/state-file.js";

test("state gate warns at soft interval and blocks at hard interval", () => {
  const fresh = evaluateStateGate({ hasState: true, ageSeconds: 120, elapsedSeconds: 120 });
  assert.equal(fresh.due, false);
  assert.equal(fresh.blocked, false);
  const due = evaluateStateGate({ hasState: true, ageSeconds: 320, elapsedSeconds: 320 });
  assert.equal(due.due, true);
  assert.equal(due.blocked, false);
  const blocked = evaluateStateGate({ hasState: true, ageSeconds: 700, elapsedSeconds: 700 });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.hint, /POST \/api\/agent\/state/);
});

test("missing STATE.md is blocked only after the startup grace period", () => {
  const grace = evaluateStateGate({ hasState: false, ageSeconds: null, elapsedSeconds: 30 });
  assert.equal(grace.due, true);
  assert.equal(grace.blocked, false);
  const blocked = evaluateStateGate({ hasState: false, ageSeconds: null, elapsedSeconds: 121 });
  assert.equal(blocked.blocked, true);
});

test("renderStateMarkdown emits the parsed canonical fields", () => {
  const markdown = renderStateMarkdown(
    {
      objective: "launch a rocket",
      current: "smelting",
      done_when: "20 plates/min",
      next: "place furnace",
      timebox: "10 min",
      progress: "2/20 plates",
      notes: "coal belt is running",
      scores: { production: 60, logistics: 50, exploration: 5 },
    },
    new Date("2026-01-02T03:04:05Z"),
  );
  assert.match(markdown, /^# STATE\nUpdated: 2026-01-02T03:04:05\.000Z/);
  assert.match(markdown, /Objective: launch a rocket/);
  assert.match(
    markdown,
    /Scores: production 60, logistics 50, mining 0, research 0, defense 0, exploration 5/,
  );
  assert.match(markdown, /Current: smelting/);
  assert.match(markdown, /Done when: 20 plates\/min/);
  assert.match(markdown, /Next: place furnace/);
  assert.match(markdown, /Timebox: 10 min/);
  assert.match(markdown, /Progress: 2\/20 plates/);
  assert.match(markdown, /coal belt is running/);
});

test("renderStateMarkdown accepts a raw markdown override", () => {
  assert.equal(
    renderStateMarkdown({ current: "x", markdown: "# custom\nCurrent: x" }),
    "# custom\nCurrent: x\n",
  );
});
