import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "public", "recording.html"), "utf8");
const css = fs.readFileSync(path.join(process.cwd(), "public", "runs.css"), "utf8");

test("recording page keeps its semantic structure and information surfaces", () => {
  // Semantic grouping for the status header and the shared 12-column grid.
  assert.match(html, /<div class="status-inner ui-grid-12">/);
  assert.match(html, /<header class="status-head" aria-label="Run status">/);
  assert.match(html, /<div class="status-tools" role="group" aria-label="Display options">/);
  assert.match(html, /<section id="planPanel" class="status-plan ui-col-1-7" aria-label="Current plan">/);
  assert.match(html, /class="run-masthead" aria-hidden="true"/);
  assert.match(html, /id="runMastheadContext"[^>]*>factory log</);
  assert.match(html, /id="planKicker"[^>]*>Work order</);
  assert.match(html, /id="telemetryKicker"[^>]*>Readouts</);
  assert.match(
    html,
    /<section id="telemetryPanel" class="status-telemetry ui-col-8-12" aria-label="Live telemetry">/,
  );
  // Transcript pane + labelled toolbar groups.
  assert.match(html, /<main class="transcript-pane">/);
  assert.match(html, /id="transcriptTools"[^>]*role="toolbar"[^>]*aria-label="Transcript filters"/);
  assert.match(html, /id="filterGroup"[^>]*role="group"[^>]*aria-label="Filter by category"/);
  assert.match(html, /class="icon icon-search"/);
  // Existing information + icon hooks must survive the structural refactor.
  // The shared grid tokens and helpers exist and are reused by the page bands.
  assert.match(css, /--ui-max: 1080px/);
  assert.match(css, /\.ui-grid-12 \{/);
  assert.match(css, /\.ui-col-1-7 \{/);
  assert.match(css, /\.ui-col-8-12 \{/);
  assert.match(css, /html\[data-theme="light"\] body\.recording/);
  assert.match(css, /html:not\(\[data-theme="light"\]\) body\.recording/);
  assert.match(css, /--rec-bg: #000000/);
  assert.match(css, /--font-display:/);
  assert.match(css, /--safety:/);
  assert.match(css, /--font-body:/);
  assert.match(css, /body\.recording \.connection-notice/);
  assert.match(css, /body\.recording \.status-tools/);
  assert.match(css, /html\[data-theme="light"\] body\.recording #agentStatus\.stale-plan \.status-current/);
  assert.match(css, /body\.recording main\.transcript-pane \{[^}]*margin: 0;/);
  assert.match(css, /main\.transcript-pane > #transcriptTools,/);
  for (const id of [
    "agentStatus",
    "statusToggle",
    "statusState",
    "statusActivity",
    "stateTimer",
    "statusMeta",
    "statusCurrent",
    "statusDone",
    "planKicker",
    "telemetryKicker",
    "connectionNotice",
    "connectionRetry",
    "runMastheadContext",
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
  assert.match(html, /id="mapInfoToggle"[^>]*aria-controls="mapInfoOverlay"/);
  assert.match(html, /id="themeToggle"[^>]*aria-pressed="false"/);
  assert.match(html, /id="connectionNotice"[^>]*role="alert"[^>]*hidden/);
  assert.match(html, /id="connectionRetry"/);
  assert.match(html, /class="icon icon-sun"/);
  assert.match(html, /class="icon icon-map"/);
  assert.match(html, /id="mapInfoOverlay"[^>]*hidden/);
  assert.match(html, /id="mapInfoDialog"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="mapInfoClose"/);
  assert.match(html, /class="icon icon-layers"/);
  assert.match(html, /class="icon icon-brain"/);
  assert.match(html, /class="icon icon-wrench"/);
  assert.match(html, /class="icon icon-chat"/);
  assert.match(html, /class="icon icon-siren"/);
  assert.match(html, /class="icon icon-compass"/);
});
