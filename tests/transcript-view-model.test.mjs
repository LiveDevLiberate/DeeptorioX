import test from "node:test";
import assert from "node:assert/strict";
import {
  splitReasoning,
  summarizeCommand,
  summarizeCommandGroup,
  summarizeTool,
  classifyActivity,
  formatRelativeMs,
  normalizeReasoning,
  reasoningKey,
  collapseRepeatedSentences,
  extractFactorioAction,
  extractTarget,
  parseEnvelope,
  LoopDetector,
} from "../public/transcript-view-model.js";

test("splitReasoning yields summary + body segments and merges tiny paragraphs", () => {
  const segments = splitReasoning(
    "First tiny line.\n\nSecond tiny line.\n\nThe third paragraph is long enough to stand on its own as a separate segment for display.",
  );
  assert.equal(segments.length >= 1, true);
  assert.match(segments.at(-1).summary, /third paragraph/i);
  assert.match(segments.at(-1).body, /separate segment/);
  assert.deepEqual(splitReasoning(""), []);
  assert.deepEqual(splitReasoning(null), []);
});

test("splitReasoning prefers a keyword-bearing sentence for the summary", () => {
  const segments = splitReasoning(
    "The current situation looks acceptable and there is plenty of coal nearby.\nNext step: build two assemblers for gears and feed the science lab.",
  );
  assert.match(segments[0].summary, /Next step: build two assemblers/i);
});

test("normalizeReasoning/reasoningKey strips code and formatting differences", () => {
  assert.equal(normalizeReasoning("Use `python3` here.\n\n\n  ```py\nx=1\n```  End."), "Use here. End.");
  assert.equal(reasoningKey("Use `python3` here."), reasoningKey("use here."));
});

test("collapseRepeatedSentences annotates consecutive repeats", () => {
  assert.equal(
    collapseRepeatedSentences("Mine coal.\nMine coal.\nBuild belts."),
    "Mine coal. (×2)\nBuild belts.",
  );
});

test("formatRelativeMs renders +m:ss", () => {
  assert.equal(formatRelativeMs(0), "+0:00");
  assert.equal(formatRelativeMs(12_400), "+0:12");
  assert.equal(formatRelativeMs(65_000), "+1:05");
  assert.equal(formatRelativeMs(-50), "+0:00");
});

test("formatDurationText and summarizeCommand durations", async () => {
  const model = await import("../public/transcript-view-model.js");
  assert.equal(model.formatDurationText(450), "450ms");
  assert.equal(model.formatDurationText(1420), "1.4s");
  assert.equal(model.formatDurationText(65_000), "1m 05s");
  assert.equal(model.formatDurationText(undefined), "");
  const summary = summarizeCommand({
    type: "command_execution",
    command: "python3 factorio.py act-mine --target 1,2",
    status: "completed",
    duration_ms: 1420,
    aggregated_output: '{"ok":true,"data":{"results":[{"ok":true}]}}',
  });
  assert.equal(summary.durationMs, 1420);
  assert.equal(model.formatDurationText(summary.durationMs), "1.4s");
});

test("classifyActivity maps transcript item types to status activity", () => {
  assert.equal(classifyActivity({ type: "reasoning" }), "thinking");
  assert.equal(classifyActivity({ type: "agent_message" }), "reporting");
  assert.equal(classifyActivity({ type: "error" }), "error");
  assert.equal(classifyActivity({ type: "command_execution", status: "in_progress" }), "acting");
  assert.equal(classifyActivity({ type: "command_execution", status: "completed" }), "thinking");
  assert.equal(classifyActivity({ type: "mcp_tool_call" }), "output");
});

