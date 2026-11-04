import assert from "node:assert/strict";
import test from "node:test";

const { createOpenCodeState, translateOpenCodeEvent } = await import("../dist/agents/opencode-events.js");
const { createCodexState, isCodexNativeErrorLine, sessionIdFromCodexOutput, translateCodexEvent } =
  await import("../dist/agents/codex-events.js");

// These helpers mirror the JSONL loops in src/runs.ts: lines are decoded as
// UTF-8 JSON, and a malformed line is skipped without producing ops (the raw
// bytes stay on disk for diagnostics). Fixtures are captured OpenCode/Codex
// event shapes, not synthetic minimal objects.
const translateLines = (lines, translate, state) => {
  const ops = [];
  for (const line of lines) {
    try {
      ops.push(...translate(JSON.parse(line), state));
    } catch {
      /* raw bytes remain available */
    }
  }
  return ops;
};
const openCodeOps = (lines, state = createOpenCodeState()) =>
  translateLines(lines, translateOpenCodeEvent, state);
const codexOps = (lines, state = createCodexState()) => translateLines(lines, translateCodexEvent, state);
const kinds = (ops) => ops.map((op) => op.kind);
const json = (event) => JSON.stringify(event);

// Captured OpenCode `opencode run --format json` stream: one session, a step
// without parts, text output, reasoning with a part id, and step token usage.
const openCodeSession = "ses_01J8ZQ4K9X7M2N5P3R6T8V0W1Y";
const openCodeStep = (tokens, id = "prt_f00") =>
  json({
    type: "step_finish",
    timestamp: 1751680000000,
    sessionID: openCodeSession,
    part: { id, type: "step-finish", reason: "stop", tokens },
  });

test("OpenCode text and session events translate into transcript ops", () => {
  const lines = [
    json({
      type: "step_start",
      timestamp: 1751680000000,
      sessionID: openCodeSession,
      part: { id: "prt_00", type: "step-start" },
    }),
    json({
      type: "text",
      timestamp: 1751680000100,
      sessionID: openCodeSession,
      part: { id: "prt_01", type: "text", text: "I will observe the player first." },
    }),
    json({
      type: "text",
      timestamp: 1751680000200,
      sessionID: openCodeSession,
      part: { type: "text", text: "Then automate mining." },
    }),
    json({
      type: "step_start",
      timestamp: 1751680000300,
      sessionID: openCodeSession,
      part: { id: "prt_02", type: "step-start" },
    }),
  ];
  const ops = openCodeOps(lines);
  assert.deepEqual(kinds(ops), ["thread", "message", "message"]);
  assert.deepEqual(ops[0], { kind: "thread", sessionId: openCodeSession });
  assert.deepEqual(ops[1], {
    kind: "message",
    id: "prt_01",
    text: "I will observe the player first.",
  });
  // Missing part ids fall back to the historical `opencode-text-<n>` scheme.
  assert.deepEqual(ops[2], { kind: "message", id: "opencode-text-1", text: "Then automate mining." });
});

test("OpenCode reasoning dedupes thought narration by part id and messageID prefix", () => {
  const repeated = {
    type: "reasoning",
    timestamp: 1751680001000,
    sessionID: "ses_reasoning",
    part: { id: "prt_10", type: "reasoning", text: "Observe, then automate." },
  };
  const byPartId = openCodeOps([json(repeated), json(repeated)]);
  assert.deepEqual(kinds(byPartId), ["thread", "reasoning", "reasoning"]);
  assert.deepEqual(byPartId[1], {
    kind: "reasoning",
    id: "prt_10",
    text: "Observe, then automate.",
    thought: true,
  });
  // The transcript line is emitted again, but the thought stream is not.
  assert.equal(byPartId[2].thought, false);
  assert.equal(byPartId[2].id, "prt_10");

  const chunk = (messageID, text) =>
    json({
      type: "reasoning",
      timestamp: 1751680001100,
      sessionID: "ses_reasoning",
      part: { type: "reasoning", messageID, text },
    });
  const byMessage = openCodeOps([chunk("msg_1", "Plan the bus."), chunk("msg_1", "Plan the bus.")]);
  assert.deepEqual(kinds(byMessage), ["thread", "reasoning", "reasoning"]);
  assert.deepEqual(byMessage[1], {
    kind: "reasoning",
    id: "opencode-reasoning-1",
    text: "Plan the bus.",
    thought: true,
  });
  assert.equal(byMessage[2].thought, false);
  assert.equal(byMessage[2].id, "opencode-reasoning-2");
  // A different message id is a new thought even with identical text.
  const other = openCodeOps([chunk("msg_2", "Plan the bus.")]);
  assert.equal(other[1].thought, true);
  assert.equal(other[1].id, "opencode-reasoning-1");
});

