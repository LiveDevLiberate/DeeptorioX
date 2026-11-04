import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_THRESHOLDS,
  evaluateThresholds,
  parseCoverageReport,
  resolveThresholds,
} from "../scripts/coverage-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(ROOT, "scripts", "coverage-gate.mjs");

// Trimmed-down fixture copied from a real `node --test
// --experimental-test-coverage` TAP run: coverage lines are "# "-prefixed and
// per-file rows must not be mistaken for the "all files" row.
const FIXTURE = `# start of tests
TAP version 13
ok 1 - a passing test
# tests 1
# pass 1
# ----------------------------------------------------------------------
# file                  | line % | branch % | funcs % | uncovered lines
# ----------------------------------------------------------------------
# dist/command-builders.js | 100.00 |   87.50 |  100.00 |
# dist/platform.js      |  30.47 |   50.00 |   39.39 | 14-45 48-50
# dist/runs.js          |  71.12 |   63.22 |   73.91 | 87-91
# scripts/release.mjs   |  12.00 |   10.00 |    5.00 | 1-200
# ----------------------------------------------------------------------
# all files             |  83.88 |   80.20 |   86.18 |
# ----------------------------------------------------------------------
# end of coverage report
`;

test("parseCoverageReport extracts the all-files row and ignores file rows", () => {
  const actual = parseCoverageReport(FIXTURE);
  assert.deepEqual(actual, { lines: 83.88, branches: 80.2, functions: 86.18 });
});

test("parseCoverageReport accepts the interactive report prefix and column variants", () => {
  const tty = [
    "\u2139 start of coverage report",
    "\u2139 file           | line % | branch % | funcs % | uncovered lines",
    "\u2139 foo.test.mjs   |  10.00 |   20.00 |   30.00 | 1",
    "\u2139 all files      |  90.00 |   88.88 |  100.00 |",
  ].join("\n");
  assert.deepEqual(parseCoverageReport(tty), { lines: 90, branches: 88.88, functions: 100 });
  const spaced = "all files | line % | branch % | funcs % | uncovered lines\nall files | 99.5 | 98.25 | 97 |";
  assert.deepEqual(parseCoverageReport(spaced), { lines: 99.5, branches: 98.25, functions: 97 });
});

test("parseCoverageReport returns null for a missing or malformed report", () => {
  assert.equal(parseCoverageReport(""), null);
  assert.equal(parseCoverageReport("TAP version 13\nok 1 - test"), null);
  assert.equal(parseCoverageReport("all files | 83.88 | 80.20 |"), null);
  assert.equal(parseCoverageReport("all files | n/a | 80.20 | 86.18 |"), null);
});

test("evaluateThresholds passes on or above the thresholds and reports failures", () => {
  const passing = evaluateThresholds({ lines: 83.88, branches: 80.2, functions: 86.18 }, DEFAULT_THRESHOLDS);
  assert.equal(passing.ok, true);
  assert.deepEqual(
    passing.checks.map((check) => check.metric),
    ["lines", "branches", "functions"],
  );
  assert.ok(passing.checks.every((check) => check.ok));

  // Equal to the threshold is a pass; one point lower is a fail.
  const boundary = evaluateThresholds({ lines: 82, branches: 78, functions: 84 }, DEFAULT_THRESHOLDS);
  assert.equal(boundary.ok, true);
  const failing = evaluateThresholds({ lines: 82, branches: 77.99, functions: 84 }, DEFAULT_THRESHOLDS);
  assert.equal(failing.ok, false);
  assert.deepEqual(
    failing.checks.filter((check) => !check.ok).map((check) => check.metric),
    ["branches"],
  );

  const missing = evaluateThresholds({ lines: 90, branches: 90 }, DEFAULT_THRESHOLDS);
  assert.equal(missing.ok, false);
  assert.equal(missing.checks.find((check) => check.metric === "functions").actual, null);
});

test("default thresholds match the documented headroom", () => {
  assert.deepEqual({ ...DEFAULT_THRESHOLDS }, { lines: 82, branches: 78, functions: 84 });
});

test("resolveThresholds honours environment overrides and lets CLI flags win", () => {
  assert.deepEqual(resolveThresholds([], {}), { ...DEFAULT_THRESHOLDS });
  assert.deepEqual(
    resolveThresholds([], { AUTORIO_COVERAGE_LINES: "90", AUTORIO_COVERAGE_FUNCTIONS: "95" }),
    { lines: 90, branches: 78, functions: 95 },
  );
  assert.deepEqual(
    resolveThresholds(["--lines", "91", "--branches=88", "--functions", "96"], {
      AUTORIO_COVERAGE_LINES: "90",
    }),
    { lines: 91, branches: 88, functions: 96 },
  );
  assert.throws(() => resolveThresholds(["--lines", "abc"], {}), /--lines must be a percentage/);
  assert.throws(() => resolveThresholds([], { AUTORIO_COVERAGE_BRANCHES: "101" }), /between 0 and 100/);
  assert.throws(() => resolveThresholds(["--functions", "20", "--functions"], {}), /must be a percentage/);
});

test("CLI prints usage for --help and rejects unknown arguments", () => {
  const help = spawnSync(process.execPath, [GATE, "--help"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node scripts\/coverage-gate\.mjs/);
  assert.match(help.stdout, /lines 82, branches 78, functions 84/);

  const invalid = spawnSync(process.execPath, [GATE, "--bogus"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /unknown argument/);
});
