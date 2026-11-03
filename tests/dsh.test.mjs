import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const {
  createDshState,
  dshArgs,
  dshCredentialsPath,
  dshEnvironmentPrompt,
  dshHome,
  dshModelPatch,
  parseDshModel,
  readDshApiKey,
  translateDshEvent,
  writeDshModelPatch,
  writeDshWrappers,
} = await import("../dist/dsh.js");

const tempDir = (prefix = "autorio-dsh-test-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("parseDshModel handles bare ids, provider routes and #effort", () => {
  assert.deepEqual(parseDshModel("deepseek-flash", {}), {
    provider: "deepseek-official",
    model: "deepseek-flash",
    reasoningEffort: undefined,
  });
  assert.deepEqual(parseDshModel("my-provider/deepseek-v3#high", {}), {
    provider: "my-provider",
    model: "deepseek-v3",
    reasoningEffort: "high",
  });
  assert.deepEqual(
    parseDshModel(undefined, { AUTORIO_DSH_PROVIDER: "p2", AUTORIO_DSH_MODEL: "m2", AUTORIO_DSH_REASONING_EFFORT: "low" }),
    { provider: "p2", model: "m2", reasoningEffort: "low" },
  );
  assert.equal(parseDshModel("deepseek-flash#minimal", { AUTORIO_DSH_REASONING_EFFORT: "max" }).reasoningEffort, "minimal");
});

test("readDshApiKey prefers the launch environment and falls back to DSH credentials", () => {
  const home = tempDir();
  assert.equal(dshHome({ DSH_HOME: home }), path.resolve(home));
  assert.equal(dshCredentialsPath({ DSH_HOME: home }), path.join(home, ".credentials.yaml"));

  const credentials = path.join(home, ".credentials.yaml");
  fs.writeFileSync(credentials, [
    "version: 1",
    "refs:",
    "  DEEPSEEK_API_KEY: sk-stored-key",
    "records:",
    "  llm-deepseek-api-key/route:",
    "    kind: grant",
    "",
  ].join("\n"));
  assert.equal(readDshApiKey({ env: {}, credentialsPath: credentials }), "sk-stored-key");
  assert.equal(readDshApiKey({ env: { DEEPSEEK_API_KEY: "sk-env-key" }, credentialsPath: credentials }), "sk-env-key");
  assert.equal(readDshApiKey({ env: {}, credentialsPath: path.join(home, "missing.yaml") }), undefined);

  fs.writeFileSync(credentials, ['version: 1', "refs:", '  DEEPSEEK_API_KEY: "sk-quoted"', ""].join("\n"));
  assert.equal(readDshApiKey({ env: {}, credentialsPath: credentials }), "sk-quoted");
});

test("dshModelPatch writes the agent-default-model override", () => {
  const patch = dshModelPatch({ provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "low" });
  assert.match(patch, /^- id: agent-default-model$/m);
  assert.match(patch, /provider: "deepseek-official"/);
  assert.match(patch, /model: "deepseek-flash"/);
  assert.match(patch, /reasoningEffort: "low"/);
  assert.doesNotMatch(
    dshModelPatch({ provider: "p", model: "m" }),
    /reasoningEffort/,
  );
  const dir = tempDir();
  const file = writeDshModelPatch(dir, { provider: "p", model: "m" });
  assert.equal(file, path.join(dir, "dsh-model.patch.yml"));
  assert.match(fs.readFileSync(file, "utf8"), /model: "m"/);
});

test("dshArgs keeps launcher flags before app flags", () => {
  assert.deepEqual(dshArgs({ profile: "headless" }), ["--profile", "headless", "--json"]);
  assert.deepEqual(
    dshArgs({ profile: "headless", patchPath: "/tmp/model.yml", sessionId: "session-1" }),
    ["--profile", "headless", "--patch", "/tmp/model.yml", "--json", "--session-id", "session-1"],
  );
});

