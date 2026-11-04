// Codex `exec --json` event translation.
//
// Codex writes newline-delimited JSON events that autorio persists verbatim in
// agent.events.jsonl for the browser transcript. This module is the pure
// classifier for those events: session id, reasoning/message activity, command
// activity, turn usage and quota failures. It also classifies the native-mode
// raw output patterns (session banner, error lines) so terminal runs keep their
// pass-through behavior. runs.ts keeps process handling, raw byte writes and
// RunManager mutation and only applies ops.
import { quotaError } from "../quota.js";

/** Mutable translation state for one Codex agent launch. */
export type CodexState = {
  /** Usage snapshot when the agent launched; turn.completed is merged onto it. */
  baseUsage: Record<string, number>;
};

export function createCodexState(initialUsage: Record<string, number> = {}): CodexState {
  return { baseUsage: { ...initialUsage } };
}

/**
 * One observable effect the RunManager must apply, in order. Codex JSON events
 * are already persisted as raw bytes, so these ops only drive run state and the
 * activity/thought logs; nothing is re-emitted into agent.events.jsonl.
 */
export type CodexOp =
  | { kind: "thread"; sessionId: string }
  | { kind: "reasoning"; text: string }
  | { kind: "message"; text: string }
  | { kind: "command"; command: string; status: string; output: string }
  | { kind: "usage"; usage: Record<string, number>; contextTokens?: number }
  | { kind: "error"; message: string; quota?: string };

/** What runs.ts must do with each op; implemented by the launchCodex applier. */
export type CodexOpApplier = (op: CodexOp) => void;

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Extract the session id Codex prints in native terminal mode (`session id: ...`). */
export function sessionIdFromCodexOutput(text: string): string | undefined {
  return text.replace(ANSI_PATTERN, "").match(/session id:\s*([a-zA-Z0-9-]+)/i)?.[1];
}

/** Native-mode stderr lines worth checking for account limits (not JSON tool output). */
export function isCodexNativeErrorLine(line: string): boolean {
  return /^(?:ERROR[: ]|you(?:'|’)?ve hit your usage limit)/i.test(line.replace(ANSI_PATTERN, "").trim());
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Render a decoded JSON value the way the historical template literals did for
 * strings/numbers (verbatim) without the `[object Object]` fallback for odd
 * payloads. `undefined` still renders as `undefined`, like a template literal.
 */
function display(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return `${value}`;
  if (value === null || value === undefined) return `${value}`;
  const json = JSON.stringify(value);
  return json === undefined ? "" : json;
}

/**
 * Translate one Codex JSON event into ops. Unknown event types and malformed
 * payloads yield no ops, so a newer Codex version cannot break a run.
 */
export function translateCodexEvent(event: unknown, state: CodexState): CodexOp[] {
  const source = record(event);
  if (!source) return [];
  switch (source.type) {
    case "thread.started": {
      const sessionId = source.thread_id;
      return typeof sessionId === "string" && sessionId ? [{ kind: "thread", sessionId }] : [];
    }
    case "turn.completed": {
      const usage = record(source.usage);
      if (!usage) return [];
      // Codex reports per-turn usage; merge it onto the launch snapshot instead
      // of summing turns, preserving the historical run.json totals.
      const merged: Record<string, number> = {};
      for (const [key, value] of Object.entries(usage)) {
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        merged[key] = value + (state.baseUsage[key] || 0);
      }
      const contextTokens = Number(merged.input_tokens) || undefined;
      return [{ kind: "usage", usage: merged, contextTokens }];
    }
    case "turn.failed":
    case "error": {
      const errorValue = record(source.error);
      const message =
        (errorValue && typeof errorValue.message === "string" && errorValue.message) ||
        (typeof source.message === "string" && source.message) ||
        "Codex error";
      const quota = quotaError(source);
      return [quota ? { kind: "error", message, quota } : { kind: "error", message }];
    }
    case "item.completed": {
      const item = record(source.item);
      if (!item) return [];
      switch (item.type) {
        case "reasoning":
          return [{ kind: "reasoning", text: typeof item.text === "string" ? item.text : "" }];
        case "agent_message":
          return [{ kind: "message", text: typeof item.text === "string" ? item.text : "" }];
        case "command_execution":
          // Strings, numbers and booleans render verbatim, matching the
          // historical activity text; malformed optional fields still render
          // as `undefined` there.
          return [
            {
              kind: "command",
              command: display(item.command),
              status: display(item.status),
              output: display(item.aggregated_output || ""),
            },
          ];
        default:
          return [];
      }
    }
    default:
      return [];
  }
}
