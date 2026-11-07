import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const html = fs.readFileSync(path.join(process.cwd(), "public", "recording.html"), "utf8");
const entryCss = fs.readFileSync(path.join(process.cwd(), "public", "runs.css"), "utf8");
const styleFiles = ["base.css", "recording.css", "dashboard.css", "recording-modern.css"];
const css = [
  entryCss,
  ...styleFiles.map((file) => fs.readFileSync(path.join(process.cwd(), "public", "styles", file), "utf8")),
].join("\n");

test("recording page keeps its semantic structure and information surfaces", () => {
  // The entry point imports modules in the original source order.
  assert.match(entryCss, /@import url\("\.\/styles\/tokens\.css"\);/);
  assert.match(entryCss, /@import url\("\.\/styles\/base\.css"\);/);
  assert.match(entryCss, /@import url\("\.\/styles\/recording\.css"\);/);
  assert.match(entryCss, /@import url\("\.\/styles\/dashboard\.css"\);/);
  assert.match(entryCss, /@import url\("\.\/styles\/recording-modern\.css"\);/);
  // Semantic grouping for the status header and the shared 12-column grid.
  assert.match(html, /<div class="status-inner ui-grid-12">/);
  assert.match(html, /<header class="status-head" aria-label="Run status">/);
  assert.match(html, /<div class="status-tools" role="group" aria-label="Display options">/);
  assert.match(html, /<section id="planPanel" class="status-plan ui-col-1-7" aria-label="Current plan">/);
  assert.match(html, /id="planKicker"[^>]*>Work order</);
  assert.match(html, /id="telemetryKicker"[^>]*>Readouts</);
  assert.doesNotMatch(html, /id="statusMilestones"/);
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
  assert.match(css, /--rule:/);
  assert.match(css, /--ink:/);
  assert.match(css, /--font-display:/);
  assert.match(css, /--safety:/);
  assert.match(css, /--font-body:/);
  assert.match(css, /--icon-sm: 12px/);
  assert.match(css, /--icon-md: 14px/);
  // Readout columns stay fixed; discipline badges wrap instead of widening them.
  assert.match(css, /body\.recording \.metrics-table \{[\s\S]*?table-layout: fixed;/);
  assert.match(css, /body\.recording \.metric-discipline td\.metric-value \{[\s\S]*?white-space: normal;/);
  // Narrow recording windows must keep the milestone percent/count visible.
  assert.match(
    css,
    /@media \(max-width: 680px\) \{[\s\S]*?body\.recording \.metric-milestones \.metric-trend \{[\s\S]*?flex-wrap: nowrap;/,
  );
  assert.match(
    css,
    /body\.recording \.metric-milestones \.ms-bar \{[\s\S]*?width: clamp\(20px, 14vw, 64px\);/,
  );
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
    "statusModel",
    "stateTimer",
    "statusMeta",
    "statusCurrent",
    "statusDone",
    "planKicker",
    "telemetryKicker",
    "connectionNotice",
    "connectionRetry",
    "statusMetrics",
    "statusScores",
    "filterAll",
    "filterThinking",
    "filterActions",
    "filterTech",
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
  assert.match(html, /id="mapThumbnail"/);
  assert.match(html, /src="\/map-thumbnail.js"/);
  assert.match(html, /id="recordingBlueprintsToggle"[^>]*aria-controls="blueprintOverlay"/);
  assert.match(html, /id="blueprintOverlay"[^>]*hidden/);
  assert.match(html, /id="blueprintDialog"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="blueprintBody"/);
  assert.match(html, /id="blueprintsClose"/);
  assert.match(html, /id="toolCallsToggle"[^>]*aria-controls="toolCallsOverlay"/);
  assert.match(html, /id="toolCallsOverlay"[^>]*hidden/);
  assert.match(html, /id="toolCallsDialog"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="toolCallsBody"/);
  assert.match(html, /id="toolCallsClose"/);
  assert.match(html, /class="icon icon-layers"/);
  assert.match(html, /class="icon icon-brain"/);
  assert.match(html, /class="icon icon-wrench"/);
  assert.match(html, /class="icon icon-flask"/);
  assert.match(html, /class="icon icon-siren"/);
  assert.match(html, /class="icon icon-compass"/);
});