test("writeDshWrappers writes the WSL wrapper and Windows launcher", () => {
  const dir = tempDir();
  const linux = writeDshWrappers(dir, {
    windows: false, distro: "Ubuntu-24.04", workspaceWsl: dir, apiBase: "http://127.0.0.1:3000",
  });
  assert.equal(linux.sh, path.join(dir, "play.sh"));
  assert.equal(linux.ps1, undefined);
  const sh = fs.readFileSync(linux.sh, "utf8");
  assert.match(sh, /^#!\/bin\/sh/);
  assert.match(sh, /export FACTORIO_API_BASE="http:\/\/127\.0\.0\.1:3000"/);
  assert.match(sh, /export PYTHONPATH=/);
  assert.match(sh, /exec python3 "\$@"/);

  const winDir = tempDir();
  const win = writeDshWrappers(winDir, {
    windows: true, distro: "Ubuntu-24.04", workspaceWsl: "/mnt/c/run/workspace", apiBase: "http://127.0.0.1:4000",
  });
  assert.ok(win.ps1 && fs.existsSync(win.ps1));
  const ps1 = fs.readFileSync(win.ps1, "utf8");
  assert.match(ps1, /wsl\.exe -d 'Ubuntu-24\.04' -e sh '\/mnt\/c\/run\/workspace\/play\.sh'/);
  assert.match(ps1, /ValueFromRemainingArguments/);
  assert.ok(win.cmd && fs.existsSync(win.cmd));
  const cmd = fs.readFileSync(win.cmd, "utf8");
  assert.match(cmd, /where python/);
  assert.match(cmd, /python %\*/);
  assert.match(cmd, /py -3 %\*/);
  assert.match(cmd, /FACTORIO_API_BASE=http:\/\/127\.0\.0\.1:4000/);
  assert.match(cmd, /\r\n/);
});

test("dshEnvironmentPrompt teaches the right wrapper per platform", () => {
  const windowsPython = dshEnvironmentPrompt({
    windows: true, windowsPython: true, distro: "Ubuntu-24.04",
    workspaceWsl: "/mnt/c/run/workspace", apiBase: "http://127.0.0.1:3000",
  });
  assert.match(windowsPython, /\.\\play\.cmd factorio\.py/);
  assert.match(windowsPython, /FACTORIO_API_BASE=http:\/\/127\.0\.0\.1:3000/);
  assert.match(windowsPython, /never sleep longer than 10 seconds/i);
  assert.match(windowsPython, /python factorio\.py/);
  const windowsWsl = dshEnvironmentPrompt({
    windows: true, windowsPython: false, distro: "Ubuntu-24.04",
    workspaceWsl: "/mnt/c/run/workspace", apiBase: "http://127.0.0.1:3000",
  });
  assert.match(windowsWsl, /play\.ps1 factorio\.py/);
  assert.match(windowsWsl, /wsl\.exe -d Ubuntu-24\.04/);
  const linux = dshEnvironmentPrompt({
    windows: false, distro: "Ubuntu-24.04", workspaceWsl: "/home/user/workspace", apiBase: "http://127.0.0.1:3000",
  });
  assert.match(linux, /sh \.\/play\.sh factorio\.py/);
  assert.doesNotMatch(linux, /play\.ps1/);
});

test("translateDshEvent projects session, thinking, text, tools and usage", () => {
  const state = createDshState();
  assert.deepEqual(translateDshEvent({ type: "session", sessionId: "session-1", cwd: "/w" }, state), [
    { kind: "thread", sessionId: "session-1" },
  ]);
  assert.deepEqual(translateDshEvent({ type: "thinking", text: "" }, state), []);
  assert.deepEqual(translateDshEvent({ type: "thinking", text: "think" }, state), [{ kind: "reasoning", text: "think" }]);
  assert.deepEqual(translateDshEvent({ type: "text", text: "hello" }, state), [{ kind: "message", text: "hello" }]);

  const start = translateDshEvent({
    type: "tool_call", callId: "call-1", tool: "pwsh", input: { description: "x", command: "node --version" },
  }, state);
  assert.deepEqual(start, [{
    kind: "tool_start", id: "call-1", tool: "pwsh", command: "node --version",
    input: { description: "x", command: "node --version" },
  }]);
  const end = translateDshEvent({ type: "tool_result", callId: "call-1", status: "completed", result: "v24" }, state);
  assert.deepEqual(end, [{
    kind: "tool_end", id: "call-1", tool: "pwsh", command: "node --version", status: "completed", output: "v24",
  }]);
  // A result without a matching call still renders.
  assert.deepEqual(translateDshEvent({ type: "tool_result", callId: "lost", status: "error", result: "boom" }, state), [{
    kind: "tool_end", id: "lost", tool: undefined, command: undefined, status: "error", output: "boom",
  }]);

  assert.deepEqual(translateDshEvent({
    type: "status", phase: "step_end", turn: 1, step: 1,
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, reasoningTokens: 5, totalTokens: 120 },
  }, state), [{
    kind: "usage",
    usage: { input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 5, cached_input_tokens: 40, total_tokens: 120 },
    contextTokens: 140,
  }]);
});

test("translateDshEvent surfaces turn failures and ignores unknown events", () => {
  const state = createDshState();
  assert.deepEqual(
    translateDshEvent({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } }, state),
    [],
  );
  assert.deepEqual(
    translateDshEvent({
      type: "status", phase: "turn_end", turn: 1,
      reason: { kind: "error", error: { message: "no API key", code: "MISSING_CREDENTIAL" } },
    }, state),
    [{ kind: "error", message: "no API key" }],
  );
  assert.deepEqual(translateDshEvent({ type: "error", message: "runner failed" }, state), [{ kind: "error", message: "runner failed" }]);
  assert.deepEqual(translateDshEvent({ type: "final", text: "done" }, state), [{ kind: "final", text: "done" }]);
  assert.deepEqual(translateDshEvent({ type: "future_type", payload: 1 }, state), []);
  assert.deepEqual(translateDshEvent(null, state), []);
});

test("a full headless event stream translates in order", () => {
  const state = createDshState();
  const stream = [
    { type: "session", sessionId: "s" },
    { type: "status", phase: "turn_start", turn: 1 },
    { type: "status", phase: "step_start", turn: 1, step: 1 },
    { type: "tool_call", callId: "a", tool: "bash", input: { command: "ls" } },
    { type: "tool_result", callId: "a", status: "completed", result: "x" },
    { type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 2 } },
    { type: "text", text: "answer" },
    { type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } },
    { type: "final", text: "answer" },
  ];
  const kinds = stream.flatMap((event) => translateDshEvent(event, state)).map((op) => op.kind);
  assert.deepEqual(kinds, ["thread", "tool_start", "tool_end", "usage", "message", "final"]);
});
