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
  const nodes = Object.fromEntries(
    ["error", "matching", "scoringNotice", "comparison"].map((id) => [id, new Node()]),
  );
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
    assert.equal(rows[0].children[1].children.at(-1).href, "/run.html?run=first");
    assert.equal(nodes.scoringNotice.textContent, "");
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
  assert.match(html, /id="disciplinePanel"/);
  assert.match(html, /id="constructionPanel"/);
  assert.match(html, /id="constructionPlanList"/);
  assert.match(html, /id="disciplineStats"/);
  assert.match(html, /id="disciplineSummary"/);
  assert.match(js, /renderDiscipline\(run\)/);
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

test("comparison page ranks by capability and warns on mixed scoring configs", async () => {
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
  const nodes = Object.fromEntries(
    ["error", "matching", "scoringNotice", "comparison"].map((id) => [id, new Node()]),
  );
  const fixtures = {
    low: {
      id: "low",
      name: "Low run",
      state: "timed_out",
      elapsed_seconds: 120,
      milestones: {},
      hashes: { benchmark: "same", baseline_save: "same", client: "same" },
      scoring: { version: 2, par_seconds: 641 },
      evaluation: {
        capability: {
          score: 300,
          max: 1000,
          completed: false,
          progress: 0.6,
          milestones: { completed: 1, total: 2 },
        },
        discipline: {
          manual_mines: 4,
          manual_crafts: 1,
          blackouts: 0,
          state_blocked_seconds: 0,
          flags: ["manual_work"],
          refactor: { debt_peak: 12 },
        },
      },
    },
    high: {
      id: "high",
      name: "High run",
      state: "completed",
      elapsed_seconds: 600,
      milestones: { twenty: { wall_seconds: 600 } },
      hashes: { benchmark: "same", baseline_save: "same", client: "same" },
      scoring: { version: 3, par_seconds: 900 },
      evaluation: {
        capability: {
          score: 750,
          max: 1000,
          completed: true,
          progress: 1,
          milestones: { completed: 2, total: 2 },
          completion_seconds: 600,
          par_seconds: 900,
        },
        discipline: {
          manual_mines: 0,
          manual_crafts: 0,
          blackouts: 1,
          state_blocked_seconds: 30,
          flags: ["blackouts"],
          refactor: { debt_peak: 4 },
        },
      },
    },
  };
  const oldFetch = globalThis.fetch;
  globalThis.document = { getElementById: (id) => nodes[id], createElement: () => new Node() };
  globalThis.location = { search: "?runs=low,high" };
  globalThis.fetch = async (url) => ({ ok: true, json: async () => fixtures[url.split("/").at(-1)] });
  try {
    await import("../public/compare.js?capability");
    assert.equal(nodes.error.textContent, "");
    assert.match(nodes.scoringNotice.textContent, /not directly comparable/);
    const rows = nodes.comparison.children;
    // Sorted by capability descending: high is column #1, low is column #2.
    assert.equal(rows[0].children[1].children[0].textContent, "#1 ");
    assert.equal(rows[0].children[1].children.at(-1).href, "/run.html?run=high");
    const capabilityRow = rows.find((row) => row.children[0].textContent === "Capability");
    assert.ok(capabilityRow);
    assert.match(capabilityRow.children[1].textContent, /^750 \/ 1000 · completed$/);
    assert.match(capabilityRow.children[2].textContent, /^300 \/ 1000 · 60%$/);
    const completionRow = rows.find((row) => row.children[0].textContent === "Completion time");
    assert.match(completionRow.children[1].textContent, /par 900s/);
    const flagsRow = rows.find((row) => row.children[0].textContent === "Discipline flags");
    assert.equal(flagsRow.children[1].textContent, "blackouts");
    assert.equal(flagsRow.children[2].textContent, "manual_work");
  } finally {
    globalThis.fetch = oldFetch;
    delete globalThis.document;
    delete globalThis.location;
  }
});