test("OpenCode tool_use emits command ops for completed, failed and running tools", () => {
  const lines = [
    json({
      type: "tool_use",
      timestamp: 1751680002000,
      sessionID: "ses_tools",
      part: {
        id: "prt_20",
        type: "tool",
        tool: "bash",
        callID: "call_1",
        state: {
          status: "completed",
          input: { command: "python3 play.py observe-player" },
          output: '{"ok":true}',
          metadata: { metadata: { exit: 0 } },
          time: { start: 1, end: 2 },
        },
      },
    }),
    json({
      type: "tool_use",
      timestamp: 1751680002100,
      sessionID: "ses_tools",
      part: {
        id: "prt_21",
        type: "tool",
        tool: "read",
        callID: "call_2",
        state: {
          status: "error",
          input: { filePath: "/workspace/STATE.md" },
          output: "ENOENT: no such file",
          metadata: { exit: 2 },
        },
      },
    }),
    json({
      type: "tool_use",
      timestamp: 1751680002200,
      sessionID: "ses_tools",
      part: {
        id: "prt_22",
        type: "tool",
        tool: "grep",
        callID: "call_3",
        state: { status: "running", input: { pattern: "*.py" } },
      },
    }),
  ];
  const ops = openCodeOps(lines);
  assert.deepEqual(kinds(ops), ["thread", "command", "command", "command"]);
  assert.deepEqual(ops[1], {
    kind: "command",
    id: "prt_20",
    command: "python3 play.py observe-player",
    output: '{"ok":true}',
    phase: "completed",
    status: "completed",
    reportedStatus: "completed",
    exitCode: 0,
  });
  // A failed tool still uses item.started, exactly like the old inline handler.
  assert.deepEqual(ops[2], {
    kind: "command",
    id: "prt_21",
    command: "read /workspace/STATE.md",
    output: "ENOENT: no such file",
    phase: "started",
    status: "failed",
    reportedStatus: "error",
    exitCode: 2,
  });
  assert.deepEqual(ops[3], {
    kind: "command",
    id: "prt_22",
    command: "grep *.py",
    output: "",
    phase: "started",
    status: "in_progress",
    reportedStatus: "running",
    exitCode: null,
  });

  // A tool_use without a part keeps the historical default command/status.
  const [fallback] = translateOpenCodeEvent({ type: "tool_use" }, createOpenCodeState());
  assert.deepEqual(fallback, {
    kind: "command",
    id: "opencode-tool-1",
    command: "tool",
    output: "",
    phase: "started",
    status: "in_progress",
    reportedStatus: "running",
    exitCode: null,
  });
});