test("extractFactorioAction and extractTarget parse CLI commands", () => {
  assert.equal(extractFactorioAction("python3 factorio.py act-mine --target 129,-26"), "act-mine");
  assert.equal(
    extractFactorioAction("C:\\...\\play.cmd factorio.py observe-production"),
    "observe-production",
  );
  assert.equal(
    extractFactorioAction("python3 factorio.py --base http://x:3000 act-build --entity a,1,2"),
    "act-build",
  );
  assert.equal(extractFactorioAction("python3 plan.py"), null);
  assert.equal(extractTarget("python3 factorio.py act-mine --target 129,-26"), "(129,-26)");
  assert.equal(extractTarget("factorio.py build-pipe-line --from 0,0 --to 10,4"), "(0,0)→(10,4)");
  assert.equal(extractTarget("factorio.py observe-area --center-x 4 --center-y -2"), "(4,-2)");
  assert.equal(extractTarget("factorio.py act-build --entity stone-furnace,10,20,0"), "(10,20)");
  assert.equal(extractTarget("factorio.py observe-world --window-x 8 --window-y -9 --radius 4"), "(8,-9)");
  assert.equal(extractTarget("factorio.py act-craft --item x --count 2"), null);
});

test("parseEnvelope finds the last JSON object in output", () => {
  const output =
    'some CLI preamble\nwarning: thing\n{"schema_version":2,"ok":true,"data":{"status":"done"}}\n';
  assert.deepEqual(parseEnvelope(output).envelope, { schema_version: 2, ok: true, data: { status: "done" } });
  assert.equal(parseEnvelope("plain text\nno json").envelope, null);
});

test("summarizeCommand reads mine results and items from the JSON envelope", () => {
  const item = {
    id: "c1",
    type: "command_execution",
    command: "python3 factorio.py act-mine --target 129,-26",
    status: "completed",
    exit_code: 0,
    aggregated_output: [
      "job 12345678 completed",
      JSON.stringify({
        schema_version: 2,
        ok: true,
        data: {
          status: "completed",
          results: [
            { ok: true, mined_count: 2, items: { wood: 2 } },
            { ok: true, mined_count: 1, items: { wood: 1 } },
          ],
        },
      }),
    ].join("\n"),
  };
  const summary = summarizeCommand(item);
  assert.equal(summary.category, "mine");
  assert.equal(summary.target, "(129,-26)");
  assert.match(summary.outcome, /2\/2 ok/);
  assert.match(summary.outcome, /mined 3/);
  assert.match(summary.outcome, /\+3 wood/);
  assert.equal(summary.failed, false);
});

test("summarizeCommand flags failed entity results and errors", () => {
  const item = {
    id: "c2",
    type: "command_execution",
    command: "python3 factorio.py act-build --entity stone-furnace,10,20,0",
    status: "completed",
    exit_code: 0,
    aggregated_output: JSON.stringify({
      ok: true,
      data: { results: [{ ok: true }, { ok: false, error: "cannot_build" }] },
    }),
  };
  const summary = summarizeCommand(item);
  assert.equal(summary.category, "build");
  assert.equal(summary.failed, true);
  assert.match(summary.outcome, /1\/2 ok/);
  assert.match(summary.outcome, /1 failed/);
});

test("summarizeCommand reports observe production rates and idle", () => {
  const production = summarizeCommand({
    type: "command_execution",
    command: "python3 factorio.py observe-production",
    status: "completed",
    exit_code: 0,
    aggregated_output: JSON.stringify({
      ok: true,
      data: { production_per_minute: { "iron-plate": 12.4, "iron-gear-wheel": 6, wood: 0 } },
    }),
  });
  assert.equal(production.category, "observe");
  assert.match(production.outcome, /iron-plate 12\/min/);
  assert.match(production.outcome, /iron-gear-wheel 6\/min/);
  const idle = summarizeCommand({
    type: "command_execution",
    command: "python3 factorio.py observe-production",
    status: "completed",
    exit_code: 0,
    aggregated_output: JSON.stringify({ ok: true, data: { production_per_minute: {} } }),
  });
  assert.equal(idle.outcome, "idle");
});

