import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReleasePlan,
  compareVersions,
  nextVersion,
  parseReleaseArgs,
  parseVersion,
  releaseDate,
  rewriteChangelog,
  runRelease,
  updateVersions,
} from "../scripts/release.mjs";

const PACKAGE = `${JSON.stringify(
  {
    name: "factorio-manager",
    version: "1.2.3",
    private: true,
    scripts: { build: "tsc" },
    devDependencies: { typescript: "^5.7.3" },
  },
  null,
  2,
)}\n`;

const LOCK = `${JSON.stringify(
  {
    name: "factorio-manager",
    version: "1.2.3",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "factorio-manager", version: "1.2.3", devDependencies: { typescript: "^5.7.3" } },
      "node_modules/typescript": { version: "5.7.3", dev: true },
    },
  },
  null,
  2,
)}\n`;

const CHANGELOG = `# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added

- Coverage threshold gate.

### Fixed

- A bug that should be released.

[Unreleased]: https://github.com/example/repo/compare/abc1234...HEAD
`;

const FIXED_NOW = new Date("2026-11-04T12:00:00Z");

function createTempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-release-"));
  fs.writeFileSync(path.join(dir, "package.json"), PACKAGE);
  fs.writeFileSync(path.join(dir, "package-lock.json"), LOCK);
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), CHANGELOG);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createFakeGit({ branch = "main", status = "", tagExists = false } = {}) {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return `${branch}\n`;
    if (args[0] === "status") return status;
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      if (tagExists) return `${args[args.length - 1]}\n`;
      throw new Error("fatal: Needed a single revision");
    }
    return "";
  };
  return { git, calls };
}

function readRepository(dir) {
  return {
    packageJson: fs.readFileSync(path.join(dir, "package.json"), "utf8"),
    packageLock: fs.readFileSync(path.join(dir, "package-lock.json"), "utf8"),
    changelog: fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"),
  };
}

test("parseVersion and compareVersions validate and order X.Y.Z semver", () => {
  assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3 });
  assert.equal(parseVersion("v1.2.3"), null);
  assert.equal(parseVersion("1.2"), null);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
  assert.throws(() => compareVersions("1.2.3", "nope"), /invalid version/);
});

