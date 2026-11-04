// Shared launch contract for the agent backends.
//
// Each backend module turns a run description into a deterministic `LaunchSpec`:
// executable, argv, environment, workspace files and launch metadata. RunManager
// owns everything observable: it writes the files, spawns the process, writes
// agent-launch.json, pipes the stdin task and attaches capture/close handlers.
// Keeping specs pure lets tests assert prompts, args, env and wrapper files
// without a manager, a model or a game.
import path from "node:path";

/** A workspace file the backend needs before the process starts. */
export type LaunchFile = {
  path: string;
  /** Exact bytes; wrappers are byte-identical to the previous inline writers. */
  content: string;
  /** fs.writeFileSync mode; omitted keeps the platform default. */
  mode?: number;
};

/** OpenCode WSL launches leave a pid file the manager polls for cleanup. */
export type LaunchRemote = {
  distro: string;
  pidFile: string;
};

/** Deterministic description of one agent launch. */
export type LaunchSpec = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Working directory for the child process. */
  cwd: string;
  /** Physical transport ("native" | "wsl" | "wsl-python"), when tracked. */
  transport?: string;
  /** Task text delivered over stdin instead of argv (DSH). */
  stdinTask?: string;
  /** Persisted verbatim as agent-launch.json (RunManager adds api_base). */
  launchInfo: Record<string, unknown>;
  files: LaunchFile[];
  remote?: LaunchRemote;
};

/**
 * The run facts a backend needs. Environment-derived provider settings are
 * resolved by RunManager and passed in explicitly so specs stay deterministic
 * on every platform.
 */
export type AgentLaunchInput = {
  /** Absolute run workspace. */
  workspace: string;
  /** Base process environment; specs copy it and never mutate it. */
  env: NodeJS.ProcessEnv;
  /** API base URL handed to the agent. */
  apiBase: string;
  /** Whether the host manager is Windows (injected so tests cover both). */
  windows: boolean;
  resume: boolean;
  restart: boolean;
  language?: string;
  /** Session id to resume; set only when resuming. */
  sessionId?: string;
};

const DISCIPLINE_PROMPT =
  "Never run a shell `sleep` longer than 10 seconds. Use wait_for_item, wait_for_research, wait_for_factory or wait_until, and keep doing useful work while production runs. Batch at least five related actions or observations per tool call and print only a short summary. ";
const RESUME_PROMPT =
  "Continue the same benchmark from its saved game. Re-read AGENTS.md (automation-first rule) and RESUME.md, then re-observe the player/world before acting. ";
const RESTART_PROMPT =
  "Continue the same benchmark. The previous agent session was reset because its context reached the configured limit. Read AGENTS.md, STATE.md and RESUME.md, re-observe the game, then continue. ";
const BASE_TASK_PROMPT =
  "STEP 0 (mandatory, before any gameplay action): call the state API to write STATE.md (Python: client.write_state(current=..., scores={...}, done_when=..., next=...); CLI: state-write --current ...), or write STATE.md in this workspace with this template:\n" +
  "# STATE\nUpdated: <ISO-8601 timestamp>\nObjective: <from TASK.md>\nScores: production 0, logistics 0, mining 0, research 0, defense 0, exploration 0\nCurrent: <subtask name> (score 0)\nDone when: <quantified completion condition>\nNext: <first action>\n\n" +
  "Refresh STATE.md at least every 5 minutes and whenever the subtask changes. The manager blocks mutating actions with STATE_UPDATE_REQUIRED once STATE.md is older than 10 minutes (or missing after the startup grace period); STATE.md writes reset that deadline. " +
  "Before inventing a command, read the generated tool manifest (`factorio.py tools --json` or `client.tools()`): it lists every client method signature, parameter, CLI usage and manager endpoint. Do not read factorio.py source to discover the interface. " +
  "Read AGENTS.md, COOKBOOK.md and TASK.md, then play Factorio through the Python library until the objective is complete. " +
  "Update STATE.md whenever the current subtask or its done-when condition changes, and after completing a subtask; the operator view and crash recovery rely on it. " +
  "The cookbook has proven layouts and the error-recovery matrix; follow it before inventing new designs. " +
  "After every completed subtask (and at least every 10 tool calls) post one short user-facing progress message in the configured output language: what was completed, any blocker, and the next step. " +
  "You may rotate, mine or deconstruct your own buildings when fixing a layout; prefer rotating/reusing them over building around a mistake, and re-observe afterwards. " +
  "Watch the automation score in observe_factory().plan.automation: automate extraction and crafting instead of hand work (manual mines/crafts are penalty points). " +
  "Write Python scripts in this workspace as needed. The game is already running. Do not manage game processes or access raw RCON.";

