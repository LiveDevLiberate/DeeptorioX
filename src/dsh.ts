// DSH (DeepSeek Harness) agent backend helpers.
//
// autorio normally runs OpenCode or Codex as the agent. This module adds the
// third backend: `dsh --profile headless --json` (one-shot task mode) whose
// newline-delimited events are translated into the transcript schema the UI
// already renders. Everything here is pure or injectable so tests never launch
// a model, a manager, or Factorio.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DSH_PROFILE_DEFAULT = "headless";
export const DSH_PROVIDER_DEFAULT = "deepseek-official";
export const DSH_MODEL_DEFAULT = "deepseek-flash";
export const DSH_API_KEY_REF = "DEEPSEEK_API_KEY";

export type DshModelSelection = {
  provider: string;
  model: string;
  reasoningEffort?: string;
};

export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh"));
}

export function dshCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dshHome(env), ".credentials.yaml");
}

export function dshExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_BIN?.trim() || "dsh";
}

export function dshProfile(env: NodeJS.ProcessEnv = process.env): string {
  return env.AUTORIO_DSH_PROFILE?.trim() || DSH_PROFILE_DEFAULT;
}

export function dshProvider(env: NodeJS.ProcessEnv = process.env): string {
  return env.AUTORIO_DSH_PROVIDER?.trim() || DSH_PROVIDER_DEFAULT;
}

export function dshDefaultModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.AUTORIO_DSH_MODEL?.trim() || DSH_MODEL_DEFAULT;
}

/** Optional reasoning effort; headless keeps the profile default when unset. */
export function dshReasoningEffort(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.AUTORIO_DSH_REASONING_EFFORT?.trim() || undefined;
}

/**
 * Resolve the DeepSeek API key handed to headless runs. The shipped headless
 * profile disables the managed credential store, so it reads the launch
 * environment first; when the key is only saved in the desktop GUI we read the
 * plaintext `refs` block of $DSH_HOME/.credentials.yaml. The value is never
 * logged or persisted by autorio.
 */
export function readDshApiKey(options: {
  env?: NodeJS.ProcessEnv;
  credentialsPath?: string;
} = {}): string | undefined {
  const env = options.env ?? process.env;
  const fromEnv = env[DSH_API_KEY_REF]?.trim();
  if (fromEnv) return fromEnv;
  const file = options.credentialsPath ?? dshCredentialsPath(env);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let inRefs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true;
      continue;
    }
    if (!inRefs) continue;
    if (/^\S/.test(line)) {
      inRefs = false;
      continue;
    }
    const match = line.match(new RegExp(`^\\s+${DSH_API_KEY_REF}:\\s*(.+?)\\s*$`));
    if (match) {
      const value = match[1].replace(/^['"]|['"]$/g, "").trim();
      if (value) return value;
    }
  }
  return undefined;
}

/**
 * Parse `provider/model#effort`, `provider/model`, or a bare model id. A bare
 * id keeps the configured default provider, so `deepseek-flash#low` works like
 * the OpenCode `model#level` syntax autorio already documents.
 */
export function parseDshModel(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): DshModelSelection {
  const raw = (value || "").trim();
  let text = raw;
  let effort: string | undefined;
  const hash = text.lastIndexOf("#");
  if (hash > 0) {
    effort = text.slice(hash + 1).trim() || undefined;
    text = text.slice(0, hash).trim();
  }
  const slash = text.indexOf("/");
  const provider = slash > 0 ? text.slice(0, slash).trim() : dshProvider(env);
  const model = slash > 0 ? text.slice(slash + 1).trim() : text;
  return {
    provider: provider || dshProvider(env),
    model: model || dshDefaultModel(env),
    reasoningEffort: effort ?? dshReasoningEffort(env),
  };
}

/** YAML loader patch selecting the default model for one headless run. */
export function dshModelPatch(selection: DshModelSelection): string {
  const lines = [
    "- id: agent-default-model",
    "  config:",
    `    provider: ${JSON.stringify(selection.provider)}`,
    `    model: ${JSON.stringify(selection.model)}`,
  ];
  if (selection.reasoningEffort) {
    lines.push(`    reasoningEffort: ${JSON.stringify(selection.reasoningEffort)}`);
  }
  return lines.join("\n") + "\n";
}

export function writeDshModelPatch(workspace: string, selection: DshModelSelection): string {
  const file = path.join(workspace, "dsh-model.patch.yml");
  fs.writeFileSync(file, dshModelPatch(selection));
  return file;
}

/**
 * Launcher + app arguments for `dsh`. The task itself is written to stdin (a
 * positional task would let the model's own flags, such as `--version`, be
 * parsed as CLI options).
 */
