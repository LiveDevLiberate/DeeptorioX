#!/usr/bin/env node
// Reproducible release packaging: `npm run package`.
//
// Writes the cumulative patch (base..HEAD) and a source zip built by
// `git archive` (so only tracked files are shipped) plus sha256 checksums.
// Defaults match the historical artifacts so existing workflows keep working.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE = "9e4e677"; // last pre-adaptation upstream checkpoint
const DEFAULT_NAME = "autorio-windows";

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function resolveBase(requested) {
  const candidate = requested || DEFAULT_BASE;
  try {
    git(["rev-parse", "--verify", `${candidate}^{commit}`]);
    return candidate;
  } catch {
    return git(["rev-list", "--max-parents=0", "HEAD"]).trim();
  }
}

function main() {
  const name = option("name", DEFAULT_NAME);
  const outDir = path.resolve(ROOT, option("out", ".."));
  const base = resolveBase(option("base", process.env.AUTORIO_PACKAGE_BASE));
  const prefix = option("prefix", "autorio/");
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

  if (git(["status", "--porcelain"]).trim() && !hasFlag("allow-dirty")) {
    throw new Error("working tree is dirty; commit first or pass --allow-dirty");
  }
  git(["rev-parse", "--verify", `${base}^{commit}`]);
  const head = git(["rev-parse", "HEAD"]).trim();
  const tracked = git(["ls-files"]).trim().split("\n").filter(Boolean);

  fs.mkdirSync(outDir, { recursive: true });
  const patchFile = path.join(outDir, `${name}.patch`);
  const zipFile = path.join(outDir, `${name}.zip`);
  fs.writeFileSync(patchFile, git(["diff", base, "HEAD"]));
  git(["archive", "--format=zip", `--prefix=${prefix}`, "-o", zipFile, "HEAD"]);

  const artifacts = [patchFile, zipFile].map((file) => ({
    file,
    bytes: fs.statSync(file).size,
    sha256: sha256(file),
  }));
  const checksumFile = path.join(outDir, `${name}.sha256`);
  fs.writeFileSync(
    checksumFile,
    artifacts.map((artifact) => `${artifact.sha256}  ${path.basename(artifact.file)}`).join("\n") + "\n",
  );

  console.log(`version  ${version}`);
  console.log(`head     ${head}`);
  console.log(`base     ${base}`);
  console.log(`tracked  ${tracked.length} files`);
  for (const artifact of artifacts) {
    console.log(
      `${path.basename(artifact.file).padEnd(name.length + 8)} ${String(artifact.bytes).padStart(9)} bytes  ${artifact.sha256}`,
    );
  }
  console.log(`checksum ${checksumFile}`);
}

try {
  main();
} catch (error) {
  console.error(`package: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