test("summarizeCommand falls back to raw output for scripts and failures", () => {
  const script = summarizeCommand({
    type: "command_execution",
    command: "python3 plan.py",
    status: "completed",
    exit_code: 0,
    aggregated_output: "wrote 4 entities to /tmp/plan.json\nmore output",
  });
  assert.equal(script.category, "other");
  assert.equal(script.label, "cmd");
  assert.match(script.outcome, /wrote 4 entities/);
  const failed = summarizeCommand({
    type: "command_execution",
    command: "python3 factorio.py observe-world",
    status: "failed",
    exit_code: 1,
    aggregated_output: "Traceback: RuntimeError: RCON not connected",
  });
  assert.equal(failed.failed, true);
  assert.match(failed.outcome, /RCON not connected/);
});

test("summarizeCommandGroup groups categories and failures", () => {
  const items = [
    {
      type: "command_execution",
      command: "python3 factorio.py act-mine --target 1,2",
      status: "completed",
      aggregated_output: '{"ok":true,"data":{"results":[{"ok":true}]}}',
    },
    {
      type: "command_execution",
      command: "python3 factorio.py act-mine --target 3,4",
      status: "completed",
      aggregated_output: '{"ok":true,"data":{"results":[{"ok":true}]}}',
    },
    {
      type: "command_execution",
      command: "python3 factorio.py act-build --entity a,1,2",
      status: "completed",
      aggregated_output: '{"ok":true,"data":{"results":[{"ok":false}]}}',
    },
    { type: "command_execution", command: "python3 plan.py", status: "in_progress", aggregated_output: "" },
  ];
  const group = summarizeCommandGroup(items);
  assert.match(group.text, /1 build/);
  assert.match(group.text, /2 mine/);
  assert.match(group.text, /1 cmd/);
  assert.match(group.text, /1 failed/);
  assert.match(group.text, /1 running/);
  assert.equal(group.failed, 1);
  assert.equal(group.running, 1);
  assert.equal(summarizeCommandGroup([]).text, "Ran 0 commands");
});

test("summarizeTool collapses JSON tools into a label + detail", () => {
  assert.deepEqual(summarizeTool({ type: "file_change", path: "/tmp/plan.py", status: "completed" }), {
    label: "file change",
    detail: "/tmp/plan.py",
  });
  assert.equal(summarizeTool({ type: "mcp_tool_call", arguments: { x: 1 } }).detail, '{"x":1}');
});

test("LoopDetector flags repeated signatures inside the sliding window", () => {
  const detector = new LoopDetector({ threshold: 3, window: 4 });
  assert.equal(detector.push("mine:(1,2)").repeated, false);
  assert.equal(detector.push("mine:(1,2)").repeated, false);
  assert.equal(detector.push("mine:(1,2)").repeated, true);
  assert.equal(detector.push("build:(3,4)").repeated, false);
  // Window slides: the old repeats expire, so the next one is not flagged yet.
  assert.equal(detector.push("done:(5,6)").repeated, false);
  assert.equal(detector.push("done:(5,6)").repeated, false);
  detector.reset();
  assert.equal(detector.push("mine:(1,2)").repeated, false);
});

test("observe summaries cover area, fluids, combat, player and factory", () => {
  const area = summarizeCommand({
    type: "command_execution",
    command: "python3 factorio.py observe-area --center-x 4 --center-y -2 --radius 8",
    status: "completed",
    aggregated_output: JSON.stringify({
      ok: true,
      data: { counts: { total: 240, matched: 239, included: 12 } },
    }),
  });
  assert.equal(area.outcome, "12/239 entities");
  const fluids = summarizeCommand({
    type: "command_execution",
    command: "python3 factorio.py observe-fluids --radius 32",
    status: "completed",
    aggregated_output: JSON.stringify({
      ok: true,
      data: { counts: { pipe: 85 }, fluids: { petroleum: { amount: 500 }, water: { amount: 120 } } },
    }),
  });
  assert.equal(fluids.outcome, "petroleum 500");
  const combat = summarizeCommand({
    type: "command_execution",
    command: "python3 factorio.py observe-combat --radius 64",
    status: "completed",
    aggregated_output: JSON.stringify({ ok: true, data: { counts: { enemy_total: 0, turrets: 2 } } }),
  });
  assert.equal(combat.outcome, "0 enemies · 2 turrets");
  const player = summarizeCommand({
    type: "command_execution",
    command: "python3 factorio.py observe-player",
    status: "completed",
    aggregated_output: JSON.stringify({ ok: true, data: { player: { health: 250 } } }),
  });
  assert.equal(player.outcome, "health 250");
  const factory = summarizeCommand({
    type: "command_execution",
    command: "python3 factorio.py observe-factory --radius 24",
    status: "completed",
    aggregated_output: JSON.stringify({
      ok: true,
      data: { problems: { no_fuel: [{}, {}, {}], no_power: [{}], no_ingredients: [] } },
    }),
  });
  assert.equal(factory.outcome, "3 no_fuel · 1 no_power");
});

