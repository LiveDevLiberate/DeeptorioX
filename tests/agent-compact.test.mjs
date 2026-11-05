import test from "node:test";
import assert from "node:assert/strict";
import { compactAgentPayload } from "../dist/http/agent-compact.js";

test("agent response compaction drops manager-only bookkeeping fields", () => {
  const compacted = compactAgentPayload({
    ok: true,
    truncated: false,
    timing_ms: 42,
    job_id: "job-1",
    status: "completed",
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    idempotency_key: null,
    cancel_requested: false,
    progress: { completed: 1, total: 1 },
    results: [
      {
        ok: true,
        wall_duration_ms: 12,
        movement: { distance: 3.2, game_ticks: 20, duration_ms: 300, final_position: { x: 1, y: 2 } },
        clearing: { ok: true, cleared: [], skipped: [], passes: 1, pending_remaining: 0 },
        alerts: { revision: 0, counts: { critical: 0, warning: 0 } },
      },
    ],
  });
  assert.equal(compacted.timing_ms, undefined);
  assert.equal(compacted.truncated, undefined);
  assert.equal(compacted.started_at, undefined);
  assert.equal(compacted.completed_at, undefined);
  assert.equal(compacted.idempotency_key, undefined);
  assert.equal(compacted.cancel_requested, undefined);
  assert.equal(compacted.created_at, undefined);
  assert.deepEqual(compacted.results[0].movement, { final_position: { x: 1, y: 2 }, distance: 3.2 });
  assert.deepEqual(compacted.results[0].clearing, { ok: true });
  assert.deepEqual(compacted.results[0].alerts, { revision: 0, counts: { critical: 0, warning: 0 } });
});

test("agent response compaction keeps actionable failures", () => {
  const compacted = compactAgentPayload({
    ok: false,
    error: "protected_building",
    hints: null,
    canceled: true,
    clearing: { ok: false, skipped: [{ name: "steam-engine" }] },
  });
  assert.equal(compacted.error, "protected_building");
  assert.deepEqual(compacted.clearing, { ok: false, skipped: [{ name: "steam-engine" }] });
});
