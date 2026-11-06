import test from "node:test";
import assert from "node:assert/strict";
import { summarizeConnectionsData } from "../dist/connection-summary.js";

test("connection summary groups issues and draws a compact belt map", () => {
  const data = {
    window: { x: 0, y: 0, radius: 10 },
    counts: { belts: 2, issues: 2 },
    belts: [
      { name: "transport-belt", x: 0.5, y: 0.5, direction: 4, next_connection: "straight" },
      {
        name: "transport-belt",
        x: 1.5,
        y: 0.5,
        direction: 12,
        next_connection: "head_on",
        parallel_belts: 1,
      },
    ],
    issues: [
      { kind: "belt_opposite", x: 0.5, y: 0.5, direction: 4 },
      { kind: "belt_no_input", x: 1.5, y: 0.5, direction: 12 },
    ],
  };
  const summary = summarizeConnectionsData(data);
  assert.equal(summary.issue_summary.total, 2);
  assert.equal(summary.issue_summary.groups[0].count, 1);
  assert.ok(summary.issue_summary.suggestions.some((text) => /Rotate|inserter|feeder/i.test(text)));
  assert.equal(summary.belt_links.head_on, 1);
  assert.equal(summary.parallel_belts, 1);
  assert.ok(summary.map.rows.length > 0);
  assert.match(summary.map.rows[0], /[X?+>]/);
  assert.ok(summary.junctions.length >= 1);
});
