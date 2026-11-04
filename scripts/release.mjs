#!/usr/bin/env node
// Release automation: `node scripts/release.mjs <major|minor|patch|X.Y.Z>`.
//
// Steps:
//   1. check the branch, clean tracked tree and that the tag does not exist
//   2. compute the next semver from package.json
//   3. update package.json and package-lock.json (root version and packages[""])
//   4. move the CHANGELOG `[Unreleased]` body into a new dated section, keep an
//      empty `[Unreleased]`, and rewrite the bottom compare links
//   5. commit `chore(release): vX.Y.Z` and create an annotated tag
//
// Flags: --dry-run (print the plan, change nothing), --no-commit (write the
// version/changelog files but skip the commit and tag), --tag-prefix <prefix>
// (default "v"), --allow-branch (allow a branch other than main/master), --help.
// Exit codes: 0 success, 1 release failure, 2 usage error.
//
// The pure helpers (nextVersion, rewriteChangelog, updateVersions,
// buildReleasePlan) are exported so tests do not need a repository or git.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_BRANCHES = ["main", "master"];
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_TAG_PREFIX = "v";

class ReleaseError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "ReleaseError";
    this.exitCode = exitCode;
  }
}

function parseVersionParts(version) {
  const match = SEMVER_PATTERN.exec(String(version ?? "").trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function formatVersionParts(parts) {
  return `${parts.major}.${parts.minor}.${parts.patch}`;
}

/** Parse `X.Y.Z` into `{ major, minor, patch }`, or return null when invalid. */
export function parseVersion(version) {
  return parseVersionParts(version);
}

/** Compare two `X.Y.Z` versions; returns -1, 0 or 1 (throws when invalid). */
export function compareVersions(left, right) {
  const a = parseVersionParts(left);
  const b = parseVersionParts(right);
  if (!a) throw new ReleaseError(`invalid version: ${JSON.stringify(left)}`);
  if (!b) throw new ReleaseError(`invalid version: ${JSON.stringify(right)}`);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return 0;
}

/**
 * Compute the next `X.Y.Z` version. `bump` is `major`, `minor`, `patch` or an
 * explicit `X.Y.Z` (a leading `v` is accepted). The result must be greater than
 * `current`; explicit downgrades are rejected.
 */
export function nextVersion(current, bump) {
  const currentParts = parseVersionParts(current);
  if (!currentParts) {
    throw new ReleaseError(`current version is not a valid X.Y.Z semver: ${JSON.stringify(current)}`);
  }
  const requested = String(bump ?? "")
    .trim()
    .replace(/^v/, "");
  let nextParts;
  if (requested === "major") nextParts = { major: currentParts.major + 1, minor: 0, patch: 0 };
  else if (requested === "minor")
    nextParts = { major: currentParts.major, minor: currentParts.minor + 1, patch: 0 };
  else if (requested === "patch") nextParts = { ...currentParts, patch: currentParts.patch + 1 };
  else {
    nextParts = parseVersionParts(requested);
    if (!nextParts) {
      throw new ReleaseError(
        `invalid release type ${JSON.stringify(bump)}: expected major, minor, patch or an explicit X.Y.Z version`,
      );
    }
  }
  const next = formatVersionParts(nextParts);
  if (compareVersions(next, formatVersionParts(currentParts)) <= 0) {
    throw new ReleaseError(
      `next version ${next} must be greater than the current version ${formatVersionParts(currentParts)}`,
    );
  }
  return next;
}

/** Today's UTC date as `YYYY-MM-DD` (kept UTC so releases are reproducible). */
export function releaseDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function compareLinkParts(url) {
  const marker = "/compare/";
  const index = url.indexOf(marker);
  if (index < 0) throw new ReleaseError(`unsupported [Unreleased] compare link: ${url}`);
  const base = url.slice(0, index);
  const range = url.slice(index + marker.length);
  const match = /^(.*)\.\.\.HEAD$/.exec(range);
  if (!match || !match[1])
    throw new ReleaseError(`[Unreleased] compare link must end with "...HEAD": ${url}`);
  return { base, previousRef: match[1] };
}

/**
 * Rewrite a Keep-a-Changelog document for a release:
 * - the `[Unreleased]` body moves under a new `## [version] - date` heading
 * - an empty `[Unreleased]` section is kept at the top
 * - `[Unreleased]` now compares `<tagPrefix><version>...HEAD`
 * - the new version link compares the previous ref to `<tagPrefix><version>`
 */
export function rewriteChangelog(text, { version, date, tagPrefix = DEFAULT_TAG_PREFIX } = {}) {
  if (typeof text !== "string" || text.length === 0) {
    throw new ReleaseError("CHANGELOG.md content is required");
  }
  if (!parseVersionParts(version)) {
    throw new ReleaseError(`invalid changelog version: ${JSON.stringify(version)}`);
  }
  if (!DATE_PATTERN.test(String(date ?? ""))) {
    throw new ReleaseError(`invalid release date (expected YYYY-MM-DD): ${JSON.stringify(date)}`);
  }
  const endsWithNewline = /\r?\n$/.test(text);
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);

  const unreleasedIndex = lines.findIndex((line) => /^##\s+\[Unreleased\]\s*$/.test(line));
  if (unreleasedIndex < 0) {
    throw new ReleaseError("CHANGELOG.md is missing a `## [Unreleased]` section");
  }
  let nextSectionIndex = -1;
  for (let index = unreleasedIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index]) || /^\[Unreleased\]:/.test(lines[index])) {
      nextSectionIndex = index;
      break;
    }
  }
  const prefix = lines.slice(0, unreleasedIndex + 1);
  const body = lines.slice(unreleasedIndex + 1, nextSectionIndex < 0 ? lines.length : nextSectionIndex);
  while (body.length > 0 && body[0].trim() === "") body.shift();
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();
  const tail = nextSectionIndex < 0 ? [] : lines.slice(nextSectionIndex);

  const linkIndex = tail.findIndex((line) => /^\[Unreleased\]:\s*\S+\s*$/.test(line));
  if (linkIndex < 0) {
    throw new ReleaseError("CHANGELOG.md is missing the bottom `[Unreleased]: <compare link>` line");
  }
  const linkMatch = /^\[Unreleased\]:\s*(\S+)\s*$/.exec(tail[linkIndex]);
  const { base, previousRef } = compareLinkParts(linkMatch[1]);
  const tag = `${tagPrefix}${version}`;
  const rewrittenTail = [
    ...tail.slice(0, linkIndex),
    `[Unreleased]: ${base}/compare/${tag}...HEAD`,
    `[${version}]: ${base}/compare/${previousRef}...${tag}`,
    ...tail.slice(linkIndex + 1),
  ];

  const output = [...prefix, "", `## [${version}] - ${date}`];
  if (body.length > 0) output.push("", ...body);
  output.push("", ...rewrittenTail);
  return `${output.join("\n")}${endsWithNewline ? "\n" : ""}`;
}

