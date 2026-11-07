import test from "node:test";
import assert from "node:assert/strict";
import { CodexOutput } from "../public/codex-output.js";

test("recording preserves text and SGR styles across byte and escape boundaries", () => {
  const raw = Buffer.from("\x1b[1;32mcodex\x1b[0m\nI’ll run <script> safely.\n\x1b[38;2;1;2;3mRGB\x1b[0m");
  const decoder = new TextDecoder(),
    parser = new CodexOutput(),
    segments = [];
  for (const byte of raw)
    segments.push(...parser.push(decoder.decode(Uint8Array.of(byte), { stream: true })));
  assert.equal(segments.map((s) => s.text).join(""), "codex\nI’ll run <script> safely.\nRGB");
  assert.deepEqual(segments[0].style, { fontWeight: "bold", color: "#99cc99" });
  assert.deepEqual(segments.at(-1).style, { color: "rgb(1,2,3)" });
  assert.deepEqual(segments.find((s) => s.text === "I").style, {});
});
test("recording ignores title and cursor controls and supports indexed colors", () => {
  const parser = new CodexOutput();
  assert.deepEqual(parser.push("\x1b]0;private title"), []);
  const segments = parser.push("\x07\x1b[2J\x1b[38;5;196mexec\x1b[0m\n");
  assert.equal(segments.map((s) => s.text).join(""), "exec\n");
  assert.equal(segments[0].style.color, "rgb(255,0,0)");
  assert.deepEqual(segments[1].style, {});
});

const { CodexTranscript, commandSummary } = await import("../public/codex-transcript.js");
test("structured transcript handles split JSON/UTF-8 and replaces command updates", () => {
  const transcript = new CodexTranscript(),
    decoder = new TextDecoder();
  const events = [
    { type: "thread.started", thread_id: "hidden metadata" },
    {
      type: "item.started",
      item: { id: "cmd", type: "command_execution", command: "python3 play.py", status: "in_progress" },
    },
    {
      type: "item.completed",
      item: {
        id: "cmd",
        type: "command_execution",
        command: "python3 play.py",
        status: "completed",
        exit_code: 0,
        aggregated_output: "<script>π</script>",
      },
    },
    { type: "item.completed", item: { id: "think", type: "reasoning", text: "I’ll check production." } },
    { type: "item.completed", item: { id: "msg", type: "agent_message", text: "Done." } },
  ];
  for (const byte of Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n"))
    transcript.push(decoder.decode(Uint8Array.of(byte), { stream: true }));
  assert.equal(transcript.items.size, 3);
  assert.equal(transcript.items.get("cmd").aggregated_output, "<script>π</script>");
  assert.equal(transcript.items.get("think").text, "I’ll check production.");
  assert.equal(commandSummary([events[1].item]), "Running 1 command");
  assert.equal(commandSummary([events[2].item]), "Ran 1 command");
  assert.equal(
    commandSummary([events[2].item, { status: "failed", exit_code: 1 }]),
    "Ran 2 commands · failed",
  );
});
test("structured transcript surfaces errors without breaking on malformed or incomplete lines", () => {
  const transcript = new CodexTranscript();
  assert.deepEqual(transcript.push('not json\n{"type":"turn.failed",'), []);
  assert.equal(transcript.push('"error":{"message":"Failed to connect"}}\n')[0].text, "Failed to connect");
});

test("transcript keeps commands with reused IDs distinct across resumed Codex sessions", () => {
  const transcript = new CodexTranscript();
  const events = [
    { type: "thread.started", thread_id: "same" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "first segment" } },
    { type: "thread.started", thread_id: "same" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "second segment" } },
  ];
  const items = transcript.push(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  assert.equal(items.length, 2);
  assert.notEqual(items[0].id, items[1].id);
  assert.equal(transcript.items.size, 2);
});