test("copy-settings results use the settings summary path", () => {
  const summary = summarizeCommand({
    type: "command_execution",
    command: "python3 factorio.py act-copy-settings --targets-json '[]'",
    status: "completed",
    aggregated_output: JSON.stringify({ ok: true, data: { results: [{ ok: true }, { ok: false }] } }),
  });
  assert.equal(summary.category, "settings");
  assert.equal(summary.failed, true);
  assert.match(summary.outcome, /1\/2 ok/);
});

test("decision detection, mini bars and telemetry helpers", async () => {
  const model = await import("../public/transcript-view-model.js");
  assert.equal(model.isDecisionText("Next step: mine coal"), true);
  assert.equal(model.isDecisionText("The map looks calm."), false);
  assert.equal(model.isDecisionText("I need to build two furnaces."), true);
  assert.equal(model.isDecisionText("Let's check the ore patch first."), true);
  assert.equal(model.isDecisionText("The belt moved then the items got stuck."), false);
  assert.equal(model.isDecisionText("Items should move east once the belt is full."), false);
  assert.equal(model.isDecisionText("下一步建造熔炉。"), true);
  assert.deepEqual(model.miniBars([0, 5, 10]), [0, 50, 100]);
  assert.deepEqual(model.miniBars([]), []);
  const lines = [
    JSON.stringify({ production_per_game_minute: { "iron-plate": 12, wood: 0 } }),
    "not json",
    JSON.stringify({ current_research: "automation", research_progress: 0.42 }),
  ].join("\n");
  const samples = model.parseTelemetryLines(lines);
  assert.equal(samples.length, 2);
  assert.deepEqual(model.telemetryRates(samples), [{ name: "iron-plate", rate: 12 }]);
  assert.deepEqual(model.telemetrySeries(samples, "iron-plate", 4), [12]);
  assert.equal(model.telemetryResearch(samples), "automation 42%");
  assert.equal(model.telemetryPower(samples), null);
  const withPower = model.parseTelemetryLines(
    JSON.stringify({ power: { networks: 2, satisfaction: 0.98 }, current_research: "automation" }),
  );
  assert.equal(model.telemetryPower(withPower), "power 98%");
});

test("telemetryMarkers reports research, production starts and rockets", async () => {
  const model = await import("../public/transcript-view-model.js");
  const previous = {
    research: { automation: true },
    production: { "iron-plate": 10 },
    rockets: 0,
  };
  const next = {
    research: { automation: true, electronics: true },
    production: { "iron-plate": 20, "copper-plate": 3 },
    production_per_game_minute: { "iron-plate": 12, "copper-plate": 3, "automation-science-pack": 1 },
    rockets: 1,
  };
  assert.deepEqual(model.telemetryMarkers(previous, next), [
    "researched electronics",
    "copper-plate 3/min",
    "automation-science-pack 1/min",
    "rocket launched (1)",
  ]);
  assert.deepEqual(model.telemetryMarkers(null, next), []);
  assert.deepEqual(model.telemetryMarkers(previous, previous), []);
});
