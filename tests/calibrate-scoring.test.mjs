import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { loadRunRecords, summarizeCompletionTimes, applyPar } =
  await import("../scripts/calibrate-scoring.mjs");

function writeRun(root, name, run) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(run));
}

test("calibration suggests the median completion time and applies it", () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-calibrate-runs-"));
  const benchmarks = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-calibrate-bench-"));
  try {
    writeRun(runs, "a", {
      benchmark: { id: "automation", completion: "twenty-plates" },
      state: "completed",
      milestones: { "twenty-plates": { wall_seconds: 600 } },
    });
    writeRun(runs, "b", {
      benchmark: { id: "automation", completion: "twenty-plates" },
      state: "completed",
      milestones: { "twenty-plates": { wall_seconds: 700 } },
    });
    writeRun(runs, "c", {
      benchmark: { id: "automation", completion: "twenty-plates" },
      state: "timed_out",
      milestones: {},
    });
    fs.writeFileSync(
      path.join(benchmarks, "automation.json"),
      JSON.stringify({ id: "automation", scoring: { par_seconds: 1 } }, null, 2),
    );
    const records = loadRunRecords(runs);
    assert.equal(records.length, 3);
    const summary = summarizeCompletionTimes(records);
    const automation = summary.get("automation");
    assert.ok(automation);
    assert.equal(automation.completed, 2);
    assert.equal(automation.parse, 650);
    assert.equal(automation.provisional, true);
    const written = applyPar(benchmarks, summary);
    assert.deepEqual(written, ["automation"]);
    const updated = JSON.parse(fs.readFileSync(path.join(benchmarks, "automation.json"), "utf8"));
    assert.equal(updated.scoring.par_seconds, 650);
    assert.match(updated.scoring.par_source, /median_completed:/);
    assert.match(updated.scoring.par_source, /n=2/);
  } finally {
    fs.rmSync(runs, { recursive: true, force: true });
    fs.rmSync(benchmarks, { recursive: true, force: true });
  }
});

test("calibration ignores benchmarks without completed runs", () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-calibrate-runs-"));
  try {
    writeRun(runs, "r", {
      benchmark: { id: "rocket", completion: "rocket-launched" },
      state: "timed_out",
      milestones: { "first-plate": { wall_seconds: 300 } },
    });
    const summary = summarizeCompletionTimes(loadRunRecords(runs));
    const rocket = summary.get("rocket");
    assert.ok(rocket);
    assert.equal(rocket.completed, 0);
    assert.equal(rocket.parse, undefined);
    assert.equal(rocket.milestone_medians["first-plate"], 300);
  } finally {
    fs.rmSync(runs, { recursive: true, force: true });
  }
});