export function dshArgs(options: {
  profile?: string;
  patchPath?: string;
  sessionId?: string;
} = {}): string[] {
  const args = ["--profile", options.profile || dshProfile()];
  if (options.patchPath) args.push("--patch", options.patchPath);
  args.push("--json");
  if (options.sessionId) args.push("--session-id", options.sessionId);
  return args;
}

/**
 * Prompt paragraph that teaches a Windows DSH agent to reach the gameplay
 * library through WSL. The manager runs the real game on Windows while
 * factorio.py needs python3 and loopback access from WSL, so the workspace
 * wrapper is the only supported path.
 */
export function dshEnvironmentPrompt(options: {
  windows: boolean;
  distro: string;
  workspaceWsl: string;
  apiBase: string;
  windowsPython?: boolean;
}): string {
  if (!options.windows) {
    return [
      "Environment: run gameplay commands through the workspace wrapper: `sh ./play.sh factorio.py <command> ...`",
      "(`sh ./play.sh plan.py` for a script you write here).",
      `It exports FACTORIO_API_BASE=${options.apiBase}, PYTHONPATH and a short-sleep guard, then runs python3.`,
      "The game is already running: never launch or kill the Factorio process, and never sleep longer than 10 seconds (use wait_for_* helpers).",
    ].join(" ");
  }
  return [
    "Environment: the manager runs on Windows and your shell tool is Windows PowerShell.",
    options.windowsPython
      ? "Run every gameplay command through the workspace batch wrapper: `.\\play.cmd factorio.py <command> ...`"
        + " (for example `.\\play.cmd factorio.py observe-player`); for multi-step work write a Python script here and run `.\\play.cmd plan.py`."
      : "Run every gameplay command through the WSL wrapper `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\play.ps1 factorio.py <command> ...`"
        + " (`... -File .\\play.ps1 plan.py` for a script you write here).",
    `The wrapper changes into the run workspace, exports FACTORIO_API_BASE=${options.apiBase}, PYTHONPATH and the short-sleep guard, then runs the Python client.`,
    options.windowsPython
      ? "A direct `python factorio.py <command> ...` also works when the wrapper is unavailable; the Windows Python client reaches the manager on 127.0.0.1."
      : `If the wrapper is unavailable, the equivalent command is \`wsl.exe -d ${options.distro} -e sh '${options.workspaceWsl}/play.sh' factorio.py ...\`.`,
    "Never launch or kill the Factorio process, never use raw RCON, and never sleep longer than 10 seconds (use wait_for_* helpers instead).",
  ].join(" ");
}

/**
 * Write the workspace wrappers the DSH prompt points at: `play.cmd` (Windows
 * Python, the primary path), `play.ps1` (WSL fallback for machines without
 * Windows Python), and `play.sh` (the script that runs inside WSL).
 */
export function writeDshWrappers(
  workspace: string,
  options: { windows: boolean; distro: string; workspaceWsl: string; apiBase: string },
): { sh: string; cmd?: string; ps1?: string } {
  const sh = path.join(workspace, "play.sh");
  fs.writeFileSync(sh, [
    "#!/bin/sh",
    'cd "$(dirname "$0")" || exit 1',
    `export FACTORIO_API_BASE="${options.apiBase}"`,
    'export PYTHONPATH="$PWD${PYTHONPATH:+:$PYTHONPATH}"',
    'export PATH="$PWD/bin:$PATH"',
    'exec python3 "$@"',
    "",
  ].join("\n"), { mode: 0o755 });
  if (!options.windows) return { sh };
  // cmd.exe needs CRLF for reliable label handling.
  const cmd = path.join(workspace, "play.cmd");
  fs.writeFileSync(cmd, [
    "@echo off",
    "setlocal",
    'cd /d "%~dp0"',
    `set "FACTORIO_API_BASE=${options.apiBase}"`,
    'set "PYTHONPATH=%~dp0;%PYTHONPATH%"',
    "where python >nul 2>nul",
    "if not errorlevel 1 goto autorio_python",
    "where py >nul 2>nul",
    "if not errorlevel 1 goto autorio_py",
    "echo autorio: no Windows Python found; use the WSL wrapper play.ps1 1>&2",
    "exit /b 9009",
    ":autorio_python",
    "python %*",
    "exit /b %errorlevel%",
    ":autorio_py",
    "py -3 %*",
    "exit /b %errorlevel%",
    "",
  ].join("\r\n"));
  const ps1 = path.join(workspace, "play.ps1");
  fs.writeFileSync(ps1, [
    "param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CommandArgs)",
    "$ErrorActionPreference = 'Continue'",
    `& wsl.exe -d '${options.distro}' -e sh '${options.workspaceWsl}/play.sh' @CommandArgs`,
    "exit $LASTEXITCODE",
    "",
  ].join("\n"));
  return { sh, cmd, ps1 };
}