test("OpenCode step_finish accumulates usage across steps and keeps cache reads cumulative", () => {
  const state = createOpenCodeState();
  const ops = openCodeOps(
    [
      openCodeStep({ input: 100, output: 20, reasoning: 5, cache: { write: 0, read: 40 } }),
      openCodeStep({ input: 50, output: 10, reasoning: 2, cache: { write: 0, read: 70 } }),
    ],
    state,
  );
  assert.deepEqual(ops, [
    { kind: "thread", sessionId: openCodeSession },
    {
      kind: "usage",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        reasoning_output_tokens: 5,
        cached_input_tokens: 40,
        total_tokens: 120,
      },
      contextTokens: 140,
    },
    {
      kind: "usage",
      usage: {
        input_tokens: 150,
        output_tokens: 30,
        reasoning_output_tokens: 7,
        cached_input_tokens: 70,
        total_tokens: 180,
      },
      // Context is the latest prompt size (input + cache read), not the sum.
      contextTokens: 120,
    },
  ]);
});

test("OpenCode step_finish seeds accumulation from a resumed run's usage", () => {
  const state = createOpenCodeState({ input_tokens: 10, output_tokens: 3, total_tokens: 13 });
  const [thread, op] = openCodeOps([openCodeStep({ input: 5, output: 2, cache: { read: 8 } })], state);
  assert.equal(thread.kind, "thread");
  assert.deepEqual(op.usage, {
    input_tokens: 15,
    output_tokens: 5,
    total_tokens: 20,
    cached_input_tokens: 8,
    reasoning_output_tokens: 0,
  });
  assert.equal(op.contextTokens, 13);
});

test("OpenCode error events preserve messages and pass quota failures through", () => {
  const lines = [
    json({
      type: "error",
      timestamp: 1751680003000,
      sessionID: "ses_errors",
      error: { name: "APIError", data: { message: "Provider returned status 429", statusCode: 429 } },
    }),
    json({
      type: "error",
      timestamp: 1751680003100,
      sessionID: "ses_errors",
      error: {
        name: "APIError",
        message: "You've hit your usage limit. Try again after your quota resets.",
      },
    }),
    json({ type: "error", timestamp: 1751680003200, sessionID: "ses_errors", message: "socket hang up" }),
    json({ type: "error", timestamp: 1751680003300, sessionID: "ses_errors" }),
  ];
  const ops = openCodeOps(lines);
  assert.deepEqual(kinds(ops), ["thread", "error", "error", "error", "error"]);
  assert.deepEqual(ops[1], { kind: "error", message: "Provider returned status 429" });
  assert.equal(ops[1].quota, undefined);
  assert.equal(ops[2].message, "You've hit your usage limit. Try again after your quota resets.");
  assert.match(ops[2].quota, /usage limit/);
  assert.deepEqual(ops[3], { kind: "error", message: "socket hang up" });
  assert.deepEqual(ops[4], { kind: "error", message: "OpenCode error" });
});

test("OpenCode malformed and unknown events produce no ops without breaking the stream", () => {
  const state = createOpenCodeState();
  const malformed = [
    null,
    "plain text",
    42,
    [],
    {},
    { type: "unknown.event" },
    { type: "text" },
    { type: "text", part: {} },
    { type: "text", part: { text: "" } },
    { type: "reasoning", part: {} },
    { type: "step_finish" },
    { type: "step_finish", part: { tokens: null } },
    { type: "step_finish", part: { tokens: "not tokens" } },
  ];
  assert.deepEqual(
    malformed.flatMap((event) => translateOpenCodeEvent(event, state)),
    [],
  );
  // Malformed JSON lines are skipped by the runs.ts loop; later lines still work.
  const ops = openCodeOps([
    '{"type":"text","sessionID":"ses_broken","part":{',
    "not json at all",
    json({ type: "error", error: { message: "recovered" } }),
  ]);
  assert.deepEqual(kinds(ops), ["error"]);
  assert.equal(ops[0].message, "recovered");
  // An unknown event type still relays a new session id (old behavior).
  assert.deepEqual(translateOpenCodeEvent({ type: "unknown", sessionID: "ses_x" }, createOpenCodeState()), [
    { kind: "thread", sessionId: "ses_x" },
  ]);
});

