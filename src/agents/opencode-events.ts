// OpenCode `run --format json` event translation.
//
// OpenCode streams newline-delimited JSON, but the transcript and activity logs
// use the Codex-shaped schema the browser already renders. This module is the
// pure half of that translation: it classifies one event into typed ops,
// dedupes session/reasoning ids and accumulates token usage. runs.ts keeps
// process handling, file writes and RunManager mutation and only applies ops.
import { quotaError } from "../quota.js";

/** Mutable translation state for one OpenCode agent launch (one JSONL stream). */
export type OpenCodeState = {
  /** Last session id reported by an event; dedupes thread.started ops. */
  sessionId?: string;
  /** Fallback transcript ids, matching the historical `opencode-*-<n>` scheme. */
  sequence: number;
  /** Reasoning dedup keys: part id, or messageID plus a text prefix. */
  thoughtIds: Set<string>;
  /** Accumulated token usage; seeded from an earlier segment when restarting. */
  usage: Record<string, number>;
};

export function createOpenCodeState(initialUsage: Record<string, number> = {}): OpenCodeState {
  return { sessionId: undefined, sequence: 0, thoughtIds: new Set(), usage: { ...initialUsage } };
}

/**
 * One observable effect the RunManager must apply, in order. Ops carry every
 * id, dedup decision and usage total the transcript/log writers need, so
 * translation stays pure and testable; the applier lives in runs.ts.
 */
export type OpenCodeOp =
  | { kind: "thread"; sessionId: string }
  | { kind: "message"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string; thought: boolean }
  | {
      kind: "command";
      id: string;
      command: string;
      output: string;
      /** item.started while the tool is in flight, item.completed once finished. */
      phase: "started" | "completed";
      /** Transcript status; `failed` still uses item.started, like the old inline code. */
      status: "completed" | "failed" | "in_progress";
      /** Raw OpenCode `state.status` for the activity log (`running` when absent). */
      reportedStatus: string;
      exitCode: number | null;
    }
  | { kind: "usage"; usage: Record<string, number>; contextTokens: number }
  | { kind: "error"; message: string; quota?: string };

/** What runs.ts must do with each op; implemented by the launchOpenCode applier. */
export type OpenCodeOpApplier = (op: OpenCodeOp) => void;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** First non-empty string, matching the historical `a || b || fallback` chains. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Render a decoded JSON value the way the historical template literals did for
 * strings (verbatim) without the `[object Object]` fallback for odd payloads.
 */
function display(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return `${value}`;
  if (value === null || value === undefined) return `${value}`;
  const json = JSON.stringify(value);
  return json === undefined ? "" : json;
}

/**
 * Translate one OpenCode JSON event into transcript ops. Unknown event types and
 * malformed payloads yield no ops (or only a session op when the event still
 * carries a new session id), so a newer OpenCode version cannot break a run.
 */
export function translateOpenCodeEvent(event: unknown, state: OpenCodeState): OpenCodeOp[] {
  const source = record(event);
  if (!source) return [];
  const ops: OpenCodeOp[] = [];
  const sessionId = text(source.sessionID);
  if (sessionId && sessionId !== state.sessionId) {
    state.sessionId = sessionId;
    ops.push({ kind: "thread", sessionId });
  }
  const part = record(source.part);
  switch (source.type) {
    case "text": {
      const body = part ? text(part.text) : undefined;
      if (!part || !body) return ops;
      const id = text(part.id) ?? `opencode-text-${++state.sequence}`;
      return [...ops, { kind: "message", id, text: body }];
    }
    case "reasoning": {
      const body = part ? text(part.text) : undefined;
      if (!part || !body) return ops;
      const explicitId = text(part.id);
      // `messageID:text-prefix` is the historical dedup key when OpenCode emits
      // reasoning chunks without part ids.
      const dedupKey = explicitId ?? `${String(part.messageID)}:${body.slice(0, 48)}`;
      const thought = !state.thoughtIds.has(dedupKey);
      if (thought) state.thoughtIds.add(dedupKey);
      const id = explicitId ?? `opencode-reasoning-${++state.sequence}`;
      return [...ops, { kind: "reasoning", id, text: body, thought }];
    }
    case "tool_use": {
      const tool = (part ? text(part.tool) : undefined) ?? "tool";
      const partState = part ? record(part.state) : undefined;
      const input = (partState ? record(partState.input) : undefined) ?? {};
      const detailValue = input.filePath || input.path || input.pattern;
      const detail = detailValue ? display(detailValue) : undefined;
      const commandValue = input.command || (detail ? `${tool} ${detail}` : tool);
      const command = typeof commandValue === "string" ? commandValue : display(commandValue);
      const reportedStatus = (partState ? text(partState.status) : undefined) ?? "running";
      const output = partState && typeof partState.output === "string" ? partState.output : "";
      const metadata = partState ? record(partState.metadata) : undefined;
      const nested = metadata ? record(metadata.metadata) : undefined;
      const exit = nested?.exit ?? metadata?.exit;
      const exitCode = typeof exit === "number" && Number.isFinite(exit) ? exit : null;
      const completed = reportedStatus === "completed";
      const failed = reportedStatus === "error" || reportedStatus === "failed";
      const id = (part ? text(part.id) : undefined) ?? `opencode-tool-${++state.sequence}`;
      return [
        ...ops,
        {
          kind: "command",
          id,
          command,
          output,
          phase: completed ? "completed" : "started",
          status: completed ? "completed" : failed ? "failed" : "in_progress",
          reportedStatus,
          exitCode,
        },
      ];
    }
    case "step_finish": {
      const tokens = part ? record(part.tokens) : undefined;
      if (!tokens) return ops;
      const cache = record(tokens.cache);
      const inputTokens = count(tokens.input);
      const outputTokens = count(tokens.output);
      const reasoningTokens = count(tokens.reasoning);
      const cacheRead = count(cache?.read);
      state.usage.input_tokens = (state.usage.input_tokens || 0) + inputTokens;
      state.usage.output_tokens = (state.usage.output_tokens || 0) + outputTokens;
      state.usage.reasoning_output_tokens = (state.usage.reasoning_output_tokens || 0) + reasoningTokens;
      // OpenCode reports cache reads cumulatively; never add them across steps.
      state.usage.cached_input_tokens = Math.max(state.usage.cached_input_tokens || 0, cacheRead);
      state.usage.total_tokens = (state.usage.input_tokens || 0) + (state.usage.output_tokens || 0);
      // Context is this step's prompt size, not the accumulated billing total.
      return [...ops, { kind: "usage", usage: { ...state.usage }, contextTokens: inputTokens + cacheRead }];
    }
    case "error": {
      const errorValue = record(source.error);
      const dataValue = errorValue ? record(errorValue.data) : undefined;
      const message =
        (dataValue ? text(dataValue.message) : undefined) ??
        (errorValue ? text(errorValue.message) : undefined) ??
        text(source.message) ??
        "OpenCode error";
      // OpenCode quota failures arrive as plain error messages, so classify the
      // message exactly like the historical synthetic error event did.
      const quota = quotaError({ type: "error", message, error: { message } });
      return [...ops, quota ? { kind: "error", message, quota } : { kind: "error", message }];
    }
    default:
      return ops;
  }
}