/** Optional output-language instruction; empty when the run uses the default. */
export function languagePrompt(language?: string): string {
  if (!language) return "";
  const label = /^(?:chinese|中文|zh)/i.test(language) ? "Simplified Chinese (简体中文)" : language;
  return `CRITICAL OUTPUT LANGUAGE: ${label}. Think in ${label}: write your internal reasoning/thinking content, every reasoning summary and every user-facing message in ${label}. Do not write English prose. Keep code, commands, file paths, identifiers and in-game proper names unchanged. `;
}

/** Shared agent task prompt: language + discipline + resume/restart clause. */
export function agentPrompt(input: Pick<AgentLaunchInput, "language" | "resume" | "restart">): string {
  return (
    languagePrompt(input.language) +
    DISCIPLINE_PROMPT +
    (input.restart ? RESTART_PROMPT : input.resume ? RESUME_PROMPT : "") +
    BASE_TASK_PROMPT
  );
}

/** Environment handed to a child: process env plus the local API base. */
export function agentEnv(input: Pick<AgentLaunchInput, "env" | "apiBase">): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input.env, FACTORIO_API_BASE: input.apiBase };
  delete env.RCON_PASSWORD;
  delete env.OBS_WEBSOCKET_PASSWORD;
  return env;
}

/** Prepend the workspace so the stdlib client is importable from any script. */
export function withWorkspacePythonPath(env: NodeJS.ProcessEnv, workspace: string): NodeJS.ProcessEnv {
  env.PYTHONPATH = [workspace, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  return env;
}

/**
 * Hard-enforce the short-wait rule for agent shell/Python commands: a `sleep`
 * shim on PATH and a stdlib sitecustomize hook for Python scripts.
 */
export function shortWaitGuardFiles(workspace: string): LaunchFile[] {
  return [
    {
      path: path.join(workspace, "bin", "sleep"),
      mode: 0o755,
      content: [
        "#!/bin/sh",
        'n="${1:-0}"',
        'case "$n" in ""|*[!0-9.]*) exec /bin/sleep "$@" ;; esac',
        'if [ "${n%%.*}" -gt 10 ] 2>/dev/null; then',
        '  echo "[autoriods] sleep ${n}s capped to 10s; use wait_for_*" >&2',
        "  n=10",
        "fi",
        'exec /bin/sleep "$n"',
        "",
      ].join("\n"),
    },
    {
      path: path.join(workspace, "sitecustomize.py"),
      content: [
        "import time as _autoriods_time",
        "import sys as _autoriods_sys",
        "_autoriods_orig_sleep = _autoriods_time.sleep",
        "def _autoriods_sleep(seconds):",
        "    try:",
        "        value = float(seconds)",
        "    except (TypeError, ValueError):",
        "        return _autoriods_orig_sleep(seconds)",
        "    if value > 10:",
        '        print(f"[autoriods] sleep {value:g}s capped to 10s; use wait_for_*", file=_autoriods_sys.stderr, flush=True)',
        "        value = 10",
        "    return _autoriods_orig_sleep(value)",
        "_autoriods_time.sleep = _autoriods_sleep",
        "",
      ].join("\n"),
    },
  ];
}
