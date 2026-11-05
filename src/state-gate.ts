/** Agent mutation classification for the STATE.md freshness gate. */

/**
 * True for external requests that can mutate the game. Observations, STATE
 * reads/writes, the tool manifest, job status/cancel and internal action-loopback
 * dispatches are deliberately excluded.
 */
export function isAgentMutationRequest(method: string, pathname: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  if (pathname === "/api/agent/jobs") return true;
  if (pathname.startsWith("/api/agent/act/")) return true;
  return false;
}

/** Structured nudge attached to STATE_UPDATE_REQUIRED responses. */
export function stateGateNudge(gate: {
  blocked: boolean;
  age_seconds: number | null;
  hard_seconds: number;
  hint: string;
}): {
  reason: "plan_stale";
  first_step: "write_state";
  message: string;
  age_seconds: number | null;
  hard_seconds: number;
} {
  return {
    reason: "plan_stale",
    first_step: "write_state",
    message: gate.hint,
    age_seconds: gate.age_seconds,
    hard_seconds: gate.hard_seconds,
  };
}
