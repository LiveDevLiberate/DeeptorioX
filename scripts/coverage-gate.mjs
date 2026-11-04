#!/usr/bin/env node
// Coverage threshold gate: `node scripts/coverage-gate.mjs`.
//
// Node 20 only exposes `--experimental-test-coverage` (there are no
// `--test-coverage-lines`/branch/function threshold flags), so this gate runs
// the Node test suite with coverage, parses the final `all files` row of the
// report and enforces minimum percentages. Per-file rows are ignored so small
// helpers cannot skew the gate.
//
// Defaults leave a little headroom under the current suite coverage:
//   lines 82, branches 78, functions 84
//
// Override per run:
//   node scripts/coverage-gate.mjs --lines 85 --branches 80 --functions 88
//   AUTORIO_COVERAGE_LINES=85 AUTORIO_COVERAGE_BRANCHES=80 ...
//
// Other flags: --json (machine-readable summary), --help.
// Exit codes: 0 thresholds passed, 1 coverage/test failure, 2 usage/setup error.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const METRICS = ["lines", "branches", "functions"];
const ENV_KEYS = {
  lines: "AUTORIO_COVERAGE_LINES",
  branches: "AUTORIO_COVERAGE_BRANCHES",
  functions: "AUTORIO_COVERAGE_FUNCTIONS",
};
const COVERAGE_FLAG = "--experimental-test-coverage";

export const DEFAULT_THRESHOLDS = Object.freeze({ lines: 82, branches: 78, functions: 84 });

/**
 * Parse the final `all files | line % | branch % | funcs %` row out of a Node
 * coverage report. Returns `{ lines, branches, functions }` or `null` when the
 * report (or the all-files row) is missing or malformed.
 */
export function parseCoverageReport(text) {
  let actual = null;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    // Coverage lines are prefixed with "ℹ " on a TTY and "# " in piped TAP.
    const line = rawLine
      .replace(/^[#\u2139]+\s*/, "")
      .replace(/^[\u2139\s]+/, "")
      .trim();
    if (!/^all files\b/.test(line)) continue;
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);
    // Skip a header-looking row ("all files | line % | ...") or a truncated
    // row and keep scanning: a later, complete row still wins.
    if (cells.length < 4) continue;
    const numbers = cells.slice(1, 4).map((cell) => Number.parseFloat(cell.replace(/%/g, "")));
    if (numbers.some((value) => !Number.isFinite(value))) continue;
    actual = { lines: numbers[0], branches: numbers[1], functions: numbers[2] };
  }
  return actual;
}

/**
 * Compare measured percentages against thresholds. Every metric must be at or
 * above its threshold (inclusive). Returns `{ ok, checks }` where each check is
 * `{ metric, actual, threshold, ok }`.
 */
export function evaluateThresholds(actual, thresholds = DEFAULT_THRESHOLDS) {
  const checks = METRICS.map((metric) => {
    const value = actual?.[metric];
    const threshold = thresholds?.[metric];
    return {
      metric,
      actual: Number.isFinite(value) ? value : null,
      threshold: Number.isFinite(threshold) ? threshold : null,
      ok: Number.isFinite(value) && Number.isFinite(threshold) && value >= threshold,
    };
  });
  return { ok: checks.every((check) => check.ok), checks };
}

function parsePercent(value, source) {
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error(`${source} must be a percentage between 0 and 100 (got ${JSON.stringify(value)})`);
  }
  return percent;
}

/**
 * Resolve thresholds from CLI flags and environment variables. CLI flags win
 * over `AUTORIO_COVERAGE_*` environment variables.
 */
export function resolveThresholds(argv = [], env = process.env) {
  const thresholds = { ...DEFAULT_THRESHOLDS };
  for (const metric of METRICS) {
    const envValue = env?.[ENV_KEYS[metric]];
    if (envValue !== undefined && envValue !== "") {
      thresholds[metric] = parsePercent(envValue, ENV_KEYS[metric]);
    }
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    for (const metric of METRICS) {
      const flag = `--${metric}`;
      if (token === flag) {
        thresholds[metric] = parsePercent(argv[index + 1], flag);
        index += 1;
      } else if (token.startsWith(`${flag}=`)) {
        thresholds[metric] = parsePercent(token.slice(flag.length + 1), flag);
      }
    }
  }
  return thresholds;
}