/**
 * Return the updated package.json and package-lock.json text for `version`.
 * Only the root `version` fields are bumped; dependency entries are untouched.
 */
export function updateVersions(packageText, lockText, version) {
  if (!parseVersionParts(version)) {
    throw new ReleaseError(`invalid package version: ${JSON.stringify(version)}`);
  }
  let packageJson;
  let packageLock;
  try {
    packageJson = JSON.parse(packageText);
  } catch {
    throw new ReleaseError("package.json is not valid JSON");
  }
  try {
    packageLock = JSON.parse(lockText);
  } catch {
    throw new ReleaseError("package-lock.json is not valid JSON");
  }
  packageJson.version = version;
  packageLock.version = version;
  if (packageLock.packages && packageLock.packages[""]) packageLock.packages[""].version = version;
  return {
    packageJson: `${JSON.stringify(packageJson, null, 2)}\n`,
    packageLock: `${JSON.stringify(packageLock, null, 2)}\n`,
  };
}

/** Build everything a release would write without touching the filesystem. */
export function buildReleasePlan({
  packageText,
  lockText,
  changelogText,
  bump,
  date = releaseDate(),
  tagPrefix = DEFAULT_TAG_PREFIX,
}) {
  let currentVersion;
  try {
    currentVersion = JSON.parse(packageText).version;
  } catch {
    throw new ReleaseError("package.json is not valid JSON");
  }
  const version = nextVersion(currentVersion, bump);
  const updated = updateVersions(packageText, lockText, version);
  return {
    currentVersion,
    version,
    tag: `${tagPrefix}${version}`,
    packageJson: updated.packageJson,
    packageLock: updated.packageLock,
    changelog: rewriteChangelog(changelogText, { version, date, tagPrefix }),
  };
}

/** Parse release CLI arguments. Throws `ReleaseError` with exit code 2 on usage errors. */
export function parseReleaseArgs(argv = []) {
  const options = {
    bump: null,
    dryRun: false,
    noCommit: false,
    allowBranch: false,
    tagPrefix: DEFAULT_TAG_PREFIX,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run") options.dryRun = true;
    else if (token === "--no-commit") options.noCommit = true;
    else if (token === "--allow-branch") options.allowBranch = true;
    else if (token === "--help" || token === "-h") options.help = true;
    else if (token === "--tag-prefix") {
      const value = argv[index + 1];
      if (value === undefined) throw new ReleaseError("--tag-prefix requires a value", 2);
      options.tagPrefix = value;
      index += 1;
    } else if (token.startsWith("--tag-prefix=")) {
      options.tagPrefix = token.slice("--tag-prefix=".length);
    } else if (token.startsWith("-")) {
      throw new ReleaseError(`unknown option: ${token}`, 2);
    } else if (options.bump === null) {
      options.bump = token;
    } else {
      throw new ReleaseError(`unexpected argument: ${token}`, 2);
    }
  }
  return options;
}

