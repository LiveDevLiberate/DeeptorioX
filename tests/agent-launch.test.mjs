import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { agentPrompt, languagePrompt, shortWaitGuardFiles } = await import("../dist/agents/launch-types.js");
const { openCodeLaunchSpec } = await import("../dist/agents/opencode-launch.js");
const { codexLaunchSpec, codexProviderArgs } = await import("../dist/agents/codex-launch.js");
const { dshLaunchSpec } = await import("../dist/agents/dsh-launch.js");
const { writeDshModelPatch, writeDshWrappers } = await import("../dist/dsh.js");
const { shellQuote, toWslPath } = await import("../dist/opencode.js");

const workspace = "/runs/example/workspace";
const apiBase = "http://127.0.0.1:3000";
const baseEnv = {
  PATH: "/usr/local/bin:/usr/bin",
  PYTHONPATH: "/opt/autoradio",
  HOME: "/home/tester",
  RCON_PASSWORD: "rcon-secret",
  OBS_WEBSOCKET_PASSWORD: "obs-secret",
};
const runInput = (overrides = {}) => ({
  workspace,
  env: baseEnv,
  apiBase,
  windows: false,
  resume: false,
  restart: false,
  ...overrides,
});
const promptOf = (spec) => spec.args.at(-1);

test("agentPrompt composes language, discipline and base instructions", () => {
  assert.equal(languagePrompt(undefined), "");
  assert.match(languagePrompt("Deutsch"), /^CRITICAL OUTPUT LANGUAGE: Deutsch\./);
  for (const chinese of ["Chinese", "chinese", "中文", "zh-CN"])
    assert.match(languagePrompt(chinese), /Simplified Chinese \(简体中文\)/);

  const fresh = agentPrompt({ resume: false, restart: false });
  assert.match(fresh, /Never run a shell `sleep` longer than 10 seconds\./);
  assert.match(fresh, /Batch at least five related actions or observations per tool call/);
  assert.match(
    fresh,
    /Read AGENTS\.md, COOKBOOK\.md and TASK\.md, then play Factorio through the Python library/,
  );
  assert.match(fresh, /proven layouts and the error-recovery matrix/);
  assert.match(fresh, /Do not manage game processes or access raw RCON\.$/);
  assert.doesNotMatch(fresh, /Continue the same benchmark/);

  const resume = agentPrompt({ resume: true, restart: false });
  assert.match(resume, /Continue the same benchmark from its saved game\./);
  assert.match(resume, /RESUME\.md/);

  // Restart takes precedence: the agent must rebuild context from STATE.md.
  const restart = agentPrompt({ resume: true, restart: true });
  assert.match(restart, /previous agent session was reset because its context reached/);
  assert.match(restart, /STATE\.md and RESUME\.md/);
  assert.doesNotMatch(restart, /Continue the same benchmark from its saved game/);

  const localized = agentPrompt({ resume: false, restart: false, language: "中文" });
  assert.match(localized, /^CRITICAL OUTPUT LANGUAGE: Simplified Chinese \(简体中文\)\./);
});

test("shortWaitGuardFiles plans the sleep shim and Python sitecustomize hook", () => {
  const files = shortWaitGuardFiles(workspace);
  assert.deepEqual(
    files.map((file) => file.path),
    [path.join(workspace, "bin", "sleep"), path.join(workspace, "sitecustomize.py")],
  );
  assert.equal(files[0].mode, 0o755);
  assert.equal(files[1].mode, undefined);
  assert.match(files[0].content, /capped to 10s; use wait_for_\*/);
  assert.match(files[0].content, /exec \/bin\/sleep "\$n"/);
  assert.match(files[1].content, /_autoriods_time\.sleep = _autoriods_sleep/);
});

