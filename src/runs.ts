import fs from "node:fs";
import path from "node:path";
import { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { performance } from "node:perf_hooks";
import {
  ROOT,
  DATA_DIR,
  PORT,
  controlModHash,
  createMap,
  factorioVersion,
  execFileAsync,
} from "./runtime.js";
import { factorioLocale } from "./locale.js";
import {
  CRAFT_PENALTY_POINTS,
  CLEANUP_REWARD_POINTS,
  REFACTOR_REWARD_POINTS,
  manualPenaltyGraceActive,
  STATE_BLOCKED_PENALTY,
  STATE_DUE_PENALTY,
  computeAutomationScore,
  cleanupMineUnits,
  manualCraftUnits,
  manualMineUnits,
  trackPowerBlackout,
  type AutomationScore,
} from "./automation-score.js";
import {
  evaluateStateGate,
  renderStateMarkdown,
  type StateGate,
  type StateWriteInput,
  stateLanguageMismatches,
} from "./state-file.js";
import {
  Benchmark,
  Snapshot,
  loadBenchmarks,
  scoringForVariant,
  trackedMilestones,
  parseSnapshot,
  reached,
  TELEMETRY_COMMAND,
  type ScoringConfig,
} from "./benchmarks.js";
import {
  computeCapabilityScore,
  computeDiscipline,
  type CapabilityScore,
  type DisciplineMetrics,
} from "./evaluation-score.js";
import {
  ConstructionPlanError,
  constructionPlanHash,
  constructionPlanPublic,
  constructionVariant,
  normalizeConstructionEntity,
  normalizeConstructionTarget,
  planBBox,
  type ConstructionEntity,
  type ConstructionMode,
  type ConstructionPlan,
  type ConstructionPlanKind,
  type ConstructionTarget,
} from "./construction.js";
import { pointInRefactorCluster, type RefactorCluster } from "./refactor-audit.js";
import {
  blueprintRequiredItems,
  decodeBlueprintString,
  expandBlueprintPayload,
  transformBlueprintEntities,
} from "./blueprints.js";
import {
  planBeltLine,
  planBeltPath,
  planPipeLine,
  planPipePath,
  planPowerLine,
  planPowerNetwork,
  planPowerPath,
} from "./construction-planners.js";
import { normalizeMapGen } from "./map-config.js";
import {
  listRunBlueprints,
  readRunBlueprint,
  registerRunBlueprint,
  updateRunBlueprint,
  deleteRunBlueprint,
  type RegisterBlueprintInput,
  type RunBlueprintDetail,
  type RunBlueprintSummary,
} from "./run-blueprints.js";
import { openRunTerminal } from "./run-terminal.js";
import { pacificTimestamp, modelLabel, REASONING_LEVELS, ReasoningLevel } from "./run-labels.js";
import { quotaError } from "./quota.js";
import { sessionUsage } from "./token-usage.js";
import { ObsRunRecorder, obsEnabled, ensureObsRunning, connectObs } from "./obs.js";
import { renderTimelapse, verifyTimelapseMetadata } from "./timelapse.js";
import { openRunRecording } from "./recording-window.js";
import {
  IS_MACOS,
  IS_WINDOWS,
  codexExecutable,
  execExecutable,
  killProcessTree,
  resolveExecutable,
  spawnExecutable,
} from "./platform.js";
import {
  opencodeModel,
  opencodeTransport,
  opencodeVersionCommand,
  wslBinCommand,
  wslDistro,
} from "./opencode.js";
import {
  createDshState,
  dshExecutable,
  dshProfile,
  parseDshModel,
  readDshApiKey,
  translateDshEvent,
} from "./dsh.js";
import { codexLaunchSpec, codexProviderArgs } from "./agents/codex-launch.js";
import { dshLaunchSpec } from "./agents/dsh-launch.js";
import type { LaunchFile, LaunchSpec } from "./agents/launch-types.js";
import { openCodeLaunchSpec } from "./agents/opencode-launch.js";
import type { ActionJobRecord } from "./action-jobs.js";
import { asBoolean, asRecord } from "./validation.js";
import {
  createCodexState,
  isCodexNativeErrorLine,
  sessionIdFromCodexOutput,
  translateCodexEvent,
  type CodexOpApplier,
} from "./agents/codex-events.js";
import {
  createOpenCodeState,
  translateOpenCodeEvent,
  type OpenCodeOpApplier,
} from "./agents/opencode-events.js";

export type RunState =
  | "preparing"
  | "launching"
  | "running"
  | "saving"
  | "completed"
  | "failed"
  | "stopped"
  | "timed_out"
  | "interrupted"
  | "paused";
type Video = NonNullable<Run["video"]>;
type Segment = {
  index: number;
  state: RunState;
  started_at?: string;
  ended_at?: string;
  start_seconds: number;
  end_seconds?: number;
  event_offset: number;
  native_offset: number;
  session_id?: string;
  save_file?: string;
  video?: Video;
};
type StateMeta = {
  schema_version: 1;
  revision: number;
  updated_at: string;
  content_sha256: string;
  updated_by: "api" | "external";
};

type RefactorState = {
  audited_at: string;
  invalid_count: number;
  factory_problems: number;
  connection_issues: number;
  fingerprint: string;
  debt_since?: string;
  audits_with_debt: number;
  /** Warning only: debt survived for RESET_AUDITS audits or BIG_RESET_BLACKOUTS blackouts. */
  big_reset_pending: boolean;
  /** Highest invalid count observed during this run. */
  debt_peak?: number;
  /** Escalation ladder step derived from debt persistence. */
  escalation_tier?: "normal" | "expansion_blocked" | "relayout_only";
  /** Flagged rebuild windows the agent may build inside while expansion is gated. */
  clusters?: RefactorCluster[];
  /** Remaining in-cluster construction allowance (rebuild credits). */
  build_credits?: number;
  /** Credits earned by cleanup/deconstruction in this debt episode. */
  credits_earned?: number;
  /** Base repair credits were granted once for this debt episode. */
  base_credits_granted?: boolean;
  /** Top priority actions from the recorded audit, for 409 nudges and the UI. */
  actions?: Array<{ kind?: string; severity?: string; count?: number; action?: string }>;
};

/** Build target in world tile coordinates, used by the refactor build gate. */
export type RefactorBuildTarget = { x: number; y: number };

export type RefactorBuildCheck = {
  blocked: boolean;
  reason?: "expansion" | "credits";
  /** The gate is past its grace window and currently enforced. */
  armed: boolean;
  tier: "normal" | "expansion_blocked" | "relayout_only";
  build_credits: number;
  allowed_clusters: RefactorCluster[];
  out_of_cluster: number;
  message: string;
  actions: RefactorState["actions"];
};

type ConstructionMetrics = {
  planned_actions: number;
  free_actions: number;
  unplanned_actions: number;
  plan_requests: number;
  plan_rejections: number;
  plan_ineffective: number;
  plan_regressions: number;
  cleanup_units: number;
  blueprints_used: number;
  blueprint_entities_planned: number;
  blueprint_entities_placed: number;
  blueprint_entities_failed: number;
};

type ConstructionRunState = {
  mode: ConstructionMode;
  variant: string;
  plan_required: boolean;
  blueprints: {
    enabled: boolean;
    source: "none" | "agent" | "preloaded";
    catalog: string;
    catalog_hash?: string;
  };
  metrics: ConstructionMetrics;
};

type Run = {
  id: string;
  name?: string;
  reasoning_effort?: ReasoningLevel;
  benchmark: Benchmark;
  state: RunState;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  reason?: string;
  model?: string;
  language?: string;
  agent: "codex" | "opencode" | "dsh" | "manual";
  max_seconds: number;
  elapsed_seconds: number;
  segments?: Segment[];
  checkpoint?: { file: string; sha256: string; saved_at: string; segment: number };
  quota?: { message: string; detected_at: string };
  terminal: boolean;
  recording?: boolean;
  capture_video?: boolean;
  video?: {
    state: "pending" | "recording" | "rendering" | "ready" | "failed";
    capture_fps: 5;
    playback_fps: 30;
    speed: 6;
    raw_file?: string;
    file?: string;
    error?: string;
    metadata?: unknown;
  };
  output_format?: "events" | "native";
  baseline_tick?: number;
  latest?: Snapshot;
  baseline?: Snapshot;
  milestones: Record<
    string,
    { wall_seconds: number; game_ticks: number; observed_at: string; initial?: boolean }
  >;
  agent_exit?: AgentExit;
  /** Number of automatic same-session continuations after an early agent exit. */
  auto_continues?: number;
  /** Coarse failure category used by diagnostics and the run UI. */
  failure_kind?: string;
  session_id?: string;
  usage?: Record<string, number>;
  usage_status?: "final" | "last_reported" | "unavailable";
  usage_source?: "session_log" | "turn.completed" | "opencode" | "dsh";
  context_tokens?: number;
  context_limit?: number;
  session_resets?: number;
  versions?: Record<string, string>;
  hashes?: Record<string, string>;
  warnings: string[];
  actions: {
    submitted: number;
    completed: number;
    failed: number;
    cancelled: number;
    partial_failures: number;
  };
  /** Automated production score and manual-work penalty (updated with telemetry). */
  automation?: AutomationScore & { updated_at?: string };
  /** Resolved evaluation-scoring config snapshot (v2), fixed at run start. */
  scoring?: ScoringConfig;
  /** Capability + discipline evaluation (operator-only; never exposed to the agent). */
  evaluation?: {
    capability: CapabilityScore;
    discipline: DisciplineMetrics;
    computed_at: string;
  };
  /** Accumulated STATE.md due/blocked seconds for discipline metrics. */
  state_metrics?: { due_seconds: number; blocked_seconds: number };
  /** A power plant/generator has produced capacity at least once. */
  power_plant_seen?: boolean;
  /** Previous telemetry sample was a full blackout. */
  power_blackout_active?: boolean;
  /** Number of full-blackout transitions counted since power was established. */
  power_blackouts?: number;
  /** HTTP agent-interface call counts keyed by "METHOD /path". */
  tool_calls?: Record<string, number>;
  /** Last emitted STATE.md reminder stage, so markers are not duplicated. */
  state_reminder?: "due" | "blocked";
  /** First time the plan entered the hard-blocked stage. */
  state_blocked_since?: string;
  /** One active nudge/restart attempt per blocked cycle. */
  state_nudge_restarted?: boolean;
  /** Refactor debt/gate state updated by factory audits. */
  refactor?: RefactorState;
  /** Construction mode/policy snapshot and discipline counters. */
  construction?: ConstructionRunState;
  /** Audit revision used to invalidate construction plans after a new audit. */
  audit_revision?: number;
  /** Single-use construction plans issued for this run. */
  construction_plans?: ConstructionPlan[];
};
/** Metadata reported by timelapse rendering; persisted into run.json verbatim. */
export type VideoRenderResult = {
  file?: string;
  fps?: number;
  frames?: number;
  [key: string]: unknown;
};

/** Terminal child-process outcome recorded in run.json (`agent_exit`). */
export type AgentExit = { code: number | null; signal: string | null };

/** Automatic continuation budget; 0 disables the recovery loop. */
function autoContinueLimit(): number {
  const raw = process.env.AUTORIO_AUTO_CONTINUE_MAX;
  if (raw === undefined || raw.trim() === "") return 3;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 3;
}

/** Coarse, UI-friendly failure category. */
function classifyFailure(reason: string): string {
  if (/quota|usage limit/i.test(reason)) return "quota";
  if (/no valid game checkpoint|final save|checkpoint|save /i.test(reason)) return "save_failure";
  if (/launch failed|exited with|spawn|ENOENT/i.test(reason)) return "agent_crash";
  if (/telemetry failed|RCON/i.test(reason)) return "game_connection";
  if (/objective/i.test(reason)) return "agent_early_exit";
  return "run_failure";
}

type Hooks = {
  running(): boolean;
  openRecording?(dir: string): Promise<void>;
  startVideo?(dir: string): Promise<{ stop(): Promise<string> }>;
  renderVideo?(source: string, dir: string): Promise<VideoRenderResult>;
  start(save: string, profile: string, logFile: string, options?: { locale?: string }): Promise<void>;
  stop(): Promise<void>;
  command(lua: string, timeout?: number): Promise<string>;
  connect(): Promise<void>;
  cancelJobs(): Promise<void>;
};
const terminal = new Set<RunState>(["completed", "failed", "stopped", "timed_out", "interrupted", "paused"]);

/** Codex-shaped transcript item written to agent.events.jsonl and rendered by the web UI. */
type TranscriptItem = {
  id: string;
  received_at?: string;
  type: "agent_message" | "reasoning" | "command_execution" | "event_marker";
  text?: string;
  command?: string;
  status?: "completed" | "failed" | "error" | "in_progress";
  exit_code?: number | null;
  aggregated_output?: string;
};

/** One transcript line; the shared shape every agent backend emits for the UI. */
type TranscriptEvent = {
  type: "thread.started" | "item.started" | "item.completed" | "error";
  received_at?: string;
  thread_id?: string;
  message?: string;
  item?: TranscriptItem;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Counts per-item job results that explicitly reported a failure. */
export function failureCount(results: readonly unknown[]): number {
  return results.filter((result) => asRecord(result)?.ok === false).length;
}

// --- TTS/overlay reasoning digest -------------------------------------------
// The digest is deliberately simple and dependency-free (no imports from
// public/): the front-end transcript summary and the manager-side narration
// stream are independent heuristics.

/** Keywords that make a reasoning sentence a likely plan/decision line (English + Chinese). */
const DIGEST_KEYWORDS =
  /next|plan|build|mine|research|craft|need|should|will|then|goal|下一步|计划|需要|然后|先|目标|建造/i;
/** Hard cap for one digest line handed to TTS/overlay. */
export const DIGEST_MAX_CHARS = 200;
/** Sentence splitter that keeps CJK terminators (。！？) as sentence ends. */
const DIGEST_SENTENCE = /[^.!?。！？]+[.!?。！？]?/g;

/**
 * Condenses one reasoning chunk into a single narration line: drops code,
 * normalizes whitespace, prefers the first sentence containing a plan/decision
 * keyword and falls back to the first sentence, capped at DIGEST_MAX_CHARS.
 * Returns "" for empty or code-only chunks. `thought()` keeps the raw
 * `thoughts.log` stream unchanged and only mirrors this digest alongside it.
 */
export function digestThought(text: string): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  const sentences = (clean.match(DIGEST_SENTENCE) ?? []).map((sentence) => sentence.trim()).filter(Boolean);
  const chosen = sentences.find((sentence) => DIGEST_KEYWORDS.test(sentence)) ?? sentences[0] ?? clean;
  if (chosen.length <= DIGEST_MAX_CHARS) return chosen;
  const cut = chosen.slice(0, DIGEST_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 0 ? cut.slice(0, lastSpace).trimEnd() : cut;
}

function clusterCountInBBox(
  clusters: RefactorCluster[] | undefined,
  bbox: { left: number; top: number; right: number; bottom: number },
): number {
  let count = 0;
  for (const cluster of clusters ?? []) {
    const cx = Number(cluster.x);
    const cy = Number(cluster.y);
    const radius = Number(cluster.radius);
    if (![cx, cy, radius].every(Number.isFinite)) continue;
    const nearestX = Math.max(bbox.left, Math.min(cx, bbox.right));
    const nearestY = Math.max(bbox.top, Math.min(cy, bbox.bottom));
    if (Math.hypot(cx - nearestX, cy - nearestY) <= radius) count += Number(cluster.count) || 1;
  }
  return count;
}

function integerLayoutPoint(value: unknown): { x: number; y: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : undefined;
}

export class RunManager {
  readonly benchmarks = loadBenchmarks(ROOT);
  readonly root = path.join(DATA_DIR, "runs");
  private runs = new Map<string, Run>();
  private active?: Run;
  private agent?: ChildProcess;
  private opencodeRemote?: { distro: string; pidFile: string; pid?: number };
  private contextResetting = false;
  private stateNudging = false;
  private abort?: AbortController;
  private monitor?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private sampling = false;
  private ending?: Promise<void>;
  private preparation?: Promise<void>;
  private startedMono = 0;
  private elapsedBefore = 0;
  private telemetryErrors = 0;
  private stopRequested = false;
  private videoRecorder?: { stop(): Promise<string> };
  /** Last digest per run for consecutive-duplicate suppression (recovered from disk). */
  private digestTail = new Map<string, string | null>();
  /** Last time tool-call counters were flushed to run.json. */
  private toolCallPersist = new Map<string, number>();

  constructor(private hooks: Hooks) {
    fs.mkdirSync(this.root, { recursive: true });
    for (const id of fs.readdirSync(this.root)) {
      const file = path.join(this.root, id, "run.json");
      if (!fs.existsSync(file)) continue;
      const run = JSON.parse(fs.readFileSync(file, "utf8")) as Run;
      run.audit_revision ??= 0;
      // Plan tokens are intentionally memory-of-the-process capabilities. A
      // manager restart invalidates issued-but-unconsumed plans; the agent must
      // re-plan against the current audit.
      for (const plan of run.construction_plans ?? []) {
        if (plan.status === "issued") plan.status = "invalidated";
      }
      if (!terminal.has(run.state)) {
        run.state = "interrupted";
        run.ended_at = new Date().toISOString();
        run.reason = "Manager exited before this run finished; automatic resume is not supported.";
        this.persist(run);
      }
      if (!run.usage && run.session_id) {
        this.captureUsage(run);
        this.persist(run);
      }
      // A cleanly paused run must remain resumable even if the manager exited
      // while converting its recording. Recover a finished artifact or retain
      // the raw capture and report the interrupted conversion separately.
      let recoveredVideo = false;
      for (const segment of run.segments || []) {
        if (segment.video?.state !== "rendering") continue;
        const dir =
          segment.index === 1
            ? this.dir(run)
            : path.join(this.dir(run), "segments", String(segment.index).padStart(3, "0"));
        try {
          const metadata = JSON.parse(fs.readFileSync(path.join(dir, "video", "timelapse.json"), "utf8"));
          const file = path.join(dir, "video", "timelapse.mp4");
          verifyTimelapseMetadata(metadata);
          if (!fs.existsSync(file)) throw new Error("Conversion incomplete");
          Object.assign(segment.video, {
            state: "ready",
            file: path.relative(this.dir(run), file),
            metadata,
          });
        } catch {
          segment.video.state = "failed";
          segment.video.error = "Manager exited during conversion; the original recording is retained";
        }
        recoveredVideo = true;
      }
      if (run.segments?.at(-1)?.video) run.video = run.segments.at(-1)!.video;
      if (!run.automation) {
        const { mines, crafts } = this.recountManualActions(run);
        const penalty = mines + crafts * CRAFT_PENALTY_POINTS;
        run.automation = {
          score: -penalty,
          positive: 0,
          penalty,
          state_penalty: 0,
          blackout_penalty: 0,
          alert_penalty: 0,
          blackouts: 0,
          manual_mines: mines,
          manual_crafts: crafts,
          cleanup_units: 0,
          refactor_reward: 0,
          breakdown: { production: 0, science: 0, power: 0, research: 0, rockets: 0, refactor: 0 },
        };
        this.persist(run);
      }
      if (recoveredVideo) this.persist(run);
      this.runs.set(id, run);
    }
  }

  get busy() {
    return Boolean(this.active);
  }
  get acceptingActions() {
    return this.active?.state === "running";
  }
  /** Rebuild manual-work counters for runs created before automation scoring. */
  private recountManualActions(run: Run) {
    let mines = 0;
    let crafts = 0;
    if (!manualPenaltyGraceActive(run.elapsed_seconds)) return { mines, crafts };
    try {
      const lines = fs.readFileSync(path.join(this.dir(run), "jobs.jsonl"), "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as {
          phase?: string;
          status?: string;
          action?: string;
          payload?: unknown;
          results?: unknown[];
        };
        if (record.phase !== "finished" || record.status !== "completed") continue;
        if (record.action === "mine") mines += manualMineUnits(record.results || []);
        else if (record.action === "craft") crafts += manualCraftUnits(record.payload, record.results || []);
      }
    } catch {
      /* no jobs file yet */
    }
    return { mines, crafts };
  }

  /** Record the cumulative alert-ignore penalty in the active run's score. */
  setAlertPenalty(points: number) {
    const run = this.active;
    if (!run?.automation) return;
    const value = Math.max(0, Math.round(Number(points) || 0));
    if (run.automation.alert_penalty === value) return;
    run.automation.alert_penalty = value;
    run.automation.penalty =
      (run.automation.manual_mines || 0) +
      (run.automation.manual_crafts || 0) * CRAFT_PENALTY_POINTS +
      (run.automation.state_penalty || 0) +
      (run.automation.blackout_penalty || 0) +
      value;
    run.automation.score = run.automation.positive - run.automation.penalty;
    this.persist(run);
  }

  recordJob(phase: "submitted" | "finished", job: ActionJobRecord) {
    const run = this.active;
    if (!run || !["running", "saving"].includes(run.state)) return;
    fs.appendFileSync(
      path.join(this.dir(run), "jobs.jsonl"),
      JSON.stringify({ phase, at: new Date().toISOString(), ...job }) + "\n",
    );
    if (phase === "submitted") run.actions.submitted++;
    else {
      if (job.status === "completed") run.actions.completed++;
      if (job.status === "failed") run.actions.failed++;
      if (job.status === "cancelled") run.actions.cancelled++;
      run.actions.partial_failures += failureCount(job.results);
      if (job.status === "completed" && run.automation) {
        const cleanup = job.action === "mine" ? cleanupMineUnits(job.payload, job.results) : 0;
        const mines = job.action === "mine" ? Math.max(0, manualMineUnits(job.results) - cleanup) : 0;
        const crafts = job.action === "craft" ? manualCraftUnits(job.payload, job.results) : 0;
        if (cleanup > 0) {
          if (run.construction) {
            run.construction.metrics.cleanup_units += cleanup;
          }
          const reward = cleanup * CLEANUP_REWARD_POINTS;
          run.automation.cleanup_units = (run.automation.cleanup_units ?? 0) + cleanup;
          run.automation.refactor_reward = (run.automation.refactor_reward ?? 0) + reward;
          run.automation.positive += reward;
          run.automation.breakdown.refactor = (run.automation.breakdown.refactor ?? 0) + reward;
          run.automation.score = run.automation.positive - run.automation.penalty;
          this.event(
            run,
            `Cleanup reward +${reward} (${cleanup} player-owned invalid/obsolete entities removed)`,
          );
          // Cleaning during a debt episode earns in-cluster rebuild credits, so
          // deconstruct-then-rebuild refactors stay possible while expansion is gated.
          if (run.refactor?.debt_since) {
            run.refactor.build_credits = Math.max(0, Math.round((run.refactor.build_credits ?? 0) + cleanup));
            run.refactor.credits_earned = Math.max(
              0,
              Math.round((run.refactor.credits_earned ?? 0) + cleanup),
            );
            this.event(run, `Rebuild credits +${cleanup} (cleanup during refactor debt)`);
          }
        }
        // Opening grace: manual work is allowed without penalty while the
        // character is still bootstrapping the first power/production loop.
        if ((mines || crafts) && manualPenaltyGraceActive(this.elapsed())) {
          run.automation.manual_mines += mines;
          run.automation.manual_crafts += crafts;
          run.automation.penalty =
            run.automation.manual_mines +
            run.automation.manual_crafts * CRAFT_PENALTY_POINTS +
            (run.automation.state_penalty || 0) +
            (run.automation.alert_penalty || 0);
          run.automation.score = run.automation.positive - run.automation.penalty;
        }
      }
    }
    this.persist(run);
  }
  private dir(run: Run) {
    return path.join(this.root, run.id);
  }
  private persist(run: Run) {
    const file = path.join(this.dir(run), "run.json");
    fs.writeFileSync(file + ".tmp", JSON.stringify(run, null, 2));
    fs.renameSync(file + ".tmp", file);
  }
  private elapsed() {
    return this.elapsedBefore + (this.startedMono ? (performance.now() - this.startedMono) / 1000 : 0);
  }
  private event(run: Run, text: string) {
    fs.appendFileSync(path.join(this.dir(run), "activity.log"), `[${new Date().toISOString()}] ${text}\n`);
  }
  /** Plain reasoning stream for livestream overlays and TTS narration. */
  private thought(run: Run, text: string) {
    const clean = text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]*`/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) return;
    const dir = this.dir(run);
    // Raw stream: unchanged byte-for-byte behavior for existing consumers.
    fs.appendFileSync(path.join(dir, "thoughts.log"), clean + "\n");
    fs.writeFileSync(path.join(dir, "thoughts.txt"), clean + "\n");
    // Condensed one-line digest for TTS/overlay; never alters thoughts.log.
    const digest = digestThought(clean);
    if (!digest || digest === this.lastDigest(run)) return;
    this.digestTail.set(run.id, digest);
    fs.appendFileSync(path.join(dir, "thoughts.digest.log"), digest + "\n");
    fs.writeFileSync(path.join(dir, "thoughts.digest.txt"), digest + "\n");
  }

  /** Previous digest for a run; recovered from disk so restarts don't duplicate lines. */
  private lastDigest(run: Run): string | null {
    if (this.digestTail.has(run.id)) return this.digestTail.get(run.id) ?? null;
    let last: string | null = null;
    try {
      const lines = fs
        .readFileSync(path.join(this.dir(run), "thoughts.digest.log"), "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      last = lines.length > 0 ? lines[lines.length - 1] : null;
    } catch {
      /* the run has no digest yet */
    }
    this.digestTail.set(run.id, last);
    return last;
  }
  list() {
    return [...this.runs.values()]
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .map((run) => this.view(run));
  }
  get(id: string) {
    const run = this.runs.get(id);
    return run ? this.view(run) : undefined;
  }

  /** The run currently owning the game/agent, if any. */
  activeRunId(): string | undefined {
    return this.active?.id;
  }

  /**
   * Count one API call made by the active agent. Internal loopback action
   * dispatches and polling requests are intentionally included: this is the
   * agent's interface-usage profile, not just user-visible observations.
   */
  recordToolCall(method: string, pathname: string): void {
    const run = this.active;
    if (!run || !pathname.startsWith("/api/agent/")) return;
    const path = pathname
      .replace(/^\/api\/agent\/jobs\/[^/]+$/, "/api/agent/jobs/:id")
      .replace(/^\/api\/agent\/jobs\/[^/]+\/cancel$/, "/api/agent/jobs/:id/cancel");
    const key = `${method.toUpperCase()} ${path}`;
    run.tool_calls ||= {};
    run.tool_calls[key] = (run.tool_calls[key] || 0) + 1;
    const now = Date.now();
    if (now - (this.toolCallPersist.get(run.id) || 0) > 1000) {
      this.toolCallPersist.set(run.id, now);
      this.persist(run);
    }
  }

  /** Tool/interface usage for one run, sorted by call count. */
  toolCalls(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const calls = Object.entries(run.tool_calls || {})
      .map(([key, count]) => {
        const [method, ...pathParts] = key.split(" ");
        return { method, path: pathParts.join(" "), count };
      })
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
    return {
      run_id: run.id,
      total: calls.reduce((sum, call) => sum + call.count, 0),
      calls,
    };
  }

  /** Blueprints registered for this run, newest first. */
  blueprints(runId: string): RunBlueprintSummary[] | undefined {
    const run = this.runs.get(runId);
    return run ? listRunBlueprints(this.dir(run), run.id) : undefined;
  }

  /** One registered blueprint including its raw wire string and decoded payload. */
  blueprint(runId: string, blueprintId: string): RunBlueprintDetail | undefined {
    const run = this.runs.get(runId);
    return run ? readRunBlueprint(this.dir(run), run.id, blueprintId) : undefined;
  }

  /** Persist an agent-created blueprint for this run. */
  registerBlueprint(runId: string, input: RegisterBlueprintInput): RunBlueprintSummary {
    const run = this.runs.get(runId);
    if (!run) throw new Error("Run not found");
    return registerRunBlueprint(this.dir(run), run.id, input).blueprint;
  }

  /** Rename or annotate an existing blueprint. */
  updateBlueprint(
    runId: string,
    blueprintId: string,
    input: { label?: unknown; description?: unknown },
  ): RunBlueprintSummary | undefined {
    const run = this.runs.get(runId);
    if (!run) throw new Error("Run not found");
    return updateRunBlueprint(this.dir(run), run.id, blueprintId, input);
  }

  /** Delete one blueprint from the run catalogue. */
  deleteBlueprint(runId: string, blueprintId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) throw new Error("Run not found");
    return deleteRunBlueprint(this.dir(run), run.id, blueprintId);
  }
  private stateMetaPath(run: Run): string {
    return path.join(this.dir(run), "workspace", "state-meta.json");
  }
  private readStateMeta(run: Run): StateMeta | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateMetaPath(run), "utf8")) as StateMeta;
      if (parsed?.schema_version !== 1 || !Number.isFinite(parsed.revision)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }
  private stateFile(run: Run) {
    for (const relative of ["workspace/STATE.md", "STATE.md"]) {
      try {
        const file = path.join(this.dir(run), relative);
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        const text = fs.readFileSync(file, "utf8").slice(0, 8000);
        const hash = sha256(text);
        const meta = this.readStateMeta(run);
        if (meta && meta.content_sha256 === hash) {
          return {
            text,
            updated_at: meta.updated_at,
            content_sha256: hash,
            revision: meta.revision,
            updated_by: meta.updated_by,
            external_changed: false,
          };
        }
        // A legacy state has no metadata; a hash mismatch means the file was
        // edited outside the API. Both are real content updates, but only the
        // mismatch gets marked external.
        return {
          text,
          updated_at: stat.mtime.toISOString(),
          content_sha256: hash,
          revision: (meta?.revision ?? 0) + 1,
          updated_by: "external" as const,
          external_changed: Boolean(meta),
        };
      } catch {
        /* try the other location */
      }
    }
    return undefined;
  }
  /** The active agent's own plan, for observe-factory and the status header. */
  plan() {
    const run = this.active;
    if (!run) return undefined;
    const state = this.stateFile(run);
    const updated = state?.updated_at ? Date.parse(state.updated_at) : 0;
    const age = updated ? Math.max(0, (Date.now() - updated) / 1000) : null;
    return {
      run_id: run.id,
      state_md: state?.text,
      updated_at: state?.updated_at,
      stale: age === null || age > 600,
      age_seconds: age === null ? null : Math.round(age),
      research: run.latest?.current_research ?? null,
      research_progress: run.latest?.research_progress ?? null,
      state: this.stateStatus(),
      remaining_seconds: Math.max(0, run.max_seconds - this.elapsed()),
    };
  }
  /** STATE.md freshness and deadline information for the active run. */
  stateStatus() {
    const run = this.active;
    if (!run) return undefined;
    const state = this.stateFile(run);
    const updated = state?.updated_at ? Date.parse(state.updated_at) : null;
    const age = updated ? Math.max(0, (Date.now() - updated) / 1000) : null;
    const segment = run.segments?.at(-1);
    const segmentElapsed = segment?.started_at
      ? Math.max(0, (Date.now() - Date.parse(segment.started_at)) / 1000)
      : null;
    const resumeGraceSeconds =
      segment && segment.index > 1 ? Number(process.env.AUTORIO_STATE_RESUME_GRACE_SECONDS || 0) || 120 : 0;
    const gate = evaluateStateGate({
      hasState: Boolean(state),
      ageSeconds: age,
      elapsedSeconds: this.elapsed(),
      softSeconds: Number(process.env.AUTORIO_STATE_SOFT_SECONDS || 0) || undefined,
      hardSeconds: Number(process.env.AUTORIO_STATE_HARD_SECONDS || 0) || undefined,
      graceSeconds: Number(process.env.AUTORIO_STATE_GRACE_SECONDS || 0) || undefined,
      segmentElapsedSeconds: segmentElapsed,
      resumeGraceSeconds,
    });
    return {
      run_id: run.id,
      state_md: state?.text,
      updated_at: state?.updated_at,
      revision: state?.revision ?? 0,
      content_sha256: state?.content_sha256 ?? null,
      updated_by: state?.updated_by ?? "external",
      external_changed: state?.external_changed ?? false,
      scores_source: state ? "agent_self_reported" : "missing",
      age_seconds: gate.age_seconds,
      soft_seconds: gate.soft_seconds,
      hard_seconds: gate.hard_seconds,
      grace_seconds: gate.grace_seconds,
      segment_elapsed_seconds: segmentElapsed === null ? null : Math.round(segmentElapsed),
      resume_grace_seconds: gate.resume_grace_seconds,
      resume_grace_active: gate.resume_grace_active,
      resume_grace_remaining_seconds: gate.resume_grace_remaining_seconds,
      due: gate.due,
      blocked: gate.blocked,
      hint: gate.hint,
    };
  }

  /** Gate for mutating agent actions. */
  stateGate(): { gate: StateGate; status: NonNullable<ReturnType<RunManager["stateStatus"]>> } | undefined {
    const status = this.stateStatus();
    if (!status) return undefined;
    const gate: StateGate = evaluateStateGate({
      hasState: Boolean(status.updated_at),
      ageSeconds: status.age_seconds,
      elapsedSeconds: this.elapsed(),
      softSeconds: status.soft_seconds,
      hardSeconds: status.hard_seconds,
      graceSeconds: status.grace_seconds,
      segmentElapsedSeconds: status.segment_elapsed_seconds,
      resumeGraceSeconds: status.resume_grace_seconds,
    });
    return { gate, status };
  }

  private stateHistoryDir(run: Run): string {
    return path.join(this.dir(run), "workspace", "state-history");
  }

  /** Save one revision, keeping only the newest 20 files. */
  private saveStateHistory(run: Run, revision: number, markdown: string): void {
    const dir = this.stateHistoryDir(run);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${String(revision).padStart(6, "0")}.md`), markdown);
    const files = fs
      .readdirSync(dir)
      .filter((file) => /^\d+\.md$/.test(file))
      .sort();
    for (const stale of files.slice(0, Math.max(0, files.length - 20))) {
      fs.rmSync(path.join(dir, stale), { force: true });
    }
  }

  /** Recent plan revisions, oldest first. */
  stateHistory(runId: string) {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const dir = this.stateHistoryDir(run);
    let files: string[] = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((file) => /^\d+\.md$/.test(file))
        .sort();
    } catch {
      /* no history yet */
    }
    return {
      run_id: run.id,
      revisions: files.map((file) => {
        const revision = Number(file.slice(0, -3));
        const text = fs.readFileSync(path.join(dir, file), "utf8");
        const current = (text.match(/^Current:\s*(.+)$/m) || [])[1] || "";
        const doneWhen = (text.match(/^Done when:\s*(.+)$/m) || [])[1] || "";
        const updated = (text.match(/^Updated:\s*(.+)$/m) || [])[1] || "";
        return { revision, updated_at: updated || null, current, done_when: doneWhen, markdown: text };
      }),
    };
  }

  /** Write the canonical STATE.md from structured fields and refresh the deadline. */
  writeState(input: StateWriteInput) {
    const run = this.active;
    if (!run) throw new Error("No active run");
    if (!input || typeof input.current !== "string" || !input.current.trim())
      throw new Error("Missing current subtask");
    const mismatched = stateLanguageMismatches(input, run.language);
    if (mismatched.length) {
      throw new Error(
        `STATE_LANGUAGE_REQUIRED: ${run.language} output language requested; rewrite ${mismatched.join(", ")} in ${run.language}. Keep code, commands, paths and identifiers unchanged.`,
      );
    }
    const workspace = path.join(this.dir(run), "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const previous = this.stateFile(run);
    const timestamp = new Date();
    const markdown = renderStateMarkdown(input, timestamp);
    const hash = sha256(markdown);
    const changed = previous?.content_sha256 !== hash;
    const revision = (previous?.revision ?? 0) + (changed ? 1 : 0);
    if (previous && changed) this.saveStateHistory(run, previous.revision, previous.text);
    fs.writeFileSync(path.join(workspace, "STATE.md"), markdown);
    fs.rmSync(path.join(workspace, "PLAN_REMINDER.md"), { force: true });
    const meta: StateMeta = {
      schema_version: 1,
      revision: revision || 1,
      updated_at: timestamp.toISOString(),
      content_sha256: hash,
      updated_by: "api",
    };
    fs.mkdirSync(path.dirname(this.stateMetaPath(run)), { recursive: true });
    fs.writeFileSync(this.stateMetaPath(run), JSON.stringify(meta, null, 2) + "\n");
    if (changed) this.saveStateHistory(run, meta.revision, markdown);
    this.event(run, `STATE.md updated: ${input.current.trim().slice(0, 120)} (revision ${meta.revision})`);
    this.checkStateReminder(run);
    return this.stateStatus();
  }

  /** Stamp and append one event so the browser can show stable relative times. */
  private appendAgentEvent(run: Run, event: TranscriptEvent) {
    const receivedAt = new Date().toISOString();
    event.received_at = receivedAt;
    if (event.item) event.item.received_at = receivedAt;
    fs.appendFileSync(path.join(this.dir(run), "agent.events.jsonl"), JSON.stringify(event) + "\n");
  }

  /** Append a transcript marker (rendered by the recording window). */
  private emitTranscript(run: Run, item: TranscriptItem) {
    this.appendAgentEvent(run, { type: "item.completed", item });
  }

  /** Emit at most one marker per stale -> blocked -> fresh transition. */
  private checkStateReminder(run: Run) {
    const status = this.stateStatus();
    if (!status) return;
    const stage: "" | "due" | "blocked" = status.blocked ? "blocked" : status.due ? "due" : "";
    if (stage === "blocked") {
      if (!run.state_blocked_since) {
        run.state_blocked_since = new Date().toISOString();
        this.persist(run);
      }
      const nudgeAfter = Number(process.env.AUTORIO_STATE_NUDGE_RESTART_SECONDS || 0);
      const blockedFor = (Date.now() - Date.parse(run.state_blocked_since)) / 1000;
      if (
        nudgeAfter > 0 &&
        !run.state_nudge_restarted &&
        blockedFor >= nudgeAfter &&
        run.state === "running" &&
        !this.ending &&
        run.session_id
      ) {
        run.state_nudge_restarted = true;
        this.event(run, `STATE.md overdue for ${Math.round(blockedFor)}s; requesting an agent plan refresh`);
        this.persist(run);
        void this.nudgeStalePlan(run).catch((error) =>
          this.finish("paused", `STATE nudge failed: ${errorText(error)}`),
        );
      }
    } else {
      if (run.state_blocked_since || run.state_nudge_restarted) {
        delete run.state_blocked_since;
        delete run.state_nudge_restarted;
        this.persist(run);
      }
    }
    if ((run.state_reminder || "") === stage) return;
    const previous = run.state_reminder;
    run.state_reminder = stage || undefined;
    const zh = /chinese|中文|zh/i.test(run.language || "");
    const age = Math.round(status.age_seconds ?? 0);
    // Materialize a nudge the operator/agent can read before actions are blocked.
    const workspace = path.join(this.dir(run), "workspace");
    const reminder = path.join(workspace, "PLAN_REMINDER.md");
    try {
      if (stage) {
        fs.mkdirSync(workspace, { recursive: true });
        fs.writeFileSync(
          reminder,
          [
            zh ? "# 计划需要更新" : "# Plan needs updating",
            "",
            zh
              ? `STATE.md 已 ${age} 秒未更新。请在继续动作前调用 state-write / POST /api/agent/state 更新 current、done_when、next 和 scores。`
              : `STATE.md is ${age}s old. Call state-write / POST /api/agent/state to refresh current, done_when, next and scores before acting.`,
            stage === "blocked"
              ? zh
                ? "当前状态：动作已被阻止。"
                : "Current state: mutating actions are blocked."
              : zh
                ? "当前状态：即将超时，请立即更新。"
                : "Current state: soft deadline passed; update now.",
            "",
          ].join("\n"),
        );
      } else {
        fs.rmSync(reminder, { force: true });
      }
    } catch {
      /* nudge is best-effort; the transcript marker below is authoritative */
    }
    const text =
      stage === "blocked"
        ? zh
          ? `计划超时：STATE.md 已 ${Math.round(age / 60)} 分钟未更新，动作已被阻止`
          : `Plan overdue: STATE.md unchanged for ${Math.round(age / 60)} min; actions are blocked`
        : stage === "due"
          ? zh
            ? `计划需要更新：STATE.md 已 ${age} 秒未更新`
            : `Plan needs updating: STATE.md unchanged for ${age}s`
          : previous
            ? zh
              ? "STATE.md 已更新，计划恢复"
              : "STATE.md refreshed; plan is current"
            : "";
    if (!text) return;
    this.emitTranscript(run, {
      id: `state-marker-${Date.now()}`,
      type: "event_marker",
      text,
    });
    this.persist(run);
  }

  /** Env override that treats 0 as a real value (used by the refactor ladder). */
  private refactorSetting(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  /** True once debt has persisted past the gate grace and the audit is fresh enough. */
  private refactorArmed(state: RefactorState): boolean {
    const debounce = this.refactorSetting("AUTORIO_REFACTOR_GATE_GRACE_SECONDS", 300);
    const auditedAt = Date.parse(state.audited_at);
    const fresh = Number.isFinite(auditedAt) && Date.now() - auditedAt < 15 * 60 * 1000;
    return (
      fresh && Boolean(state.debt_since) && Date.now() - Date.parse(state.debt_since!) >= debounce * 1000
    );
  }

  /**
   * Record the latest prioritized refactor audit and advance the escalation
   * ladder: normal -> expansion_blocked -> relayout_only, with a big-reset
   * warning on top.
   *
   * The gate only blocks *expansion*: while the debt persists the agent may
   * still rebuild inside the flagged clusters using rebuild credits, so a
   * refactor stays possible without tearing the whole base down.
   */
  recordRefactorAudit(audit: {
    invalid_count: number;
    factory_problems: number;
    connection_issues: number;
    fingerprint: string;
    clusters?: RefactorCluster[];
    actions?: RefactorState["actions"];
  }): RefactorState | undefined {
    const run = this.active;
    if (!run) return undefined;
    const now = Date.now();
    run.audit_revision = (run.audit_revision ?? 0) + 1;
    const previous = run.refactor;
    const invalid = Math.max(0, Math.round(audit.invalid_count));
    // A few transient warnings (backpressure, momentarily starved machines,
    // empty buffer chests) must not lock construction; sustained, larger debt
    // still does.
    const cleanTarget = Math.max(0, this.refactorSetting("AUTORIO_REFACTOR_CLEAN_TARGET", 20));
    const above = invalid > cleanTarget;
    const sameDebt = Boolean(previous?.debt_since) && above;
    const auditsWithDebt = above ? (sameDebt ? (previous?.audits_with_debt ?? 0) + 1 : 1) : 0;
    const relayoutAudits = this.refactorSetting("AUTORIO_REFACTOR_RELAYOUT_AUDITS", 3);
    const resetAudits = this.refactorSetting("AUTORIO_REFACTOR_RESET_AUDITS", 6);
    const blackoutLimit = this.refactorSetting("AUTORIO_BIG_RESET_BLACKOUTS", 50);
    const escalation: RefactorState["escalation_tier"] = !above
      ? "normal"
      : auditsWithDebt >= relayoutAudits
        ? "relayout_only"
        : "expansion_blocked";
    const baseCredits = this.refactorSetting("AUTORIO_REFACTOR_BASE_BUILD_CREDITS", 12);
    const creditsEarned = above ? Math.max(0, Math.round(previous?.credits_earned ?? 0)) : 0;
    let buildCredits = above ? Math.max(0, Math.round(previous?.build_credits ?? 0)) : 0;
    let baseGranted = above ? Boolean(previous?.base_credits_granted) : false;
    if (above && escalation === "expansion_blocked" && !baseGranted) {
      buildCredits += Math.min(baseCredits, invalid);
      baseGranted = true;
    }
    if (above && escalation === "relayout_only") {
      // Tier 2 revokes the unused repair allowance: only cleanup earns credits.
      buildCredits = Math.min(buildCredits, creditsEarned);
      baseGranted = true;
    }
    const blackouts = run.power_blackouts ?? 0;
    const bigResetPending =
      above &&
      ((resetAudits > 0 && auditsWithDebt >= resetAudits) ||
        (blackoutLimit > 0 && blackouts >= blackoutLimit));
    const clusters = above ? (audit.clusters ?? previous?.clusters ?? []).slice(0, 8) : [];
    run.refactor = {
      audited_at: new Date(now).toISOString(),
      invalid_count: invalid,
      factory_problems: Math.max(0, Math.round(audit.factory_problems)),
      connection_issues: Math.max(0, Math.round(audit.connection_issues)),
      fingerprint: audit.fingerprint,
      debt_since: above ? (previous?.debt_since ?? new Date(now).toISOString()) : undefined,
      audits_with_debt: auditsWithDebt,
      big_reset_pending: bigResetPending,
      debt_peak: Math.max(previous?.debt_peak ?? 0, invalid),
      escalation_tier: escalation,
      clusters,
      build_credits: buildCredits,
      credits_earned: creditsEarned,
      base_credits_granted: baseGranted,
      actions: above ? (audit.actions ?? previous?.actions) : undefined,
    };
    if (escalation !== (previous?.escalation_tier ?? "normal")) {
      this.event(
        run,
        `Refactor escalation ${previous?.escalation_tier ?? "normal"} -> ${escalation} (debt ${invalid}, audits ${auditsWithDebt})`,
      );
    }
    if (bigResetPending && !previous?.big_reset_pending) {
      this.event(
        run,
        `Big-reset warning armed (debt ${invalid}, audits ${auditsWithDebt}, blackouts ${blackouts}); warning only, operator confirmation required`,
      );
    }
    if (run.automation && previous && previous.invalid_count > invalid) {
      const cleaned = previous.invalid_count - invalid;
      const reward = cleaned * REFACTOR_REWARD_POINTS;
      run.automation.refactor_reward = (run.automation.refactor_reward ?? 0) + reward;
      run.automation.positive += reward;
      run.automation.breakdown.refactor = (run.automation.breakdown.refactor ?? 0) + reward;
      run.automation.score = run.automation.positive - run.automation.penalty;
      this.event(run, `Refactor reward +${reward} (invalid debt ${previous.invalid_count} -> ${invalid})`);
    }
    this.persist(run);
    return run.refactor;
  }

  /** Gate new expansion while refactor debt remains unresolved. */
  refactorGate(): { blocked: boolean; state: RefactorState; message: string } | undefined {
    const run = this.active;
    if (!run?.refactor || run.state !== "running") return undefined;
    const state = run.refactor;
    if ((run.construction?.mode ?? "free") === "free") {
      return { blocked: false, state, message: "" };
    }
    const blocked = this.refactorArmed(state);
    return {
      blocked,
      state,
      message: blocked
        ? `Refactor debt ${state.invalid_count} invalid connections/problems; expansion is blocked — repair/rebuild inside the flagged clusters freely, clean flagged/obsolete entities, then re-audit`
        : "",
    };
  }

  /**
   * Check build targets against the refactor gate.
   *
   * Expansion targets (outside the flagged clusters) are refused. In-cluster
   * rebuild targets are allowed while rebuild credits last; internal job
   * loops pass `internal: true` and skip the credit check because the credits
   * were already spent when the external build job was accepted.
   */
  /** Construction mode/policy summary exposed to the agent at /api/agent/construction. */
  constructionStatus() {
    const run = this.active;
    const state = run?.construction;
    return {
      mode: state?.mode ?? "free",
      variant: state?.variant ?? null,
      plan_required: state?.plan_required ?? false,
      audit_revision: run?.audit_revision ?? 0,
      blueprints: state?.blueprints ?? { enabled: false, source: "none", catalog: "run" },
      metrics: state?.metrics,
      plans: run?.construction_plans?.length ?? 0,
    };
  }

  /** Cancel an issued plan; consumed/expired plans are left unchanged. */
  cancelConstructionPlan(planId: string) {
    const run = this.active;
    const plan = run?.construction_plans?.find((entry) => entry.plan_id === planId);
    if (!run || !plan) throw new ConstructionPlanError("PLAN_BAD_REQUEST", "Plan not found", {}, 404);
    if (plan.status === "issued") {
      plan.status = "invalidated";
      this.persist(run);
    }
    return constructionPlanPublic(plan);
  }

  /** Public view of one issued construction plan. */
  constructionPlan(planId: string) {
    const run = this.active;
    const plan = run?.construction_plans?.find((entry) => entry.plan_id === planId);
    return plan ? constructionPlanPublic(plan) : undefined;
  }

  /**
   * Issue a single-use plan token for a construction intent. Planned mode only;
   * free mode returns CONSTRUCTION_MODE_FREE so the client can fall back to the
   * legacy action path.
   */
  createConstructionPlan(input: unknown) {
    const run = this.active;
    if (!run) {
      throw new ConstructionPlanError("PLAN_BAD_REQUEST", "No active run for construction plans");
    }
    const state = run.construction;
    if (!state || state.mode === "free") {
      throw new ConstructionPlanError(
        "CONSTRUCTION_MODE_FREE",
        "This run uses free construction; no plan token is required.",
        { mode: "free" },
      );
    }
    const record =
      input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    const rawKind = typeof record.kind === "string" ? record.kind : "";
    const kinds: ConstructionPlanKind[] = [
      "build",
      "mutation",
      "cleanup",
      "blueprint",
      "expansion",
      "power",
      "pipe",
      "belt",
    ];
    if (!kinds.includes(rawKind as ConstructionPlanKind)) {
      throw new ConstructionPlanError(
        "PLAN_BAD_REQUEST",
        `kind must be one of ${kinds.join(", ")}`,
        { allowed_kinds: kinds },
        400,
      );
    }
    const kind = rawKind as ConstructionPlanKind;
    const rawEntities = Array.isArray(record.entities) ? record.entities : [];
    const rawTargets = Array.isArray(record.targets) ? record.targets : [];
    let entities = rawEntities
      .map((entry) => normalizeConstructionEntity(entry))
      .filter((entry): entry is ConstructionEntity => Boolean(entry));
    const targets = rawTargets
      .map((entry) => normalizeConstructionTarget(entry))
      .filter((entry): entry is ConstructionTarget => Boolean(entry));
    if (rawEntities.length && entities.length !== rawEntities.length) {
      throw new ConstructionPlanError(
        "PLAN_BAD_REQUEST",
        "every entity needs a name and a finite anchor {x,y}",
        {},
        400,
      );
    }
    if (rawTargets.length && targets.length !== rawTargets.length) {
      throw new ConstructionPlanError(
        "PLAN_BAD_REQUEST",
        "every target needs finite x/y coordinates",
        {},
        400,
      );
    }
    const anchorRecord =
      record.anchor && typeof record.anchor === "object"
        ? (record.anchor as Record<string, unknown>)
        : undefined;
    const anchorX = Number(anchorRecord?.x);
    const anchorY = Number(anchorRecord?.y);
    const anchor =
      Number.isFinite(anchorX) && Number.isFinite(anchorY) ? { x: anchorX, y: anchorY } : undefined;
    let decodedBlueprintHash: string | undefined;
    let blueprintRequired: Record<string, number> | undefined;
    if (kind === "blueprint" && typeof record.blueprint === "string") {
      let decoded;
      try {
        decoded = decodeBlueprintString(record.blueprint);
      } catch (error) {
        throw new ConstructionPlanError(
          "BLUEPRINT_INVALID",
          error instanceof Error ? error.message : "invalid blueprint",
        );
      }
      const sizesRecord =
        record.prototype_sizes && typeof record.prototype_sizes === "object"
          ? (record.prototype_sizes as Record<string, unknown>)
          : undefined;
      const prototypeSizes: Record<string, { width: number; height: number }> = {};
      for (const [name, value] of Object.entries(sizesRecord ?? {})) {
        const size = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        const width = Number(size.width);
        const height = Number(size.height);
        if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) {
          prototypeSizes[name] = { width, height };
        }
      }
      let expanded;
      try {
        expanded = expandBlueprintPayload(decoded.payload, {
          ...(anchor ? { anchor } : {}),
          prototype_sizes: prototypeSizes,
        });
      } catch (error) {
        throw new ConstructionPlanError(
          "BLUEPRINT_INVALID",
          error instanceof Error ? error.message : "blueprint expansion failed",
        );
      }
      let canonical = expanded
        .map((entry) => normalizeConstructionEntity(entry))
        .filter((entry): entry is ConstructionEntity => Boolean(entry));
      const blueprintRotation = Number(record.rotation);
      const blueprintMirror = record.mirror === true;
      if ([0, 2, 4, 6].includes(blueprintRotation) || blueprintMirror) {
        canonical = transformBlueprintEntities(canonical, prototypeSizes, {
          rotation: [0, 2, 4, 6].includes(blueprintRotation) ? blueprintRotation : 0,
          mirror: blueprintMirror,
        })
          .map((entry) => normalizeConstructionEntity(entry))
          .filter((entry): entry is ConstructionEntity => Boolean(entry));
      }
      if (entities.length) {
        const expected = entities.map((entry) => ({
          name: entry.name,
          anchor: entry.anchor,
          direction: entry.direction,
          underground_type: entry.underground_type,
        }));
        const actual = canonical.map((entry) => ({
          name: entry.name,
          anchor: entry.anchor,
          direction: entry.direction,
          underground_type: entry.underground_type,
        }));
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          throw new ConstructionPlanError(
            "BLUEPRINT_TARGET_MISMATCH",
            "The submitted entities do not match manager-side blueprint expansion.",
          );
        }
      }
      entities = canonical;
      decodedBlueprintHash = decoded.sha256;
      blueprintRequired = blueprintRequiredItems(decoded.payload);
    }
    if (kind === "power" || kind === "pipe" || kind === "belt") {
      try {
        if (Array.isArray(record.path)) {
          if (kind === "power") {
            entities = planPowerPath({
              path: record.path,
              pole: typeof record.pole === "string" ? record.pole : undefined,
              spacing: record.spacing,
              existing_poles: record.existing_poles,
            });
          } else if (kind === "pipe") {
            entities = planPipePath({
              path: record.path,
              name: typeof record.name === "string" ? record.name : undefined,
            });
          } else {
            entities = planBeltPath({
              path: record.path,
              name: typeof record.name === "string" ? record.name : undefined,
            });
          }
        } else if (kind === "power") {
          const from = integerLayoutPoint(record.from);
          const to = integerLayoutPoint(record.to);
          entities =
            from && to
              ? planPowerLine({
                  from,
                  to,
                  pole: typeof record.pole === "string" ? record.pole : undefined,
                  spacing: record.spacing,
                })
              : planPowerNetwork({
                  targets: Array.isArray(record.targets) ? record.targets : rawTargets,
                  pole: typeof record.pole === "string" ? record.pole : undefined,
                  spacing: record.spacing,
                });
        } else if (kind === "pipe") {
          const from = integerLayoutPoint(record.from);
          const to = integerLayoutPoint(record.to);
          if (!from || !to) throw new Error("pipe layout needs from/to");
          entities = planPipeLine({
            from,
            to,
            name: typeof record.name === "string" ? record.name : undefined,
          });
        } else {
          const from = integerLayoutPoint(record.from);
          const to = integerLayoutPoint(record.to);
          if (!from || !to) throw new Error("belt layout needs from/to");
          entities = planBeltLine({
            from,
            to,
            name: typeof record.name === "string" ? record.name : undefined,
          });
        }
      } catch (error) {
        throw new ConstructionPlanError(
          "PLAN_BAD_REQUEST",
          error instanceof Error ? error.message : "layout generation failed",
          {},
          400,
        );
      }
    }
    if ((kind === "build" || kind === "blueprint" || kind === "expansion") && entities.length === 0) {
      throw new ConstructionPlanError("PLAN_BAD_REQUEST", `${kind} plan needs entities`, {}, 400);
    }
    if ((kind === "mutation" || kind === "cleanup") && targets.length === 0) {
      throw new ConstructionPlanError("PLAN_BAD_REQUEST", `${kind} plan needs targets`, {}, 400);
    }
    if (kind === "blueprint") {
      if (!state.blueprints.enabled) {
        throw new ConstructionPlanError("BLUEPRINT_INVALID", "Blueprints are disabled for this run");
      }
      if (
        record.blueprint_id !== undefined &&
        (typeof record.blueprint_id !== "string" || !record.blueprint_id.trim())
      ) {
        throw new ConstructionPlanError("BLUEPRINT_INVALID", "blueprint_id must be a non-empty string");
      }
      if (
        record.blueprint_hash !== undefined &&
        (typeof record.blueprint_hash !== "string" || !record.blueprint_hash.trim())
      ) {
        throw new ConstructionPlanError("BLUEPRINT_INVALID", "blueprint_hash must be a non-empty string");
      }
    }
    if (kind === "cleanup") {
      const bad = targets.filter((target) => target.cleanup !== true || target.allow_buildings !== true);
      if (bad.length) {
        throw new ConstructionPlanError(
          "PLAN_BAD_REQUEST",
          "cleanup targets must carry cleanup=true and allow_buildings=true",
          { invalid_targets: bad.length },
          400,
        );
      }
    }
    const scopeTargets =
      kind === "build" || kind === "blueprint" || kind === "expansion"
        ? entities.map((entity) => ({ x: entity.anchor.x, y: entity.anchor.y }))
        : targets;
    if (kind === "cleanup") {
      const mineCheck = this.refactorMineCheck(targets);
      if (mineCheck?.blocked) {
        throw new ConstructionPlanError("PLAN_SCOPE_VIOLATION", mineCheck.message, {
          out_of_cluster: mineCheck.out_of_cluster ?? 0,
        });
      }
    } else {
      const buildCheck = this.refactorBuildCheck(scopeTargets);
      if (buildCheck?.blocked) {
        throw new ConstructionPlanError("PLAN_SCOPE_VIOLATION", buildCheck.message, {
          tier: buildCheck.tier,
          allowed_clusters: buildCheck.allowed_clusters,
          out_of_cluster: buildCheck.out_of_cluster,
          actions: buildCheck.actions ?? [],
        });
      }
    }
    const auditRevision = run.audit_revision ?? 0;
    const requestedRevision = Number(record.audit_revision);
    if (Number.isFinite(requestedRevision) && requestedRevision !== auditRevision) {
      throw new ConstructionPlanError(
        "PLAN_REVISION_CHANGED",
        "The audit changed after this plan request; call factory-audit and re-plan.",
        { audit_revision: auditRevision },
      );
    }
    const rotation = Number(record.rotation);
    const normalizedRotation = [0, 2, 4, 6].includes(rotation) ? rotation : undefined;
    const mirror = record.mirror === true;
    const blueprintId =
      typeof record.blueprint_id === "string" && record.blueprint_id.trim()
        ? record.blueprint_id.trim()
        : undefined;
    const blueprintHash =
      typeof record.blueprint_hash === "string" && record.blueprint_hash.trim()
        ? record.blueprint_hash.trim()
        : decodedBlueprintHash;
    if (
      decodedBlueprintHash &&
      typeof record.blueprint_hash === "string" &&
      record.blueprint_hash.trim() &&
      record.blueprint_hash.trim() !== decodedBlueprintHash
    ) {
      throw new ConstructionPlanError(
        "BLUEPRINT_TARGET_MISMATCH",
        "blueprint_hash does not match the supplied blueprint.",
      );
    }
    if (blueprintId && !blueprintHash) {
      // The token must bind the design, not just its label.
      throw new ConstructionPlanError(
        "BLUEPRINT_INVALID",
        "blueprint_hash is required when blueprint_id is supplied",
      );
    }
    const planHash = constructionPlanHash({
      kind,
      entities,
      targets,
      ...(blueprintId ? { blueprint_id: blueprintId } : {}),
      ...(blueprintHash ? { blueprint_hash: blueprintHash } : {}),
      ...(anchor ? { anchor } : {}),
      ...(normalizedRotation !== undefined ? { rotation: normalizedRotation } : {}),
      ...(mirror ? { mirror } : {}),
    });
    const repeatedIneffective = run.construction_plans?.find(
      (entry) =>
        entry.targets_hash === planHash &&
        entry.verification?.result === "ineffective" &&
        Date.now() - Date.parse(entry.verification.verified_at) < 5 * 60 * 1000,
    );
    if (repeatedIneffective) {
      throw new ConstructionPlanError(
        "PLAN_INEFFECTIVE",
        "The same plan was ineffective within the last five minutes; change the plan before retrying.",
        { previous_plan_id: repeatedIneffective.plan_id },
      );
    }
    const requiredItems: Record<string, number> = blueprintRequired ? { ...blueprintRequired } : {};
    if (!blueprintRequired) {
      for (const entity of entities) requiredItems[entity.name] = (requiredItems[entity.name] ?? 0) + 1;
    }
    const ttlRaw = Number(process.env.AUTORIO_CONSTRUCTION_PLAN_TTL_SECONDS ?? 300);
    const ttl = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.min(3600, Math.round(ttlRaw)) : 300;
    const now = Date.now();
    const plan: ConstructionPlan = {
      plan_id: `pln_${randomUUID()}`,
      run_id: run.id,
      mode: "planned",
      kind,
      scope:
        kind === "cleanup"
          ? "cleanup"
          : kind === "expansion"
            ? "expansion"
            : kind === "mutation"
              ? "local_repair"
              : "in_cluster",
      created_at: now,
      expires_at: now + ttl * 1000,
      audit_revision: auditRevision,
      refactor_revision: auditRevision,
      audit_invalid_before: run.refactor?.invalid_count ?? 0,
      target_cluster_before: clusterCountInBBox(run.refactor?.clusters, planBBox(entities, targets)),
      targets_hash: planHash,
      required_items: requiredItems,
      bbox: planBBox(entities, targets),
      entities,
      targets,
      allowed_entity_names: [...new Set(entities.map((entity) => entity.name))].sort(),
      max_entities: Math.max(entities.length, targets.length),
      ...(blueprintId ? { blueprint_id: blueprintId } : {}),
      ...(blueprintHash ? { blueprint_hash: blueprintHash } : {}),
      ...(anchor ? { anchor } : {}),
      ...(normalizedRotation !== undefined ? { rotation: normalizedRotation } : {}),
      ...(mirror ? { mirror } : {}),
      single_use: true,
      status: "issued",
    };
    run.construction_plans ||= [];
    run.construction_plans.push(plan);
    state.metrics.plan_requests += 1;
    this.persist(run);
    this.event(
      run,
      `Construction plan ${plan.plan_id} issued (${kind}, ${plan.max_entities} target(s), audit ${auditRevision})`,
    );
    return constructionPlanPublic(plan);
  }

  /** Count and throw a rejected unplanned action. */
  private rejectConstructionPlan(run: Run, error: ConstructionPlanError): never {
    if (run.construction) {
      run.construction.metrics.plan_rejections += 1;
      run.construction.metrics.unplanned_actions += 1;
    }
    this.persist(run);
    throw error;
  }

  /**
   * Validate and consume a plan token at the action boundary. Internal job
   * loopback dispatches have already been authorized by the external job route
   * and must not consume a second token.
   */
  requireConstructionPlan(input: {
    plan_id?: unknown;
    allowed_kinds: ConstructionPlanKind[];
    entities?: unknown;
    targets?: unknown;
    blueprint_id?: unknown;
    blueprint_hash?: unknown;
    internal?: boolean;
  }): ConstructionPlan | undefined {
    const run = this.active;
    if (!run?.construction) return undefined;
    const state = run.construction;
    if (state.mode === "free") {
      if (!input.internal) {
        state.metrics.free_actions += 1;
        this.persist(run);
      }
      return undefined;
    }
    if (input.internal) return undefined;
    const planId = typeof input.plan_id === "string" ? input.plan_id.trim() : "";
    if (!planId) {
      this.rejectConstructionPlan(
        run,
        new ConstructionPlanError(
          "PLAN_REQUIRED",
          "Call POST /api/agent/plan with the planned entities/targets first; planned buildings cannot use raw actions.",
          { mode: state.mode, audit_revision: run.audit_revision ?? 0 },
        ),
      );
    }
    const plan = run.construction_plans?.find((entry) => entry.plan_id === planId);
    if (!plan)
      this.rejectConstructionPlan(
        run,
        new ConstructionPlanError("PLAN_REQUIRED", `Unknown construction plan ${planId}`),
      );
    if (!input.allowed_kinds.includes(plan.kind)) {
      this.rejectConstructionPlan(
        run,
        new ConstructionPlanError(
          "PLAN_KIND_MISMATCH",
          `Plan ${plan.plan_id} is ${plan.kind}, not ${input.allowed_kinds.join("/")}`,
          { kind: plan.kind },
        ),
      );
    }
    if (plan.status === "consumed") {
      this.rejectConstructionPlan(
        run,
        new ConstructionPlanError("PLAN_ALREADY_CONSUMED", `Plan ${plan.plan_id} was already used`),
      );
    }
    if (plan.status !== "issued") {
      this.rejectConstructionPlan(
        run,
        new ConstructionPlanError("PLAN_EXPIRED", `Plan ${plan.plan_id} is ${plan.status}`),
      );
    }
    if (plan.expires_at <= Date.now()) {
      plan.status = "expired";
      this.rejectConstructionPlan(
        run,
        new ConstructionPlanError("PLAN_EXPIRED", `Plan ${plan.plan_id} expired`),
      );
    }
    const inProgressChunked =
      ["blueprint", "power", "pipe", "belt"].includes(plan.kind) &&
      plan.status === "issued" &&
      (plan.executed_entities?.length ?? 0) > 0;
    if (!inProgressChunked && (run.audit_revision ?? 0) !== plan.audit_revision) {
      this.rejectConstructionPlan(
        run,
        new ConstructionPlanError(
          "PLAN_REVISION_CHANGED",
          "The audit changed after this plan was issued; call factory-audit and re-plan.",
          { audit_revision: run.audit_revision ?? 0 },
        ),
      );
    }
    const actionEntities = (Array.isArray(input.entities) ? input.entities : [])
      .map((entry) => normalizeConstructionEntity(entry))
      .filter((entry): entry is ConstructionEntity => Boolean(entry));
    const actionTargets = (Array.isArray(input.targets) ? input.targets : [])
      .map((entry) => normalizeConstructionTarget(entry))
      .filter((entry): entry is ConstructionTarget => Boolean(entry));
    if (["blueprint", "power", "pipe", "belt"].includes(plan.kind)) {
      // Multi-entity plans execute in chunks. Every chunk entity must belong to
      // the manager-expanded plan; the token is consumed after the full set.
      // manager-expanded plan; the token is consumed only after the full set.
      if (!actionEntities.length) {
        this.rejectConstructionPlan(
          run,
          new ConstructionPlanError("PLAN_TARGET_MISMATCH", "Blueprint action has no entities"),
        );
      }
      const planned = new Set(
        plan.entities.map((entity) =>
          JSON.stringify({
            name: entity.name,
            anchor: entity.anchor,
            direction: entity.direction,
            underground_type: entity.underground_type,
          }),
        ),
      );
      const executed = new Set(plan.executed_entities ?? []);
      for (const entity of actionEntities) {
        const key = JSON.stringify({
          name: entity.name,
          anchor: entity.anchor,
          direction: entity.direction,
          underground_type: entity.underground_type,
        });
        if (!planned.has(key)) {
          this.rejectConstructionPlan(
            run,
            new ConstructionPlanError(
              "PLAN_TARGET_MISMATCH",
              "Blueprint chunk contains an entity outside the manager-expanded plan.",
              { plan_id: plan.plan_id },
            ),
          );
        }
        if (executed.has(key)) {
          this.rejectConstructionPlan(
            run,
            new ConstructionPlanError(
              "PLAN_ALREADY_CONSUMED",
              "Blueprint chunk repeats an already executed entity.",
              { plan_id: plan.plan_id },
            ),
          );
        }
        executed.add(key);
      }
      plan.executed_entities = [...executed];
      state.metrics.planned_actions += 1;
      if (plan.executed_entities.length >= plan.entities.length) plan.status = "consumed";
      this.persist(run);
      this.event(
        run,
        `Blueprint plan ${plan.plan_id} chunk accepted (${plan.executed_entities.length}/${plan.entities.length})`,
      );
      return plan;
    }
    const actionHash = constructionPlanHash({
      kind: plan.kind,
      entities: actionEntities,
      targets: actionTargets,
      ...(plan.blueprint_id ? { blueprint_id: plan.blueprint_id } : {}),
      ...(plan.blueprint_hash ? { blueprint_hash: plan.blueprint_hash } : {}),
      ...(plan.anchor ? { anchor: plan.anchor } : {}),
      ...(plan.rotation !== undefined ? { rotation: plan.rotation } : {}),
      ...(plan.mirror ? { mirror: plan.mirror } : {}),
    });
    if (actionHash !== plan.targets_hash) {
      this.rejectConstructionPlan(
        run,
        new ConstructionPlanError(
          "PLAN_TARGET_MISMATCH",
          "The action payload does not match the planned entities/targets.",
          { plan_id: plan.plan_id },
        ),
      );
    }
    const points = [...actionEntities.map((entity) => entity.anchor), ...actionTargets];
    const outside = points.filter(
      (point) =>
        point.x < plan.bbox.left ||
        point.x > plan.bbox.right ||
        point.y < plan.bbox.top ||
        point.y > plan.bbox.bottom,
    );
    if (outside.length) {
      this.rejectConstructionPlan(
        run,
        new ConstructionPlanError(
          "PLAN_SCOPE_VIOLATION",
          "Action targets fall outside the issued plan bbox.",
          { outside: outside.length },
        ),
      );
    }
    plan.status = "consumed";
    state.metrics.planned_actions += 1;
    this.persist(run);
    this.event(run, `Construction plan ${plan.plan_id} consumed (${plan.kind})`);
    return plan;
  }

  /**
   * Classify a consumed plan after its job finished and an audit refresh ran.
   * Called by the server's action-job recorder, never by the agent.
   */
  verifyConstructionPlan(
    planId: string,
    job: { status?: string; error?: string | null; results?: unknown[] },
  ) {
    const run = this.active;
    const plan = run?.construction_plans?.find((entry) => entry.plan_id === planId);
    if (!run || !plan || plan.status !== "consumed" || plan.verification) return undefined;
    const before = plan.audit_invalid_before;
    const after = run.refactor?.invalid_count ?? before;
    const targetBefore = plan.target_cluster_before ?? 0;
    const targetAfter = clusterCountInBBox(run.refactor?.clusters, plan.bbox);
    const targetDelta = targetAfter - targetBefore;
    let result: "effective" | "neutral" | "ineffective" | "regressed";
    if (job.status !== "completed") result = "ineffective";
    else if (targetDelta < 0) result = "effective";
    else if (targetDelta > 0) result = "regressed";
    else if (after < before) result = "effective";
    else if (after === before) result = "neutral";
    else result = "regressed";
    plan.verification = {
      result,
      audit_before: before,
      audit_after: after,
      verified_at: new Date().toISOString(),
      ...(job.error ? { error: String(job.error).slice(0, 300) } : {}),
    };
    if (run.construction) {
      if (result === "ineffective") run.construction.metrics.plan_ineffective += 1;
      if (result === "regressed") run.construction.metrics.plan_regressions += 1;
    }
    this.persist(run);
    this.event(run, `Construction plan ${plan.plan_id} verified: ${result} (audit ${before} -> ${after})`);
    return plan.verification;
  }

  refactorBuildCheck(
    targets: RefactorBuildTarget[],
    _options: { internal?: boolean } = {},
  ): RefactorBuildCheck | undefined {
    const run = this.active;
    if (!run?.refactor || run.state !== "running") return undefined;
    // Free construction is an evaluation mode: audit is read-only and never
    // blocks legacy direct actions.
    if ((run.construction?.mode ?? "free") === "free") return undefined;
    const state = run.refactor;
    const tier = state.escalation_tier ?? "normal";
    const allowed = (state.clusters ?? [])
      .filter((cluster) =>
        ["x", "y", "radius"].every((key) => Number.isFinite(Number(cluster[key as keyof RefactorCluster]))),
      )
      .slice(0, 8);
    const credits = Math.max(0, Math.round(state.build_credits ?? 0));
    const armed = this.refactorArmed(state);
    const base: RefactorBuildCheck = {
      blocked: false,
      armed,
      tier,
      build_credits: credits,
      allowed_clusters: allowed,
      out_of_cluster: 0,
      message: "",
      actions: state.actions,
    };
    if (!armed) return base;
    const points = (Array.isArray(targets) ? targets : []).filter(
      (target) => Number.isFinite(Number(target?.x)) && Number.isFinite(Number(target?.y)),
    );
    const inside = points.filter((target) =>
      allowed.some((cluster) => pointInRefactorCluster(cluster, Number(target.x), Number(target.y))),
    ).length;
    const outside = points.length - inside;
    if (outside > 0) {
      return {
        ...base,
        blocked: true,
        reason: "expansion",
        out_of_cluster: outside,
        message:
          `Refactor debt ${state.invalid_count} persists: expansion is blocked (${outside} target(s) outside the flagged rebuild clusters). ` +
          "Repair/rebuild inside the flagged clusters freely, or clean flagged/obsolete entities and re-audit.",
      };
    }
    // Repairs and local rebuilds inside a flagged cluster are deliberately free.
    // Charging credits here made a zero-credit relayout_only tier block even the
    // one-tile repairs needed to clear its own debt, pushing agents to dismantle
    // working production blocks to earn credits.
    return base;
  }

  /** Require building mining during refactor debt to be explicit flagged cleanup. */
  refactorMineCheck(
    targets: Array<{ x?: unknown; y?: unknown; cleanup?: unknown; allow_buildings?: unknown }>,
  ): { blocked: boolean; message: string; out_of_cluster?: number } | undefined {
    const run = this.active;
    if ((run?.construction?.mode ?? "free") === "free") return undefined;
    const state = run?.refactor;
    if (!run || !state || !this.refactorArmed(state)) return undefined;
    const buildingTargets = (Array.isArray(targets) ? targets : []).filter(
      (target) => target?.allow_buildings === true,
    );
    if (!buildingTargets.length) return undefined;
    const notCleanup = buildingTargets.some((target) => target.cleanup !== true);
    if (notCleanup) {
      return {
        blocked: true,
        message:
          "Mining player-owned buildings while refactor debt is active requires cleanup=true on every target. " +
          "Only flagged or obsolete entities may be cleaned; never dismantle a working production block.",
      };
    }
    const allowed = (state.clusters ?? []).filter((cluster) =>
      ["x", "y", "radius"].every((key) => Number.isFinite(Number(cluster[key as keyof RefactorCluster]))),
    );
    const outside = buildingTargets.filter(
      (target) =>
        !allowed.some((cluster) => pointInRefactorCluster(cluster, Number(target.x), Number(target.y))),
    ).length;
    if (outside > 0) {
      return {
        blocked: true,
        out_of_cluster: outside,
        message:
          `Mining ${outside} cleanup target(s) outside the flagged rebuild clusters is blocked during refactor debt. ` +
          "Clean only flagged/obsolete entities inside allowed_clusters, then re-audit.",
      };
    }
    return undefined;
  }

  /** Spend in-cluster rebuild credits after an external build was authorized. */
  consumeRefactorCredits(count: number): void {
    const run = this.active;
    const state = run?.refactor;
    if (!run || !state) return;
    const spend = Math.max(0, Math.round(Number(count) || 0));
    if (!spend) return;
    const current = Math.max(0, Math.round(state.build_credits ?? 0));
    const next = Math.max(0, current - spend);
    if (next === current) return;
    state.build_credits = next;
    this.persist(run);
  }

  /** Compact refactor view for agent observations (operational state, not the eval score). */
  refactorView() {
    const run = this.active;
    const state = run?.refactor;
    if (!state) return undefined;
    return {
      invalid_count: state.invalid_count,
      tier: state.escalation_tier ?? "normal",
      gate_active: this.refactorGate()?.blocked ?? false,
      build_credits: Math.max(0, Math.round(state.build_credits ?? 0)),
      local_repairs_free: true,
      clusters: state.clusters ?? [],
      actions: state.actions,
      big_reset_pending: state.big_reset_pending,
      audits_with_debt: state.audits_with_debt,
    };
  }

  /** Require at least one captured blueprint before further expansion. */
  blueprintGate(): { blocked: boolean; message: string; blueprints: number } | undefined {
    const run = this.active;
    if (!run || run.state !== "running") return undefined;
    const count = this.blueprints(run.id)?.length ?? 0;
    const rawGrace = process.env.AUTORIO_BLUEPRINT_GATE_MIN_SECONDS;
    const minSeconds =
      rawGrace !== undefined && rawGrace !== "" && Number.isFinite(Number(rawGrace))
        ? Math.max(0, Number(rawGrace))
        : 900;
    const blocked = count === 0 && this.elapsed() >= minSeconds;
    return {
      blocked,
      blueprints: count,
      message: blocked ? "No blueprint captured yet. Capture a validated layout before expanding." : "",
    };
  }

  /**
   * Operator leaderboard grouped by benchmark construction variant. Free and
   * planned runs never share a ranking group.
   */
  leaderboard(filters: { benchmark?: string; variant?: string; model?: string } = {}) {
    const groups = new Map<
      string,
      {
        variant: string;
        benchmark: string;
        construction_mode: string;
        blueprint_policy: string;
        ranked: boolean;
        runs: Array<{
          id: string;
          name: string;
          state: RunState;
          model: string | null;
          elapsed_seconds: number;
          score: number | null;
          completed: boolean;
          completion_seconds: number | null;
          created_at: string;
        }>;
      }
    >();
    for (const run of this.runs.values()) {
      if (run === this.active && !run.evaluation) continue;
      const capability = run.evaluation?.capability;
      const construction = run.construction;
      const mode = capability?.construction_mode ?? construction?.mode ?? "free";
      const variant =
        capability?.variant ??
        construction?.variant ??
        `${run.benchmark.id}:${mode}:${run.scoring?.blueprint_policy ?? "none"}`;
      const key = `${run.benchmark.id}:${variant}`;
      const group = groups.get(key) ?? {
        variant,
        benchmark: run.benchmark.id,
        construction_mode: mode,
        blueprint_policy:
          capability?.blueprint_policy ??
          construction?.blueprints?.source ??
          run.scoring?.blueprint_policy ??
          "none",
        ranked: run.benchmark.scoring?.ranked ?? true,
        runs: [],
      };
      groups.set(key, group);
      group.runs.push({
        id: run.id,
        name: run.name || run.id,
        state: run.state,
        model: run.model ?? null,
        elapsed_seconds: Math.round(run.elapsed_seconds),
        score: capability ? capability.score : null,
        completed: capability?.completed ?? false,
        completion_seconds: capability?.completion_seconds ?? null,
        created_at: run.created_at,
      });
    }
    const sorted = [...groups.values()].map((group) => {
      group.runs.sort(
        (left, right) =>
          Number(right.completed) - Number(left.completed) ||
          (right.score ?? -1) - (left.score ?? -1) ||
          left.elapsed_seconds - right.elapsed_seconds,
      );
      return group;
    });
    const filtered = sorted
      .filter((group) => !filters.benchmark || group.benchmark === filters.benchmark)
      .filter((group) => !filters.variant || group.variant === filters.variant)
      .map((group) => ({
        ...group,
        runs: filters.model
          ? group.runs.filter((entry) => (entry.model ?? "") === filters.model)
          : group.runs,
      }))
      .filter((group) => group.runs.length > 0);
    filtered.sort(
      (left, right) =>
        left.benchmark.localeCompare(right.benchmark) || left.variant.localeCompare(right.variant),
    );
    return { generated_at: new Date().toISOString(), groups: filtered };
  }

  private view(run: Run) {
    const state = this.stateFile(run);
    const stateStatus = run === this.active ? this.stateStatus() : undefined;
    return {
      ...run,
      state_md: state?.text,
      state_updated_at: state?.updated_at,
      state_info: state
        ? {
            revision: state.revision,
            updated_by: state.updated_by,
            external_changed: state.external_changed,
            content_sha256: state.content_sha256,
            age_seconds: Math.max(0, Math.round((Date.now() - Date.parse(state.updated_at)) / 1000)),
          }
        : undefined,
      state_status: stateStatus
        ? {
            age_seconds: stateStatus.age_seconds,
            due: stateStatus.due,
            blocked: stateStatus.blocked,
            soft_seconds: stateStatus.soft_seconds,
            hard_seconds: stateStatus.hard_seconds,
            grace_seconds: stateStatus.grace_seconds,
          }
        : undefined,
      ...(run.refactor
        ? {
            refactor: {
              ...run.refactor,
              gate_active: Boolean(this.refactorGate()?.blocked && run === this.active),
            },
          }
        : {}),
      resumable: this.canResume(run),
      model_label: modelLabel(run),
      elapsed_seconds: run === this.active && run.state === "running" ? this.elapsed() : run.elapsed_seconds,
    };
  }
  log(id: string, offset: number, native: boolean | "events" | "telemetry" = false) {
    const run = this.runs.get(id);
    if (!run) throw new Error("Run not found");
    const file = path.join(
      this.dir(run),
      native === "telemetry"
        ? "telemetry.jsonl"
        : native === "events"
          ? "agent.events.jsonl"
          : native
            ? "codex.log"
            : "activity.log",
    );
    if (!fs.existsSync(file)) return native ? { data: "", offset: 0 } : { text: "", offset: 0 };
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.min(Math.max(0, offset), size);
      const buffer = Buffer.alloc(Math.min(size - start, 128 * 1024));
      const length = fs.readSync(fd, buffer, 0, buffer.length, start);
      return native
        ? { data: buffer.subarray(0, length).toString("base64"), offset: start + length }
        : { text: buffer.subarray(0, length).toString("utf8"), offset: start + length };
    } finally {
      fs.closeSync(fd);
    }
  }

  start(options: {
    benchmark?: string;
    map_gen?: unknown;
    model?: string;
    reasoning_effort?: string;
    agent?: string;
    language?: string;
    max_seconds?: number;
    terminal?: boolean;
    recording?: boolean;
    capture_video?: boolean;
    construction_mode?: string;
  }) {
    if (this.active || this.hooks.running())
      throw new Error("Stop the active game/run before starting another run.");
    let benchmark = this.benchmarks.find((b) => b.id === (options.benchmark || "smoke"));
    if (!benchmark) throw new Error("Unknown benchmark");
    if (options.map_gen !== undefined) {
      benchmark = { ...benchmark, map_gen: normalizeMapGen(options.map_gen, benchmark.map_gen) };
    }
    if (options.map_gen !== undefined) {
      benchmark = { ...benchmark, map_gen: normalizeMapGen(options.map_gen, benchmark.map_gen) };
    }
    const requestedMode = options.construction_mode ?? benchmark.construction.default_mode;
    if (requestedMode !== "free" && requestedMode !== "planned") {
      throw new Error("construction_mode must be free or planned");
    }
    if (!benchmark.construction.modes.includes(requestedMode)) {
      throw new Error(
        `benchmark ${benchmark.id} does not allow construction_mode=${requestedMode}; allowed: ${benchmark.construction.modes.join(", ")}`,
      );
    }
    const constructionMode = requestedMode;
    const constructionVariantName = constructionVariant(
      benchmark.id,
      benchmark.construction,
      constructionMode,
    );
    const agent = options.agent || "opencode";
    if (!["manual", "codex", "opencode", "dsh"].includes(agent))
      throw new Error("agent must be opencode, codex, dsh or manual");
    const max = options.max_seconds ?? benchmark.max_seconds;
    if (!Number.isFinite(max) || max < 1 || max > 86400)
      throw new Error("max_seconds must be between 1 and 86400");
    if (options.model !== undefined && (typeof options.model !== "string" || !options.model.trim()))
      throw new Error("Invalid model");
    if (
      options.language !== undefined &&
      (typeof options.language !== "string" || !options.language.trim() || options.language.length > 40)
    )
      throw new Error("Invalid language");
    if (options.terminal !== undefined && typeof options.terminal !== "boolean")
      throw new Error("terminal must be a boolean");
    if (options.recording !== undefined && typeof options.recording !== "boolean")
      throw new Error("recording must be a boolean");
    if (options.capture_video !== undefined && typeof options.capture_video !== "boolean")
      throw new Error("capture_video must be a boolean");
    const contextLimit = Math.floor(Number(process.env.AUTORIO_CONTEXT_LIMIT || 0));
    const explicitEffort = options.reasoning_effort;
    const effort = explicitEffort ?? "low";
    if (!REASONING_LEVELS.includes(effort as ReasoningLevel))
      throw new Error(`Invalid reasoning_effort; choose ${REASONING_LEVELS.join(", ")}`);
    const created = new Date();
    const timestamp = pacificTimestamp(created);
    const run: Run = {
      id: `${timestamp.replaceAll(":", "-").replaceAll(" ", "_")}-${randomUUID().slice(0, 8)}`,
      name: `${timestamp} · ${benchmark.id}`,
      reasoning_effort:
        agent === "codex"
          ? (effort as ReasoningLevel)
          : agent === "dsh"
            ? (explicitEffort as ReasoningLevel | undefined)
            : undefined,
      benchmark: { ...benchmark, milestones: trackedMilestones(benchmark) },
      state: "preparing",
      created_at: created.toISOString(),
      model: agent === "opencode" ? opencodeModel(options.model) : options.model,
      language: options.language?.trim() || process.env.AUTORIO_AGENT_LANGUAGE?.trim() || undefined,
      agent: agent as Run["agent"],
      max_seconds: max,
      // DSH renders only the web transcript; the codex-shaped terminal viewer
      // cannot display its event stream.
      terminal:
        agent !== "manual" && agent !== "dsh" && (options.terminal ?? process.env.AUTORIO_TERMINAL === "1"),
      elapsed_seconds: 0,
      milestones: {},
      warnings: [],
      context_tokens: 0,
      context_limit: Number.isFinite(contextLimit) && contextLimit > 0 ? contextLimit : undefined,
      session_resets: 0,
      actions: { submitted: 0, completed: 0, failed: 0, cancelled: 0, partial_failures: 0 },
      automation: {
        score: 0,
        positive: 0,
        penalty: 0,
        state_penalty: 0,
        blackout_penalty: 0,
        alert_penalty: 0,
        blackouts: 0,
        manual_mines: 0,
        manual_crafts: 0,
        cleanup_units: 0,
        refactor_reward: 0,
        breakdown: { production: 0, science: 0, power: 0, research: 0, rockets: 0, refactor: 0 },
      },
      scoring: {
        ...scoringForVariant(benchmark.scoring, constructionVariantName),
        progress_weights: { ...benchmark.scoring.progress_weights },
        construction_mode: constructionMode,
        benchmark_variant: constructionVariantName,
        blueprint_policy: benchmark.construction.blueprints.enabled
          ? benchmark.construction.blueprints.source
          : "none",
      },
      construction: {
        mode: constructionMode,
        variant: constructionVariantName,
        plan_required: constructionMode === "planned",
        blueprints: { ...benchmark.construction.blueprints },
        metrics: {
          planned_actions: 0,
          free_actions: 0,
          unplanned_actions: 0,
          plan_requests: 0,
          plan_rejections: 0,
          plan_ineffective: 0,
          plan_regressions: 0,
          cleanup_units: 0,
          blueprints_used: 0,
          blueprint_entities_planned: 0,
          blueprint_entities_placed: 0,
          blueprint_entities_failed: 0,
        },
      },
      audit_revision: 0,
      state_metrics: { due_seconds: 0, blocked_seconds: 0 },
    };
    run.capture_video = run.agent !== "manual" && (options.capture_video ?? obsEnabled());
    if (run.capture_video && run.terminal)
      throw new Error("OBS capture requires the web recording window; use --no-terminal or --no-video");
    if (run.capture_video) run.video = { state: "pending", capture_fps: 5, playback_fps: 30, speed: 6 };
    run.recording =
      run.agent !== "manual" && !run.terminal && (run.capture_video || (options.recording ?? true));
    run.output_format =
      run.agent === "opencode" || run.agent === "dsh" ? "events" : run.terminal ? "native" : "events";
    fs.mkdirSync(this.dir(run), { recursive: true });
    this.active = run;
    this.runs.set(run.id, run);
    this.persist(run);
    this.beginSegment(run);
    this.abort = new AbortController();
    this.ending = undefined;
    this.startedMono = 0;
    this.elapsedBefore = 0;
    this.stopRequested = false;
    this.telemetryErrors = 0;
    this.preparation = this.prepare(run).catch(async (error) => {
      if (!this.stopRequested) await this.finish("failed", errorText(error));
    });
    return this.view(run);
  }

  private beginSegment(run: Run) {
    const size = (name: string) => {
      try {
        return fs.statSync(path.join(this.dir(run), name)).size;
      } catch {
        return 0;
      }
    };
    run.segments ||= [];
    run.segments.push({
      index: run.segments.length + 1,
      state: "preparing",
      start_seconds: run.elapsed_seconds,
      event_offset: size("agent.events.jsonl"),
      native_offset: size("codex.log"),
    });
    if (run.capture_video) run.video = { state: "pending", capture_fps: 5, playback_fps: 30, speed: 6 };
    this.persist(run);
  }
  private segment(run: Run) {
    return run.segments!.at(-1)!;
  }
  private segmentDir(run: Run) {
    return path.join(this.dir(run), "segments", String(this.segment(run).index).padStart(3, "0"));
  }
  private videoDir(run: Run) {
    return this.segment(run).index === 1 ? this.dir(run) : this.segmentDir(run);
  }
  /**
   * Optional startup recovery: with AUTORIO_AUTO_RESUME=1, resume the newest
   * interrupted run that still has a current checkpoint. Never resumes a
   * run that an operator explicitly stopped or completed.
   */
  autoResumeInterrupted(): string | undefined {
    if (process.env.AUTORIO_AUTO_RESUME !== "1") return undefined;
    const candidates = this.list()
      .filter((run) => run.state === "interrupted" && run.resumable)
      .sort((a, b) => String(b.ended_at || b.created_at).localeCompare(String(a.ended_at || a.created_at)));
    const candidate = candidates[0];
    if (!candidate) return undefined;
    try {
      this.resume(candidate.id);
      return candidate.id;
    } catch {
      return undefined;
    }
  }

  /** A checkpoint is resumable when it belongs to the current segment, not a stale save. */
  private canResume(run: Run): boolean {
    const checkpoint = run.checkpoint;
    if (!checkpoint || !fs.existsSync(path.join(this.dir(run), checkpoint.file))) return false;
    if (!["paused", "failed", "interrupted", "timed_out"].includes(run.state)) return false;
    if (run.elapsed_seconds >= run.max_seconds) return false;
    if (run.state === "timed_out" && run.elapsed_seconds >= run.max_seconds - 1) return false;
    if (run.state === "paused" || checkpoint.segment === this.segment(run).index) return true;
    // A failed run can have started a new segment after saving its checkpoint;
    // resuming the immediately previous segment is still safe when the run
    // failure happened during startup/telemetry before any progress.
    return (
      run.state === "failed" &&
      /Telemetry failed/i.test(run.reason || "") &&
      checkpoint.segment === this.segment(run).index - 1
    );
  }

  /** Extend a run's wall-clock budget without touching its checkpoint. */
  extend(id: string, seconds: number) {
    const run = this.runs.get(id);
    if (!run) throw new Error("Run not found");
    const extra = Math.floor(Number(seconds));
    if (!Number.isFinite(extra) || extra <= 0)
      throw new Error("Extension must be a positive number of seconds");
    if (extra > 30 * 24 * 3600) throw new Error("Extension is too large");
    run.max_seconds = Math.round(run.max_seconds + extra);
    if (this.active === run && run.state === "running") {
      if (this.watchdog) clearTimeout(this.watchdog);
      this.watchdog = setTimeout(
        () => {
          void this.finish("timed_out", "Wall-clock time limit reached");
        },
        Math.max(1, run.max_seconds - this.elapsed()) * 1000,
      );
    }
    this.persist(run);
    return this.view(run);
  }

  resume(id: string) {
    if (this.active || this.hooks.running())
      throw new Error("Stop the active game/run before resuming another run");
    const run = this.runs.get(id);
    if (!run || !this.canResume(run))
      throw new Error("Only a paused, timed-out, or checkpointed failed/interrupted run can be resumed");
    const checkpoint = run.checkpoint!;
    if (sha256(fs.readFileSync(path.join(this.dir(run), checkpoint.file))) !== checkpoint.sha256)
      throw new Error("Checkpoint checksum changed; refusing to load a different game");
    if (run.elapsed_seconds >= run.max_seconds) throw new Error("The run has no active play time remaining");
    if (run.video?.state === "rendering")
      throw new Error("Wait for the current recording segment to finish rendering");
    if (!run.context_limit) {
      const limit = Math.floor(Number(process.env.AUTORIO_CONTEXT_LIMIT || 0));
      if (Number.isFinite(limit) && limit > 0) run.context_limit = limit;
    }
    run.state = "preparing";
    delete run.ended_at;
    delete run.reason;
    delete run.agent_exit;
    delete run.failure_kind;
    delete run.state_blocked_since;
    delete run.state_nudge_restarted;
    run.auto_continues = 0;
    if (run.usage) run.usage_status = "last_reported";
    this.elapsedBefore = run.elapsed_seconds;
    this.startedMono = 0;
    this.beginSegment(run);
    this.active = run;
    this.abort = new AbortController();
    this.ending = undefined;
    this.stopRequested = false;
    this.telemetryErrors = 0;
    this.preparation = this.prepare(run, true).catch(async (error) => {
      if (!this.stopRequested) await this.finish("paused", `Resume failed: ${errorText(error)}`);
    });
    return this.view(run);
  }

  private checkCancelled() {
    if (this.stopRequested) throw new Error("Run stopped");
  }
  private async prepare(run: Run, resuming = false) {
    const dir = this.dir(run);
    if (run.capture_video && !this.hooks.startVideo) {
      await ensureObsRunning();
      const client = await connectObs();
      try {
        if (asBoolean(asRecord(await client.request("GetRecordStatus"))?.outputActive))
          throw new Error("OBS is already recording; refusing to take over an existing recording");
      } finally {
        client.close();
      }
    }
    const workspace = path.join(dir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const version = await factorioVersion();
    this.checkCancelled();
    const client = fs.readFileSync(path.join(ROOT, "factorio.py"));
    const instructions = fs.readFileSync(path.join(ROOT, "runs/run_template/AGENTS.md"));
    const cookbook = fs.readFileSync(path.join(ROOT, "runs/run_template/COOKBOOK.md"));
    const knowledge = fs.readFileSync(path.join(ROOT, "runs/run_template/KNOWLEDGE.md"));
    const layout = fs.readFileSync(path.join(ROOT, "runs/run_template/LAYOUT.md"));
    // Always refresh the bundled client/playbook. A resumed run must not keep an
    // older factorio.py that predates tools/manifest commands the prompt expects.
    fs.writeFileSync(path.join(workspace, "factorio.py"), client);
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), instructions);
    fs.writeFileSync(path.join(workspace, "COOKBOOK.md"), cookbook);
    fs.writeFileSync(path.join(workspace, "KNOWLEDGE.md"), knowledge);
    fs.writeFileSync(path.join(workspace, "LAYOUT.md"), layout);
    const analysisDir = path.join(ROOT, "blueprint_analysis");
    if (fs.existsSync(analysisDir)) {
      fs.cpSync(analysisDir, path.join(workspace, "blueprint_analysis"), { recursive: true });
    }
    for (const vendored of ["vendor", "tools"]) {
      const sourceDir = path.join(ROOT, vendored);
      if (fs.existsSync(sourceDir)) {
        fs.cpSync(sourceDir, path.join(workspace, vendored), { recursive: true });
      }
    }
    fs.writeFileSync(
      path.join(workspace, "TASK.md"),
      `# Task\n\n${run.benchmark.task}\n\nTime limit: ${run.max_seconds} wall-clock seconds.\n`,
    );
    fs.writeFileSync(path.join(dir, "benchmark.json"), JSON.stringify(run.benchmark, null, 2));
    let commit = "unknown";
    try {
      commit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ROOT })).stdout.trim();
    } catch {
      /* optional */
    }
    if (resuming && run.versions?.factorio !== version)
      throw new Error("Factorio version changed since this run started");
    if (!resuming) run.versions = { factorio: version, manager_commit: commit, node: process.version };
    if (!resuming)
      run.hashes = {
        client: sha256(client),
        instructions: sha256(instructions),
        cookbook: sha256(cookbook),
        benchmark: sha256(JSON.stringify(run.benchmark)),
        harness: sha256(
          ["server.ts", "runtime.ts", "runs.ts", "benchmarks.ts"]
            .map((file) => file + "\n" + fs.readFileSync(path.join(ROOT, "src", file), "utf8"))
            .join("\n"),
        ),
      };
    if (resuming && run.hashes) {
      const refreshed = {
        client: sha256(client),
        instructions: sha256(instructions),
        cookbook: sha256(cookbook),
      };
      if (
        refreshed.client !== run.hashes.client ||
        refreshed.instructions !== run.hashes.instructions ||
        refreshed.cookbook !== run.hashes.cookbook
      ) {
        this.event(run, "Refreshed agent workspace client/playbook files for this resume");
        Object.assign(run.hashes, refreshed);
      }
    }
    if (!resuming) {
      const key = sha256(JSON.stringify({ version, map_gen: run.benchmark.map_gen, mods: controlModHash() }));
      const baselineDir = path.join(DATA_DIR, "baselines", key);
      const baselineSave = path.join(baselineDir, "baseline.zip");
      if (!fs.existsSync(baselineSave)) {
        this.event(run, "Generating fixed-seed baseline map");
        await createMap(
          baselineSave + ".tmp.zip",
          path.join(baselineDir, "profile"),
          run.benchmark.map_gen,
          this.abort?.signal,
        );
        this.checkCancelled();
        fs.renameSync(baselineSave + ".tmp.zip", baselineSave);
      }
      this.checkCancelled();
      run.hashes!.control_mod = controlModHash();
      run.hashes!.baseline_save = sha256(fs.readFileSync(baselineSave));
      fs.copyFileSync(baselineSave, path.join(dir, "game.zip"));
    }
    run.state = "launching";
    this.persist(run);
    this.event(run, "Launching graphical Factorio; waiting for RCON and a player character");
    await this.hooks.start(
      resuming ? path.join(dir, run.checkpoint!.file) : path.join(dir, "game.zip"),
      path.join(dir, "profile"),
      path.join(dir, "factorio.log"),
      { locale: factorioLocale(run.language) },
    );
    this.checkCancelled();
    const deadline = performance.now() + Number(process.env.AUTORIO_STARTUP_SECONDS || 180) * 1000;
    let ready: Snapshot | undefined;
    while (performance.now() < deadline) {
      this.checkCancelled();
      if (!this.hooks.running())
        throw new Error("Factorio exited during startup. Check factorio.log; ensure Steam is signed in.");
      try {
        await this.hooks.connect();
        ready = parseSnapshot(await this.hooks.command(TELEMETRY_COMMAND));
        break;
      } catch {
        await sleep(1000);
      }
    }
    if (!ready)
      throw new Error(
        "Factorio readiness timeout. Check for a Steam or game dialog and inspect factorio.log.",
      );
    this.checkCancelled();
    if (!resuming) {
      // The first /sc on a fresh save can only acknowledge achievement disabling.
      const setup =
        "/sc local p=game.players[1]; if p.controller_type==defines.controllers.cutscene then p.exit_cutscene() end; game.tick_paused=true; game.speed=1; " +
        `p.surface.always_day=${run.benchmark.always_day}; ${run.benchmark.always_day ? "p.surface.daytime=0; " : ""}p.clear_items_inside(); ` +
        Object.entries(run.benchmark.starting_items)
          .map(
            ([name, count]) =>
              `assert(p.insert{name=${JSON.stringify(name)},count=${count}}==${count},'starting inventory does not fit');`,
          )
          .join(" ") +
        " local f=remote.interfaces.freeplay; if f and f.set_skip_intro then remote.call('freeplay','set_skip_intro',true) end; " +
        "if f and f.set_disable_crashsite then remote.call('freeplay','set_disable_crashsite',true) end; rcon.print('ready')";
      if (!(await this.hooks.command(setup)).includes("ready"))
        throw new Error("Failed to initialize benchmark inventory/settings");
      run.baseline = parseSnapshot(await this.hooks.command(TELEMETRY_COMMAND));
      run.baseline_tick = run.baseline.tick;
    } else {
      await this.hooks.command("/sc game.tick_paused=true; rcon.print('paused')");
      const loaded = parseSnapshot(await this.hooks.command(TELEMETRY_COMMAND));
      if (loaded.tick < (run.latest?.tick ?? run.baseline_tick!))
        throw new Error("Loaded checkpoint is older than the recorded game state");
      fs.writeFileSync(
        path.join(workspace, "RESUME.md"),
        `Continue the same benchmark from its saved game. Active play time so far: ${run.elapsed_seconds.toFixed(2)} seconds. Waiting and loading time are excluded.\n\nMilestones: ${JSON.stringify(run.milestones)}\n\nCurrent game snapshot: ${JSON.stringify(loaded)}\n\nIf STATE.md is missing or stale, call state-write to refresh it before any mutating action. A short resume grace applies, then stale-state gating resumes.\n`,
      );
      const existingState = this.stateFile(run);
      const existingAge = existingState ? (Date.now() - Date.parse(existingState.updated_at)) / 1000 : null;
      if (!existingState || existingAge === null || existingAge > 300) {
        fs.writeFileSync(
          path.join(workspace, "PLAN_REMINDER.md"),
          "Resume: STATE.md is missing or stale. Call state-write / POST /api/agent/state before any mutating action.\n",
        );
        this.emitTranscript(run, {
          id: `state-resume-marker-${Date.now()}`,
          type: "event_marker",
          text: "Resume: refresh STATE.md before mutating actions",
        });
      }
    }
    await this.hooks.command(
      "/sc if remote.interfaces['autorio-control'] then remote.call('autorio-control','reset') end; rcon.print('controls_reset')",
    );
    if (run.agent !== "manual") await this.checkAgent(run);
    this.checkCancelled();
    if (run.terminal || run.recording) {
      try {
        if (run.terminal) await openRunTerminal(dir);
        else await (this.hooks.openRecording || openRunRecording)(dir);
      } catch (error) {
        run.warnings.push(`${run.terminal ? "Terminal" : "Recording"} view: ${errorText(error)}`);
        this.persist(run);
        this.event(run, run.warnings.at(-1)!);
      }
    }
    this.checkCancelled();
    if (run.capture_video) {
      let windowId: number | undefined;
      if (!this.hooks.startVideo) {
        const viewer = JSON.parse(fs.readFileSync(path.join(dir, "recording-window.json"), "utf8"));
        // macOS OBS selects a screen_capture window by its native window number.
        if (IS_MACOS && Number.isInteger(viewer.window_id) && viewer.window_id > 0)
          windowId = viewer.window_id;
      }
      this.videoRecorder = await (this.hooks.startVideo
        ? this.hooks.startVideo(this.videoDir(run))
        : ObsRunRecorder.start(this.videoDir(run), undefined, run.id, windowId));
      run.video!.state = "recording";
      this.persist(run);
    }
    this.checkCancelled();
    await this.hooks.command("/sc game.tick_paused=false; rcon.print('running')");
    this.segment(run).started_at = new Date().toISOString();
    run.started_at ||= this.segment(run).started_at;
    for (const m of run.benchmark.milestones)
      if (!resuming && m.kind === "research" && run.baseline!.research[m.name!]) {
        run.milestones[m.id] = {
          wall_seconds: 0,
          game_ticks: 0,
          observed_at: run.started_at!,
          initial: true,
        };
        fs.appendFileSync(
          path.join(dir, "milestones.jsonl"),
          JSON.stringify({ ...m, ...run.milestones[m.id] }) + "\n",
        );
      }
    this.startedMono = performance.now();
    run.state = "running";
    this.segment(run).state = "running";
    this.persist(run);
    this.event(run, `Run started (${run.agent}); objective: ${run.benchmark.title}`);
    this.watchdog = setTimeout(
      () => {
        void this.finish("timed_out", "Wall-clock time limit reached");
      },
      Math.max(1, run.max_seconds - run.elapsed_seconds) * 1000,
    );
    if (run.agent === "codex") this.launchCodex(run, workspace, resuming);
    else if (run.agent === "opencode") this.launchOpenCode(run, workspace, resuming);
    else if (run.agent === "dsh") this.launchDsh(run, workspace, resuming);
    this.monitor = setInterval(() => {
      void this.sample().catch((error) => {
        this.telemetryErrors++;
        this.event(run, `Telemetry error: ${errorText(error)}`);
        if (this.telemetryErrors >= 3) void this.finish("failed", "Telemetry failed three consecutive times");
      });
    }, run.benchmark.sample_seconds * 1000);
    await this.sample();
  }

  private codexBin() {
    return codexExecutable();
  }
  private async checkCodex(run: Run) {
    const { stdout } = await execExecutable(this.codexBin(), ["--version"], { timeout: 10_000 });
    run.versions!.codex = stdout.trim();
    if (process.env.AUTORIO_CODEX_PROVIDER?.trim()) {
      // Custom providers use an environment API key, not the Codex login session.
      const envKey = process.env.AUTORIO_CODEX_ENV_KEY?.trim() || "OPENCODE_API_KEY";
      if (!process.env[envKey]) throw new Error(`Set ${envKey} for the configured Codex provider`);
      codexProviderArgs(process.env);
      return;
    }
    // Fail before starting the clock if authentication is missing.
    await execExecutable(this.codexBin(), ["login", "status"], { timeout: 10_000 });
  }
  private async checkAgent(run: Run) {
    if (run.agent === "codex") return this.checkCodex(run);
    if (run.agent === "dsh") {
      const { stdout } = await execExecutable(dshExecutable(), ["--version"], { timeout: 15_000 });
      run.versions!.dsh = stdout.trim();
      // Headless ignores the GUI credential store; fail before the clock starts.
      if (!readDshApiKey()) {
        throw new Error(
          "DSH headless needs a DeepSeek API key: export DEEPSEEK_API_KEY, save it on the DSH Models page, or put it in this repo's .env",
        );
      }
      return;
    }
    const { bin, args } = opencodeVersionCommand();
    const { stdout } = await execExecutable(bin, args, { timeout: 15_000 });
    run.versions!.opencode = stdout.trim();
  }

  /** Materialize a backend's deterministic workspace files (wrappers, patches, guards). */
  private writeLaunchFiles(files: LaunchFile[]) {
    for (const file of files) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      fs.writeFileSync(file.path, file.content, file.mode === undefined ? undefined : { mode: file.mode });
    }
  }
  /** Persist the launch metadata for the segment and the run root, plus api_base. */
  private writeLaunchMetadata(run: Run, spec: LaunchSpec) {
    fs.mkdirSync(this.segmentDir(run), { recursive: true });
    fs.writeFileSync(
      path.join(this.segmentDir(run), "agent-launch.json"),
      JSON.stringify(spec.launchInfo, null, 2),
    );
    fs.writeFileSync(
      path.join(this.dir(run), "agent-launch.json"),
      JSON.stringify({ ...spec.launchInfo, api_base: spec.env.FACTORIO_API_BASE }, null, 2),
    );
  }
  /** OpenCode reports structured JSONL; translate it to the transcript schema the UI already renders. */
  private launchOpenCode(run: Run, workspace: string, resuming = false, restarting = false) {
    const model = opencodeModel(run.model);
    run.model = model;
    run.output_format = "events";
    this.persist(run);
    const transport = opencodeTransport();
    const spec = openCodeLaunchSpec({
      workspace,
      env: {
        ...process.env,
        AUTORIO_RUN_ID: run.id,
        AUTORIO_CONSTRUCTION_MODE: run.construction?.mode ?? "free",
      },
      apiBase: `http://127.0.0.1:${PORT}`,
      windows: IS_WINDOWS,
      resume: resuming,
      restart: restarting,
      language: run.language,
      sessionId: resuming ? run.session_id : undefined,
      model,
      transport,
      executable: process.env.OPENCODE_BIN?.trim() || "opencode",
      wslDistro: wslDistro(),
      wslCommand: wslBinCommand(),
    });
    this.writeLaunchFiles(spec.files);
    this.opencodeRemote = spec.remote ? { ...spec.remote } : undefined;
    const child = spawnExecutable(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !IS_WINDOWS,
      windowsHide: true,
    });
    this.agent = child;
    if (this.opencodeRemote) {
      const remote = this.opencodeRemote;
      const until = Date.now() + 10_000;
      const readPid = () => {
        try {
          const pid = Number(fs.readFileSync(remote.pidFile, "utf8").trim());
          if (Number.isInteger(pid) && pid > 0) {
            remote.pid = pid;
            return;
          }
        } catch {
          /* WSL shell is still starting */
        }
        if (Date.now() < until) setTimeout(readPid, 100);
      };
      readPid();
    }
    this.writeLaunchMetadata(run, spec);
    let eventBuffer = "",
      stderrTail = "";
    const decoder = new StringDecoder("utf8");
    const emit = (event: TranscriptEvent) => this.appendAgentEvent(run, event);
    const plain = (text: string) => fs.appendFileSync(path.join(this.dir(run), "codex.log"), text + "\n");
    const limited = (message: string) => {
      if (run.state !== "running" || this.ending) return;
      run.quota = { message, detected_at: new Date().toISOString() };
      void this.finish("paused", `OpenCode quota exhausted: ${message}`);
    };
    const translator = createOpenCodeState((resuming || restarting) && run.usage ? { ...run.usage } : {});
    const apply: OpenCodeOpApplier = (op) => {
      switch (op.kind) {
        case "thread":
          if (op.sessionId === run.session_id) break;
          run.session_id = op.sessionId;
          this.segment(run).session_id = op.sessionId;
          emit({ type: "thread.started", thread_id: op.sessionId });
          break;
        case "message":
          emit({
            type: "item.completed",
            item: { id: op.id, type: "agent_message", text: op.text },
          });
          this.event(run, op.text);
          plain(op.text);
          break;
        case "reasoning":
          if (op.thought) this.thought(run, op.text);
          emit({
            type: "item.completed",
            item: { id: op.id, type: "reasoning", text: op.text },
          });
          break;
        case "command":
          emit({
            type: op.phase === "completed" ? "item.completed" : "item.started",
            item: {
              id: op.id,
              type: "command_execution",
              command: op.command,
              status: op.status,
              exit_code: op.exitCode,
              aggregated_output: op.output,
            },
          });
          this.event(run, `${op.command} (${op.reportedStatus})\n${op.output}`);
          plain(`$ ${op.command}`);
          if (op.output) plain(op.output);
          break;
        case "usage":
          run.usage = { ...op.usage };
          run.usage_status = "final";
          run.usage_source = "opencode";
          run.context_tokens = op.contextTokens;
          if (run.context_limit && op.contextTokens >= run.context_limit)
            void this.restartAgentForContext(run).catch((error) =>
              this.finish("failed", `Context reset failed: ${errorText(error)}`),
            );
          break;
        case "error":
          emit({ type: "error", message: op.message });
          if (op.quota) limited(op.quota);
          break;
      }
    };
    const handle = (event: unknown) => {
      for (const op of translateOpenCodeEvent(event, translator)) apply(op);
    };
    const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (this.agent !== child) return;
      fs.appendFileSync(path.join(this.dir(run), `agent.${stream}.log`), chunk);
      if (stream === "stdout") {
        eventBuffer += decoder.write(chunk);
        let newline: number;
        while ((newline = eventBuffer.indexOf("\n")) >= 0) {
          const line = eventBuffer.slice(0, newline);
          eventBuffer = eventBuffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            handle(JSON.parse(line));
          } catch {
            /* raw bytes remain available */
          }
        }
      } else {
        fs.appendFileSync(path.join(this.dir(run), "activity.log"), chunk);
        stderrTail = (stderrTail + chunk.toString()).slice(-8192);
        for (const line of stderrTail.split("\n")) {
          const quota = quotaError({ type: "error", message: line });
          if (quota) limited(quota);
        }
      }
      this.persist(run);
    };
    child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", (error) => {
      void this.finish("failed", `OpenCode launch failed: ${error.message}`);
    });
    child.once("close", (code, signal) => {
      if (child !== this.agent) return;
      run.agent_exit = { code, signal };
      this.persist(run);
      this.event(run, `OpenCode exited (${signal || code})`);
      this.agentExited(run, "OpenCode", code, signal);
    });
  }
  /** Handle a closed agent process: continue the same session when it exited cleanly, or finish. */
  private agentExited(run: Run, agentName: string, code: number | null, signal: string | null): void {
    if (run.state !== "running" || this.ending) return;
    void (async () => {
      // Let already-queued crafting finish, then verify the game independently.
      await sleep(1000);
      if (run.state !== "running" || this.ending) return;
      await this.sample();
      if (this.ending) return;
      const limit = autoContinueLimit();
      const attempts = run.auto_continues || 0;
      if (code === 0 && limit > 0 && attempts < limit && this.elapsed() < run.max_seconds) {
        if (!this.continueAgent(run, limit)) {
          await this.finish(
            "paused",
            "Agent exited before the objective was verified; automatic continuation is unavailable",
          );
          return;
        }
        run.auto_continues = attempts + 1;
        this.event(run, `${agentName} exited; auto-continuing (${run.auto_continues}/${limit})`);
        this.persist(run);
        return;
      }
      if (code === 0 && limit > 0 && attempts >= limit) {
        await this.finish(
          "paused",
          `Agent exited before the objective was verified; auto-continuation limit (${limit}) reached`,
        );
        return;
      }
      await this.finish(
        "failed",
        code === 0
          ? "Agent exited before the objective was verified"
          : `${agentName} exited with ${signal || code}`,
      );
    })().catch((error) => void this.finish("failed", errorText(error)));
  }

  /**
   * Relaunch the current agent against the same live game and session after a
   * clean early exit. Returns false when there is no session id to resume.
   */
  private continueAgent(run: Run, limit: number): boolean {
    if (!run.session_id) return false;
    const workspace = path.join(this.dir(run), "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const attempt = (run.auto_continues || 0) + 1;
    fs.writeFileSync(
      path.join(workspace, "RESUME.md"),
      `Continue the same benchmark from its live game. The previous agent turn ended before the objective was verified; this is automatic continuation ${attempt}/${limit}.

Active play time so far: ${run.elapsed_seconds.toFixed(2)} seconds.

Milestones: ${JSON.stringify(run.milestones)}

Current game snapshot: ${JSON.stringify(run.latest || {})}

Re-read AGENTS.md and STATE.md, refresh STATE.md with state-write if stale, re-observe the player/world, then continue. Do not repeat completed work.
`,
    );
    this.event(run, `Auto-continuing agent session (${attempt}/${limit})`);
    this.persist(run);
    if (run.agent === "opencode") this.launchOpenCode(run, workspace, true, false);
    else if (run.agent === "codex") this.launchCodex(run, workspace, true, false);
    else if (run.agent === "dsh") this.launchDsh(run, workspace, true, false);
    else return false;
    return true;
  }

  /**
   * One controlled agent restart when a blocked plan proves the agent is not
   * refreshing STATE.md on its own. Uses the same session and live game; only
   * enabled by AUTORIO_STATE_NUDGE_RESTART_SECONDS.
   */
  /** Persist a recovery checkpoint without stopping the live game. */
  private async saveNudgeCheckpoint(run: Run): Promise<void> {
    if (!this.hooks.running()) return;
    const saveName = `autorio-state-nudge-${this.segment(run).index}`;
    const finalSave = path.join(this.dir(run), "profile", "saves", `${saveName}.zip`);
    fs.rmSync(finalSave, { force: true });
    await this.hooks.command(`/save ${saveName}`, 30_000);
    const until = performance.now() + 30_000;
    while (!fs.existsSync(finalSave) && performance.now() < until) await sleep(200);
    if (!fs.existsSync(finalSave)) throw new Error("state-nudge save was not written");
    fs.mkdirSync(this.segmentDir(run), { recursive: true });
    const checkpoint = path.join(this.segmentDir(run), "checkpoint.zip");
    fs.copyFileSync(finalSave, checkpoint);
    run.checkpoint = {
      file: path.relative(this.dir(run), checkpoint),
      sha256: sha256(fs.readFileSync(checkpoint)),
      saved_at: new Date().toISOString(),
      segment: this.segment(run).index,
    };
    this.segment(run).save_file = run.checkpoint.file;
    this.persist(run);
  }

  private async nudgeStalePlan(run: Run): Promise<void> {
    if (this.stateNudging || this.contextResetting || this.ending || run.state !== "running") return;
    if (!run.session_id) return;
    this.stateNudging = true;
    try {
      await this.saveNudgeCheckpoint(run).catch((error) => {
        run.warnings.push(`STATE nudge checkpoint: ${errorText(error)}`);
      });
      const child = this.agent;
      const remote = this.opencodeRemote;
      this.agent = undefined;
      this.opencodeRemote = undefined;
      if (remote?.pid) {
        await execExecutable("wsl.exe", ["-d", remote.distro, "-e", "kill", "-TERM", String(remote.pid)], {
          timeout: 5_000,
        }).catch(() => {});
      }
      if (child?.pid) killProcessTree(child.pid, true);
      if (remote?.pid) {
        await execExecutable("wsl.exe", ["-d", remote.distro, "-e", "kill", "-KILL", String(remote.pid)], {
          timeout: 5_000,
        }).catch(() => {});
      }
      await sleep(1000);
      if (run.state !== "running" || this.ending) return;
      const workspace = path.join(this.dir(run), "workspace");
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "RESUME.md"),
        `Continue the same benchmark. STATE.md has been overdue long enough that the manager restarted the agent once to recover the plan. Active play time: ${run.elapsed_seconds.toFixed(2)} seconds.\n\nFIRST: call state-write / POST /api/agent/state to refresh current, done_when, next and scores. Then re-observe the player/world and continue.\n\nCurrent game snapshot: ${JSON.stringify(run.latest || {})}\n`,
      );
      this.event(run, "Restarting the agent once to refresh the stale plan");
      this.persist(run);
      if (run.agent === "opencode") this.launchOpenCode(run, workspace, true, false);
      else if (run.agent === "codex") this.launchCodex(run, workspace, true, false);
      else if (run.agent === "dsh") this.launchDsh(run, workspace, true, false);
    } finally {
      this.stateNudging = false;
    }
  }

  /** DSH headless reports JSONL events; translate them to the transcript schema the UI already renders. */
  private launchDsh(run: Run, workspace: string, resuming = false, restarting = false) {
    const selection = parseDshModel(run.model);
    run.model = `${selection.provider}/${selection.model}`;
    run.output_format = "events";
    this.persist(run);
    const windows = IS_WINDOWS;
    const apiBase = `http://127.0.0.1:${PORT}`;
    // DSH's headless shell sandbox can deny wsl.exe; when a Windows Python is
    // present the wrapper runs the same stdlib client directly and avoids WSL.
    const windowsPython = windows ? Boolean(resolveExecutable("python") || resolveExecutable("py")) : false;
    const spec = dshLaunchSpec({
      workspace,
      env: {
        ...process.env,
        AUTORIO_RUN_ID: run.id,
        AUTORIO_CONSTRUCTION_MODE: run.construction?.mode ?? "free",
      },
      apiBase,
      windows,
      resume: resuming,
      restart: restarting,
      language: run.language,
      sessionId: resuming ? run.session_id : undefined,
      executable: dshExecutable(),
      apiKey: readDshApiKey() || "",
      profile: dshProfile(),
      selection,
      distro: wslDistro(),
      windowsPython,
    });
    this.writeLaunchFiles(spec.files);
    const child = spawnExecutable(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: !IS_WINDOWS,
      windowsHide: true,
    });
    this.agent = child;
    this.writeLaunchMetadata(run, spec);
    // The task goes over stdin: a positional task would let model text such as
    // `node --version` be parsed as launcher options.
    const task = spec.stdinTask;
    child.stdin?.on("error", () => {});
    if (task !== undefined) child.stdin?.end(task.endsWith("\n") ? task : task + "\n");
    let eventBuffer = "",
      stderrTail = "",
      sequence = 0;
    const decoder = new StringDecoder("utf8");
    const usage: Record<string, number> = (resuming || restarting) && run.usage ? { ...run.usage } : {};
    const emit = (event: TranscriptEvent) => this.appendAgentEvent(run, event);
    const plain = (text: string) => fs.appendFileSync(path.join(this.dir(run), "codex.log"), text + "\n");
    const limited = (message: string) => {
      if (run.state !== "running" || this.ending) return;
      run.quota = { message, detected_at: new Date().toISOString() };
      void this.finish("paused", `DSH quota exhausted: ${message}`);
    };
    const translator = createDshState();
    let lastDshMessage = "";
    const handle = (event: unknown) => {
      for (const op of translateDshEvent(event, translator)) {
        switch (op.kind) {
          case "thread":
            if (op.sessionId !== run.session_id) {
              run.session_id = op.sessionId;
              this.segment(run).session_id = op.sessionId;
              emit({ type: "thread.started", thread_id: op.sessionId });
            }
            break;
          case "reasoning":
            this.thought(run, op.text);
            emit({
              type: "item.completed",
              item: { id: `dsh-reasoning-${++sequence}`, type: "reasoning", text: op.text },
            });
            break;
          case "message":
            lastDshMessage = op.text;
            emit({
              type: "item.completed",
              item: { id: `dsh-message-${++sequence}`, type: "agent_message", text: op.text },
            });
            this.event(run, op.text);
            plain(op.text);
            break;
          case "tool_start":
            emit({
              type: "item.started",
              item: {
                id: op.id,
                type: "command_execution",
                command: op.command,
                status: "in_progress",
                exit_code: null,
                aggregated_output: "",
              },
            });
            this.event(run, op.command);
            plain(`$ ${op.command}`);
            break;
          case "tool_end": {
            const command = op.command || op.tool || op.id;
            emit({
              type: "item.completed",
              item: {
                id: op.id,
                type: "command_execution",
                command,
                status: op.status,
                exit_code: null,
                aggregated_output: op.output,
              },
            });
            this.event(run, `${command} (${op.status})\n${op.output}`);
            plain(op.output);
            break;
          }
          case "usage": {
            const tokens = op.usage;
            const addUsage = (
              key: "input_tokens" | "output_tokens" | "reasoning_output_tokens",
              value: number | undefined,
            ) => {
              if (value) usage[key] = (usage[key] || 0) + value;
            };
            addUsage("input_tokens", tokens.input_tokens);
            addUsage("output_tokens", tokens.output_tokens);
            addUsage("reasoning_output_tokens", tokens.reasoning_output_tokens);
            // DSH reports cache reads per step; never sum them across steps.
            if (tokens.cached_input_tokens !== undefined)
              usage.cached_input_tokens = Math.max(
                usage.cached_input_tokens || 0,
                tokens.cached_input_tokens,
              );
            usage.total_tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
            run.usage = { ...usage };
            run.usage_status = "final";
            run.usage_source = "dsh";
            run.context_tokens = op.contextTokens;
            if (run.context_limit && op.contextTokens >= run.context_limit) {
              void this.restartAgentForContext(run).catch((error) =>
                this.finish("failed", `Context reset failed: ${errorText(error)}`),
              );
            }
            break;
          }
          case "error": {
            emit({ type: "error", message: op.message });
            const quota = quotaError({ type: "error", message: op.message, error: { message: op.message } });
            if (quota) limited(quota);
            break;
          }
          case "final":
            if (op.text) {
              plain(op.text);
              // The final answer may not have been streamed as a text event; keep
              // it in the transcript (the Messages filter/recording view expects it).
              if (op.text !== lastDshMessage) {
                lastDshMessage = op.text;
                emit({
                  type: "item.completed",
                  item: { id: `dsh-message-${++sequence}`, type: "agent_message", text: op.text },
                });
                this.event(run, op.text);
              }
            }
            break;
        }
      }
    };
    const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (this.agent !== child) return;
      fs.appendFileSync(path.join(this.dir(run), `agent.${stream}.log`), chunk);
      if (stream === "stdout") {
        eventBuffer += decoder.write(chunk);
        let newline: number;
        while ((newline = eventBuffer.indexOf("\n")) >= 0) {
          const line = eventBuffer.slice(0, newline);
          eventBuffer = eventBuffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            handle(JSON.parse(line));
          } catch {
            /* raw bytes remain available */
          }
        }
      } else {
        fs.appendFileSync(path.join(this.dir(run), "activity.log"), chunk);
        stderrTail = (stderrTail + chunk.toString()).slice(-8192);
        for (const line of stderrTail.split("\n")) {
          const quota = quotaError({ type: "error", message: line });
          if (quota) limited(quota);
        }
      }
      this.persist(run);
    };
    child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", (error) => {
      void this.finish("failed", `DSH launch failed: ${error.message}`);
    });
    child.once("close", (code, signal) => {
      if (child !== this.agent) return;
      run.agent_exit = { code, signal };
      this.persist(run);
      this.event(run, `DSH exited (${signal || code})`);
      this.agentExited(run, "DSH", code, signal);
    });
  }
  private async restartAgentForContext(run: Run) {
    if (this.contextResetting || this.ending || run.state !== "running") return;
    this.contextResetting = true;
    try {
      const child = this.agent;
      const remote = this.opencodeRemote;
      this.agent = undefined;
      this.opencodeRemote = undefined;
      if (remote?.pid) {
        await execExecutable("wsl.exe", ["-d", remote.distro, "-e", "kill", "-TERM", String(remote.pid)], {
          timeout: 5_000,
        }).catch(() => {});
      }
      if (child?.pid) killProcessTree(child.pid, true);
      if (remote?.pid) {
        await execExecutable("wsl.exe", ["-d", remote.distro, "-e", "kill", "-KILL", String(remote.pid)], {
          timeout: 5_000,
        }).catch(() => {});
      }
      const previous = run.session_id;
      run.session_id = undefined;
      run.context_tokens = 0;
      run.session_resets = (run.session_resets || 0) + 1;
      this.event(run, `Context limit reached (${run.context_limit} tokens); starting a new agent session`);
      const workspace = path.join(this.dir(run), "workspace");
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(
        path.join(workspace, "RESUME.md"),
        `Continue the same benchmark. The previous agent session (${previous || "unknown"}) was reset because its context reached ${run.context_limit} tokens. Active play time: ${run.elapsed_seconds.toFixed(2)} seconds.\n\nMilestones: ${JSON.stringify(run.milestones)}\n\nCurrent game snapshot: ${JSON.stringify(run.latest || {})}\n\nRe-read AGENTS.md and STATE.md, re-observe the player/world, and continue. Automate repeated work; never sleep longer than 10 seconds.\n`,
      );
      this.persist(run);
      if (run.agent === "opencode") this.launchOpenCode(run, workspace, false, true);
      else if (run.agent === "codex") this.launchCodex(run, workspace, false, true);
      else if (run.agent === "dsh") this.launchDsh(run, workspace, false, true);
    } finally {
      this.contextResetting = false;
    }
  }

  private launchCodex(run: Run, workspace: string, resuming = false, restarting = false) {
    run.output_format = run.terminal ? "native" : "events";
    this.persist(run);
    const spec = codexLaunchSpec({
      workspace,
      env: {
        ...process.env,
        AUTORIO_RUN_ID: run.id,
        AUTORIO_CONSTRUCTION_MODE: run.construction?.mode ?? "free",
      },
      apiBase: `http://127.0.0.1:${PORT}`,
      windows: IS_WINDOWS,
      resume: resuming,
      restart: restarting,
      language: run.language,
      sessionId: resuming ? run.session_id : undefined,
      executable: this.codexBin(),
      model: run.model,
      reasoningEffort: run.reasoning_effort,
      terminal: run.terminal,
      sandbox:
        process.env.AUTORIO_CODEX_SANDBOX?.trim() || (IS_WINDOWS ? "danger-full-access" : "workspace-write"),
    });
    this.writeLaunchFiles(spec.files);
    const child = spawnExecutable(spec.executable, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX uses a process group for cleanup; Windows uses taskkill /T instead.
      detached: !IS_WINDOWS,
      windowsHide: true,
    });
    this.agent = child;
    this.writeLaunchMetadata(run, spec);
    let outputTail = "",
      eventBuffer = "",
      stderrTail = "";
    const limited = (message: string) => {
      if (run.state !== "running" || this.ending) return;
      run.quota = { message, detected_at: new Date().toISOString() };
      void this.finish("paused", `Codex quota exhausted: ${message}`);
    };
    const translator = createCodexState((resuming || restarting) && run.usage ? { ...run.usage } : {});
    const apply: CodexOpApplier = (op) => {
      switch (op.kind) {
        case "thread":
          run.session_id = op.sessionId;
          this.segment(run).session_id = op.sessionId;
          break;
        case "reasoning":
          if (op.text) this.thought(run, op.text);
          this.event(run, op.text);
          break;
        case "message":
          this.event(run, op.text);
          break;
        case "command":
          this.event(run, `${op.command} (${op.status})\n${op.output}`);
          break;
        case "usage":
          run.usage = { ...op.usage };
          run.usage_status = "final";
          run.usage_source = "turn.completed";
          run.context_tokens = op.contextTokens ?? run.context_tokens;
          if (run.context_limit && run.context_tokens && run.context_tokens >= run.context_limit)
            void this.restartAgentForContext(run).catch((error) =>
              this.finish("failed", `Context reset failed: ${errorText(error)}`),
            );
          break;
        case "error":
          if (op.quota) limited(op.quota);
          break;
      }
    };
    const eventDecoder = new StringDecoder("utf8");
    const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (this.agent !== child) return;
      fs.appendFileSync(path.join(this.dir(run), `agent.${stream}.log`), chunk);
      if (run.terminal) {
        // The optional Terminal viewer still receives native human output.
        fs.appendFileSync(path.join(this.dir(run), "codex.log"), chunk);
        fs.appendFileSync(path.join(this.dir(run), "activity.log"), chunk);
        outputTail = (outputTail + chunk.toString()).slice(-4096);
        const sessionId = sessionIdFromCodexOutput(outputTail);
        if (sessionId) run.session_id = sessionId;
      } else if (stream === "stdout") {
        // Decode complete JSONL lines, stamp each event, then persist it. The
        // browser still receives clean JSONL and can show relative timestamps.
        eventBuffer += eventDecoder.write(chunk);
        let newline: number;
        while ((newline = eventBuffer.indexOf("\n")) >= 0) {
          const line = eventBuffer.slice(0, newline);
          eventBuffer = eventBuffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as TranscriptEvent;
            this.appendAgentEvent(run, event);
            for (const op of translateCodexEvent(event, translator)) apply(op);
          } catch {
            fs.appendFileSync(path.join(this.dir(run), "agent.events.jsonl"), line + "\n");
          }
        }
      } else fs.appendFileSync(path.join(this.dir(run), "activity.log"), chunk);
      if (stream === "stderr") {
        stderrTail = (stderrTail + chunk.toString()).slice(-8192);
        for (const line of stderrTail.split("\n")) {
          // Native/error stderr only; JSON tool output is deliberately excluded.
          if (isCodexNativeErrorLine(line)) {
            const quota = quotaError({ type: "error", message: line });
            if (quota) limited(quota);
          }
        }
      }
      this.persist(run);
    };
    child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", (error) => {
      void this.finish("failed", `Codex launch failed: ${error.message}`);
    });
    child.once("close", (code, signal) => {
      if (child !== this.agent) return;
      run.agent_exit = { code, signal };
      this.persist(run);
      this.event(run, `Codex exited (${signal || code})`);
      this.agentExited(run, "Codex", code, signal);
    });
  }
  private captureUsage(run: Run) {
    if (run.agent !== "codex") return;
    {
      let usage: Record<string, number> | undefined;
      try {
        usage = sessionUsage(run.session_id, run.created_at);
      } catch {
        /* Usage availability must never stop the game. */
      }
      if (
        usage &&
        (!run.usage ||
          (usage.input_tokens >= (run.usage.input_tokens || 0) &&
            usage.output_tokens >= (run.usage.output_tokens || 0)))
      ) {
        run.usage = usage;
        run.usage_status = run.usage_status === "final" ? "final" : "last_reported";
        run.usage_source = "session_log";
      } else if (!run.usage) run.usage_status = "unavailable";
    }
  }
  private async sample() {
    const run = this.active;
    if (!run || run.state !== "running" || this.sampling || this.ending) return;
    this.sampling = true;
    try {
      if (!this.hooks.running()) throw new Error("Factorio process exited");
      const snapshot = parseSnapshot(await this.hooks.command(TELEMETRY_COMMAND));
      if (run.state !== "running" || this.ending) return;
      this.telemetryErrors = 0;
      this.captureUsage(run);
      this.recordSnapshot(run, snapshot, this.elapsed());
      if (run.milestones[run.benchmark.completion])
        void this.finish("completed", "Objective independently verified from game statistics");
      else if (run.elapsed_seconds >= run.max_seconds)
        void this.finish("timed_out", "Wall-clock time limit reached");
    } finally {
      this.sampling = false;
    }
  }

  private recordSnapshot(run: Run, snapshot: Snapshot, wallSeconds: number) {
    const previous = run.latest || run.baseline!;
    const ticks = snapshot.tick - previous.tick;
    const rates = Object.fromEntries(
      Object.entries(snapshot.production).map(([name, count]) => [
        name,
        ticks > 0 ? ((count - (previous.production[name] || 0)) * 3600) / ticks : 0,
      ]),
    );
    const previousElapsed = Number(run.elapsed_seconds) || 0;
    const elapsedDelta = Math.max(0, wallSeconds - previousElapsed);
    run.latest = snapshot;
    run.elapsed_seconds = wallSeconds;
    const now = new Date().toISOString();
    const rocketsLaunched = snapshot.rockets - (run.baseline?.rockets ?? 0);
    const productionTotals = Object.fromEntries(
      Object.entries(snapshot.production).map(([name, count]) => [
        name,
        count - (run.baseline?.production[name] || 0),
      ]),
    );
    const blackout = trackPowerBlackout(
      {
        power_plant_seen: run.power_plant_seen ?? false,
        blackout_active: run.power_blackout_active ?? false,
        blackouts: run.power_blackouts ?? 0,
      },
      snapshot.power,
    );
    run.power_plant_seen = blackout.state.power_plant_seen;
    run.power_blackout_active = blackout.state.blackout_active;
    run.power_blackouts = blackout.state.blackouts;
    if (blackout.blackout_started) {
      this.event(
        run,
        `Power blackout #${run.power_blackouts} detected after power was established (-500 points)`,
      );
    }
    const stateStatus = this.stateStatus();
    const statePenalty = stateStatus?.blocked
      ? STATE_BLOCKED_PENALTY
      : stateStatus?.due
        ? STATE_DUE_PENALTY
        : 0;
    const stateMetrics = run.state_metrics ?? { due_seconds: 0, blocked_seconds: 0 };
    if (stateStatus?.due) stateMetrics.due_seconds += elapsedDelta;
    if (stateStatus?.blocked) stateMetrics.blocked_seconds += elapsedDelta;
    run.state_metrics = stateMetrics;
    run.automation = {
      ...computeAutomationScore({
        productionTotals,
        powerSatisfaction: snapshot.power?.satisfaction ?? null,
        researchProgress: snapshot.research_progress ?? null,
        rocketsLaunched,
        manualMines: run.automation?.manual_mines ?? 0,
        manualCrafts: run.automation?.manual_crafts ?? 0,
        cleanupUnits: run.automation?.cleanup_units ?? 0,
        refactorReward: run.automation?.refactor_reward ?? 0,
        statePenalty,
        blackouts: run.power_blackouts ?? 0,
        alertPenalty: run.automation?.alert_penalty ?? 0,
      }),
      updated_at: now,
    };
    this.checkStateReminder(run);
    fs.appendFileSync(
      path.join(this.dir(run), "telemetry.jsonl"),
      JSON.stringify({
        observed_at: now,
        wall_seconds: run.elapsed_seconds,
        game_ticks: snapshot.tick - run.baseline_tick!,
        production_per_game_minute: rates,
        automation: run.automation,
        ...snapshot,
      }) + "\n",
    );
    for (const milestone of run.benchmark.milestones) {
      if (!run.milestones[milestone.id] && reached(milestone, snapshot, run.baseline!)) {
        run.milestones[milestone.id] = {
          wall_seconds: run.elapsed_seconds,
          game_ticks: snapshot.tick - run.baseline_tick!,
          observed_at: now,
        };
        fs.appendFileSync(
          path.join(this.dir(run), "milestones.jsonl"),
          JSON.stringify({ ...milestone, ...run.milestones[milestone.id] }) + "\n",
        );
        this.event(
          run,
          `Milestone ${milestone.id} at ${run.elapsed_seconds.toFixed(1)}s / ${snapshot.tick - run.baseline_tick!} ticks`,
        );
      }
    }
    run.evaluation = {
      capability: computeCapabilityScore({
        benchmark: run.benchmark,
        milestones: run.milestones,
        latest: snapshot,
        baseline: run.baseline ?? null,
        activeSeconds: run.elapsed_seconds,
        ...(run.construction
          ? {
              construction: {
                mode: run.construction.mode,
                variant: run.construction.variant,
                blueprint_policy: run.construction.blueprints.enabled
                  ? run.construction.blueprints.source
                  : "none",
              },
            }
          : {}),
      }),
      discipline: computeDiscipline({
        manualMines: run.automation?.manual_mines,
        manualCrafts: run.automation?.manual_crafts,
        blackouts: run.power_blackouts,
        alertPenalty: run.automation?.alert_penalty,
        stateMetrics: run.state_metrics,
        refactor: run.refactor,
        ...(run.construction
          ? {
              construction: {
                mode: run.construction.mode,
                variant: run.construction.variant,
                ...run.construction.metrics,
              },
            }
          : {}),
      }),
      computed_at: now,
    };
    this.persist(run);
  }

  async stop() {
    if (!this.active) throw new Error("No active run");
    this.stopRequested = true;
    this.abort?.abort();
    await this.preparation;
    await this.finish("stopped", "Stopped by operator");
  }
  /** Save a checkpoint and stop the game while keeping this run resumable. */
  async pause() {
    if (!this.active) throw new Error("No active run");
    if (!["running", "saving"].includes(this.active.state))
      throw new Error("Only a running run can be paused");
    await this.finish("paused", "Paused by operator");
  }
  async shutdown() {
    if (this.active) await this.stop();
  }
  private finish(state: RunState, reason: string): Promise<void> {
    if (this.ending) return this.ending;
    const run = this.active;
    if (!run) return Promise.resolve();
    this.ending = this.finalize(run, state, reason);
    return this.ending;
  }
  private async finalize(run: Run, state: RunState, reason: string) {
    if (this.monitor) clearInterval(this.monitor);
    if (this.watchdog) clearTimeout(this.watchdog);
    run.elapsed_seconds = this.elapsed();
    run.state = "saving";
    run.reason = reason;
    this.persist(run);
    this.event(run, reason);
    let rawVideo: string | undefined;
    try {
      if (state === "paused" && this.hooks.running())
        await this.hooks
          .command("/sc game.tick_paused=true; rcon.print('paused')")
          .catch((error) => run.warnings.push(`Pause game: ${errorText(error)}`));
      if (this.agent?.pid) {
        const child = this.agent;
        const pid = child.pid!;
        const remote = this.opencodeRemote;
        if (remote?.pid) {
          await execExecutable("wsl.exe", ["-d", remote.distro, "-e", "kill", "-TERM", String(remote.pid)], {
            timeout: 5_000,
          }).catch(() => {});
        }
        killProcessTree(pid, false);
        if (child.exitCode === null && child.signalCode === null) {
          await Promise.race([new Promise((resolve) => child.once("close", resolve)), sleep(3000)]);
        }
        // Windows tree kill is already recursive; POSIX still needs the group signal.
        if (child.exitCode === null && child.signalCode === null) killProcessTree(pid, true);
        if (remote?.pid) {
          await execExecutable("wsl.exe", ["-d", remote.distro, "-e", "kill", "-KILL", String(remote.pid)], {
            timeout: 5_000,
          }).catch(() => {});
        }
      }
      this.opencodeRemote = undefined;
      this.captureUsage(run);
      this.agent = undefined;
      await this.hooks.cancelJobs();
      if (this.videoRecorder) {
        try {
          if (this.hooks.running())
            await this.hooks.command("/sc game.tick_paused=true; rcon.print('paused')");
          rawVideo = await this.videoRecorder.stop();
          run.video!.raw_file = path.relative(this.dir(run), rawVideo);
          run.video!.state = "rendering";
        } catch (error) {
          run.video!.state = "failed";
          run.video!.error = errorText(error);
          run.warnings.push(`OBS recording: ${errorText(error)}`);
        }
        this.videoRecorder = undefined;
      } else if (run.video?.state === "pending") {
        run.video.state = "failed";
        run.video.error = reason;
      }
      if (this.hooks.running()) {
        try {
          await this.hooks.command("/sc game.tick_paused=true; rcon.print('paused')");
          if (state === "paused")
            this.recordSnapshot(
              run,
              parseSnapshot(await this.hooks.command(TELEMETRY_COMMAND)),
              run.elapsed_seconds,
            );
          const saveName =
            this.segment(run).index === 1 ? "autorio-final" : `autorio-final-${this.segment(run).index}`;
          const finalSave = path.join(this.dir(run), "profile", "saves", saveName + ".zip");
          fs.rmSync(finalSave, { force: true });
          const response = await this.hooks.command(`/save ${saveName}`, 30_000);
          this.event(run, `Final save requested: ${response.trim()}`);
          // /save acknowledges before asynchronous writing has finished.
          const until = performance.now() + 30_000;
          while (!fs.existsSync(finalSave) && performance.now() < until) await sleep(200);
          if (!fs.existsSync(finalSave)) throw new Error("Final save was not written");
          fs.copyFileSync(finalSave, path.join(this.dir(run), "final.zip"));
          fs.mkdirSync(this.segmentDir(run), { recursive: true });
          const checkpoint = path.join(this.segmentDir(run), "checkpoint.zip");
          fs.copyFileSync(finalSave, checkpoint);
          run.checkpoint = {
            file: path.relative(this.dir(run), checkpoint),
            sha256: sha256(fs.readFileSync(checkpoint)),
            saved_at: new Date().toISOString(),
            segment: this.segment(run).index,
          };
          this.segment(run).save_file = run.checkpoint.file;
        } catch (error) {
          run.warnings.push(`Final save: ${errorText(error)}`);
        }
        await this.hooks.stop();
      }
    } catch (error) {
      run.warnings.push(`Cleanup: ${errorText(error)}`);
    } finally {
      if (
        state === "paused" &&
        (!run.checkpoint ||
          (this.segment(run).started_at && run.checkpoint.segment !== this.segment(run).index))
      ) {
        state = "failed";
        reason += "; no valid game checkpoint could be saved";
      }
      const segment = this.segment(run);
      segment.state = state;
      segment.end_seconds = run.elapsed_seconds;
      segment.ended_at = new Date().toISOString();
      segment.session_id = run.session_id;
      segment.video = run.video;
      this.startedMono = 0;
      this.elapsedBefore = run.elapsed_seconds;
      run.state = state;
      run.reason = reason;
      if (state === "failed") run.failure_kind = classifyFailure(reason);
      else delete run.failure_kind;
      run.ended_at = new Date().toISOString();
      this.persist(run);
      fs.writeFileSync(
        path.join(this.dir(run), "SUMMARY.md"),
        [
          `# ${run.benchmark.title}`,
          "",
          `Run: ${run.name || run.id}`,
          `Result: ${state}`,
          `Reason: ${reason}`,
          ...(run.failure_kind ? [`Failure kind: ${run.failure_kind}`] : []),
          `Agent: ${modelLabel(run)}`,
          `Language: ${run.language || "model default"}`,
          `Active play time: ${run.elapsed_seconds.toFixed(2)} seconds`,
          ...(run.evaluation
            ? [
                `Capability: ${run.evaluation.capability.score} / 1000${
                  run.evaluation.capability.completed
                    ? " (completed)"
                    : ` (progress ${Math.round(run.evaluation.capability.progress * 100)}%)`
                }`,
                `Milestones: ${run.evaluation.capability.milestones.completed}/${run.evaluation.capability.milestones.total}`,
                `Scoring: v${run.evaluation.capability.scoring_version} · par ${run.evaluation.capability.par_seconds}s (${run.evaluation.capability.par_source})`,
                `Discipline flags: ${
                  run.evaluation.discipline.flags.length ? run.evaluation.discipline.flags.join(", ") : "none"
                }`,
              ]
            : []),
          `Segments: ${run.segments?.length || 1}`,
          `Checkpoint: ${run.checkpoint?.file || "unavailable"}`,
          `Tokens: ${run.usage ? JSON.stringify(run.usage) : "unavailable"} (${run.usage_status || "unavailable"})`,
          `Context: ${run.context_tokens || 0}${run.context_limit ? ` / ${run.context_limit}` : ""} tokens; session resets: ${run.session_resets || 0}`,
          "",
          ...Object.entries(run.milestones).map(
            ([id, m]) => `- ${id}: ${m.wall_seconds.toFixed(2)} seconds / ${m.game_ticks} ticks`,
          ),
          "",
          ...run.warnings.map((warning) => `Warning: ${warning}`),
          "",
        ].join("\n"),
      );
      this.event(run, `Run ${state}`);
      this.active = undefined;
      const video = run.video;
      if (rawVideo)
        void (this.hooks.renderVideo || renderTimelapse)(rawVideo, path.join(this.videoDir(run), "video"))
          .then((metadata) => {
            video!.state = "ready";
            video!.file = path.relative(
              this.dir(run),
              path.join(this.videoDir(run), "video", "timelapse.mp4"),
            );
            video!.metadata = metadata;
            this.persist(run);
            fs.appendFileSync(
              path.join(this.dir(run), "SUMMARY.md"),
              `\nSegment ${segment.index} timelapse: ${video!.file} (5 fps capture → 30 fps playback, 6× speed)\n`,
            );
          })
          .catch((error) => {
            video!.state = "failed";
            video!.error = errorText(error);
            run.warnings.push(`Timelapse rendering: ${errorText(error)}`);
            this.persist(run);
          });
    }
  }
  videoFile(id: string, index?: number) {
    const run = this.runs.get(id);
    if (!run) return;
    const video = index === undefined ? run.video : run.segments?.find((s) => s.index === index)?.video;
    if (video?.state !== "ready" || !video.file) return;
    const file = path.resolve(this.dir(run), video.file);
    if (!file.startsWith(this.dir(run) + path.sep)) return;
    return file;
  }
}
