import fs from "node:fs";
import path from "node:path";

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
};

export function loadBenchmarks(root: string): Benchmark[] {
  return fs
    .readdirSync(path.join(root, "benchmarks"))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const b = JSON.parse(fs.readFileSync(path.join(root, "benchmarks", file), "utf8")) as Benchmark;
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
  "local power=nil pcall(function() local px=p.position.x local py=p.position.y local poles=s.find_entities_filtered{area={{px-128,py-128},{px+128,py+128}},type='electric-pole'} local seen={} local production,consumption,transfer,networks=0,0,0,0 for _,pole in ipairs(poles) do local ok,sub=pcall(function() return pole.electric_network end) if ok and sub then local ok2,parent=pcall(function() return sub.parent_network end) if ok2 and parent then local key=tostring(parent) if not seen[key] then seen[key]=true networks=networks+1 local ok3,flow=pcall(function() return parent.flow_last_tick end) if ok3 and flow then production=production+(flow.maximum_production or 0) consumption=consumption+(flow.maximum_consumption or 0) transfer=transfer+(flow.total_transfer or 0) end end end end end power={networks=networks,maximum_production=production,maximum_consumption=consumption,total_transfer=transfer} if consumption>0 then power.satisfaction=math.min(1,transfer/consumption) end end) " +
  "rcon.print(helpers.table_to_json({tick=game.tick,speed=game.speed,paused=game.tick_paused,player=p.name," +
  "character=p.character~=nil and p.connected,production=i.input_counts,consumption=i.output_counts," +
  "fluids_produced=l.input_counts,fluids_consumed=l.output_counts,research=research,current_research=current,research_progress=progress,rockets=f.rockets_launched,power=power}))";

export function parseSnapshot(raw: string): Snapshot {
  const sample = JSON.parse(raw);
  if (!Number.isFinite(sample.tick) || !sample.character)
    throw new Error("Connected player 1 with a character is not ready");
  return sample;
}
