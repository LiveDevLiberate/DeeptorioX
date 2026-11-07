/** STATE.md freshness gate and canonical markdown rendering for agent plans. */

export const DEFAULT_STATE_SOFT_SECONDS = 300;
export const DEFAULT_STATE_HARD_SECONDS = 600;
export const DEFAULT_STATE_GRACE_SECONDS = 120;
export const DEFAULT_STATE_RESUME_GRACE_SECONDS = 120;

export type StateGateInput = {
  hasState: boolean;
  ageSeconds: number | null;
  elapsedSeconds: number;
  softSeconds?: number;
  hardSeconds?: number;
  graceSeconds?: number;
  /** Seconds since the current segment started; only resumed segments get grace. */
  segmentElapsedSeconds?: number | null;
  /** Grace granted after resume before an old/missing plan blocks actions. */
  resumeGraceSeconds?: number;
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
  /** A post-resume grace currently permits actions with an old plan. */
  resume_grace_active: boolean;
  resume_grace_seconds: number;
  resume_grace_remaining_seconds: number | null;
  hint: string;
};

/** Evaluate the state-update deadline. Missing state is blocked after the grace period. */
export function evaluateStateGate(input: StateGateInput): StateGate {
  const soft = positive(input.softSeconds, DEFAULT_STATE_SOFT_SECONDS);
  const hard = Math.max(soft, positive(input.hardSeconds, DEFAULT_STATE_HARD_SECONDS));
  const grace = Math.max(0, Math.round(Number(input.graceSeconds ?? DEFAULT_STATE_GRACE_SECONDS)));
  const age = Number.isFinite(input.ageSeconds) && input.ageSeconds !== null ? input.ageSeconds : null;
  const resumeGrace = Math.max(0, Math.round(Number(input.resumeGraceSeconds ?? 0)));
  const segmentElapsed =
    Number.isFinite(input.segmentElapsedSeconds) && input.segmentElapsedSeconds !== null
      ? Math.max(0, Number(input.segmentElapsedSeconds))
      : null;
  const resumeGraceActive =
    Boolean(input.hasState) && resumeGrace > 0 && segmentElapsed !== null && segmentElapsed < resumeGrace;
  const blocked =
    !resumeGraceActive && (!input.hasState ? input.elapsedSeconds >= grace : age === null || age >= hard);
  const due = !resumeGraceActive && (!input.hasState || age === null || age >= soft);
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
    resume_grace_active: resumeGraceActive,
    resume_grace_seconds: resumeGrace,
    resume_grace_remaining_seconds:
      resumeGraceActive && segmentElapsed !== null ? Math.round(resumeGrace - segmentElapsed) : null,
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

const CJK = /[\u3400-\u9fff]/;
const LATIN_WORD = /[A-Za-z]{3,}/;

function wantsLanguage(language: string | undefined, pattern: RegExp): boolean {
  return Boolean(language && pattern.test(language));
}

function stateFieldMismatch(value: unknown, language: string | undefined): boolean {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  if (wantsLanguage(language, /chinese|中文|zh/i)) {
    return LATIN_WORD.test(text) && /\s/.test(text) && !CJK.test(text);
  }
  if (wantsLanguage(language, /english|\ben\b/i)) return CJK.test(text);
  return false;
}

/** Fields whose natural language should follow the run output language. */
export function stateLanguageMismatches(input: StateWriteInput, language?: string): string[] {
  const fields: Array<[string, unknown]> = [
    ["objective", input.objective],
    ["current", input.current],
    ["done_when", input.done_when],
    ["next", input.next],
    ["timebox", input.timebox],
    ["progress", input.progress],
    ["notes", input.notes],
  ];
  const mismatched = fields.filter(([, value]) => stateFieldMismatch(value, language)).map(([name]) => name);
  if (input.markdown) {
    const parsed: Record<string, string> = {};
    for (const line of input.markdown.split(/\r?\n/)) {
      const match = /^(Objective|Current|Done when|Next):\s*(.*)$/i.exec(line.trim());
      if (match) parsed[match[1].toLowerCase().replace(" ", "_")] = match[2];
    }
    for (const [name, value] of Object.entries(parsed)) {
      if (stateFieldMismatch(value, language) && !mismatched.includes(name)) mismatched.push(name);
    }
  }
  return mismatched;
}

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
