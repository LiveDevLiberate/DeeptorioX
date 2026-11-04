#!/usr/bin/env node
// Install the repository's fast git hooks: `node scripts/install-hooks.mjs`.
//
// Points git at the versioned `.githooks/` directory (`core.hooksPath`) and
// makes sure the hook files are executable. The pre-commit hook only runs the
// cheap checks (check:repo, format:check, typecheck); the full gate lives in
// `npm run verify` and CI.
//
// Usage:
//   node scripts/install-hooks.mjs         install / reinstall (idempotent)
//   node scripts/install-hooks.mjs --check verify the hook is installed
//   node scripts/install-hooks.mjs --help  show this help
//
// Exit codes: 0 installed/already installed, 1 `--check` found it missing.
// When git (or the repository) is unavailable the installer warns and exits 0
// so source archives and non-git checkouts never fail their setup.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_DIR = ".githooks";
const HOOK_NAMES = ["pre-commit"];
const USAGE = `Usage: node scripts/install-hooks.mjs [--check]

Installs autorio's versioned git hooks by setting:
  git config core.hooksPath ${HOOKS_DIR}

Options:
  --check   verify the hooks are installed instead of installing them
  --help    show this help
`;

class GitUnavailableError extends Error {}

function runGit(args, root = ROOT) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new GitUnavailableError("git executable not found");
    }
    if (error && (error.code === 128 || error.status === 128)) {
      throw new GitUnavailableError(String(error.stderr || error.message).trim());
    }
    throw error;
  }
}

export function hookPath(root = ROOT, name = HOOK_NAMES[0]) {
  return path.join(root, HOOKS_DIR, name);
}

export function currentHooksPath(root = ROOT) {
  try {
    return runGit(["config", "--get", "core.hooksPath"], root);
  } catch (error) {
    if (error instanceof GitUnavailableError) throw error;
    return "";
  }
}

/** True when core.hooksPath points at .githooks and every hook file exists. */
export function hooksInstalled(root = ROOT) {
  let configured;
  try {
    configured = currentHooksPath(root);
  } catch (error) {
    if (error instanceof GitUnavailableError) return false;
    throw error;
  }
  const normalized = configured.replace(/[\\/]+$/, "");
  return normalized === HOOKS_DIR && HOOK_NAMES.every((name) => fs.existsSync(hookPath(root, name)));
}

function makeExecutable(root) {
  for (const name of HOOK_NAMES) {
    try {
      fs.chmodSync(hookPath(root, name), 0o755);
    } catch {
      // Windows file systems may not support the executable bit; git runs
      // hooks through sh there anyway.
    }
  }
}

/**
 * Install (or reinstall) the hooks. Idempotent: returns `{ changed: false }`
 * when core.hooksPath already points at .githooks. Throws GitUnavailableError
 * when git or the repository is missing.
 */
export function installHooks({ root = ROOT, log = console.log } = {}) {
  if (!fs.existsSync(hookPath(root))) {
    throw new Error(`missing hook file ${path.join(HOOKS_DIR, HOOK_NAMES[0])}`);
  }
  const wasInstalled = hooksInstalled(root);
  makeExecutable(root);
  runGit(["config", "core.hooksPath", HOOKS_DIR], root);
  const configured = currentHooksPath(root);
  if (configured.replace(/[\\/]+$/, "") !== HOOKS_DIR) {
    throw new Error(`failed to set core.hooksPath (got ${JSON.stringify(configured)})`);
  }
  log(
    wasInstalled
      ? `hooks: already installed (git config core.hooksPath = ${HOOKS_DIR}); hook files verified`
      : `hooks: installed - git config core.hooksPath = ${HOOKS_DIR}`,
  );
  log(`hooks: ${HOOK_NAMES.map((name) => path.join(HOOKS_DIR, name)).join(", ")} will run on commit`);
  log("hooks: bypass a commit with AUTORIO_SKIP_HOOKS=1");
  return { changed: !wasInstalled, hooksPath: HOOKS_DIR };
}

function checkHooks({ root = ROOT, log = console.log } = {}) {
  const configured = currentHooksPath(root);
  if (configured.replace(/[\\/]+$/, "") !== HOOKS_DIR) {
    throw new Error(
      `hooks are not installed (core.hooksPath = ${configured || "<unset>"}); run: node scripts/install-hooks.mjs`,
    );
  }
  for (const name of HOOK_NAMES) {
    if (!fs.existsSync(hookPath(root, name))) {
      throw new Error(`missing hook file ${path.join(HOOKS_DIR, name)}`);
    }
  }
  log(`hooks: installed and verified (git config core.hooksPath = ${HOOKS_DIR})`);
  return 0;
}

function warnAndSucceed(message, log = console.warn) {
  log(`hooks: ${message} - skipping hook installation`);
  return 0;
}

function main(argv = process.argv.slice(2), { root = ROOT, log = console.log, warn = console.warn } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    log(USAGE);
    return 0;
  }
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    warn(`hooks: unknown argument(s): ${unknown.join(" ")}\n\n${USAGE}`);
    return 2;
  }
  const check = argv.includes("--check");
  try {
    runGit(["rev-parse", "--is-inside-work-tree"], root);
    return check ? checkHooks({ root, log }) : (installHooks({ root, log }), 0);
  } catch (error) {
    if (error instanceof GitUnavailableError) {
      return warnAndSucceed(`${error.message || "git not available"} (or not a git checkout)`, warn);
    }
    throw error;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`hooks: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
