import fs from "node:fs";
import path from "node:path";
import { normalizeConstruction, type ConstructionConfig, type ConstructionMode } from "./construction.js";

export type Milestone = {
  id: string;
  kind: "production" | "research" | "rockets";
  name?: string;
  count?: number;
  label?: string;
};
export const SCIENCE_RESEARCH = [
  "automation",
  "logistic",
  "military",
  "chemical",
  "production",
  "utility",
  "space",
].map((name) => ({
  id: `research:${name}-science-pack`,
  kind: "research" as const,
  name: `${name}-science-pack`,
  label: `${name[0].toUpperCase() + name.slice(1)} science research`,
}));
export function trackedMilestones(benchmark: Benchmark): Milestone[] {
  return [
    ...benchmark.milestones,
    ...SCIENCE_RESEARCH.filter(
      (science) => !benchmark.milestones.some((m) => m.kind === "research" && m.name === science.name),
    ),
  ];
}

/** Benchmark-level evaluation parameters (scoring v2). */
export type ScoringConfig = {
  version: number;
  /** Whether completed runs of this benchmark enter the capability ranking. */
  ranked: boolean;
  completion_basis: "milestone_first_seen";
  /** Reference completion time: finishing at par scores 750 (0..1000 scale). */
  par_seconds: number;
  /** Provenance of par_seconds ("configured", "median_completed:date", "fallback:..."). */
  par_source: string;
  /**
   * Explicit scored milestone set: unlisted milestones contribute nothing.
   * Keys must be tracked milestone ids; the completion milestone must be scored.
   */
  progress_weights: Record<string, number>;
  /** Frozen construction-mode identity (set on run start, optional for old configs). */
  construction_mode?: ConstructionMode;
  /** Frozen benchmark variant including construction mode/blueprint policy. */
  benchmark_variant?: string;
  /** Frozen blueprint policy source. */
  blueprint_policy?: string;
};

export type Benchmark = {
  id: string;
  title: string;
  task: string;
  map_gen: Record<string, unknown> & { seed: number };
  always_day: boolean;
  starting_items: Record<string, number>;
  max_seconds: number;
  sample_seconds: number;
  milestones: Milestone[];
  completion: string;
  scoring: ScoringConfig;
  construction: ConstructionConfig;
};

/**
 * Normalise and validate a benchmark's scoring block.
 *
 * Missing blocks get schema-v1 defaults (all declared milestones equal weight,
 * par = max_seconds / 3) so older benchmark files keep loading. Explicit
 * `progress_weights` are authoritative: unlisted milestones never contribute.
 */
export function normalizeScoring(
  raw: unknown,
  benchmark: Pick<Benchmark, "milestones" | "completion" | "max_seconds">,
): ScoringConfig {
  const source =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const versionValue = Number(source.version);
  const version = Number.isFinite(versionValue) && versionValue >= 1 ? Math.round(versionValue) : 1;
  const ranked = typeof source.ranked === "boolean" ? source.ranked : true;
  if (source.completion_basis !== undefined && source.completion_basis !== "milestone_first_seen") {
    throw new Error(`Invalid scoring.completion_basis: ${JSON.stringify(source.completion_basis)}`);
  }
  const parValue = Number(source.par_seconds);
  const hasPar = Number.isFinite(parValue) && parValue > 0;
  const parSeconds = hasPar ? parValue : Math.max(1, Math.round(benchmark.max_seconds / 3));
  const parSource =
    typeof source.par_source === "string" && source.par_source.trim()
      ? source.par_source.trim()
      : hasPar
        ? "configured"
        : "fallback:max_seconds/3";
  const tracked = new Set(trackedMilestones(benchmark as Benchmark).map((entry) => entry.id));
  const weights: Record<string, number> = {};
  const rawWeights = source.progress_weights;
  if (rawWeights !== undefined) {
    if (!rawWeights || typeof rawWeights !== "object" || Array.isArray(rawWeights)) {
      throw new Error("Invalid scoring.progress_weights: expected an object");
    }
    for (const [id, value] of Object.entries(rawWeights as Record<string, unknown>)) {
      if (!tracked.has(id)) throw new Error(`Invalid scoring.progress_weights: unknown milestone ${id}`);
      const weight = Number(value);
      if (!Number.isFinite(weight) || weight <= 0) {
        throw new Error(`Invalid scoring.progress_weights: bad weight for ${id}`);
      }
      weights[id] = weight;
    }
  } else {
    for (const milestone of benchmark.milestones) weights[milestone.id] = 1;
  }
  if (!Number.isFinite(weights[benchmark.completion]) || weights[benchmark.completion] <= 0) {
    throw new Error("Invalid scoring.progress_weights: completion milestone must be scored");
  }
  return {
    version,
    ranked,
    completion_basis: "milestone_first_seen",
    par_seconds: parSeconds,
    par_source: parSource,
    progress_weights: weights,
  };
}