test("OpenCode native launch spec keeps args, env and prompt byte-identical", () => {
  const model = "opencode-go/deepseek-v4.1-flash";
  const spec = openCodeLaunchSpec({
    ...runInput(),
    model,
    transport: "native",
    executable: "/opt/opencode",
    wslDistro: "Ubuntu-24.04",
    wslCommand: "'$HOME/.opencode/bin/opencode'",
  });
  assert.equal(spec.executable, "/opt/opencode");
  assert.deepEqual(spec.args.slice(0, 7), [
    "run",
    "--format",
    "json",
    "--thinking",
    "--model",
    model,
    "--auto",
  ]);
  assert.equal(promptOf(spec), agentPrompt({ resume: false, restart: false }));
  assert.equal(spec.args.filter((arg) => arg === "--session").length, 0);
  assert.equal(spec.cwd, workspace);
  assert.equal(spec.transport, "native");
  assert.equal(spec.stdinTask, undefined);
  assert.equal(spec.remote, undefined);
  assert.deepEqual(spec.launchInfo, {
    executable: "/opt/opencode",
    args: spec.args,
    transport: "native",
    model,
  });

  assert.equal(spec.env.FACTORIO_API_BASE, apiBase);
  assert.equal(spec.env.OPENCODE_API_KEY, undefined);
  assert.equal(spec.env.RCON_PASSWORD, undefined);
  assert.equal(spec.env.OBS_WEBSOCKET_PASSWORD, undefined);
  assert.equal(spec.env.PYTHONPATH, [workspace, baseEnv.PYTHONPATH].join(path.delimiter));
  assert.equal(spec.env.PATH, [path.join(workspace, "bin"), baseEnv.PATH].join(path.delimiter));
  // Specs must copy the injected environment, never mutate it.
  assert.equal(baseEnv.RCON_PASSWORD, "rcon-secret");
  assert.equal(baseEnv.PYTHONPATH, "/opt/autoradio");

  assert.deepEqual(
    spec.files.map((file) => file.path),
    [path.join(workspace, "bin", "sleep"), path.join(workspace, "sitecustomize.py")],
  );
});

test("OpenCode native launch spec skips the POSIX PATH shim on Windows", () => {
  const spec = openCodeLaunchSpec({
    ...runInput({ windows: true }),
    model: "m",
    transport: "native",
    executable: "opencode",
    wslDistro: "Ubuntu-24.04",
    wslCommand: "'$HOME/.opencode/bin/opencode'",
  });
  assert.equal(spec.env.PATH, baseEnv.PATH);
  assert.equal(spec.env.PYTHONPATH, [workspace, baseEnv.PYTHONPATH].join(path.delimiter));
});

test("OpenCode WSL launch spec plans the launcher script and pid polling", () => {
  const model = "opencode-go/deepseek-v4.1-flash";
  const spec = openCodeLaunchSpec({
    ...runInput({ windows: true }),
    model,
    transport: "wsl",
    executable: "opencode",
    wslDistro: "Ubuntu-24.04",
    wslCommand: "'$HOME/.opencode/bin/opencode'",
  });
  const script = path.join(workspace, "agent-launch.sh");
  const pidFile = path.join(workspace, "agent.pid");
  assert.equal(spec.executable, "wsl.exe");
  assert.deepEqual(spec.args, ["-d", "Ubuntu-24.04", "-e", "sh", toWslPath(script)]);
  assert.deepEqual(spec.remote, { distro: "Ubuntu-24.04", pidFile });
  assert.equal(spec.transport, "wsl");
  assert.equal(spec.launchInfo.transport, "wsl");

  const file = spec.files.find((candidate) => candidate.path === script);
  assert.ok(file);
  assert.equal(file.mode, 0o700);
  const lines = file.content.split("\n");
  assert.equal(lines[0], "#!/bin/sh");
  assert.equal(lines[1], `cd ${shellQuote(toWslPath(workspace))}`);
  assert.equal(lines[2], `export PATH=${shellQuote(toWslPath(path.join(workspace, "bin")))}:"$PATH"`);
  assert.equal(
    lines[3],
    `export PYTHONPATH=${shellQuote(toWslPath(workspace))}` + "${PYTHONPATH:+:$PYTHONPATH}",
  );
  assert.equal(lines[4], `echo $$ > ${shellQuote(toWslPath(pidFile))}`);
  assert.ok(lines[5].startsWith("exec '$HOME/.opencode/bin/opencode' 'run' '--format' 'json'"));
  // The prompt may contain newlines (STATE.md template), so compare the joined tail.
  assert.ok(
    lines
      .slice(5)
      .join("\n")
      .endsWith(`${shellQuote(agentPrompt({ resume: false, restart: false }))}\n`),
  );
  assert.equal(lines[6], "# STATE");
  assert.equal(lines.at(-1), "");
  // The launcher exports its own PATH; the child environment must stay native.
  assert.equal(spec.env.PATH, baseEnv.PATH);
});

