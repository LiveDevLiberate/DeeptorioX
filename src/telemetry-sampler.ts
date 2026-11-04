// Independent production telemetry sampler for the manager.
//
// The manager already samples production inside benchmark runs (`RunManager`),
// but manual API sessions had no production rates at all. This ring buffer runs
// on the manager side (independent of runs): it asks RCON for the same
// `TELEMETRY_COMMAND` snapshot every few seconds, keeps a bounded window in
// memory, and derives per-minute item rates, deltas, research progress and
// rockets. It is fail-soft: RCON/parse errors only bump an error counter and
// keep the last good samples.
//
// Zero dependencies; the RCON command, clock, logger and an optional
// "should sample now" predicate are injected so tests never need a game.

import { parseSnapshot, type Snapshot } from "./benchmarks.js";
import type { Logger } from "./logger.js";
import { telemetrySampleCommand } from "./observation-builders.js";
import { asNumber, asRecord, asString, errorMessage } from "./validation.js";

export const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;
export const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

/** One normalized telemetry sample (subset of `Snapshot` used by the sampler). */
export type TelemetrySample = {
  /** Wall-clock sample time in epoch milliseconds. */
  t: number;
  tick: number;
  production: Record<string, number>;
  consumption: Record<string, number>;
  fluids_produced: Record<string, number>;
  fluids_consumed: Record<string, number>;
  research: Record<string, boolean>;
  current_research: string | null;
  research_progress: number | null;
  rockets: number;
};

export type TelemetryResearchSummary = {
  /** Latest researched-technology map (name -> true). */
  researched: Record<string, boolean>;
  current_research: string | null;
  research_progress: number | null;
  /** Technologies that became researched inside the sampling window. */
  new_research: string[];
};

export type TelemetryRocketSummary = {
  total: number;
  delta: number;
  per_minute: number;
};

export type TelemetrySnapshot = {
  tick: number;
  /** Number of samples currently in the window. */
  samples: number;
  /** Covered wall-clock window in seconds (0 with fewer than two samples). */
  window_seconds: number;
  /** Per-item production counts per minute over the covered window. */
  production_per_minute: Record<string, number>;
  /** Per-item production-count difference over the covered window (unchanged items omitted). */
  deltas: Record<string, number>;
  research: TelemetryResearchSummary;
  rockets: TelemetryRocketSummary;
};

export type ItemRate = {
  item: string;
  produced_delta: number;
  produced_per_minute: number;
};

export type TelemetrySamplerOptions = {
  /** Executes one Lua command and returns the RCON text reply (server passes `rconCommand`). */
  command: (lua: string) => Promise<string>;
  /** Sampling period; defaults to 5 seconds and is clamped to >= 1 ms. */
  intervalMs?: number;
  /** Sliding window; defaults to 15 minutes and is clamped to >= intervalMs. */
  windowMs?: number;
  /** Clock used for sample timestamps/windows; defaults to `Date.now`. */
  now?: () => number;
  /** Structured logger for skipped/failed samples (never required). */
  logger?: Pick<Logger, "warn" | "debug">;
  /**
   * Optional gate: when it returns false the tick is skipped without touching
   * RCON or the error counter (e.g. the manager has no connected game).
   */
  shouldSample?: () => boolean;
};

export type TelemetrySampler = {
  /** Starts periodic sampling (idempotent); samples once immediately. */
  start(): void;
  /** Stops periodic sampling (idempotent). */
  stop(): void;
  readonly running: boolean;
  readonly sampleCount: number;
  /** Number of skipped/failed samples since creation. */
  readonly errorCount: number;
  /** Samples once now; true when a sample was stored. */
  sampleOnce(): Promise<boolean>;
  /** Latest aggregated window; safe to call at any time (empty defaults). */
  snapshot(): TelemetrySnapshot;
  /** Production rate for one item, or undefined without two usable samples. */
  rates(item: string): ItemRate | undefined;
  /** Drops all buffered samples (keeps the error counter). */
  clear(): void;
};

function numberRecord(value: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  const record = asRecord(value);
  if (record) {
    for (const [key, entry] of Object.entries(record)) {
      const count = asNumber(entry);
      if (count !== undefined) result[key] = count;
    }
  }
  return result;
}

function booleanRecord(value: unknown): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  const record = asRecord(value);
  if (record) {
    for (const [key, entry] of Object.entries(record)) {
      if (typeof entry === "boolean") result[key] = entry;
    }
  }
  return result;
}

/** Rounds rates so snapshots stay compact and deterministic in tests. */
function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function ratePerMinute(delta: number, windowSeconds: number): number {
  if (windowSeconds <= 0) return 0;
  return roundRate((delta / windowSeconds) * 60);
}

function emptySnapshot(): TelemetrySnapshot {
  return {
    tick: 0,
    samples: 0,
    window_seconds: 0,
    production_per_minute: {},
    deltas: {},
    research: { researched: {}, current_research: null, research_progress: null, new_research: [] },
    rockets: { total: 0, delta: 0, per_minute: 0 },
  };
}

/**
 * Creates the independent production telemetry sampler.
 *
 * The returned timer is `unref()`d so an idle manager can exit without
 * `stop()`; `stop()` is still idempotent and safe to call from shutdown.
 */