export function loadBenchmarks(root: string): Benchmark[] {
  return fs
    .readdirSync(path.join(root, "benchmarks"))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const b = JSON.parse(fs.readFileSync(path.join(root, "benchmarks", file), "utf8")) as Benchmark & {
        scoring?: unknown;
      };
      if (
        !/^[a-z0-9-]+$/.test(b.id) ||
        !b.title ||
        !b.task ||
        !Number.isInteger(b.map_gen?.seed) ||
        !Number.isFinite(b.max_seconds) ||
        b.max_seconds <= 0 ||
        !Number.isFinite(b.sample_seconds) ||
        b.sample_seconds < 1 ||
        !b.starting_items ||
        typeof b.always_day !== "boolean" ||
        !Array.isArray(b.milestones) ||
        !b.milestones.some((m) => m.id === b.completion)
      )
        throw new Error(`Invalid benchmark: ${file}`);
      const ids = new Set<string>();
      for (const m of b.milestones) {
        if (
          !m.id ||
          ids.has(m.id) ||
          !["production", "research", "rockets"].includes(m.kind) ||
          (m.kind !== "rockets" && !m.name) ||
          (m.kind !== "research" && (!Number.isFinite(m.count) || m.count! <= 0))
        ) {
          throw new Error(`Invalid milestone in ${file}`);
        }
        ids.add(m.id);
      }
      for (const [name, count] of Object.entries(b.starting_items)) {
        if (!name || !Number.isInteger(count) || count < 0)
          throw new Error(`Invalid starting inventory in ${file}`);
      }
      b.scoring = normalizeScoring(b.scoring, b);
      b.construction = normalizeConstruction(
        (b as Benchmark & { construction?: unknown }).construction,
        b.id,
      );
      return b;
    });
}

export type Snapshot = {
  tick: number;
  speed: number;
  paused: boolean;
  character: boolean;
  player: string;
  production: Record<string, number>;
  consumption: Record<string, number>;
  fluids_produced: Record<string, number>;
  fluids_consumed: Record<string, number>;
  research: Record<string, boolean>;
  current_research?: string | null;
  research_progress?: number | null;
  rockets: number;
  /** Electric-network summary around the player (best effort, may be absent). */
  power?: {
    networks: number;
    maximum_production: number;
    maximum_consumption: number;
    total_transfer: number;
    satisfaction?: number;
  } | null;
};

export function reached(m: Milestone, sample: Snapshot, baseline: Snapshot): boolean {
  if (m.kind === "research") return sample.research[m.name!] === true;
  if (m.kind === "rockets") return sample.rockets - baseline.rockets >= m.count!;
  return (sample.production[m.name!] || 0) - (baseline.production[m.name!] || 0) >= m.count!;
}

export const TELEMETRY_COMMAND =
  "/sc local p=game.players[1]; if not p then rcon.print('{}') return end; " +
  "local f=p.force; local s=p.surface; local i=f.get_item_production_statistics(s); local l=f.get_fluid_production_statistics(s); " +
  "local research={} for name,t in pairs(f.technologies) do if t.researched then research[name]=true end end; " +
  "local current=nil local progress=nil if f.current_research then current=f.current_research.name progress=f.research_progress end; " +
  // Aggregate every player-force electric network on the surface, not only the
  // ones near the player: blackout scoring must still see a distant base outage.
  "local power=nil pcall(function() local poles=s.find_entities_filtered{force=f,type='electric-pole'} local seen={} local production,consumption,transfer,networks=0,0,0,0 for _,pole in ipairs(poles) do local ok,sub=pcall(function() return pole.electric_network end) if ok and sub then local ok2,parent=pcall(function() return sub.parent_network end) if ok2 and parent then local key=tostring(parent) if not seen[key] then seen[key]=true networks=networks+1 local ok3,flow=pcall(function() return parent.flow_last_tick end) if ok3 and flow then production=production+(flow.maximum_production or 0) consumption=consumption+(flow.maximum_consumption or 0) transfer=transfer+(flow.total_transfer or 0) end end end end end power={networks=networks,maximum_production=production,maximum_consumption=consumption,total_transfer=transfer} if consumption>0 then power.satisfaction=math.min(1,transfer/consumption) end end) " +
  "rcon.print(helpers.table_to_json({tick=game.tick,speed=game.speed,paused=game.tick_paused,player=p.name," +
  "character=p.character~=nil and p.connected,production=i.input_counts,consumption=i.output_counts," +
  "fluids_produced=l.input_counts,fluids_consumed=l.output_counts,research=research,current_research=current,research_progress=progress,rockets=f.rockets_launched,power=power}))";

export function parseSnapshot(raw: string): Snapshot {
  const sample = JSON.parse(raw);
  if (!Number.isFinite(sample.tick) || !sample.character)
    throw new Error("Connected player 1 with a character is not ready");
  return sample;
}