// Reference applier for the OpenCode transcript contract: this is exactly what
// runs.ts writes to agent.events.jsonl from each op, in order.
const openCodeTranscript = (ops) =>
  ops.flatMap((op) => {
    switch (op.kind) {
      case "thread":
        return [{ type: "thread.started", thread_id: op.sessionId }];
      case "message":
        return [{ type: "item.completed", item: { id: op.id, type: "agent_message", text: op.text } }];
      case "reasoning":
        return [{ type: "item.completed", item: { id: op.id, type: "reasoning", text: op.text } }];
      case "command":
        return [
          {
            type: op.phase === "completed" ? "item.completed" : "item.started",
            item: {
              id: op.id,
              type: "command_execution",
              command: op.command,
              status: op.status,
              exit_code: op.exitCode,
              aggregated_output: op.output,
            },
          },
        ];
      case "usage":
        return [];
      case "error":
        return [{ type: "error", message: op.message }];
    }
  });

test("OpenCode ops reproduce the historical transcript event shapes", () => {
  const lines = [
    json({ type: "text", sessionID: "ses_transcript", part: { id: "prt_t1", text: "Hello." } }),
    json({
      type: "tool_use",
      sessionID: "ses_transcript",
      part: { id: "prt_t2", tool: "bash", state: { status: "completed", input: { command: "ls" } } },
    }),
    json({ type: "error", sessionID: "ses_transcript", error: { message: "boom" } }),
  ];
  assert.deepEqual(openCodeTranscript(openCodeOps(lines)), [
    { type: "thread.started", thread_id: "ses_transcript" },
    { type: "item.completed", item: { id: "prt_t1", type: "agent_message", text: "Hello." } },
    {
      type: "item.completed",
      item: {
        id: "prt_t2",
        type: "command_execution",
        command: "ls",
        status: "completed",
        exit_code: null,
        aggregated_output: "",
      },
    },
    { type: "error", message: "boom" },
  ]);
});

// Captured Codex `codex exec --json` stream: thread banner, reasoning and
// message items, a command item and turn usage.
const codexThread = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const codexTurn = (usage) => json({ type: "turn.completed", usage });

test("Codex thread, items and turn usage translate into state ops", () => {
  const lines = [
    json({ type: "thread.started", thread_id: codexThread }),
    json({ type: "turn.started" }),
    json({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "Observe first." } }),
    json({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "I claim success" },
    }),
    json({
      type: "item.completed",
      item: {
        id: "item_2",
        type: "command_execution",
        command: "python3 play.py observe-player",
        aggregated_output: '{"ok":true}',
        exit_code: 0,
        status: "completed",
      },
    }),
    codexTurn({
      input_tokens: 20,
      cached_input_tokens: 10,
      output_tokens: 5,
      reasoning_output_tokens: 2,
      total_tokens: 25,
    }),
    json({ type: "item.completed", item: { id: "item_3", type: "file_change", changes: [] } }),
  ];
  const ops = codexOps(lines);
  assert.deepEqual(ops, [
    { kind: "thread", sessionId: codexThread },
    { kind: "reasoning", text: "Observe first." },
    { kind: "message", text: "I claim success" },
    {
      kind: "command",
      command: "python3 play.py observe-player",
      status: "completed",
      output: '{"ok":true}',
    },
    {
      kind: "usage",
      usage: {
        input_tokens: 20,
        cached_input_tokens: 10,
        output_tokens: 5,
        reasoning_output_tokens: 2,
        total_tokens: 25,
      },
      contextTokens: 20,
    },
  ]);
});

