// DOM smoke test for the live transcript renderer. It drives recording.js with
// fake elements and a mocked manager API so the P0 readability features
// (collapsed reasoning, action summaries, turns, loop badges, unread button)
// are exercised without a browser or a real run.
import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers";
import fs from "node:fs";

class FakeNode {
  constructor(tag = "div") {
    this.tagName = tag;
    this.children = [];
    this.textContent = "";
    this.className = "";
    this.hidden = false;
    this.open = false;
    this.style = {};
    this.listeners = new Map();
    this._classList = new Set();
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.clientHeight = 0;
  }
  get classList() {
    return {
      add: (...names) => names.forEach((name) => this._classList.add(name)),
      remove: (...names) => names.forEach((name) => this._classList.delete(name)),
      contains: (name) => this._classList.has(name),
      toggle: (name, force) => {
        const value = force === undefined ? !this._classList.has(name) : Boolean(force);
        if (value) this._classList.add(name);
        else this._classList.delete(name);
        return value;
      },
    };
  }
  set className(value) {
    this._classList = new Set(
      String(value || "")
        .split(/\s+/)
        .filter(Boolean),
    );
  }
  get className() {
    return [...this._classList].join(" ");
  }
  append(...nodes) {
    for (const node of nodes) this.children.push(node);
  }
  replaceChildren(...nodes) {
    this.children = [...nodes];
  }
  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }
  setAttribute() {}
  fire(type) {
    this.listeners.get(type)?.();
  }
}

function base64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function jsonl(items) {
  return items.map((item) => JSON.stringify(item)).join("\n") + "\n";
}