test("calibration skips corrupt runs and computes quartiles only with enough samples", () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-calibrate-runs-"));
  const benchmarks = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-calibrate-bench-"));
  try {
    assert.deepEqual(loadRunRecords(path.join(runs, "missing")), []);
    fs.mkdirSync(path.join(runs, "empty-dir"), { recursive: true });
    fs.writeFileSync(path.join(runs, "not-a-dir"), "x");
    fs.mkdirSync(path.join(runs, "no-run"), { recursive: true });
    fs.mkdirSync(path.join(runs, "corrupt"), { recursive: true });
    fs.writeFileSync(path.join(runs, "corrupt", "run.json"), "{bad json");
    writeRun(runs, "a", { benchmark: { id: "smoke", completion: "first-gear" }, milestones: {} });
    writeRun(runs, "b", { benchmark: { id: "smoke", completion: "first-gear" }, milestones: {} });
    writeRun(runs, "c", { benchmark: { id: "smoke", completion: "first-gear" }, milestones: {} });
    writeRun(runs, "d", { benchmark: { id: "smoke", completion: "first-gear" }, milestones: {} });
    writeRun(runs, "e", {
      benchmark: { id: "smoke", completion: "first-gear" },
      milestones: {
        "first-gear": { wall_seconds: 10 },
        "second-gear": { wall_seconds: 20 },
      },
    });
    writeRun(runs, "f", { benchmark: { id: "smoke" }, milestones: {} });
    writeRun(runs, "g", { milestones: {} });
    const records = loadRunRecords(runs);
    assert.equal(records.length, 7);
    assert.equal(records.find((record) => record.id === "f").completion_seconds, undefined);
    assert.equal(records.find((record) => record.id === "g").benchmark, undefined);
    const summary = summarizeCompletionTimes(records);
    const smoke = summary.get("smoke");
    assert.ok(smoke);
    assert.equal(smoke.completed, 1);
    assert.equal(smoke.parse, 10);
    assert.equal(smoke.min, 10);
    assert.equal(smoke.provisional, true);
    assert.equal(summarizeCompletionTimes([{ benchmark: null, milestone_seconds: {} }]).size, 0);
    fs.writeFileSync(path.join(benchmarks, "smoke.json"), JSON.stringify({ id: "smoke" }));
    applyPar(benchmarks, summary);
    const updated = JSON.parse(fs.readFileSync(path.join(benchmarks, "smoke.json"), "utf8"));
    assert.equal(updated.scoring.par_seconds, 10);
    assert.match(updated.scoring.par_source, /provisional/);
    assert.deepEqual(
      applyPar(benchmarks, new Map([["smoke", { parse: 10, completed: 3, provisional: false }]])),
      ["smoke"],
    );
    const settled = JSON.parse(fs.readFileSync(path.join(benchmarks, "smoke.json"), "utf8"));
    assert.doesNotMatch(settled.scoring.par_source, /provisional/);
    assert.deepEqual(applyPar(benchmarks, new Map([["missing", { parse: 10, completed: 3 }]])), []);
  } finally {
    fs.rmSync(runs, { recursive: true, force: true });
    fs.rmSync(benchmarks, { recursive: true, force: true });
  }
});

test("calibration leaves benchmarks without a suggested par untouched", () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-calibrate-runs-"));
  const benchmarks = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-calibrate-bench-"));
  try {
    writeRun(runs, "a", { benchmark: { id: "rocket" }, milestones: {} });
    const summary = summarizeCompletionTimes(loadRunRecords(runs));
    assert.equal(summary.get("rocket").completed, 0);
    assert.deepEqual(applyPar(benchmarks, summary), []);
  } finally {
    fs.rmSync(runs, { recursive: true, force: true });
    fs.rmSync(benchmarks, { recursive: true, force: true });
  }
});

test("calibration groups runs by construction variant and writes variant par overrides", () => {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-calibrate-runs-"));
  const benchmarks = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-calibrate-bench-"));
  try {
    writeRun(runs, "free", {
      benchmark: { id: "smoke", completion: "first-gear" },
      scoring: { benchmark_variant: "smoke:free:agent" },
      milestones: { "first-gear": { wall_seconds: 100 } },
    });
    writeRun(runs, "planned", {
      benchmark: { id: "smoke", completion: "first-gear" },
      scoring: { benchmark_variant: "smoke:planned:agent" },
      milestones: { "first-gear": { wall_seconds: 200 } },
    });
    fs.writeFileSync(
      path.join(benchmarks, "smoke.json"),
      JSON.stringify({ id: "smoke", scoring: { par_seconds: 1 } }, null, 2),
    );
    const summary = summarizeCompletionTimes(loadRunRecords(runs));
    assert.equal(summary.get("smoke:free:agent").parse, 100);
    assert.equal(summary.get("smoke:planned:agent").parse, 200);
    assert.deepEqual(applyPar(benchmarks, summary), [
      "smoke:free:agent",
      "smoke:planned:agent",
    ]);
    const updated = JSON.parse(fs.readFileSync(path.join(benchmarks, "smoke.json"), "utf8"));
    assert.equal(updated.scoring.par_seconds, 1);
    assert.equal(updated.scoring.variants["smoke:free:agent"].par_seconds, 100);
    assert.equal(updated.scoring.variants["smoke:planned:agent"].par_seconds, 200);
  } finally {
    fs.rmSync(runs, { recursive: true, force: true });
    fs.rmSync(benchmarks, { recursive: true, force: true });
  }
});