test("OpenCode resume and restart sessions change only the session/prompt clauses", () => {
  const base = {
    ...runInput(),
    model: "m",
    transport: "native",
    executable: "opencode",
    wslDistro: "Ubuntu-24.04",
    wslCommand: "'opencode'",
  };
  const resumed = openCodeLaunchSpec({ ...base, resume: true, sessionId: "ses_abc" });
  assert.deepEqual(resumed.args.slice(6, 9), ["--auto", "--session", "ses_abc"]);
  assert.match(promptOf(resumed), /Continue the same benchmark from its saved game\./);

  const restarted = openCodeLaunchSpec({ ...base, restart: true });
  assert.equal(restarted.args.filter((arg) => arg === "--session").length, 0);
  assert.match(promptOf(restarted), /previous agent session was reset because its context reached/);

  // A localized resumed run keeps the language instruction first.
  const localized = openCodeLaunchSpec({
    ...base,
    resume: true,
    sessionId: "ses_zh",
    language: "Chinese",
  });
  assert.match(promptOf(localized), /^CRITICAL OUTPUT LANGUAGE: Simplified Chinese/);
  assert.match(promptOf(localized), /Continue the same benchmark from its saved game\./);
});

test("Codex launch spec builds the default exec arguments", () => {
  const spec = codexLaunchSpec({
    ...runInput(),
    executable: "/opt/codex",
    model: "gpt-5-codex",
    reasoningEffort: "high",
    terminal: false,
    sandbox: "workspace-write",
  });
  assert.deepEqual(spec.args.slice(0, 16), [
    "exec",
    "--json",
    "--ignore-user-config",
    "--sandbox",
    "workspace-write",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "--skip-git-repo-check",
    "-C",
    workspace,
    "--output-last-message",
    path.join(workspace, "REPORT.md"),
    "--model",
    "gpt-5-codex",
    "-c",
    'model_reasoning_effort="high"',
  ]);
  assert.equal(promptOf(spec), agentPrompt({ resume: false, restart: false }));
  assert.equal(spec.executable, "/opt/codex");
  assert.equal(spec.cwd, workspace);
  assert.equal(spec.transport, undefined);
  assert.equal(spec.stdinTask, undefined);
  assert.deepEqual(spec.launchInfo, { executable: "/opt/codex", args: spec.args });
  assert.deepEqual(spec.files, []);
  assert.equal(spec.env.FACTORIO_API_BASE, apiBase);
  assert.equal(spec.env.PYTHONPATH, baseEnv.PYTHONPATH);
  assert.equal(spec.env.PATH, baseEnv.PATH);
  assert.equal(spec.env.RCON_PASSWORD, undefined);
  assert.equal(spec.env.OBS_WEBSOCKET_PASSWORD, undefined);

  // Fresh runs without model/effort leave those flags out entirely.
  const minimal = codexLaunchSpec({
    ...runInput(),
    executable: "codex",
    terminal: false,
    sandbox: "danger-full-access",
  });
  assert.ok(!minimal.args.includes("--model"));
  assert.ok(!minimal.args.some((arg) => arg.startsWith("model_reasoning_effort")));
  assert.equal(minimal.args[4], "danger-full-access");
});

test("Codex terminal runs request native colour output", () => {
  const spec = codexLaunchSpec({
    ...runInput(),
    executable: "codex",
    terminal: true,
    sandbox: "workspace-write",
  });
  assert.deepEqual(spec.args.slice(0, 3), ["exec", "--color", "always"]);
  assert.ok(!spec.args.includes("--json"));
});