test("Codex turn usage merges onto the launch snapshot instead of summing turns", () => {
  // Fresh run: each turn.completed is the per-turn report, so the last one wins
  // (matching the historical assignment of run.usage = turn usage).
  const ops = codexOps([
    codexTurn({ input_tokens: 20, output_tokens: 5 }),
    codexTurn({ input_tokens: 30, output_tokens: 7 }),
  ]);
  assert.deepEqual(ops[0].usage, { input_tokens: 20, output_tokens: 5 });
  assert.deepEqual(ops[1].usage, { input_tokens: 30, output_tokens: 7 });
  assert.equal(ops[1].contextTokens, 30);

  // Resumed run: same base merge the quota-resume path relies on (25 + 10 = 35).
  const resumed = createCodexState({ input_tokens: 25, output_tokens: 3, total_tokens: 28 });
  const [resumedTurn] = codexOps([codexTurn({ input_tokens: 10, output_tokens: 2 })], resumed);
  assert.deepEqual(resumedTurn.usage, { input_tokens: 35, output_tokens: 5 });
  assert.equal(resumedTurn.contextTokens, 35);

  // No input_tokens means "keep the previous context size" in runs.ts.
  const [noInput] = codexOps([codexTurn({ output_tokens: 5 })]);
  assert.equal(noInput.contextTokens, undefined);
});

test("Codex turn failures pass quota errors through and unknown events yield no ops", () => {
  const [explicit] = codexOps([
    json({
      type: "turn.failed",
      error: {
        message: "You've hit your usage limit. Try again after your quota resets.",
        code: "usage_limit_exceeded",
      },
    }),
  ]);
  assert.equal(explicit.kind, "error");
  assert.match(explicit.message, /usage limit/);
  assert.match(explicit.quota, /usage limit/);
  assert.match(explicit.quota, /quota resets/);

  // Code-only quota failures still classify through quotaError's code list.
  const [coded] = codexOps([
    json({ type: "turn.failed", error: { message: "", code: "usage_limit_exceeded" } }),
  ]);
  assert.equal(coded.message, "Codex error");
  assert.equal(coded.quota, "Codex account usage quota exhausted");

  const [plain] = codexOps([json({ type: "error", message: "transient network error" })]);
  assert.deepEqual(plain, { kind: "error", message: "transient network error" });
  assert.equal(plain.quota, undefined);

  const state = createCodexState();
  const malformed = [
    null,
    "plain text",
    7,
    [],
    {},
    { type: "turn.started" },
    { type: "item.completed" },
    { type: "item.completed", item: { type: "file_change" } },
    { type: "turn.completed" },
    { type: "turn.completed", usage: "not usage" },
    { type: "thread.started" },
  ];
  assert.deepEqual(
    malformed.flatMap((event) => translateCodexEvent(event, state)),
    [],
  );
  // Missing text is normalized to "" (the old inline handler emitted an empty
  // activity line), and malformed JSON lines never break the loop.
  const [empty] = codexOps([json({ type: "item.completed", item: { id: "x", type: "agent_message" } })]);
  assert.deepEqual(empty, { kind: "message", text: "" });
  assert.deepEqual(codexOps(['{"type":"thread.started",', "not json"]), []);
});

test("Codex native output classifiers keep terminal pass-through behavior", () => {
  assert.equal(
    sessionIdFromCodexOutput(`\x1b[32mOpenAI Codex v0.60.0\x1b[0m\nsession id: ${codexThread}\n`),
    codexThread,
  );
  assert.equal(sessionIdFromCodexOutput("no session banner"), undefined);
  assert.equal(sessionIdFromCodexOutput(`Session ID: ${codexThread}`), codexThread);

  assert.equal(isCodexNativeErrorLine("ERROR: stream disconnected before completion"), true);
  assert.equal(isCodexNativeErrorLine("\x1b[31mERROR: quota exceeded\x1b[0m"), true);
  assert.equal(isCodexNativeErrorLine("You've hit your usage limit."), true);
  assert.equal(isCodexNativeErrorLine("You’ve hit your usage limit."), true);
  assert.equal(isCodexNativeErrorLine("ordinary command output"), false);
  assert.equal(isCodexNativeErrorLine("INFO: ERROR: not at line start"), false);
  assert.equal(isCodexNativeErrorLine("usage limit exceeded"), false);
});