export type DshOp =
  | { kind: "thread"; sessionId: string }
  | { kind: "reasoning"; text: string }
  | { kind: "message"; text: string }
  | { kind: "tool_start"; id: string; tool: string; command: string; input: unknown }
  | { kind: "tool_end"; id: string; tool?: string; command?: string; status: "completed" | "error"; output: string }
  | { kind: "usage"; usage: Record<string, number>; contextTokens: number }
  | { kind: "error"; message: string }
  | { kind: "final"; text: string };

export type DshTranslatorState = {
  pending: Map<string, { tool: string; command: string }>;
};

export function createDshState(): DshTranslatorState {
  return { pending: new Map() };
}

function toolCommand(tool: string, input: unknown): string {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (command) return command;
  const detail = record.path ?? record.filePath ?? record.file_path ?? record.pattern ?? record.url ?? record.query;
  if (typeof detail === "string" && detail.trim()) return `${tool} ${detail.trim()}`;
  return tool;
}

function usageOp(usage: unknown): Extract<DshOp, { kind: "usage" }> | null {
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const input = number(record.inputTokens);
  const output = number(record.outputTokens);
  const reasoning = number(record.reasoningTokens);
  const cacheRead = number(record.cacheReadTokens);
  const total = number(record.totalTokens) ?? (
    input !== undefined && output !== undefined ? input + output : undefined
  );
  const mapped: Record<string, number> = {};
  if (input !== undefined) mapped.input_tokens = input;
  if (output !== undefined) mapped.output_tokens = output;
  if (reasoning !== undefined) mapped.reasoning_output_tokens = reasoning;
  if (cacheRead !== undefined) mapped.cached_input_tokens = cacheRead;
  if (total !== undefined) mapped.total_tokens = total;
  return {
    kind: "usage",
    usage: mapped,
    contextTokens: (input ?? 0) + (cacheRead ?? 0),
  };
}

/**
 * Translate one `dsh --profile headless --json` event into transcript ops.
 * Unknown event types and malformed payloads yield no ops so a newer DSH
 * version cannot break a run.
 */
export function translateDshEvent(event: unknown, state: DshTranslatorState): DshOp[] {
  if (!event || typeof event !== "object") return [];
  const record = event as Record<string, any>;
  switch (record.type) {
    case "session":
      return typeof record.sessionId === "string" && record.sessionId
        ? [{ kind: "thread", sessionId: record.sessionId }]
        : [];
    case "thinking":
      return typeof record.text === "string" && record.text
        ? [{ kind: "reasoning", text: record.text }]
        : [];
    case "text":
      return typeof record.text === "string" && record.text
        ? [{ kind: "message", text: record.text }]
        : [];
    case "tool_call": {
      const id = typeof record.callId === "string" ? record.callId : "";
      const tool = typeof record.tool === "string" ? record.tool : "tool";
      if (!id) return [];
      const command = toolCommand(tool, record.input);
      state.pending.set(id, { tool, command });
      return [{ kind: "tool_start", id, tool, command, input: record.input }];
    }
    case "tool_result": {
      const id = typeof record.callId === "string" ? record.callId : "";
      if (!id) return [];
      const pending = state.pending.get(id);
      state.pending.delete(id);
      const status = record.status === "error" ? "error" : "completed";
      const output = typeof record.result === "string" ? record.result : "";
      return [{
        kind: "tool_end",
        id,
        tool: pending?.tool,
        command: pending?.command,
        status,
        output,
      }];
    }
    case "status": {
      if (record.phase === "step_end") {
        const usage = usageOp(record.usage);
        return usage ? [usage] : [];
      }
      if (record.phase === "turn_end") {
        const reason = record.reason;
        if (reason && typeof reason === "object" && reason.kind === "error") {
          const error = reason.error;
          const message = error && typeof error === "object"
            ? String(error.message || error.code || "DSH turn failed")
            : String(reason.message || "DSH turn failed");
          return [{ kind: "error", message }];
        }
        return [];
      }
      return [];
    }
    case "error":
      return typeof record.message === "string" && record.message
        ? [{ kind: "error", message: record.message }]
        : [];
    case "final":
      return typeof record.text === "string" ? [{ kind: "final", text: record.text }] : [];
    default:
      return [];
  }
}
