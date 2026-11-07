import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import { FakeNode, PAGE_ELEMENT_IDS } from "./recording-harness.mjs";

test("milestone next target follows the run language and game locale", async () => {
  const nodes = Object.fromEntries(PAGE_ELEMENT_IDS.map((id) => [id, new FakeNode()]));
  const body = new FakeNode("body");
  const documentElement = new FakeNode("html");
  documentElement.lang = "en";
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const hadNavigator = Object.prototype.hasOwnProperty.call(globalThis, "navigator");
  const realNavigator = globalThis.navigator;
  const runFixture = {
    id: "run1",
    name: "zh milestone run",
    state: "running",
    language: "Chinese",
    output_format: "events",
    elapsed_seconds: 641,
    max_seconds: 1800,
    state_md: "",
    benchmark: {
      milestones: [{ id: "smelt-plates", kind: "production", name: "iron-plate" }],
    },
    evaluation: {
      capability: {
        score: 125,
        max: 1000,
        completed: false,
        progress: 0.42,
        milestones: { completed: 3, total: 7 },
        next_milestone: "smelt-plates",
        next_milestone_label: "iron-plate",
        par_seconds: 9600,
        par_source: "fallback:max_seconds/3",
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
  if (hadNavigator) globalThis.navigator = { language: "zh-CN" };
  else
    Object.defineProperty(globalThis, "navigator", {
      value: { language: "zh-CN" },
      configurable: true,
    });
  globalThis.setTimeout = (callback) => {
    timers.push(callback);
    return timers.length;
  };
  globalThis.fetch = async (url) => {
    if (url === "/api/runs/run1") return { ok: true, json: async () => runFixture };
    if (url === "/api/factorio-locale")
      return { ok: true, json: async () => ({ "zh-CN": { item: { "iron-plate": "铁板" } } }) };
    if (url.includes("source=telemetry")) return { ok: true, json: async () => ({ data: "", offset: 0 }) };
    if (url.includes("/log?")) return { ok: true, json: async () => ({ data: "", offset: 0 }) };
    if (url.includes("/blueprints")) return { ok: true, json: async () => ({ blueprints: [] }) };
    throw new Error(`unexpected fetch ${url}`);
  };
  const flush = async () => {
    for (let index = 0; index < 60; index += 1) await new Promise((resolve) => setImmediate(resolve));
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
    assert.ok(milestoneRow, "missing milestone row");
    const [labelCell, valueCell, trendCell] = milestoneRow.children;
    assert.equal(nodeText(labelCell), "里程碑");
    assert.equal(nodeText(valueCell), "下一个: 铁板");
    assert.equal(globalThis.document.title, "DeeptorioX | 运行于 Factorio | 智能体探索太空工业");
    assert.match(nodeText(trendCell), /42%/);
    assert.match(nodeText(trendCell), /3\/7/);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    if (hadNavigator) globalThis.navigator = realNavigator;
    else delete globalThis.navigator;
    delete globalThis.document;
    delete globalThis.location;
    delete globalThis.history;
    delete globalThis.fetch;
  }
});
