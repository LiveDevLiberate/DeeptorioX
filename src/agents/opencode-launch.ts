// OpenCode launch specification (`opencode run --format json ...`).
//
// Pure: builds argv, environment and the optional WSL launcher script from
// ResolvedRunManager inputs. Runs.ts writes the files, spawns the process and
// keeps the pid-file polling / capture / close logic.
import path from "node:path";
import { shellQuote, toWslPath } from "../opencode.js";
import {
  agentEnv,
  agentPrompt,
  shortWaitGuardFiles,
  withWorkspacePythonPath,
  type AgentLaunchInput,
  type LaunchSpec,
} from "./launch-types.js";

/** Resolved launch facts; env-derived helpers are called by RunManager. */
export type OpenCodeLaunchInput = AgentLaunchInput & {
  /** Model id already resolved through `opencodeModel()`. */
  model: string;
  /** Transport already resolved through `opencodeTransport()`. */
  transport: "native" | "wsl";
  /** Native binary: `OPENCODE_BIN` or `"opencode"`. */
  executable: string;
  /** WSL distribution (`AUTORIO_WSL_DISTRO` or its default). */
  wslDistro: string;
  /** Shell word for the WSL binary, already quoted by `wslBinCommand()`. */
  wslCommand: string;
};

/**
 * Build the OpenCode launch spec. The WSL branch returns the launcher script as
 * a spec file and the pid file to poll; the native branch returns argv as-is.
 */
export function openCodeLaunchSpec(input: OpenCodeLaunchInput): LaunchSpec {
  const prompt = agentPrompt(input);
  const command = [
    "run",
    "--format",
    "json",
    "--thinking",
    "--model",
    input.model,
    "--auto",
    ...(input.resume && input.sessionId ? ["--session", input.sessionId] : []),
    prompt,
  ];
  const env = agentEnv(input);
  // OpenCode reads its own stored credentials; inherited API keys can be stale.
  delete env.OPENCODE_API_KEY;
  withWorkspacePythonPath(env, input.workspace);
  // The generated bin/sleep shim only matters for POSIX-style shells.
  if (!input.windows)
    env.PATH = [path.join(input.workspace, "bin"), env.PATH].filter(Boolean).join(path.delimiter);
  const files = shortWaitGuardFiles(input.workspace);
  let executable: string;
  let args: string[];
  let transport: string;
  let remote: LaunchSpec["remote"];
  if (input.transport === "wsl") {
    const pidFile = path.join(input.workspace, "agent.pid");
    const script = path.join(input.workspace, "agent-launch.sh");
    const commandLine = [input.wslCommand, ...command.map(shellQuote)].join(" ");
    files.push({
      path: script,
      mode: 0o700,
      content: [
        "#!/bin/sh",
        `cd ${shellQuote(toWslPath(input.workspace))}`,
        `export PATH=${shellQuote(toWslPath(path.join(input.workspace, "bin")))}:"$PATH"`,
        `export PYTHONPATH=${shellQuote(toWslPath(input.workspace))}${"${PYTHONPATH:+:$PYTHONPATH}"}`,
        `echo $$ > ${shellQuote(toWslPath(pidFile))}`,
        `exec ${commandLine}`,
        "",
      ].join("\n"),
    });
    executable = "wsl.exe";
    args = ["-d", input.wslDistro, "-e", "sh", toWslPath(script)];
    transport = "wsl";
    remote = { distro: input.wslDistro, pidFile };
  } else {
    executable = input.executable;
    args = command;
    transport = "native";
  }
  return {
    executable,
    args,
    env,
    cwd: input.workspace,
    transport,
    remote,
    launchInfo: { executable, args, transport, model: input.model },
    files,
  };
}
