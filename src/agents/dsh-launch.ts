// DSH headless launch specification (`dsh --profile headless --json`).
//
// Pure: composes the task prompt (including the environment paragraph), the
// launcher args, the environment, the play wrappers and the model patch file.
// Runs.ts writes the files, spawns the process, persists agent-launch.json and
// pipes the task over stdin.
import path from "node:path";
import { dshArgs, dshEnvironmentPrompt, dshModelPatch, type DshModelSelection } from "../dsh.js";
import { toWslPath } from "../opencode.js";
import {
  agentEnv,
  agentPrompt,
  shortWaitGuardFiles,
  withWorkspacePythonPath,
  type AgentLaunchInput,
  type LaunchFile,
  type LaunchSpec,
} from "./launch-types.js";

/** Resolved launch facts; env/credential lookups happen in RunManager. */
export type DshLaunchInput = AgentLaunchInput & {
  executable: string;
  /** `readDshApiKey() || ""`; headless reads the key from the launch env. */
  apiKey: string;
  /** Resolved `AUTORIO_DSH_PROFILE` (default headless). */
  profile: string;
  /** Parsed provider/model/effort selection. */
  selection: DshModelSelection;
  /** WSL distribution used by the play wrappers. */
  distro: string;
  /** Whether a Windows Python is available for the primary play.cmd path. */
  windowsPython: boolean;
};

/**
 * Workspace wrappers the DSH prompt points at: `play.cmd` (Windows Python, the
 * primary path), `play.ps1` (WSL fallback), `play.sh` (runs inside WSL).
 * Byte-identical to `writeDshWrappers()` in src/dsh.ts; the launch split needs
 * the file plan without the fs write, and dsh.ts stays untouched this round.
 */
function dshWrapperFiles(
  workspace: string,
  options: { windows: boolean; distro: string; workspaceWsl: string; apiBase: string },
): LaunchFile[] {
  const files: LaunchFile[] = [
    {
      path: path.join(workspace, "play.sh"),
      mode: 0o755,
      content: [
        "#!/bin/sh",
        'cd "$(dirname "$0")" || exit 1',
        `export FACTORIO_API_BASE="${options.apiBase}"`,
        'export PYTHONPATH="$PWD${PYTHONPATH:+:$PYTHONPATH}"',
        'export PATH="$PWD/bin:$PATH"',
        'exec python3 "$@"',
        "",
      ].join("\n"),
    },
  ];
  if (!options.windows) return files;
  files.push({
    path: path.join(workspace, "play.cmd"),
    // cmd.exe needs CRLF for reliable label handling.
    content: [
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
    ].join("\r\n"),
  });
  files.push({
    path: path.join(workspace, "play.ps1"),
    content: [
      "param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CommandArgs)",
      "$ErrorActionPreference = 'Continue'",
      `& wsl.exe -d '${options.distro}' -e sh '${options.workspaceWsl}/play.sh' @CommandArgs`,
      "exit $LASTEXITCODE",
      "",
    ].join("\n"),
  });
  return files;
}

/** Build the DSH launch spec for a fresh, resumed or restarted run. */
export function dshLaunchSpec(input: DshLaunchInput): LaunchSpec {
  const model = `${input.selection.provider}/${input.selection.model}`;
  const workspaceWsl = input.windows ? toWslPath(input.workspace) : input.workspace;
  // DSH's headless shell sandbox can deny wsl.exe; when a Windows Python is
  // present the wrapper runs the stdlib client directly and avoids WSL.
  const environment = dshEnvironmentPrompt({
    windows: input.windows,
    windowsPython: input.windowsPython,
    distro: input.distro,
    workspaceWsl,
    apiBase: input.apiBase,
  });
  const prompt = environment + agentPrompt(input);
  const files = shortWaitGuardFiles(input.workspace);
  files.push(
    ...dshWrapperFiles(input.workspace, {
      windows: input.windows,
      distro: input.distro,
      workspaceWsl,
      apiBase: input.apiBase,
    }),
  );
  // Keep in sync with writeDshModelPatch() in src/dsh.ts (same filename/content).
  const patchPath = path.join(input.workspace, "dsh-model.patch.yml");
  files.push({ path: patchPath, content: dshModelPatch(input.selection) });
  const sessionId = input.resume && input.sessionId ? input.sessionId : undefined;
  const args = dshArgs({ profile: input.profile, patchPath, sessionId });
  const env = agentEnv(input);
  env.DEEPSEEK_API_KEY = input.apiKey;
  env.DSH_PROFILE = input.profile;
  delete env.DSH_SESSION_ID;
  delete env.DSH_PROFILE_DIR;
  withWorkspacePythonPath(env, input.workspace);
  const transport = input.windows ? "wsl-python" : "native";
  return {
    executable: input.executable,
    args,
    env,
    cwd: input.workspace,
    transport,
    stdinTask: prompt,
    launchInfo: {
      executable: input.executable,
      args,
      transport,
      model,
      session: input.resume ? input.sessionId : undefined,
      prompt_via: "stdin",
    },
    files,
  };
}