const USAGE = `Usage: node scripts/release.mjs <major|minor|patch|X.Y.Z> [options]

Options:
  --dry-run            print the release plan and change nothing
  --no-commit          update package.json, package-lock.json and CHANGELOG.md
                       but skip the git commit and annotated tag
  --tag-prefix <text>  tag prefix (default "v")
  --allow-branch       allow releasing from a branch other than main/master
  --help               show this help
`;

/** Create the default git runner for `root`; throws on non-zero exit. */
export function createGit(root = ROOT) {
  return (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
}

/**
 * Run the release CLI. Returns `{ code, plan, dryRun, committed }`. Read-only
 * with `--dry-run`; injectable `git`/`readFile`/`writeFile`/`now`/`log` keep it
 * unit-testable without a repository.
 */
export function runRelease(
  argv = [],
  {
    root = ROOT,
    git = createGit(root),
    now = new Date(),
    log = console.log,
    readFile = (file) => fs.readFileSync(file, "utf8"),
    writeFile = (file, content) => fs.writeFileSync(file, content),
  } = {},
) {
  const options = parseReleaseArgs(argv);
  if (options.help) {
    log(USAGE);
    return { code: 0, help: true };
  }
  if (!options.bump) {
    throw new ReleaseError(
      `missing release type: major, minor, patch or an explicit X.Y.Z version\n\n${USAGE}`,
      2,
    );
  }

  const branch = String(git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (!branch || branch === "HEAD") {
    throw new ReleaseError("cannot release from a detached HEAD - switch to main or master");
  }
  if (!options.allowBranch && !RELEASE_BRANCHES.includes(branch)) {
    throw new ReleaseError(
      `refusing to release from branch '${branch}': switch to main/master or pass --allow-branch`,
    );
  }
  const dirty = String(git(["status", "--porcelain", "--untracked-files=no"])).trim();
  if (dirty) {
    throw new ReleaseError(
      "working tree has uncommitted tracked changes - commit or stash them before releasing",
    );
  }

  const packagePath = path.join(root, "package.json");
  const lockPath = path.join(root, "package-lock.json");
  const changelogPath = path.join(root, "CHANGELOG.md");
  const plan = buildReleasePlan({
    packageText: readFile(packagePath),
    lockText: readFile(lockPath),
    changelogText: readFile(changelogPath),
    bump: options.bump,
    date: releaseDate(now),
    tagPrefix: options.tagPrefix,
  });

  let tagExists = false;
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/tags/${plan.tag}`]);
    tagExists = true;
  } catch {
    tagExists = false;
  }
  if (tagExists) throw new ReleaseError(`tag ${plan.tag} already exists - pick another version`);

  if (options.dryRun) {
    log(`release: ${plan.currentVersion} -> ${plan.version} (${options.bump})`);
    log(`release: would update package.json, package-lock.json, CHANGELOG.md`);
    if (options.noCommit) {
      log("release: would skip the commit and annotated tag (--no-commit)");
    } else {
      log(`release: would commit "chore(release): ${plan.tag}"`);
      log(`release: would create annotated tag ${plan.tag}`);
    }
    log("release: dry-run - no files were changed");
    return { code: 0, plan, dryRun: true, committed: false };
  }

  writeFile(packagePath, plan.packageJson);
  writeFile(lockPath, plan.packageLock);
  writeFile(changelogPath, plan.changelog);
  log(`release: updated package.json, package-lock.json and CHANGELOG.md to ${plan.version}`);

  if (options.noCommit) {
    log("release: skipped the commit and annotated tag (--no-commit)");
    return { code: 0, plan, dryRun: false, committed: false };
  }

  git(["add", "package.json", "package-lock.json", "CHANGELOG.md"]);
  git(["commit", "-m", `chore(release): ${plan.tag}`]);
  git(["tag", "-a", plan.tag, "-m", plan.tag]);
  log(`release: committed "chore(release): ${plan.tag}"`);
  log(`release: created annotated tag ${plan.tag}`);
  return { code: 0, plan, dryRun: false, committed: true };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = runRelease(process.argv.slice(2));
    process.exitCode = result.code ?? 0;
  } catch (error) {
    console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof ReleaseError ? error.exitCode : 1;
  }
}