test("recording page renders summaries, loops, turns and unread updates", async () => {
  const ids = [
    "agentStatus",
    "statusState",
    "statusActivity",
    "statusMeta",
    "statusCurrent",
    "statusDone",
    "statusScores",
    "statusMetrics",
    "statusToggle",
    "stateTimer",
    "transcriptSearch",
    "filterAll",
    "filterThinking",
    "filterActions",
    "filterMessages",
    "filterErrors",
    "filterDecisions",
    "codexOutput",
  ];
  const nodes = Object.fromEntries(ids.map((id) => [id, new FakeNode()]));
  const body = new FakeNode("body");
  const documentElement = new FakeNode("html");
  documentElement.lang = "en";
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const hadNavigator = Object.prototype.hasOwnProperty.call(globalThis, "navigator");
  const realNavigator = globalThis.navigator;
  const runFixture = {
    id: "run1",
    name: "test run",
    state: "running",
    language: "English",
    output_format: "events",
    elapsed_seconds: 321,
    max_seconds: 1800,
    usage: { input_tokens: 1000, output_tokens: 200 },
    context_tokens: 12000,
    context_limit: 300000,
    state_md:
      "Scores: production 40, logistics 35, mining 60\nCurrent: Mining iron\nDone when: 60 iron plates",
    latest: { current_research: "automation", research_progress: 0.4 },
    state_status: {
      age_seconds: 120,
      due: false,
      blocked: false,
      soft_seconds: 300,
      hard_seconds: 600,
      grace_seconds: 120,
    },
    automation: {
      score: 120,
      positive: 140,
      penalty: 20,
      state_penalty: 0,
      manual_mines: 6,
      manual_crafts: 7,
      breakdown: { production: 90, science: 10, power: 30, research: 5, rockets: 5 },
    },
  };
  const firstBatch = [
    { type: "thread.started", thread_id: "thread-1" },
    {
      type: "item.completed",
      item: {
        id: "r0",
        type: "reasoning",
        text: "The map has coal nearby and the belt is empty.",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "r1",
        type: "reasoning",
        text: "There is coal nearby. Next step: mine coal and build two furnaces for the iron plates.",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "c1",
        type: "command_execution",
        command: "python3 factorio.py act-mine --target 129,-26",
        status: "completed",
        exit_code: 0,
        duration_ms: 1420,
        aggregated_output:
          'job done\n{"schema_version":2,"ok":true,"data":{"results":[{"ok":true,"mined_count":2,"items":{"wood":2}}]}}',
      },
    },
    {
      type: "item.completed",
      item: {
        id: "c2",
        type: "command_execution",
        command: "python3 factorio.py act-mine --target 129,-26",
        status: "completed",
        exit_code: 0,
        aggregated_output: '{"ok":true,"data":{"results":[{"ok":true,"mined_count":1}]}}',
      },
    },
    {
      type: "item.completed",
      item: {
        id: "c3",
        type: "command_execution",
        command: "python3 factorio.py act-mine --target 129,-26",
        status: "completed",
        exit_code: 0,
        aggregated_output: '{"ok":true,"data":{"results":[{"ok":true,"mined_count":1}]}}',
      },
    },
    {
      type: "item.completed",
      item: {
        id: "r2",
        type: "reasoning",
        text: "There is coal nearby. Next step: mine coal and build two furnaces for the iron plates.",
      },
    },
    {
      type: "item.completed",
      item: { id: "marker1", type: "event_marker", text: "Plan needs updating: STATE.md unchanged for 320s" },
    },
    {
      type: "item.completed",
      item: { id: "m1", type: "agent_message", text: "Mining complete; building furnaces now." },
    },
  ];
  const secondBatch = [
    {
      type: "item.completed",
      item: { id: "m2", type: "agent_message", text: "Furnaces are running." },
    },
  ];
  const fetchCalls = [];
  globalThis.document = {
    getElementById: (id) => nodes[id] || null,
    createElement: (tag) => new FakeNode(tag),
    body,
    documentElement,
    title: "",
  };
  globalThis.location = { search: "?run=run1&overlay=1" };
  globalThis.history = { replaceState() {} };
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  if (hadNavigator) globalThis.navigator = { language: "en-US" };
  else
    Object.defineProperty(globalThis, "navigator", {
      value: { language: "en-US" },
      configurable: true,
    });
  globalThis.setTimeout = (callback) => {
    timers.push(callback);
    return timers.length;
  };
  let currentBatch = firstBatch;
  let offset = 0;
  globalThis.fetch = async (url) => {
    fetchCalls.push(url);
    if (url === "/api/runs") return { ok: true, json: async () => ({ runs: [{ id: "run1" }] }) };
    if (url === "/api/runs/run1") return { ok: true, json: async () => runFixture };
    if (url.includes("source=telemetry")) {
      const samples = [
        {
          observed_at: "2026-11-04T00:00:00.000Z",
          production_per_game_minute: { "iron-plate": 12, "copper-plate": 4 },
          current_research: "automation",
          research_progress: 0.42,
          power: {
            networks: 2,
            maximum_production: 900,
            maximum_consumption: 800,
            total_transfer: 784,
            satisfaction: 0.98,
          },
        },
      ];
      return {
        ok: true,
        json: async () => ({
          data: base64(samples.map((s) => JSON.stringify(s)).join("\n") + "\n"),
          offset: 1,
        }),
      };
    }
    if (url.startsWith("/api/runs/run1/log")) {
      const batch = currentBatch;
      const data = base64(jsonl(batch));
      offset += data.length;
      currentBatch = secondBatch;
      return { ok: true, json: async () => ({ data, offset }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const flush = async () => {
    for (let index = 0; index < 60; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    await import("../public/recording.js?smoke=1");
    await flush();
    const output = nodes.codexOutput;
    const classes = output.children.map((node) => node.className);
    assert.equal(body.classList.contains("overlay"), true);

    // Turn divider, then a collapsed reasoning block, a command group and a message.
    assert.ok(classes.includes("turn-separator"), `missing turn separator in ${classes.join(" | ")}`);
    const flatText = (node) =>
      [node?.textContent, ...(node?.children || []).map(flatText)].filter(Boolean).join(" ");
    const reasoning = output.children.find(
      (node) =>
        node.className.includes("reasoning") && flatText(node.children[0]).includes("Next step: mine coal"),
    );
    assert.ok(reasoning, "missing decision reasoning block");
    assert.match(flatText(reasoning.children[0]), /Next step: mine coal/);
    assert.equal(reasoning.open, false);
    const commands = output.children.find((node) => node.className.includes("commands"));
    assert.ok(commands, "missing command group");
    assert.match(flatText(commands.children[0]), /3 mine/);
    assert.match(flatText(commands.children[0]), /loop\? ×3/);
    assert.equal(commands.classList.contains("loop"), true);
    const message = output.children.find(
      (node) =>
        node.className.includes("message") &&
        !node.className.includes("reasoning") &&
        node.children[0]?.className === "message-body",
    );
    assert.match(message.children[0].textContent, /Mining complete/);

    // Deduped reasoning: the second identical thought did not add a second block.
    assert.equal(output.children.filter((node) => node.className.includes("reasoning")).length, 2);
    const dedupe = reasoning.children[0].children.find((node) => node.className.includes("dedupe-badge"));
    assert.match(dedupe.textContent, /repeated ×2/);

    // First batch is backfill: no misleading relative timestamps.
    assert.equal(
      output.children.some((node) => node.className.includes("msg-time")),
      false,
    );

    // Status metrics are a compact table: research, power, automation, penalty.
    const nodeText = (node) =>
      [node.textContent, ...(node.children || []).map(nodeText)].filter(Boolean).join(" ");
    const metricsTable = nodes.statusMetrics.children[0];
    assert.equal(metricsTable.tagName, "table");
    const metricRows = metricsTable.children[0].children;
    const metrics = metricRows.map(nodeText);
    assert.ok(
      metrics.some((text) => /research automation 42%/i.test(text)),
      `metrics: ${metrics.join(" | ")}`,
    );
    assert.ok(
      metrics.some((text) => /power 98%/i.test(text)),
      `metrics: ${metrics.join(" | ")}`,
    );
    const metricClass = (name) => {
      const walk = (node) => {
        if (String(node.className || "").includes(name)) return node;
        for (const child of node.children || []) {
          const hit = walk(child);
          if (hit) return hit;
        }
        return null;
      };
      return walk(metricsTable);
    };
    assert.ok(metricClass("metric-progress"), "missing research progress");
    assert.ok(
      output.children.some((node) => String(node.className).includes("event-marker")),
      "missing stale-state event marker",
    );
    assert.equal(nodes.stateTimer.hidden, false);
    assert.match(nodeText(nodes.stateTimer), /Plan 8:00/, `timer: ${nodeText(nodes.stateTimer)}`);
    assert.ok(
      metrics.some((text) => /Automation 120/i.test(text)),
      `metrics: ${metrics.join(" | ")}`,
    );
    assert.ok(
      metrics.some((text) => /Penalty -20/i.test(text)),
      `metrics: ${metrics.join(" | ")}`,
    );
    const findClass = (root, name) => {
      if (String(root.className || "").includes(name)) return root;
      for (const child of root.children || []) {
        const hit = findClass(child, name);
        if (hit) return hit;
      }
      return null;
    };
    const commandGroup = output.children.find((node) => node.className.includes("commands"));
    const durationNode = findClass(commandGroup, "action-duration");
    assert.ok(durationNode, "missing action duration");
    assert.equal(durationNode.textContent, "1.4s");

    // Filter chips hide non-matching transcript entries and persist the choice.
    nodes.filterThinking.fire("click");
    assert.equal(output.children.find((node) => node.className.includes("commands")).hidden, true);
    const thinkingNodes = output.children.filter((node) => node._kind === "reasoning");
    assert.ok(thinkingNodes.filter((node) => !node._decision).every((node) => !node.hidden));
    assert.ok(thinkingNodes.filter((node) => node._decision).every((node) => node.hidden));
    assert.ok(thinkingNodes.some((node) => !node._decision && !node.hidden));
    assert.equal(storage.get("autorio.filter"), "thinking");
    nodes.filterAll.fire("click");
    assert.equal(output.children.find((node) => node.className.includes("commands")).hidden, false);
    nodes.filterActions.fire("click");
    const commandsAfterFilter = output.children.find((node) => node.className.includes("commands"));
    assert.equal(commandsAfterFilter.hidden, false, "action filter must keep command groups visible");
    assert.equal(output.children.find((node) => node.className.includes("reasoning")).hidden, true);
    // Messages filter keeps agent messages only.
    nodes.filterMessages.fire("click");
    const messageNodes = output.children.filter((node) => node._kind === "message");
    assert.ok(messageNodes.length >= 1, "fixture should include agent messages");
    assert.ok(messageNodes.every((node) => node.hidden === false));
    assert.equal(output.children.find((node) => node.className.includes("commands")).hidden, true);
    assert.equal(output.children.find((node) => node.className.includes("reasoning")).hidden, true);
    // Decisions filter keeps only reasoning cards marked as decisions.
    nodes.filterDecisions.fire("click");
    const reasoningNodes = output.children.filter((node) => node._kind === "reasoning");
    assert.ok(reasoningNodes.some((node) => node._decision && !node.hidden));
    assert.ok(reasoningNodes.filter((node) => !node._decision).every((node) => node.hidden));
    // A filter with no matching entries shows an explicit empty-state note.
    nodes.filterErrors.fire("click");
    const emptyNote = output.children.find((node) => node.className.includes("filter-empty"));
    assert.ok(emptyNote, "missing filter empty-state note");
    assert.equal(emptyNote.hidden, false);
    assert.match(nodeText(emptyNote), /No entries/);
    nodes.filterAll.fire("click");
    assert.equal(emptyNote.hidden, true);
    assert.ok(
      emptyNote.children.some((node) => String(node.className).includes("filter-empty-reset")),
      "empty state should offer a reset action",
    );
    nodes.filterAll.fire("click");

    // The status toggle is a compact-header control (collapses all detail rows).
    // The fake page URL uses overlay=1, so the header starts collapsed.
    assert.equal(nodes.agentStatus.classList.contains("collapsed"), true);
    const toggleLabel = () =>
      nodes.statusToggle.children.find((node) => String(node.className).includes("status-toggle-label"))
        ?.textContent;
    assert.ok(nodes.statusToggle.children.some((node) => String(node.className).includes("icon-stats")));
    assert.equal(toggleLabel(), "Detailed stats");
    nodes.statusToggle.fire("click");
    assert.equal(nodes.agentStatus.classList.contains("collapsed"), false);
    assert.equal(toggleLabel(), "Detailed stats");
    nodes.statusToggle.fire("click");
    assert.equal(nodes.agentStatus.classList.contains("collapsed"), true);
    assert.equal(toggleLabel(), "Detailed stats");

    // User scrolled up; the next live batch shows the unread pill and clicking jumps down.
    output.scrollHeight = 1000;
    output.clientHeight = 300;
    output.scrollTop = 0;
    timers.shift()();
    await flush();
    const jump = body.children.find((node) => node.className.includes("jump-latest"));
    assert.ok(jump, "missing jump-to-latest button");
    assert.equal(jump.hidden, false);
    assert.match(jump.textContent, /1/);
    jump.fire("click");
    assert.equal(output.scrollTop, output.scrollHeight);
    assert.equal(jump.hidden, true);
    assert.match(
      output.children.find(
        (node) =>
          node.children[0]?.className === "message-body" && node.children[0].textContent.includes("Furnaces"),
      ).children[0].textContent,
      /Furnaces are running/,
    );
    assert.ok(fetchCalls.filter((url) => url.includes("/log?")).length >= 2);
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

test("recording page exposes map and blueprint previews", () => {
  const html = fs.readFileSync("public/recording.html", "utf8");
  const js = fs.readFileSync("public/recording.js", "utf8");
  assert.match(html, /id="recordingSeedPreview"/);
  assert.match(html, /id="recordingPreviewOverlay"/);
  assert.match(html, /id="recordingPreviewBody"/);
  assert.match(html, /id="recordingSeedInline"/);
  assert.match(js, /openRecordingPreview/);
  assert.match(js, /map-preview/);
  assert.match(js, /blueprint-viewer\/viewer\.html/);
  assert.match(js, /toolkit-viewer\/index\.html/);
  assert.match(js, /loadRecordingSeedInline/);
  assert.match(html, /id="statusProduction"/);
  assert.match(html, /id="statusProductionList"/);
  assert.match(js, /function renderProduction/);
  assert.match(js, /productionItemOrder/);
  assert.match(js, /latestProductionRates/);
  assert.match(js, /reasoningLabel/);
  assert.match(js, /markerResearched/);
  assert.match(html, /id="blueprintToast"/);
  assert.match(html, /id="blueprintToastImage"/);
  assert.match(js, /showBlueprintToast/);
  assert.match(js, /\/preview\.png/);
  assert.match(js, /研究完成/);
  assert.match(js, /api\/factorio-locale/);
  assert.match(js, /gameName\("technology"/);
  assert.match(js, /gameName\("item"/);
});