export function createTelemetrySampler(options: TelemetrySamplerOptions): TelemetrySampler {
  const command = options.command;
  const intervalMs = Math.max(1, Math.trunc(options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS));
  const windowMs = Math.max(intervalMs, Math.trunc(options.windowMs ?? DEFAULT_WINDOW_MS));
  const now = options.now ?? Date.now;
  const logger = options.logger;
  const shouldSample = options.shouldSample;
  // One slot per interval plus two guard slots; the time window prunes anyway.
  const maxSamples = Math.max(2, Math.ceil(windowMs / intervalMs) + 2);

  const samples: TelemetrySample[] = [];
  let timer: NodeJS.Timeout | undefined;
  let sampling = false;
  let errors = 0;

  function prune(nowMs: number): void {
    const cutoff = nowMs - windowMs;
    while (samples.length > 0 && samples[0].t < cutoff) samples.shift();
    while (samples.length > maxSamples) samples.shift();
  }

  function parseSample(raw: string, at: number): TelemetrySample | undefined {
    let parsed: Snapshot;
    try {
      // Shared parser: same validation as benchmark telemetry (needs tick and a
      // connected character). Malformed/partial replies are skipped, not fatal.
      parsed = parseSnapshot(raw);
    } catch (error) {
      errors += 1;
      logger?.warn("telemetry sample skipped", { error: errorMessage(error) || "invalid telemetry reply" });
      return undefined;
    }
    const record = asRecord(parsed) ?? {};
    return {
      t: at,
      tick: asNumber(record.tick) ?? 0,
      production: numberRecord(record.production),
      consumption: numberRecord(record.consumption),
      fluids_produced: numberRecord(record.fluids_produced),
      fluids_consumed: numberRecord(record.fluids_consumed),
      research: booleanRecord(record.research),
      current_research: asString(record.current_research) ?? null,
      research_progress: asNumber(record.research_progress) ?? null,
      rockets: asNumber(record.rockets) ?? 0,
    };
  }

  async function sampleOnce(): Promise<boolean> {
    if (sampling) return false;
    if (shouldSample && !shouldSample()) return false;
    sampling = true;
    try {
      let raw: string;
      try {
        raw = await command(telemetrySampleCommand());
      } catch (error) {
        errors += 1;
        logger?.debug?.("telemetry sample failed", {
          error: errorMessage(error) || String(error),
          errors,
        });
        return false;
      }
      const at = now();
      const sample = parseSample(raw, at);
      if (!sample) return false;
      samples.push(sample);
      prune(at);
      return true;
    } finally {
      sampling = false;
    }
  }

  function snapshot(): TelemetrySnapshot {
    prune(now());
    if (samples.length === 0) return emptySnapshot();
    const oldest = samples[0];
    const latest = samples[samples.length - 1];
    const windowSeconds = roundRate((latest.t - oldest.t) / 1000);
    const deltas: Record<string, number> = {};
    const productionPerMinute: Record<string, number> = {};
    if (samples.length > 1 && windowSeconds > 0) {
      for (const [item, count] of Object.entries(latest.production)) {
        const before = oldest.production[item];
        if (before === undefined) continue;
        const delta = count - before;
        // A counter reset (game reload/restart) shrinks counters; ignore it.
        // Unchanged items are omitted so the payload stays small.
        if (delta <= 0) continue;
        deltas[item] = delta;
        productionPerMinute[item] = ratePerMinute(delta, windowSeconds);
      }
    }
    const newResearch: string[] = [];
    if (samples.length > 1) {
      for (const [technology, researched] of Object.entries(latest.research)) {
        if (researched && oldest.research[technology] !== true) newResearch.push(technology);
      }
      newResearch.sort();
    }
    const rocketDelta = samples.length > 1 ? Math.max(0, latest.rockets - oldest.rockets) : 0;
    return {
      tick: latest.tick,
      samples: samples.length,
      window_seconds: windowSeconds,
      production_per_minute: productionPerMinute,
      deltas,
      research: {
        researched: latest.research,
        current_research: latest.current_research,
        research_progress: latest.research_progress,
        new_research: newResearch,
      },
      rockets: {
        total: latest.rockets,
        delta: rocketDelta,
        per_minute: ratePerMinute(rocketDelta, windowSeconds),
      },
    };
  }

  return {
    start(): void {
      if (timer) return;
      // Sample immediately so the first observe-production call has data.
      void sampleOnce();
      timer = setInterval(() => {
        void sampleOnce();
      }, intervalMs);
      // The sampler must never be the reason an idle manager stays alive.
      timer.unref();
    },
    stop(): void {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
    get running(): boolean {
      return timer !== undefined;
    },
    get sampleCount(): number {
      return samples.length;
    },
    get errorCount(): number {
      return errors;
    },
    sampleOnce,
    snapshot,
    rates(item: string): ItemRate | undefined {
      prune(now());
      if (samples.length < 2) return undefined;
      const oldest = samples[0];
      const latest = samples[samples.length - 1];
      const windowSeconds = (latest.t - oldest.t) / 1000;
      if (windowSeconds <= 0) return undefined;
      const before = oldest.production[item];
      const after = latest.production[item];
      if (before === undefined || after === undefined) return undefined;
      const delta = after - before;
      if (delta < 0) return undefined;
      return { item, produced_delta: delta, produced_per_minute: ratePerMinute(delta, windowSeconds) };
    },
    clear(): void {
      samples.length = 0;
    },
  };
}