test("codex output covers every SGR colour and style branch", () => {
  const styleAfter = (sequence) => {
    const parser = new CodexOutput();
    const segments = parser.push(`\x1b[0m${sequence}text`);
    return segments.at(-1).style;
  };
  assert.deepEqual(styleAfter("\x1b[31m"), { color: "#f2777a" });
  assert.deepEqual(styleAfter("\x1b[37m"), { color: "#d3d0c8" });
  assert.deepEqual(styleAfter("\x1b[91m"), { color: "#ff9999" });
  assert.deepEqual(styleAfter("\x1b[41m"), { backgroundColor: "#f2777a" });
  assert.deepEqual(styleAfter("\x1b[101m"), { backgroundColor: "#ff9999" });
  assert.deepEqual(styleAfter("\x1b[38;5;196m"), { color: "rgb(255,0,0)" });
  assert.deepEqual(styleAfter("\x1b[38;5;232m"), { color: "rgb(8,8,8)" });
  assert.deepEqual(styleAfter("\x1b[38;5;255m"), { color: "rgb(238,238,238)" });
  assert.deepEqual(styleAfter("\x1b[48;5;9m"), { backgroundColor: "#ff9999" });
  assert.deepEqual(styleAfter("\x1b[38;5;300m"), {});
  assert.deepEqual(styleAfter("\x1b[38;5m"), {});
  assert.deepEqual(styleAfter("\x1b[38;2;1;2;3m"), { color: "rgb(1,2,3)" });
  assert.deepEqual(styleAfter("\x1b[48;2;10;20;30m"), { backgroundColor: "rgb(10,20,30)" });
  assert.deepEqual(styleAfter("\x1b[38;2;1;2m"), { fontWeight: "bold", opacity: "0.65" });
  assert.deepEqual(styleAfter("\x1b[38;2;256;1;1m"), { fontWeight: "bold", opacity: "0.65" });
  assert.deepEqual(styleAfter("\x1b[m"), {});
  assert.deepEqual(styleAfter("\x1b[;1m"), { fontWeight: "bold" });
});

test("codex output resets and composes style flags", () => {
  const parser = new CodexOutput();
  const segments = parser.push(
    "\x1b[1;2;3;4mflags\x1b[22mno-weight\x1b[23mno-italic\x1b[24mno-underline\x1b[31mred\x1b[39mplain\x1b[41mbg\x1b[49mclear",
  );
  const byText = (value) => segments.find((segment) => segment.text === value)?.style;
  assert.deepEqual(byText("flags"), {
    fontWeight: "bold",
    opacity: "0.65",
    fontStyle: "italic",
    textDecoration: "underline",
  });
  assert.equal(byText("no-weight")?.fontWeight, undefined);
  assert.equal(byText("no-weight")?.opacity, undefined);
  assert.equal(byText("no-italic")?.fontStyle, undefined);
  assert.equal(byText("no-underline")?.textDecoration, undefined);
  assert.equal(byText("red")?.color, "#f2777a");
  assert.deepEqual(byText("plain"), {});
  assert.equal(byText("bg")?.backgroundColor, "#f2777a");
  assert.deepEqual(byText("clear"), {});
});

test("codex output buffers incomplete escapes and skips non-SGR commands", () => {
  const split = new CodexOutput();
  assert.deepEqual(split.push("a\x1b[3"), [{ text: "a", style: {} }]);
  assert.deepEqual(split.push("1mB"), [{ text: "B", style: { color: "#f2777a" } }]);
  const lone = new CodexOutput();
  assert.deepEqual(lone.push("\x1b"), []);
  // A bare ESC plus a non-CSI byte is skipped as an unknown escape, not SGR.
  assert.deepEqual(lone.push("0m"), [{ text: "m", style: {} }]);
  assert.deepEqual(lone.push("Q"), [{ text: "Q", style: {} }]);
  assert.deepEqual(new CodexOutput().push("\x1bX"), []);
  assert.deepEqual(new CodexOutput().push("\x1b[0m"), []);
});
