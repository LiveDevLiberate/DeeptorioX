#!/usr/bin/env node
/**
 * Offline calibration for evaluation scoring v2.
 *
 * Reads completed run records, computes the median completion time per
 * benchmark, and (only with --apply) writes it back as `scoring.par_seconds`
 * with provenance in `scoring.par_source`.
 *
 * Usage:
 *   node scripts/calibrate-scoring.mjs [--data-dir <runs-dir>] [--benchmarks-dir <dir>] [--apply]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);

function flagValue(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

function median(values) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Read run.json records from a runs directory (missing/corrupt files are skipped). */
export function loadRunRecords(runsDir) {
  if (!fs.existsSync(runsDir)) return [];
  const records = [];
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(runsDir, entry.name, "run.json");
    if (!fs.existsSync(file)) continue;
    try {
      const run = JSON.parse(fs.readFileSync(file, "utf8"));
      const benchmark = run?.benchmark ?? {};
      const completion = typeof benchmark.completion === "string" ? benchmark.completion : undefined;
      const milestones = run?.milestones && typeof run.milestones === "object" ? run.milestones : {};
      const completionSeconds = completion ? Number(milestones?.[completion]?.wall_seconds) : NaN;
      const variant =
        (typeof run?.scoring?.benchmark_variant === "string" && run.scoring.benchmark_variant) ||
        (typeof run?.construction?.variant === "string" && run.construction.variant) ||
        (typeof run?.evaluation?.capability?.variant === "string" &&
          run.evaluation.capability.variant) ||
        undefined;
      records.push({
        id: entry.name,
        benchmark: typeof benchmark.id === "string" ? benchmark.id : undefined,
        variant,
        completion,
        completion_seconds: Number.isFinite(completionSeconds) ? completionSeconds : undefined,
        milestone_seconds: Object.fromEntries(
          Object.entries(milestones)
            .map(([id, value]) => [id, Number(value?.wall_seconds)])
            .filter(([, seconds]) => Number.isFinite(seconds)),
        ),
      });
    } catch {
      /* skip unreadable records */
    }
  }
  return records;
}

/** Per-benchmark completion statistics used to suggest a par time. */
export function summarizeCompletionTimes(records) {
  const byBenchmark = new Map();
  for (const record of records) {
    if (!record.benchmark) continue;
    const key = record.variant || record.benchmark;
    const state = byBenchmark.get(key) ?? {
      completed_times: [],
      milestone_times: new Map(),
    };
    if (typeof record.completion_seconds === "number") {
      state.completed_times.push(record.completion_seconds);
    }
    for (const [id, seconds] of Object.entries(record.milestone_seconds)) {
      const list = state.milestone_times.get(id) ?? [];
      list.push(seconds);
      state.milestone_times.set(id, list);
    }
    byBenchmark.set(key, state);
  }
  const summary = new Map();
  for (const [benchmark, state] of byBenchmark) {
    const times = state.completed_times;
    const parsed = times.length > 0 ? Math.round(median(times)) : undefined;
    summary.set(benchmark, {
      benchmark: benchmark.includes(":") ? benchmark.split(":")[0] : benchmark,
      variant: benchmark.includes(":") ? benchmark : undefined,
      completed: times.length,
      median: parsed,
      p25:
        times.length >= 4
          ? Math.round(
              median(
                times
                  .slice()
                  .sort((a, b) => a - b)
                  .slice(0, Math.ceil(times.length / 2)),
              ),
            )
          : undefined,
      min: times.length > 0 ? Math.round(Math.min(...times)) : undefined,
      provisional: times.length < 3,
      parse: parsed,
      milestone_medians: Object.fromEntries(
        [...state.milestone_times.entries()].map(([id, seconds]) => [id, Math.round(median(seconds))]),
      ),
    });
  }
  return summary;
}

/** Write suggested par values back into `${benchmarksDir}/<id>.json`. Returns written ids. */
export function applyPar(benchmarksDir, summary) {
  const written = [];
  const date = new Date().toISOString().slice(0, 10);
  for (const [key, stats] of summary) {
    if (!stats.parse) continue;
    let benchmark = stats.benchmark || key;
    let variant = stats.variant;
    let file = path.join(benchmarksDir, `${benchmark}.json`);
    if (!fs.existsSync(file)) {
      const match = fs
        .readdirSync(benchmarksDir)
        .find((entry) => entry.endsWith(".json") && key.startsWith(`${entry.slice(0, -5)}:`));
      if (!match) continue;
      benchmark = match.slice(0, -5);
      variant = key;
      file = path.join(benchmarksDir, match);
    }
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.scoring = config.scoring && typeof config.scoring === "object" ? config.scoring : {};
    const parSource = `median_completed:${date} (n=${stats.completed}${stats.provisional ? ", provisional" : ""})`;
    if (variant) {
      config.scoring.variants =
        config.scoring.variants && typeof config.scoring.variants === "object"
          ? config.scoring.variants
          : {};
      config.scoring.variants[key] = { par_seconds: stats.parse, par_source: parSource };
    } else {
      config.scoring.par_seconds = stats.parse;
      config.scoring.par_source = parSource;
    }
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
    written.push(key);
  }
  return written;
}

function main() {
  const dataDir = path.resolve(
    String(flagValue("--data-dir") || path.join(process.cwd(), ".autorio", "runs")),
  );
  const benchmarksDir = path.resolve(
    String(flagValue("--benchmarks-dir") || path.join(process.cwd(), "benchmarks")),
  );
  const apply = args.includes("--apply");
  const summary = summarizeCompletionTimes(loadRunRecords(dataDir));
  if (summary.size === 0) {
    console.log(`No completed run records found under ${dataDir}`);
    return;
  }
  for (const [benchmark, stats] of [...summary.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const par = stats.parse === undefined ? "n/a (no completions)" : `${stats.parse}s`;
    const provisional = stats.provisional ? " provisional" : "";
    console.log(
      `${benchmark}: completed=${stats.completed} median=${stats.median ?? "n/a"}s${provisional} -> par_seconds=${par}`,
    );
    const milestoneText = Object.entries(stats.milestone_medians)
      .map(([id, seconds]) => `${id}=${seconds}s`)
      .join(", ");
    if (milestoneText) console.log(`  milestone medians: ${milestoneText}`);
  }
  if (!apply) {
    console.log("\nDry run: pass --apply to write par_seconds back into benchmark JSON.");
    return;
  }
  const written = applyPar(benchmarksDir, summary);
  console.log(`\nUpdated par_seconds in: ${written.join(", ") || "(none)"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
