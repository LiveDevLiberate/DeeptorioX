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
