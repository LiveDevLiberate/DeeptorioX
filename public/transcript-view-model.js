// Pure view-model helpers for the live agent transcript (recording window).
//
// Everything here is DOM-free so it can be unit-tested with node:test:
// reasoning segmentation/dedupe, command → action summaries, command-group
// statistics, activity classification and loop/repeat detection. The renderer
// in recording.js only turns these models into elements.

/** Sliding window (number of recent signatures) used by LoopDetector. */
export const LOOP_WINDOW = 12;
/** How often the same signature must appear to flag a loop. */
export const LOOP_THRESHOLD = 3;
/** Reasoning segments shorter than this are joined with the next one. */
const MIN_SEGMENT_CHARS = 40;
/** Maximum length of a one-line summary. */
const SUMMARY_CHARS = 160;
/** How many trailing output lines are inspected for a JSON envelope. */
const OUTPUT_TAIL_LINES = 24;

/** Normalize whitespace and strip code so reasoning dedupe ignores formatting. */
export function normalizeReasoning(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Stable key for "did the agent say the same thing again". */
export function reasoningKey(text) {
  return normalizeReasoning(text).toLowerCase().slice(0, 400);
}

/** First sentence-ish slice of a paragraph, capped for a collapsed summary. */
export function firstSentence(text) {
  const clean = normalizeReasoning(text);
  if (!clean) return "";
  const match = clean.match(/^(.{1,240}?[.!?。！？])(?:\s|$)/);
  const sentence = (match ? match[1] : clean).trim();
  return sentence.length > SUMMARY_CHARS ? `${sentence.slice(0, SUMMARY_CHARS - 1)}…` : sentence;
}

/**
 * Split reasoning into display segments: blank-line paragraphs, joined when
 * tiny, each with a one-line summary (keyword-bearing sentence preferred) and
 * its body.
 */
export function splitReasoning(text) {
  const clean = String(text ?? "").trim();
  if (!clean) return [];
  const paragraphs = clean
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const merged = [];
  for (const part of paragraphs) {
    const last = merged.at(-1);
    if (last && last.length < MIN_SEGMENT_CHARS) merged[merged.length - 1] = `${last}\n\n${part}`;
    else merged.push(part);
  }
  return merged.map((body) => ({ summary: summarizeSegment(body), body }));
}

const PLAN_WORDS =
  /(next|plan|build|mine|research|craft|need|should|will|then|step|goal|todo|next step|下一步|计划|需要|然后|先|目标|建造|挖|研究)/i;
/**
 * Stricter decision detection for the amber "plan" frames: only imperative /
 * forward-looking plans count, not narrative sentences that happen to mention
 * building or moving something.
 */
const DECISION_WORDS =
  /(next step|next,? i|my plan|the plan is|goal is|i (need|should|will|'ll) (to )?(build|mine|craft|place|check|run|try|research|make|fix|move|do)|now i(?:'ll| will)|let's |let me (now )?(try|build|mine|check|run|place|make|fix|move)|下一步|接下来|计划|目标|先建|先做|先挖|然后我|我需要|我先)/i;

/** Prefer the first keyword-bearing sentence, otherwise a representative one. */
function summarizeSegment(body) {
  const sentences = body
    .replace(/```[\s\S]*?```/g, " ")
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((sentence) => sentence.replace(/^[-*#>\s]+/, "").trim())
    .filter(Boolean);
  const keyword = sentences.find((sentence) => PLAN_WORDS.test(sentence));
  const first = sentences[0] || "";
  // Merged tiny paragraphs can start with a useless one-liner; prefer the
  // longest sentence when the first one is too short to say anything.
  const representative =
    first.length >= MIN_SEGMENT_CHARS
      ? first
      : [...sentences].sort((left, right) => right.length - left.length)[0] || first;
  const summary = firstSentence(keyword || representative || body);
  return summary || firstSentence(body);
}

/** Collapse consecutive identical sentences inside a long thought. */
export function collapseRepeatedSentences(text) {
  const parts = String(text ?? "").split(/\n+/);
  const out = [];
  for (const part of parts) {
    const key = normalizeReasoning(part).toLowerCase();
    const last = out.at(-1);
    if (last && key && key === last.key) last.count += 1;
    else out.push({ text: part, key, count: 1 });
  }
  return out.map((entry) => (entry.count > 1 ? `${entry.text} (×${entry.count})` : entry.text)).join("\n");
}

/** Format an elapsed millisecond value as `+m:ss` (used for event timestamps). */
export function formatRelativeMs(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `+${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Compact action duration: `450ms`, `1.4s`, `1m 05s`. */
export function formatDurationText(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const seconds = Math.round(value / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Classify a transcript item for the status bar activity label. */
export function classifyActivity(item) {
  if (!item) return "output";
  if (item.type === "command_execution")
    return item.status === "completed" || item.status === "failed" ? "thinking" : "acting";
  if (item.type === "reasoning") return "thinking";
  if (item.type === "agent_message") return "reporting";
  if (item.type === "error") return "error";
  return "output";
}

const CATEGORY_BY_PREFIX = [
  ["act-build-blueprint", "build"],
  ["act-build-belt", "build"],
  ["act-build-loader", "build"],
  ["act-build", "build"],
  ["build-", "build"],
  ["act-mine", "mine"],
  ["deconstruct-area", "deconstruct"],
  ["act-move", "move"],
  ["move-to", "move"],
  ["act-rotate", "rotate"],
  ["act-set-recipe", "recipe"],
  ["act-craft", "craft"],
  ["act-research", "research"],
  ["act-insert", "insert"],
  ["act-extract", "extract"],
  ["act-launch-rocket", "rocket"],
  ["act-copy-settings", "settings"],
  ["observe-", "observe"],
  ["job-status", "job"],
  ["job-cancel", "job"],
  ["wait-", "wait"],
  ["wait", "wait"],
  ["server-", "server"],
  ["run-", "run"],
];

const BADGE_LABELS = {
  build: "build",
  mine: "mine",
  deconstruct: "remove",
  move: "move",
  rotate: "rotate",
  recipe: "recipe",
  craft: "craft",
  research: "research",
  insert: "insert",
  extract: "extract",
  rocket: "rocket",
  settings: "settings",
  observe: "observe",
  job: "job",
  wait: "wait",
  server: "server",
  run: "run",
  script: "script",
  action: "act",
  other: "cmd",
};

/**
 * Describe one command_execution item: category, target, outcome summary and
 * a loop-detection key. Never throws on odd payloads.
 */
export function summarizeCommand(item) {
  const command = String(item?.command ?? "");
  const action = extractFactorioAction(command);
  const category = categorize(action);
  const target = extractTarget(command);
  const data = parseEnvelope(item?.aggregated_output);
  const outcome = data.envelope ? summarizeEnvelope(action, category, data) : summarizeRawOutput(item);
  const failed =
    item?.status === "failed" ||
    (item?.exit_code != null && item.exit_code !== 0) ||
    data.envelope?.ok === false ||
    data.envelope?.data?.ok === false ||
    (Array.isArray(data.envelope?.data?.results) &&
      data.envelope.data.results.some((result) => result?.ok === false) === true);
  const key = `${category}:${action ?? ""}:${target ?? ""}:${commandHash(command)}`;
  const durationMs = Number(item?.duration_ms ?? item?.wall_duration_ms ?? item?.duration);
  return {
    category,
    label: BADGE_LABELS[category] || category,
    action,
    target,
    outcome,
    failed,
    running: item?.status === "in_progress",
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : null,
    key,
  };
}

function categorize(action) {
  if (!action) return "other";
  for (const [prefix, category] of CATEGORY_BY_PREFIX) {
    if (action === prefix || action.startsWith(prefix)) return category;
  }
  if (action === "") return "other";
  return action.startsWith("act-") ? "action" : "other";
}

/** Pull the `factorio.py <subcommand>` action out of a shell command. */
export function extractFactorioAction(command) {
  const text = String(command ?? "");
  const match = text.match(/factorio\.py(?:\s+(?:--[^\s=]+(?:[=\s]\S+)?|\S+?\.py))*\s+([a-z][a-z0-9-]*)/i);
  return match ? match[1].toLowerCase() : null;
}

/** Extract a compact target like `(129,-26)` or `(0,0)→(10,4)` from CLI args. */
export function extractTarget(command) {
  const text = String(command ?? "");
  const from = text.match(/--from[=\s]+[("']?(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  const to = text.match(/--to[=\s]+[("']?(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (from && to) return `(${from[1]},${from[2]})→(${to[1]},${to[2]})`;
  // `--entity stone-furnace,10,20,0` / `--entity inserter,4,5`
  const entity = text.match(/--entity[=\s]+[^,\s]+,(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (entity) return `(${entity[1]},${entity[2]})`;
  const target = text.match(
    /--(?:target|targets-json|center-x)[=\s]+[("']?(-?\d+(?:\.\d+)?)(?:(?:,|\s)+(-?\d+(?:\.\d+)?))?/,
  );
  if (target && target[2] !== undefined) return `(${target[1]},${target[2]})`;
  const center = text.match(/--center-x[=\s]+(-?\d+(?:\.\d+)?)/);
  const centerY = text.match(/--center-y[=\s]+(-?\d+(?:\.\d+)?)/);
  if (center && centerY) return `(${center[1]},${centerY[1]})`;
  const windowX = text.match(/--window-x[=\s]+(-?\d+(?:\.\d+)?)/);
  const windowY = text.match(/--window-y[=\s]+(-?\d+(?:\.\d+)?)/);
  if (windowX && windowY) return `(${windowX[1]},${windowY[1]})`;
  return null;
}

function commandHash(command) {
  let hash = 0;
  for (let index = 0; index < command.length; index += 1) {
    hash = (hash * 31 + command.charCodeAt(index)) | 0;
  }
  return String(hash);
}

/** Find the last JSON object in command output (the client/CLI envelope). */
export function parseEnvelope(output) {
  const lines = String(output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-OUTPUT_TAIL_LINES);
  for (const line of [...lines].reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") return { envelope: parsed };
    } catch {
      /* keep looking backwards */
    }
  }
  return { envelope: null };
}

function summarizeEnvelope(action, category, { envelope }) {
  const data = envelope?.data && typeof envelope.data === "object" ? envelope.data : envelope;
  if (envelope?.error) return String(envelope.error).slice(0, 120);
  if (data?.error) return String(data.error).slice(0, 120);
  const results = Array.isArray(data?.results) ? data.results : null;
  if (results && ["build", "mine", "deconstruct", "settings"].includes(category)) {
    const ok = results.filter((result) => result?.ok !== false).length;
    const failed = results.length - ok;
    const mined = results.reduce((sum, result) => sum + (Number(result?.mined_count) || 0), 0);
    const items = mergeItems(results);
    const parts = [`${ok}/${results.length} ok`];
    if (failed) parts.push(`${failed} failed`);
    if (mined) parts.push(`mined ${mined}`);
    if (items) parts.push(items);
    return parts.join(" · ");
  }
  if (category === "observe") {
    const rates = data?.production_per_minute;
    if (rates && typeof rates === "object") {
      const top = Object.entries(rates)
        .filter(([, rate]) => Number(rate) > 0)
        .sort((left, right) => Number(right[1]) - Number(left[1]))
        .slice(0, 2)
        .map(([name, rate]) => `${name} ${Math.round(Number(rate))}/min`);
      if (top.length) return top.join(" · ");
      return "idle";
    }
    if (action === "observe-area") {
      const counts = data?.counts || {};
      const shown = counts.included ?? counts.matched ?? counts.total;
      const matched = counts.matched ?? counts.total;
      if (shown != null) return `${shown}/${matched != null ? matched : shown} entities`;
    }
    if (action === "observe-fluids") {
      const fluids = data?.fluids || {};
      const top = Object.entries(fluids)
        .map(([name, value]) => [name, Number(value?.amount ?? value) || 0])
        .sort((left, right) => right[1] - left[1])[0];
      if (top && top[1] > 0) return `${top[0]} ${Math.round(top[1])}`;
      return data?.counts ? `${data.counts.pipe || data.counts.tank || "0"} fluid entities` : "no fluid";
    }
    if (action === "observe-combat") {
      const counts = data?.counts || {};
      return `${counts.enemy_total || 0} enemies · ${counts.turrets || 0} turrets`;
    }
    if (action === "observe-player") {
      const player = data?.player || data;
      if (player?.health != null) return `health ${player.health}`;
    }
    if (action === "observe-factory") {
      const activeProblems = Object.entries(data?.problems || {})
        .map(([name, list]) => [name, Array.isArray(list) ? list.length : Number(list) || 0])
        .filter(([, count]) => count > 0)
        .slice(0, 3)
        .map(([name, count]) => `${count} ${name}`);
      if (activeProblems.length) return activeProblems.join(" · ");
      if (data?.counts && typeof data.counts === "object") {
        const count = Object.values(data.counts).find((value) => typeof value === "number");
        if (count != null) return `${count} entities`;
      }
    }
    if (data?.counts) {
      const count = Object.values(data.counts).find((value) => typeof value === "number");
      if (count != null) return `${count} entities`;
    }
    if (data?.ok === false) return String(data.error || "not connected");
    return "observed";
  }
  if (data?.job_id) return String(data.status || "submitted");
  if (data?.status) return String(data.status);
  if (data?.ok === true) return "ok";
  if (data?.ok === false) return "failed";
  if (action) return action;
  return "";
}

function mergeItems(results) {
  const counts = new Map();
  for (const result of results) {
    const items = result?.items;
    if (!items || typeof items !== "object") continue;
    for (const [name, count] of Object.entries(items)) {
      counts.set(name, (counts.get(name) || 0) + Number(count || 0));
    }
  }
  if (!counts.size) return "";
  return [...counts.entries()]
    .slice(0, 2)
    .map(([name, count]) => `+${count} ${name}`)
    .join(" ");
}

function summarizeRawOutput(item) {
  const output = String(item?.aggregated_output ?? "").trim();
  if (!output) return item?.status === "failed" ? "failed" : "";
  const line = output.split("\n").find((candidate) => candidate.trim());
  const clean = line.replace(/\s+/g, " ").trim();
  return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean;
}

/** Aggregate a command group: "12 build · 3 mine · 1 failed". */
export function summarizeCommandGroup(items, options = {}) {
  const counts = new Map();
  let failed = 0;
  let running = false;
  for (const item of items) {
    const summary = summarizeCommand(item);
    counts.set(summary.category, (counts.get(summary.category) || 0) + 1);
    if (summary.failed) failed += 1;
    if (summary.running) running += 1;
  }
  const order = [
    "build",
    "mine",
    "deconstruct",
    "observe",
    "craft",
    "research",
    "wait",
    "job",
    "script",
    "other",
  ];
  const labels = options.labels || {};
  const parts = [...counts.entries()]
    .sort((left, right) => order.indexOf(left[0]) - order.indexOf(right[0]))
    .map(([category, count]) => `${count} ${labels[category] || BADGE_LABELS[category] || category}`);
  if (failed) parts.push(`${failed} ${options.failed || "failed"}`);
  if (running) parts.push(`${running} ${options.running || "running"}`);
  const fallback =
    typeof options.ran === "function"
      ? options.ran(items.length)
      : `Ran ${items.length} command${items.length === 1 ? "" : "s"}`;
  return { text: parts.length ? parts.join(" · ") : fallback, failed, running };
}

/** Describe a non-command transcript item for the collapsed tool row. */
export function summarizeTool(item) {
  const type = String(item?.type || "tool").replaceAll("_", " ");
  const detailCandidate =
    item?.command || item?.path || item?.name || item?.tool_name || item?.arguments || "";
  const detail =
    typeof detailCandidate === "string" ? detailCandidate : JSON.stringify(detailCandidate ?? "");
  const clean = String(detail).replace(/\s+/g, " ").trim();
  return {
    label: type,
    detail: clean.length > 120 ? `${clean.slice(0, 119)}…` : clean,
  };
}

/** Signature used for loop detection: repeated identical actions. */
export function loopKey(summary) {
  return summary.key;
}

/** Sliding-window detector for repeated actions or repeated thoughts. */
export class LoopDetector {
  constructor({ threshold = LOOP_THRESHOLD, window = LOOP_WINDOW } = {}) {
    this.threshold = Math.max(2, Number(threshold) || LOOP_THRESHOLD);
    this.window = Math.max(this.threshold, Number(window) || LOOP_WINDOW);
    this.keys = [];
    this.counts = new Map();
  }

  /** Record a signature; returns {count, repeated} for that signature. */
  push(key) {
    if (!key) return { count: 0, repeated: false };
    this.keys.push(key);
    const count = (this.counts.get(key) || 0) + 1;
    this.counts.set(key, count);
    while (this.keys.length > this.window) {
      const dropped = this.keys.shift();
      const remaining = this.counts.get(dropped) - 1;
      if (remaining <= 0) this.counts.delete(dropped);
      else this.counts.set(dropped, remaining);
    }
    return { count, repeated: count >= this.threshold };
  }

  reset() {
    this.keys = [];
    this.counts.clear();
  }
}

/** True when a reasoning block contains a plan/decision keyword (filter mode). */
export function isDecisionText(text) {
  // Every run now starts a reasoning entry with a `目标:` / `Goal:` line. That
  // line is a label, not a decision, so exclude it before matching.
  const withoutGoal = String(text ?? "").replace(/^\s*(?:目标|goal)\s*[:：].*$/gim, " ");
  return DECISION_WORDS.test(normalizeReasoning(withoutGoal));
}

/** Normalize a numeric series into bar widths 0..100 (sparkline via div bars). */
export function miniBars(values, segments = 8) {
  const numeric = (Array.isArray(values) ? values : [])
    .map((value) => Number(value) || 0)
    .slice(-Math.max(1, segments));
  if (!numeric.length) return [];
  const max = Math.max(...numeric);
  const min = Math.min(...numeric);
  // A flat series (or tiny noise) reads as a flat mid-height sparkline instead
  // of a wall of near-full bars.
  if (max <= 0 || max - min <= Math.max(0.000001, max * 0.02)) {
    return numeric.map(() => 50);
  }
  return numeric.map((value) => Math.round(10 + ((value - min) / (max - min)) * 90));
}

/**
 * Relative change across the sampled series (last value vs first), rounded to a
 * percentage. `flat` when the change is within rounding noise.
 */
export function sparkTrend(values) {
  const numeric = (Array.isArray(values) ? values : []).map((value) => Number(value) || 0);
  if (numeric.length < 2) return { direction: "flat", percent: 0 };
  const first = numeric[0];
  const last = numeric.at(-1);
  const scale = Math.max(Math.abs(first), Math.abs(last), 1);
  const percent = Math.round(((last - first) / scale) * 100);
  if (Math.abs(percent) < 3) return { direction: "flat", percent };
  return { direction: percent > 0 ? "up" : "down", percent: Math.abs(percent) };
}

/** Six scored subtasks used by the STATE.md radar chart. */
export const SCORE_AXES = ["production", "logistics", "mining", "research", "defense", "exploration"];

/**
 * Geometry for a compact hexagonal score radar. Coordinates are an SVG
 * viewBox of `size` x `size`; the polygon uses each score clamped to 0..100.
 */
export function radarGeometry(scores, options = {}) {
  const size = Math.max(40, Number(options.size) || 96);
  const center = size / 2;
  const radius = Math.max(10, Number(options.radius) || size * 0.32);
  const labelRadius = radius + Math.max(7, size * 0.1);
  const max = Number(options.max) > 0 ? Number(options.max) : 100;
  const active = String(options.active || "");
  const ring = (fraction) =>
    SCORE_AXES.map((_, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / SCORE_AXES.length;
      return `${(center + Math.cos(angle) * radius * fraction).toFixed(2)},${(
        center +
        Math.sin(angle) * radius * fraction
      ).toFixed(2)}`;
    }).join(" ");
  const axes = SCORE_AXES.map((key, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / SCORE_AXES.length;
    const raw = Number(scores?.[key]);
    const value = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
    return {
      key,
      value,
      active: key === active,
      x: center + Math.cos(angle) * radius * (value / max),
      y: center + Math.sin(angle) * radius * (value / max),
      axisX: center + Math.cos(angle) * radius,
      axisY: center + Math.sin(angle) * radius,
      labelX: center + Math.cos(angle) * labelRadius,
      labelY: center + Math.sin(angle) * labelRadius,
      labelAnchor: Math.abs(Math.cos(angle)) < 0.25 ? "middle" : Math.cos(angle) > 0 ? "start" : "end",
    };
  });
  return {
    size,
    center,
    radius,
    rings: [0.25, 0.5, 0.75, 1].map(ring),
    axes,
    polygon: axes.map((axis) => `${axis.x.toFixed(2)},${axis.y.toFixed(2)}`).join(" "),
  };
}

/** Parse JSONL telemetry samples (raw text → objects, skipping malformed lines). */
export function parseTelemetryLines(text) {
  const samples = [];
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") samples.push(parsed);
    } catch {
      /* skip malformed telemetry lines */
    }
  }
  return samples;
}

/** Production rates per item from the most recent sample that has rates. */
export function telemetryRates(samples, { limit = 2 } = {}) {
  const withRates = (Array.isArray(samples) ? samples : [])
    .filter(
      (sample) => sample?.production_per_game_minute && typeof sample.production_per_game_minute === "object",
    )
    .at(-1);
  if (!withRates) return [];
  return Object.entries(withRates.production_per_game_minute)
    .map(([name, rate]) => ({ name, rate: Number(rate) || 0 }))
    .filter((entry) => entry.rate > 0)
    .sort((left, right) => right.rate - left.rate)
    .slice(0, Math.max(1, limit));
}

/** Rate series for one item across telemetry samples (for the mini sparkline). */
export function telemetrySeries(samples, item, segments = 8) {
  if (!item) return [];
  return (Array.isArray(samples) ? samples : [])
    .filter(
      (sample) => sample?.production_per_game_minute && typeof sample.production_per_game_minute === "object",
    )
    .slice(-Math.max(1, segments))
    .map((sample) => Number(sample.production_per_game_minute[item]) || 0);
}

/** Research label from the latest sample with research data: "automation 42%". */
/** Latest research name + normalized progress (or null when absent). */
export function telemetryResearchDetail(samples) {
  const withResearch = (Array.isArray(samples) ? samples : [])
    .filter((sample) => sample?.current_research)
    .at(-1);
  if (!withResearch) return null;
  const raw = Number(withResearch.research_progress);
  return {
    name: String(withResearch.current_research),
    progress: Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : null,
  };
}

export function telemetryResearch(samples) {
  const detail = telemetryResearchDetail(samples);
  if (!detail) return null;
  return detail.progress === null ? detail.name : `${detail.name} ${Math.round(detail.progress * 100)}%`;
}

/** Latest power satisfaction in the 0..1 range, or null. */
export function telemetryPowerSatisfaction(samples) {
  const list = Array.isArray(samples) ? samples : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const power = list[index]?.power;
    const satisfaction = power && typeof power === "object" ? power.satisfaction : null;
    if (typeof satisfaction === "number" && Number.isFinite(satisfaction)) {
      return Math.max(0, Math.min(1, satisfaction));
    }
  }
  return null;
}

/** Power satisfaction label from the latest telemetry sample: "power 98%". */
export function telemetryPower(samples) {
  const satisfaction = telemetryPowerSatisfaction(samples);
  return satisfaction === null ? null : `power ${Math.round(satisfaction * 100)}%`;
}

/**
 * Diff two telemetry samples into transcript event markers: newly researched
 * technologies, items that start producing, and rockets launched.
 */
export function telemetryMarkers(previous, next) {
  if (!previous || !next) return [];
  const markers = [];
  const previousResearch =
    previous.research && typeof previous.research === "object" ? previous.research : {};
  const nextResearch = next.research && typeof next.research === "object" ? next.research : {};
  for (const [name, done] of Object.entries(nextResearch)) {
    if (done && !previousResearch[name]) markers.push(`researched ${name}`);
  }
  const previousProduction =
    previous.production && typeof previous.production === "object" ? previous.production : {};
  const rates = next.production_per_game_minute;
  if (rates && typeof rates === "object") {
    for (const [item, rate] of Object.entries(rates)) {
      if (Number(rate) > 0 && !(Number(previousProduction[item]) > 0)) {
        markers.push(`${item} ${Math.round(Number(rate))}/min`);
      }
    }
  }
  if ((Number(next.rockets) || 0) > (Number(previous.rockets) || 0)) {
    markers.push(`rocket launched (${next.rockets})`);
  }
  return markers.slice(0, 4);
}

/**
 * Normalize a run's benchmark map generation into view-ready seed/resource rows.
 * Returns null when the run has no benchmark map_gen (old runs / manual runs).
 */
export function mapSettingsView(run) {
  const benchmark = run?.benchmark && typeof run.benchmark === "object" ? run.benchmark : {};
  const map = benchmark.map_gen;
  if (!map || typeof map !== "object") return null;
  const numberOrText = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) return value.trim();
    return null;
  };
  const controls =
    map.autoplace_controls && typeof map.autoplace_controls === "object" ? map.autoplace_controls : {};
  const resources = Object.entries(controls).map(([name, raw]) => {
    const control = raw && typeof raw === "object" ? raw : {};
    return {
      name,
      frequency: numberOrText(control.frequency),
      size: numberOrText(control.size),
      richness: numberOrText(control.richness),
    };
  });
  const extras = Object.entries(map)
    .filter(([key]) => !["seed", "peaceful_mode", "autoplace_controls"].includes(key))
    .map(([key, value]) => ({
      key,
      value: value && typeof value === "object" ? JSON.stringify(value) : String(value),
    }));
  return {
    seed: numberOrText(map.seed ?? benchmark.seed),
    peaceful: typeof map.peaceful_mode === "boolean" ? map.peaceful_mode : null,
    resources,
    extras,
    raw: map,
  };
}
