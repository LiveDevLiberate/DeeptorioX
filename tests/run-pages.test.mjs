import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { detailsUrl, recordingUrl } from "../public/run-view.js";

test("run links keep details and recording navigation separate and encode IDs", () => {
  assert.equal(detailsUrl("Pacific run & high"), "/run.html?run=Pacific%20run%20%26%20high");
  assert.equal(recordingUrl("Pacific run & high"), "/recording.html?run=Pacific%20run%20%26%20high");
});
test("comparison page shows model thinking levels, outcomes, tokens, and missing milestones", async () => {
  class Node {
    children = [];
    textContent = "";
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.children = nodes;
    }
  }
  const nodes = Object.fromEntries(["error", "matching", "comparison"].map((id) => [id, new Node()]));
  const fixtures = {
    first: {
      id: "first",
      name: "Pacific first run",
      model_label: "test-model (high)",
      state: "completed",
      elapsed_seconds: 12,
      usage: { input_tokens: 100, output_tokens: 20 },
      milestones: { science: { wall_seconds: 10 } },
      hashes: { benchmark: "same", baseline_save: "same", client: "same" },
    },
    second: {
      id: "second",
      name: "Pacific second run",
      model_label: "test-model (low)",
      state: "timed_out",
      elapsed_seconds: 30,
      milestones: {},
      hashes: { benchmark: "same", baseline_save: "same", client: "same" },
    },
  };
  const oldFetch = globalThis.fetch;
  globalThis.document = { getElementById: (id) => nodes[id], createElement: () => new Node() };
  globalThis.location = { search: "?runs=first,second" };
  globalThis.fetch = async (url) => ({ ok: true, json: async () => fixtures[url.split("/").at(-1)] });
  try {
    await import("../public/compare.js");
    assert.equal(nodes.error.textContent, "");
    assert.match(nodes.matching.textContent, /Matching benchmark/);
    const rows = nodes.comparison.children;
    assert.equal(rows[0].children[1].children[0].href, "/run.html?run=first");
    assert.deepEqual(
      rows[1].children.map((c) => c.textContent),
      ["Agent", "test-model (high)", "test-model (low)"],
    );
    assert.deepEqual(
      rows.at(-1).children.map((c) => c.textContent),
      ["science", "10.0s", "—"],
    );
  } finally {
    globalThis.fetch = oldFetch;
    delete globalThis.document;
    delete globalThis.location;
  }
});

test("run page exposes the agent blueprint catalogue and its toggle", () => {
  const html = fs.readFileSync(path.join(process.cwd(), "public", "run.html"), "utf8");
  const js = fs.readFileSync(path.join(process.cwd(), "public", "run.js"), "utf8");
  assert.match(html, /id="blueprintsToggle"[^>]*aria-controls="blueprintsPanel"/);
  assert.match(html, /id="blueprintCount"/);
  assert.match(html, /id="blueprintsPanel"/);
  assert.match(html, /id="mapToggle"[^>]*aria-controls="mapPanel"/);
  assert.match(html, /id="mapPanel"/);
  assert.match(html, /id="runMapThumbnail"/);
  assert.match(html, /id="toolCallsToggle"[^>]*aria-controls="toolCallsPanel"/);
  assert.match(html, /id="toolCallList"/);
  assert.match(html, /id="stateToggle"[^>]*aria-controls="statePanel"/);
  assert.match(html, /id="statePanel"/);
  assert.match(html, /id="stateHistory"/);
  assert.match(html, /id="blueprintList"/);
  assert.match(js, /\/api\/runs\/\$\{encodeURIComponent\(id\)\}\/blueprints/);
  assert.match(js, /Decode blueprint/);
  assert.match(js, /download=1/);
  assert.match(js, /blueprint-download/);
  assert.match(html, /id="previewOverlay"/);
  assert.match(html, /id="previewBody"/);
  assert.match(html, /id="seedPreviewExpand"/);
  assert.match(js, /function openPreview/);
  assert.match(js, /blueprint-viewer\/viewer\.html/);
  assert.match(js, /seedPreviewUrl/);
  assert.match(html, /id="seedToolkitViewer"/);
  assert.match(html, /id="seedUploadLocal"/);
  assert.match(js, /api\/map-previews\/upload/);
  const recordingJs = fs.readFileSync(path.join(process.cwd(), "public", "recording.js"), "utf8");
  assert.match(recordingJs, /download=1/);
  assert.match(recordingJs, /blueprintDownload/);
});

test("launch page exposes exchange string file and clipboard providers", () => {
  const html = fs.readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");
  const js = fs.readFileSync(path.join(process.cwd(), "public", "runs.js"), "utf8");
  assert.match(html, /id="exchangeString"/);
  assert.match(html, /id="exchangeFile"/);
  assert.match(html, /id="exchangeFileButton"/);
  assert.match(html, /id="exchangePaste"/);
  assert.match(html, /id="launchPreviewTabs"/);
  assert.match(js, /exchangeFileButton/);
  assert.match(js, /navigator\.clipboard/);
  assert.match(js, /\/api\/map-preview\/exchange/);
});