test("Codex provider arguments come from the injected environment only", () => {
  const providerEnv = {
    ...baseEnv,
    AUTORIO_CODEX_PROVIDER: "opencode-go",
    AUTORIO_CODEX_BASE_URL: "https://api.example.test/v1",
  };
  assert.deepEqual(codexProviderArgs(providerEnv), [
    "-c",
    'model_provider="opencode-go"',
    "-c",
    'model_providers.opencode-go.name="opencode-go"',
    "-c",
    'model_providers.opencode-go.base_url="https://api.example.test/v1"',
    "-c",
    'model_providers.opencode-go.env_key="OPENCODE_API_KEY"',
    "-c",
    'model_providers.opencode-go.wire_api="responses"',
  ]);
  assert.deepEqual(codexProviderArgs({ ...baseEnv }), []);
  // A custom API key variable, wire API and context window pass through.
  assert.deepEqual(
    codexProviderArgs({
      ...providerEnv,
      AUTORIO_CODEX_ENV_KEY: "MY_KEY",
      AUTORIO_CODEX_WIRE_API: "chat",
      AUTORIO_CODEX_CONTEXT_WINDOW: "200000",
    }).slice(-6),
    [
      "-c",
      'model_providers.opencode-go.env_key="MY_KEY"',
      "-c",
      'model_providers.opencode-go.wire_api="chat"',
      "-c",
      "model_context_window=200000",
    ],
  );
  assert.throws(
    () => codexProviderArgs({ ...baseEnv, AUTORIO_CODEX_PROVIDER: "broken" }),
    /AUTORIO_CODEX_PROVIDER requires AUTORIO_CODEX_BASE_URL/,
  );

  // Process env must not leak into a spec built with an explicit env.
  const names = ["AUTORIO_CODEX_PROVIDER", "AUTORIO_CODEX_BASE_URL"];
  const saved = names.map((name) => process.env[name]);
  process.env.AUTORIO_CODEX_PROVIDER = "from-process";
  process.env.AUTORIO_CODEX_BASE_URL = "https://process.example.test";
  try {
    const spec = codexLaunchSpec({
      ...runInput(),
      executable: "codex",
      terminal: false,
      sandbox: "workspace-write",
    });
    assert.ok(!spec.args.some((arg) => arg.includes("from-process")));
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  }
});

test("Codex resume and restart sessions change only session args and prompt", () => {
  const base = {
    ...runInput(),
    executable: "codex",
    terminal: false,
    sandbox: "workspace-write",
  };
  const resumed = codexLaunchSpec({ ...base, resume: true, sessionId: "thread-42" });
  assert.deepEqual(resumed.args.slice(-3), ["resume", "thread-42", promptOf(resumed)]);
  assert.match(promptOf(resumed), /Continue the same benchmark from its saved game\./);

  const restarted = codexLaunchSpec({ ...base, restart: true });
  assert.ok(!restarted.args.includes("resume"));
  assert.match(promptOf(restarted), /previous agent session was reset because its context reached/);
});

const dshSelection = {
  provider: "deepseek-official",
  model: "deepseek-flash",
  reasoningEffort: "high",
};
const dshInput = (overrides = {}) => ({
  ...runInput({ windows: true }),
  executable: "/opt/dsh",
  apiKey: "sk-test-key",
  profile: "headless",
  selection: dshSelection,
  distro: "Ubuntu-24.04",
  windowsPython: true,
  ...overrides,
});
const dshPatchPath = path.join(workspace, "dsh-model.patch.yml");

test("DSH launch spec builds args, stdin task, env and workspace files", () => {
  const spec = dshLaunchSpec(dshInput());
  assert.equal(spec.executable, "/opt/dsh");
  assert.deepEqual(spec.args, ["--profile", "headless", "--patch", dshPatchPath, "--json"]);
  assert.equal(spec.cwd, workspace);
  assert.equal(spec.transport, "wsl-python");
  assert.ok(
    spec.stdinTask.startsWith(
      "Environment: the manager runs on Windows and your shell tool is Windows PowerShell.",
    ),
  );
  assert.ok(spec.stdinTask.includes("play.cmd factorio.py"));
  assert.ok(spec.stdinTask.endsWith(agentPrompt({ resume: false, restart: false })));
  assert.deepEqual(JSON.parse(JSON.stringify(spec.launchInfo)), {
    executable: "/opt/dsh",
    args: spec.args,
    transport: "wsl-python",
    model: "deepseek-official/deepseek-flash",
    prompt_via: "stdin",
  });
  assert.equal(spec.env.DEEPSEEK_API_KEY, "sk-test-key");
  assert.equal(spec.env.DSH_PROFILE, "headless");
  assert.equal(spec.env.FACTORIO_API_BASE, apiBase);
  assert.equal(spec.env.RCON_PASSWORD, undefined);
  assert.equal(spec.env.OBS_WEBSOCKET_PASSWORD, undefined);
  assert.equal(spec.env.DSH_SESSION_ID, undefined);
  assert.equal(spec.env.DSH_PROFILE_DIR, undefined);
  assert.equal(spec.env.PYTHONPATH, [workspace, baseEnv.PYTHONPATH].join(path.delimiter));

  assert.deepEqual(
    spec.files.map((file) => file.path),
    [
      path.join(workspace, "bin", "sleep"),
      path.join(workspace, "sitecustomize.py"),
      path.join(workspace, "play.sh"),
      path.join(workspace, "play.cmd"),
      path.join(workspace, "play.ps1"),
      dshPatchPath,
    ],
  );
  assert.equal(spec.files[2].mode, 0o755);
  assert.equal(
    spec.files[5].content,
    [
      "- id: agent-default-model",
      "  config:",
      '    provider: "deepseek-official"',
      '    model: "deepseek-flash"',
      '    reasoningEffort: "high"',
      "",
    ].join("\n"),
  );
});