test("nextVersion bumps patch/minor/major and accepts explicit versions", () => {
  assert.equal(nextVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(nextVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(nextVersion("1.2.3", "major"), "2.0.0");
  assert.equal(nextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(nextVersion("1.2.3", "2.5.0"), "2.5.0");
  assert.equal(nextVersion("1.2.3", "v2.5.0"), "2.5.0");
});

test("nextVersion rejects invalid bumps and non-increasing versions", () => {
  assert.throws(() => nextVersion("1.2.3", "banana"), /invalid release type/);
  assert.throws(() => nextVersion("1.2.3", "1.2.3"), /must be greater than the current version/);
  assert.throws(() => nextVersion("1.2.3", "1.0.0"), /must be greater than the current version/);
  assert.throws(() => nextVersion("not-a-version", "patch"), /current version is not a valid/);
});

test("releaseDate formats a UTC YYYY-MM-DD date", () => {
  assert.equal(releaseDate(FIXED_NOW), "2026-11-04");
});

test("rewriteChangelog moves the Unreleased body into a dated version section", () => {
  const updated = rewriteChangelog(CHANGELOG, { version: "1.2.4", date: "2026-11-04" });

  // The Unreleased section is kept but emptied, and the body moved below the
  // new version heading (newest release first).
  assert.match(updated, /## \[Unreleased\]\n\n## \[1\.2\.4\] - 2026-11-04\n/);
  const unreleasedBody = updated.split("## [Unreleased]")[1].split("## [1.2.4]")[0];
  assert.equal(unreleasedBody.trim(), "");
  assert.ok(updated.includes("## [1.2.4] - 2026-11-04\n\n### Added\n\n- Coverage threshold gate."));
  assert.ok(updated.indexOf("### Fixed") < updated.indexOf("[Unreleased]:"));

  // Bottom compare links: Unreleased compares the new tag to HEAD, the new
  // version link compares the previous ref to the new tag.
  assert.ok(updated.includes("[Unreleased]: https://github.com/example/repo/compare/v1.2.4...HEAD"));
  assert.ok(updated.includes("[1.2.4]: https://github.com/example/repo/compare/abc1234...v1.2.4"));
  assert.ok(updated.endsWith("\n"));
});

test("rewriteChangelog chains compare links across consecutive releases", () => {
  const first = rewriteChangelog(CHANGELOG, { version: "1.2.4", date: "2026-11-04" });
  const second = rewriteChangelog(first, { version: "1.3.0", date: "2026-12-01" });
  assert.ok(second.includes("[Unreleased]: https://github.com/example/repo/compare/v1.3.0...HEAD"));
  assert.ok(second.includes("[1.3.0]: https://github.com/example/repo/compare/v1.2.4...v1.3.0"));
  // The older release section and link are retained.
  assert.ok(second.includes("## [1.2.4] - 2026-11-04"));
  assert.ok(second.includes("[1.2.4]: https://github.com/example/repo/compare/abc1234...v1.2.4"));
});

test("rewriteChangelog supports an empty tag prefix and an empty Unreleased body", () => {
  const noPrefix = rewriteChangelog(CHANGELOG, { version: "2.0.0", date: "2027-01-01", tagPrefix: "" });
  assert.ok(noPrefix.includes("compare/2.0.0...HEAD"));
  assert.ok(noPrefix.includes("[2.0.0]: https://github.com/example/repo/compare/abc1234...2.0.0"));

  const emptyBody = rewriteChangelog(
    "## [Unreleased]\n\n[Unreleased]: https://example.test/x/compare/abc...HEAD\n",
    {
      version: "1.0.0",
      date: "2027-01-01",
    },
  );
  assert.match(emptyBody, /## \[Unreleased\]\n\n## \[1\.0\.0\] - 2027-01-01\n\n\[Unreleased\]:/);
});

test("rewriteChangelog rejects malformed changelogs", () => {
  const options = { version: "1.2.4", date: "2026-11-04" };
  assert.throws(() => rewriteChangelog("# Changelog\n", options), /missing a `## \[Unreleased\]`/);
  assert.throws(
    () => rewriteChangelog("## [Unreleased]\n\n- change\n", options),
    /missing the bottom `\[Unreleased\]: <compare link>`/,
  );
  assert.throws(
    () => rewriteChangelog(CHANGELOG, { version: "x", date: "2026-11-04" }),
    /invalid changelog version/,
  );
  assert.throws(
    () => rewriteChangelog(CHANGELOG, { version: "1.2.4", date: "04.11.2026" }),
    /invalid release date/,
  );
  const brokenLink = CHANGELOG.replace("abc1234...HEAD", "abc1234");
  assert.throws(() => rewriteChangelog(brokenLink, options), /must end with/);
});

test("updateVersions bumps only the root package and lockfile versions", () => {
  const updated = updateVersions(PACKAGE, LOCK, "2.3.4");
  const packageJson = JSON.parse(updated.packageJson);
  assert.equal(packageJson.version, "2.3.4");
  assert.deepEqual(packageJson.scripts, { build: "tsc" });
  assert.deepEqual(packageJson.devDependencies, { typescript: "^5.7.3" });

  const packageLock = JSON.parse(updated.packageLock);
  assert.equal(packageLock.version, "2.3.4");
  assert.equal(packageLock.packages[""].version, "2.3.4");
  assert.equal(packageLock.packages["node_modules/typescript"].version, "5.7.3");
  assert.ok(updated.packageJson.endsWith("\n"));
  assert.ok(updated.packageLock.endsWith("\n"));
  // Stable formatting (2-space JSON) keeps Prettier happy.
  assert.equal(updated.packageJson, `${JSON.stringify(packageJson, null, 2)}\n`);
});

test("buildReleasePlan combines versions, tag and changelog without writing", () => {
  const plan = buildReleasePlan({
    packageText: PACKAGE,
    lockText: LOCK,
    changelogText: CHANGELOG,
    bump: "minor",
    date: "2026-11-04",
  });
  assert.equal(plan.currentVersion, "1.2.3");
  assert.equal(plan.version, "1.3.0");
  assert.equal(plan.tag, "v1.3.0");
  assert.equal(JSON.parse(plan.packageJson).version, "1.3.0");
  assert.equal(JSON.parse(plan.packageLock).version, "1.3.0");
  assert.ok(plan.changelog.includes("## [1.3.0] - 2026-11-04"));
  assert.throws(
    () => buildReleasePlan({ packageText: "{}", lockText: LOCK, changelogText: CHANGELOG, bump: "patch" }),
    /current version is not a valid/,
  );
});

test("parseReleaseArgs handles flags and rejects usage errors", () => {
  assert.deepEqual(parseReleaseArgs(["patch"]), {
    bump: "patch",
    dryRun: false,
    noCommit: false,
    allowBranch: false,
    tagPrefix: "v",
    help: false,
  });
  assert.deepEqual(parseReleaseArgs(["2.0.0", "--dry-run", "--no-commit", "--allow-branch"]), {
    bump: "2.0.0",
    dryRun: true,
    noCommit: true,
    allowBranch: true,
    tagPrefix: "v",
    help: false,
  });
  assert.equal(parseReleaseArgs(["patch", "--tag-prefix", "release-"]).tagPrefix, "release-");
  assert.equal(parseReleaseArgs(["patch", "--tag-prefix="]).tagPrefix, "");
  assert.throws(() => parseReleaseArgs(["patch", "--nope"]), /unknown option/);
  assert.throws(() => parseReleaseArgs(["--tag-prefix"]), /--tag-prefix requires a value/);
  assert.throws(() => parseReleaseArgs(["patch", "minor"]), /unexpected argument/);
});

test("runRelease --dry-run prints the plan and changes no files", (t) => {
  const dir = createTempRepo(t);
  const { git, calls } = createFakeGit();
  const lines = [];
  const result = runRelease(["patch", "--dry-run"], {
    root: dir,
    git,
    now: FIXED_NOW,
    log: (line) => lines.push(line),
    writeFile: () => {
      throw new Error("dry-run must not write files");
    },
  });

  assert.equal(result.code, 0);
  assert.equal(result.dryRun, true);
  assert.equal(result.committed, false);
  assert.equal(result.plan.version, "1.2.4");
  assert.deepEqual(readRepository(dir), {
    packageJson: PACKAGE,
    packageLock: LOCK,
    changelog: CHANGELOG,
  });
  assert.ok(lines.some((line) => line.includes("1.2.3 -> 1.2.4")));
  assert.ok(lines.some((line) => line.includes("chore(release): v1.2.4")));
  assert.ok(lines.some((line) => line.includes("dry-run - no files were changed")));
  // Only read-only git commands are allowed during a dry run.
  const mutations = calls.filter((args) => ["add", "commit", "tag"].includes(args[0]));
  assert.deepEqual(mutations, []);
});

test("runRelease --no-commit writes files but skips the commit and tag", (t) => {
  const dir = createTempRepo(t);
  const { git, calls } = createFakeGit();
  const result = runRelease(["minor", "--no-commit", "--tag-prefix", "release-"], {
    root: dir,
    git,
    now: FIXED_NOW,
    log: () => {},
  });

  assert.equal(result.code, 0);
  assert.equal(result.committed, false);
  assert.equal(result.plan.tag, "release-1.3.0");
  const files = readRepository(dir);
  assert.equal(JSON.parse(files.packageJson).version, "1.3.0");
  assert.equal(JSON.parse(files.packageLock).version, "1.3.0");
  assert.ok(files.changelog.includes("## [1.3.0] - 2026-11-04"));
  assert.ok(files.changelog.includes("compare/release-1.3.0...HEAD"));
  assert.deepEqual(
    calls.filter((args) => ["add", "commit", "tag"].includes(args[0])),
    [],
  );
});

test("runRelease commits the release files and creates an annotated tag", (t) => {
  const dir = createTempRepo(t);
  const { git, calls } = createFakeGit();
  const result = runRelease(["patch"], { root: dir, git, now: FIXED_NOW, log: () => {} });

  assert.equal(result.code, 0);
  assert.equal(result.committed, true);
  const mutations = calls.filter((args) => ["add", "commit", "tag"].includes(args[0]));
  assert.deepEqual(mutations, [
    ["add", "package.json", "package-lock.json", "CHANGELOG.md"],
    ["commit", "-m", "chore(release): v1.2.4"],
    ["tag", "-a", "v1.2.4", "-m", "v1.2.4"],
  ]);
  assert.equal(JSON.parse(readRepository(dir).packageJson).version, "1.2.4");
});

test("runRelease refuses dirty trees, protected branches and duplicate tags", (t) => {
  const dir = createTempRepo(t);
  const base = { root: dir, now: FIXED_NOW, log: () => {} };

  const dirty = createFakeGit({ status: " M package.json\n" });
  assert.throws(() => runRelease(["patch", "--dry-run"], { ...base, git: dirty.git }), /uncommitted tracked/);

  const feature = createFakeGit({ branch: "feature/builders" });
  assert.throws(
    () => runRelease(["patch", "--dry-run"], { ...base, git: feature.git }),
    /refusing to release/,
  );
  assert.equal(runRelease(["patch", "--dry-run", "--allow-branch"], { ...base, git: feature.git }).code, 0);

  const detached = createFakeGit({ branch: "HEAD" });
  assert.throws(() => runRelease(["patch", "--dry-run"], { ...base, git: detached.git }), /detached HEAD/);

  const duplicate = createFakeGit({ tagExists: true });
  assert.throws(() => runRelease(["patch", "--dry-run"], { ...base, git: duplicate.git }), /already exists/);
});

test("runRelease reports missing release type as a usage error and --help as success", (t) => {
  const dir = createTempRepo(t);
  const { git } = createFakeGit();
  assert.throws(
    () => runRelease([], { root: dir, git, log: () => {} }),
    (error) => error.exitCode === 2 && /missing release type/.test(error.message),
  );
  const lines = [];
  const result = runRelease(["--help"], { root: dir, git, log: (line) => lines.push(line) });
  assert.equal(result.code, 0);
  assert.equal(result.help, true);
  assert.ok(lines.join("\n").includes("--dry-run"));
});
