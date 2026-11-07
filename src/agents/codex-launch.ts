// Codex launch specification (`codex exec [--json|--color always] ...`).
//
// Pure: builds argv and environment from resolved RunManager inputs. Runs.ts
// spawns the process and keeps the JSONL/terminal capture and close logic.
import path from "node:path";
import type { ReasoningLevel } from "../run-labels.js";
import { agentEnv, agentPrompt, type AgentLaunchInput, type LaunchSpec } from "./launch-types.js";

/** Resolved launch facts; RunManager resolves the executable and sandbox default. */
export type CodexLaunchInput = AgentLaunchInput & {
  executable: string;
  model?: string;
  reasoningEffort?: ReasoningLevel;
  /** Terminal viewer runs native output instead of `--json`. */
  terminal: boolean;
  /** `AUTORIO_CODEX_SANDBOX` or the platform default. */
  sandbox: string;
};

/**
 * Extra Codex overrides for an OpenAI-compatible provider (for example
 * OpenCode Go → DeepSeek). Exported for the pre-launch credential check.
 */
export function codexProviderArgs(env: NodeJS.ProcessEnv): string[] {
  const provider = env.AUTORIO_CODEX_PROVIDER?.trim();
  if (!provider) return [];
  const baseUrl = env.AUTORIO_CODEX_BASE_URL?.trim();
  if (!baseUrl) throw new Error("AUTORIO_CODEX_PROVIDER requires AUTORIO_CODEX_BASE_URL");
  const envKey = env.AUTORIO_CODEX_ENV_KEY?.trim() || "OPENCODE_API_KEY";
  const wireApi = env.AUTORIO_CODEX_WIRE_API?.trim() || "responses";
  const quote = (value: string) => JSON.stringify(value);
  return [
    "-c",
    `model_provider=${quote(provider)}`,
    "-c",
    `model_providers.${provider}.name=${quote(provider)}`,
    "-c",
    `model_providers.${provider}.base_url=${quote(baseUrl)}`,
    "-c",
    `model_providers.${provider}.env_key=${quote(envKey)}`,
    "-c",
    `model_providers.${provider}.wire_api=${quote(wireApi)}`,
    ...(env.AUTORIO_CODEX_CONTEXT_WINDOW
      ? ["-c", `model_context_window=${Number(env.AUTORIO_CODEX_CONTEXT_WINDOW)}`]
      : []),
  ];
}

/** Build the Codex launch spec for a fresh, resumed or restarted run. */
export function codexLaunchSpec(input: CodexLaunchInput): LaunchSpec {
  const args = [
    "exec",
    ...(input.terminal ? ["--color", "always"] : ["--json"]),
    "--ignore-user-config",
    // Codex's Windows sandbox rejects every spawned command, so Windows needs full access.
    "--sandbox",
    input.sandbox,
    "-c",
    "sandbox_workspace_write.network_access=true",
    "--skip-git-repo-check",
    "-C",
    input.workspace,
    "--output-last-message",
    path.join(input.workspace, "REPORT.md"),
  ];
  if (input.model) args.push("--model", input.model);
  if (input.reasoningEffort)
    args.push("-c", `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`);
  args.push(...codexProviderArgs(input.env));
  if (input.resume && input.sessionId) args.push("resume", input.sessionId);
  // Tests launch Codex through a .cmd shim, and cmd.exe rejects command lines over
  // ~8 KiB. The production prompt is longer than that, so tests may shorten it.
  args.push(process.env.AUTORIO_TEST_AGENT_PROMPT || agentPrompt(input));
  return {
    executable: input.executable,
    args,
    env: agentEnv(input),
    cwd: input.workspace,
    launchInfo: { executable: input.executable, args },
    files: [],
  };
}