test("DSH wrapper files are byte-identical to the legacy writers in src/dsh.ts", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-launch-test-"));
  const tempWorkspace = path.join(temp, "workspace");
  fs.mkdirSync(tempWorkspace, { recursive: true });
  const options = {
    windows: true,
    distro: "Ubuntu-24.04",
    workspaceWsl: toWslPath(tempWorkspace),
    apiBase,
  };
  const legacy = writeDshWrappers(tempWorkspace, options);
  writeDshModelPatch(tempWorkspace, dshSelection);
  const spec = dshLaunchSpec(dshInput({ workspace: tempWorkspace }));
  const planned = new Map(spec.files.map((file) => [file.path, file.content]));
  for (const file of [legacy.sh, legacy.cmd, legacy.ps1].filter(Boolean))
    assert.equal(planned.get(file), fs.readFileSync(file, "utf8"));
  assert.equal(
    planned.get(path.join(tempWorkspace, "dsh-model.patch.yml")),
    fs.readFileSync(path.join(tempWorkspace, "dsh-model.patch.yml"), "utf8"),
  );
  const cmd = planned.get(path.join(tempWorkspace, "play.cmd"));
  assert.ok(cmd.includes("\r\n"));
  assert.ok(cmd.includes(`set "FACTORIO_API_BASE=${apiBase}"`));
  const ps1 = planned.get(path.join(tempWorkspace, "play.ps1"));
  assert.ok(
    ps1.includes(`& wsl.exe -d 'Ubuntu-24.04' -e sh '${toWslPath(tempWorkspace)}/play.sh' @CommandArgs`),
  );
  fs.rmSync(temp, { recursive: true, force: true });
});

test("DSH non-Windows, resume and restart launches adapt prompts and files", () => {
  const native = dshLaunchSpec(
    dshInput({ windows: false, windowsPython: false, selection: { provider: "p", model: "m" } }),
  );
  assert.equal(native.transport, "native");
  assert.ok(native.stdinTask.startsWith("Environment: run gameplay commands through the workspace wrapper"));
  assert.ok(native.stdinTask.includes("`sh ./play.sh factorio.py <command> ...`"));
  assert.deepEqual(
    native.files.map((file) => file.path),
    [
      path.join(workspace, "bin", "sleep"),
      path.join(workspace, "sitecustomize.py"),
      path.join(workspace, "play.sh"),
      dshPatchPath,
    ],
  );
  assert.equal(
    native.files.at(-1).content,
    ["- id: agent-default-model", "  config:", '    provider: "p"', '    model: "m"', ""].join("\n"),
  );

  const resumed = dshLaunchSpec(dshInput({ resume: true, sessionId: "dsh-session-1" }));
  assert.deepEqual(resumed.args, [
    "--profile",
    "headless",
    "--patch",
    dshPatchPath,
    "--json",
    "--session-id",
    "dsh-session-1",
  ]);
  assert.equal(resumed.launchInfo.session, "dsh-session-1");
  assert.match(resumed.stdinTask, /Continue the same benchmark from its saved game\./);

  const restarted = dshLaunchSpec(dshInput({ restart: true }));
  assert.equal(restarted.launchInfo.session, undefined);
  assert.match(restarted.stdinTask, /previous agent session was reset because its context reached/);
});
