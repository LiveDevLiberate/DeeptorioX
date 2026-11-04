/** STATE.md freshness gate and canonical markdown rendering for agent plans. */

export const DEFAULT_STATE_SOFT_SECONDS = 300;
export const DEFAULT_STATE_HARD_SECONDS = 600;
export const DEFAULT_STATE_GRACE_SECONDS = 120;

export type StateGateInput = {
  hasState: boolean;
  ageSeconds: number | null;
  elapsedSeconds: number;
  softSeconds?: number;
  hardSeconds?: number;
  graceSeconds?: number;
};

export type StateGate = {
  has_state: boolean;
  age_seconds: number | null;
  soft_seconds: number;
  hard_seconds: number;
  grace_seconds: number;
  /** Soft reminder should be shown in responses. */
  due: boolean;
  /** Mutating actions must be refused until STATE.md is written/updated. */
  blocked: boolean;
  hint: string;
};

/** Evaluate the state-update deadline. Missing state is blocked after the grace period. */
export function evaluateStateGate(input: StateGateInput): StateGate {
  const soft = positive(input.softSeconds, DEFAULT_STATE_SOFT_SECONDS);
  const hard = Math.max(soft, positive(input.hardSeconds, DEFAULT_STATE_HARD_SECONDS));
  const grace = Math.max(0, Math.round(Number(input.graceSeconds ?? DEFAULT_STATE_GRACE_SECONDS)));
  const age = Number.isFinite(input.ageSeconds) && input.ageSeconds !== null ? input.ageSeconds : null;
  const blocked = !input.hasState ? input.elapsedSeconds >= grace : age === null || age >= hard;
  const due = !input.hasState || age === null || age >= soft;
  const reason = !input.hasState
    ? `Write STATE.md before acting (grace ${grace}s)`
    : `STATE.md is ${Math.round(age ?? 0)}s old (soft ${soft}s, hard ${hard}s)`;
  return {
    has_state: input.hasState,
    age_seconds: age,
    soft_seconds: soft,
    hard_seconds: hard,
    grace_seconds: grace,
    due,
    blocked,
    hint: `${reason}; call POST /api/agent/state (client.write_state) to update it.`,
  };
}

function positive(value: number | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

export const STATE_FIELDS = [
  "objective",
  "current",
  "done_when",
  "next",
  "timebox",
  "progress",
  "notes",
] as const;

export type StateWriteInput = {
  objective?: string;
  current: string;
  done_when?: string;
  next?: string;
  timebox?: string;
  progress?: string;
  notes?: string;
  scores?: Record<string, number>;
  markdown?: string;
};

export const STATE_SCORE_KEYS = [
  "production",
  "logistics",
  "mining",
  "research",
  "defense",
  "exploration",
] as const;

/** Render structured plan fields into the markdown format the UI/playbook parses. */
export function renderStateMarkdown(input: StateWriteInput, updatedAt = new Date()): string {
  if (typeof input.markdown === "string" && input.markdown.trim()) return input.markdown.trim() + "\n";
  const lines = ["# STATE", `Updated: ${updatedAt.toISOString()}`];
  if (input.objective) lines.push(`Objective: ${input.objective.trim()}`);
  const scores = input.scores || {};
  const scoreText = STATE_SCORE_KEYS.map((key) => `${key} ${clampScore(scores[key])}`).join(", ");
  lines.push(`Scores: ${scoreText}`);
  lines.push(`Current: ${input.current.trim()}`);
  if (input.done_when) lines.push(`Done when: ${input.done_when.trim()}`);
  if (input.next) lines.push(`Next: ${input.next.trim()}`);
  if (input.timebox) lines.push(`Timebox: ${input.timebox.trim()}`);
  if (input.progress) lines.push(`Progress: ${input.progress.trim()}`);
  if (input.notes) lines.push("", input.notes.trim());
  return lines.join("\n") + "\n";
}

function clampScore(value: unknown): number {
  const score = Math.round(Number(value));
  return Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
}
