#!/usr/bin/env node
// Zero-dependency repository hygiene gate: `npm run check:repo`.
// Keeps the engineering baseline enforceable without adding lint tooling:
// script/engine metadata, strict TS, LF line endings, tracked build artifacts,
// test focus markers, stray debug logging and obvious committed secrets.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

function check(name, verify) {
  try {
    const detail = verify();
    results.push({ ok: true, name, detail });
  } catch (error) {
    results.push({ ok: false, name, detail: error instanceof Error ? error.message : String(error) });
  }
}

function trackedFiles() {
  return git(["ls-files", "-z"]).split("\0").filter(Boolean);
}

const LF_EXTENSIONS = [
  ".ts",
  ".mjs",
  ".js",
  ".css",
  ".json",
  ".yml",
  ".yaml",
  ".md",
  ".py",
  ".sh",
  ".lua",
  ".txt",
];
const BINARY_EXTENSIONS = [".png", ".jpg", ".zip", ".webp", ".mp4", ".ico", ".woff", ".woff2"];

check("package.json scripts, engines and zero runtime dependencies", () => {
  const pkg = JSON.parse(read("package.json"));
  const required = [
    "build",
    "test",
    "test:node",
    "test:python",
    "test:coverage",
    "verify",
    "check:repo",
    "format",
    "format:check",
    "package",
  ];
  const missing = required.filter((name) => !pkg.scripts?.[name]);
  if (missing.length > 0) throw new Error(`missing scripts: ${missing.join(", ")}`);
  if (!pkg.engines?.node) throw new Error("missing engines.node");
  const runtimeDependencies = Object.keys(pkg.dependencies ?? {});
  if (runtimeDependencies.length > 0) {
    throw new Error(
      `runtime dependencies are not allowed by default (found: ${runtimeDependencies.join(", ")}); ` +
        "move tooling to devDependencies and vendor runtime code instead",
    );
  }
  return `${required.length} scripts, node ${pkg.engines.node}`;
});

check("strict TypeScript with NodeNext modules", () => {
  const config = JSON.parse(read("tsconfig.json"));
  if (config.compilerOptions?.strict !== true) throw new Error("compilerOptions.strict must be true");
  if (config.compilerOptions?.module !== "NodeNext")
    throw new Error("compilerOptions.module must be NodeNext");
  if (config.compilerOptions?.moduleResolution !== "NodeNext") {
    throw new Error("compilerOptions.moduleResolution must be NodeNext");
  }
  return "strict + NodeNext";
});

check("required engineering files exist", () => {
  const required = [
    "README.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "docs/architecture.md",
    ".env.example",
    ".editorconfig",
    ".prettierrc.json",
    ".prettierignore",
    ".gitattributes",
    ".github/workflows/ci.yml",
    "package-lock.json",
  ];
  const missing = required.filter((file) => !fs.existsSync(path.join(ROOT, file)));
  if (missing.length > 0) throw new Error(`missing: ${missing.join(", ")}`);
  return `${required.length} files`;
});

check("no build artifacts, secrets or local state tracked by git", () => {
  const tracked = trackedFiles();
  const forbidden = (file) =>
    file === ".env" ||
    file.startsWith("dist/") ||
    file.startsWith(".autorio/") ||
    file.startsWith("node_modules/") ||
    file.startsWith("__pycache__/") ||
    file.endsWith(".pyc");
  const found = tracked.filter(forbidden);
  if (found.length > 0) throw new Error(`tracked build/local files: ${found.slice(0, 5).join(", ")}`);
  return `${tracked.length} tracked files`;
});

check("LF line endings for source files", () => {
  const offenders = [];
  for (const file of trackedFiles()) {
    if (BINARY_EXTENSIONS.some((extension) => file.endsWith(extension))) continue;
    if (!LF_EXTENSIONS.some((extension) => file.endsWith(extension))) continue;
    const buffer = fs.readFileSync(path.join(ROOT, file));
    if (buffer.includes("\r\n")) offenders.push(file);
  }
  if (offenders.length > 0) throw new Error(`CRLF in: ${offenders.slice(0, 8).join(", ")}`);
  return "checked";
});

check("no focused tests", () => {
  const offenders = trackedFiles()
    .filter((file) => file.startsWith("tests/") && file.endsWith(".test.mjs"))
    .filter((file) => /\.only\s*\(/.test(read(file)));
  if (offenders.length > 0) throw new Error(`focused tests: ${offenders.join(", ")}`);
  return "none";
});

check("no stray console.log in src (CLI output and the logger excepted)", () => {
  const allowed = new Set(["src/run-cli.ts", "src/logger.ts"]);
  const offenders = trackedFiles()
    .filter((file) => file.startsWith("src/") && file.endsWith(".ts") && !allowed.has(file))
    .filter((file) => read(file).includes("console.log("));
  if (offenders.length > 0) {
    throw new Error(`use the structured logger instead: ${offenders.join(", ")}`);
  }
  return "clean";
});

check("no obvious committed secrets", () => {
  const patterns = [
    /sk-[A-Za-z0-9]{24,}/,
    /AKIA[0-9A-Z]{16}/,
    /ghp_[A-Za-z0-9]{28,}/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
  ];
  const offenders = [];
  for (const file of trackedFiles()) {
    if (BINARY_EXTENSIONS.some((extension) => file.endsWith(extension))) continue;
    const text = read(file);
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        offenders.push(file);
        break;
      }
    }
  }
  if (offenders.length > 0) throw new Error(`possible secret in: ${offenders.join(", ")}`);
  return "none";
});

check("release artifacts are reproducible from git", () => {
  const script = read("scripts/package.mjs");
  for (const token of ["git", "archive", "sha256", "diff"]) {
    if (!script.includes(token)) throw new Error(`scripts/package.mjs does not use ${token}`);
  }
  return "package.mjs";
});

const width = Math.max(...results.map((result) => result.name.length));
let failures = 0;
for (const result of results) {
  const status = result.ok ? "PASS" : "FAIL";
  if (!result.ok) failures += 1;
  process.stdout.write(`${status}  ${result.name.padEnd(width)}  ${result.detail}\n`);
}
if (failures > 0) {
  process.stderr.write(`\n${failures} repository check(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`\n${results.length} repository checks passed\n`);
