import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "public", "recording.html"), "utf8");

test("recording page keeps its semantic structure and information surfaces", () => {
  // Semantic grouping for the status header.
  assert.match(html, /<header class="status-head" aria-label="Run status">/);
  assert.match(html, /<section id="planPanel" class="status-plan" aria-label="Current plan">/);
  assert.match(html, /<section id="telemetryPanel" class="status-telemetry" aria-label="Live telemetry">/);
  // Transcript pane + labelled toolbar groups.
  assert.match(html, /<main class="transcript-pane">/);
  assert.match(html, /id="transcriptTools"[^>]*role="toolbar"[^>]*aria-label="Transcript filters"/);
  assert.match(html, /id="filterGroup"[^>]*role="group"[^>]*aria-label="Filter by category"/);
  assert.match(html, /class="icon icon-search"/);
  // Existing information + icon hooks must survive the structural refactor.
  for (const id of [
    "agentStatus",
    "statusToggle",
    "statusState",
    "statusActivity",
    "stateTimer",
    "statusMeta",
    "statusCurrent",
    "statusDone",
    "statusMetrics",
    "statusScores",
    "filterAll",
    "filterThinking",
    "filterActions",
    "filterMessages",
    "filterErrors",
    "filterDecisions",
    "transcriptSearch",
    "codexOutput",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  // Icons are preserved across the status and filter surfaces.
  assert.match(html, /class="icon icon-search"/);
  assert.match(html, /class="icon icon-layers"/);
  assert.match(html, /class="icon icon-brain"/);
  assert.match(html, /class="icon icon-wrench"/);
  assert.match(html, /class="icon icon-chat"/);
  assert.match(html, /class="icon icon-siren"/);
  assert.match(html, /class="icon icon-compass"/);
});