function parseCliArgs(argv) {
  let json = false;
  let help = false;
  const unknown = [];
  for (const token of argv) {
    if (token === "--json") json = true;
    else if (token === "--help" || token === "-h") help = true;
    else if (token.startsWith("--")) {
      const known = METRICS.some((metric) => token === `--${metric}` || token.startsWith(`--${metric}=`));
      if (!known) unknown.push(token);
    } else {
      unknown.push(token);
    }
  }
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(" ")}`);
  return { json, help, thresholds: resolveThresholds(argv) };
}

function listTestFiles() {
  return fs
    .readdirSync(path.join(ROOT, "tests"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => path.join("tests", name));
}

/**
 * Run the Node test suite with coverage, streaming output and returning the
 * combined output plus the child exit status. Never inherits stdio: the report
 * must be captured so it can be parsed.
 */
export function runCoverageSuite() {
  const testFiles = listTestFiles();
  const args = ["--test", COVERAGE_FLAG, ...testFiles];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status: status ?? 1, signal, output }));
  });
}

function formatPercent(value) {
  return `${value.toFixed(2)}%`;
}

function printSummary(thresholds, evaluation) {
  for (const check of evaluation.checks) {
    const actualText = check.actual === null ? "n/a" : formatPercent(check.actual);
    const thresholdText = check.threshold === null ? "n/a" : `${check.threshold}%`;
    const status = check.ok ? "PASS" : "FAIL";
    console.log(
      `coverage gate: ${check.metric.padEnd(9)} ${actualText.padStart(7)}  >= ${thresholdText.padEnd(6)}${status}`,
    );
  }
  const passed = evaluation.checks.filter((check) => check.ok).length;
  if (evaluation.ok) {
    console.log(`coverage gate: PASSED (${passed}/${evaluation.checks.length} thresholds)`);
  } else {
    console.error(`coverage gate: FAILED (${passed}/${evaluation.checks.length} thresholds met)`);
  }
  if (thresholds !== DEFAULT_THRESHOLDS) {
    console.log(
      `coverage gate: thresholds lines=${thresholds.lines} branches=${thresholds.branches} functions=${thresholds.functions}`,
    );
  }
}

function printUsage() {
  console.log(`Usage: node scripts/coverage-gate.mjs [--lines N] [--branches N] [--functions N] [--json]

Runs "node --test --experimental-test-coverage tests/*.test.mjs" and fails
unless the \`all files\` coverage row meets every threshold.

Defaults: lines ${DEFAULT_THRESHOLDS.lines}, branches ${DEFAULT_THRESHOLDS.branches}, functions ${DEFAULT_THRESHOLDS.functions}
Environment overrides: ${Object.values(ENV_KEYS).join(", ")}`);
}

function reportUnparsedReport() {
  console.error("coverage gate: could not find a valid `all files` coverage row in the test output");
}

async function main(argv) {
  const options = parseCliArgs(argv);
  if (options.help) {
    printUsage();
    return 0;
  }
  if (!fs.existsSync(path.join(ROOT, "dist"))) {
    throw new Error("dist/ is missing - run `npm run build` before the coverage gate");
  }
  const { status, signal, output } = await runCoverageSuite();
  const actual = parseCoverageReport(output);
  if (!actual) {
    reportUnparsedReport();
    return 1;
  }
  const evaluation = evaluateThresholds(actual, options.thresholds);
  const testsPassed = status === 0;
  if (options.json) {
    const result = {
      ok: evaluation.ok && testsPassed,
      passed: evaluation.ok,
      tests_passed: testsPassed,
      tests_exit_code: status,
      signal,
      actual,
      thresholds: options.thresholds,
      checks: evaluation.checks,
    };
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  printSummary(options.thresholds, evaluation);
  if (!testsPassed) {
    console.error(`coverage gate: test suite failed (exit code ${status}); coverage is not trusted`);
  }
  return evaluation.ok && testsPassed ? 0 : 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`coverage gate: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}
