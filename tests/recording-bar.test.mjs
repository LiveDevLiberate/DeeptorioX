import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { FakeNode, PAGE_ELEMENT_IDS } from "./recording-harness.mjs";

test("recording page renders a milestone bar with the next target", async () => {
  const nodes = Object.fromEntries(PAGE_ELEMENT_IDS.map((id) => [id, new FakeNode()]));
  const body = new FakeNode("body");
  const documentElement = new FakeNode("html");
  documentElement.lang = "en";
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const runFixture = {
    id: "run1",
    name: "milestone run",
    state: "running",
    language: "English",
    output_format: "events",
    elapsed_seconds: 641,
    max_seconds: 1800,
    state_md: "",
    evaluation: {
      capability: {
        score: 750,
        max: 1000,
        completed: false,
        progress: 0.42,
        milestones: { completed: 3, total: 7 },
        next_milestone: "logistic-science",
        next_milestone_label: "Logistic science",
        par_seconds: 640,
        par_source: "median_completed:2026-11-08",
      },
    },
  };
  globalThis.document = {
    getElementById: (id) => nodes[id] || null,
    createElement: (tag) => new FakeNode(tag),
    body,
    documentElement,
    title: "",
  };
  globalThis.location = { search: "?run=run1" };
  globalThis.history = { replaceState() {} };
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  // Node 21+ exposes a getter-only navigator global; define it explicitly.
  Object.defineProperty(globalThis, "navigator", {
    value: { language: "en-US" },
    configurable: true,
    writable: true,
  });
  globalThis.setTimeout = (callback) => {
    timers.push(callback);
    return timers.length;
  };
  globalThis.fetch = async (url) => {
    if (url === "/api/runs/run1") return { ok: true, json: async () => runFixture };
    if (url.includes("source=telemetry")) return { ok: true, json: async () => ({ data: "", offset: 0 }) };
    if (url.includes("/log?")) return { ok: true, json: async () => ({ data: "", offset: 0 }) };
    if (url.includes("/blueprints")) return { ok: true, json: async () => ({ blueprints: [] }) };
    if (url === "/api/factorio-locale") return { ok: false, json: async () => ({}) };
    throw new Error(`unexpected fetch ${url}`);
  };
  const flush = async () => {
    for (let index = 0; index < 40; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    await import("../public/recording.js");
    await flush();
    const nodeText = (node) =>
      [node.textContent, ...(node.children || []).map(nodeText)].filter(Boolean).join(" ");
    const findClass = (root, name) => {
      if (String(root.className || "").includes(name)) return root;
      for (const child of root.children || []) {
        const hit = findClass(child, name);
        if (hit) return hit;
      }
      return null;
    };
    const milestoneRow = findClass(nodes.statusMetrics, "metric-milestones");
    assert.ok(milestoneRow, "missing milestone progress row in the readout table");
    assert.equal(findClass(milestoneRow, "ms-dots"), null);
    const fill = findClass(milestoneRow, "ms-fill");
    assert.ok(fill, "missing milestone bar fill");
    assert.equal(fill.style.width, "42%");
    const [labelCell, valueCell, trendCell] = milestoneRow.children;
    assert.equal(nodeText(labelCell), "Milestones");
    assert.match(nodeText(valueCell), /Next: Logistic science/);
    assert.equal(
      globalThis.document.title,
      "DeeptorioX | Running on Factorio | AI agents exploring the space industry",
    );
    assert.match(nodeText(trendCell), /42%/);
    assert.match(nodeText(trendCell), /3\/7/);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
    delete globalThis.document;
    delete globalThis.location;
    delete globalThis.history;
    delete globalThis.fetch;
  }
});
