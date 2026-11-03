import { spawnSync } from "node:child_process";

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error("Usage: node scripts/run-python-script.mjs <script.py> [args...]");
  process.exit(2);
}

const candidates =
  process.platform === "win32"
    ? [
        ["py", ["-3"]],
        ["python", []],
        ["python3", []],
      ]
    : [
        ["python3", []],
        ["python", []],
      ];

for (const [command, prefix] of candidates) {
  const probe = spawnSync(command, [...prefix, "--version"], { stdio: "ignore" });
  if (probe.status !== 0) continue;
  const result = spawnSync(command, [...prefix, script, ...args], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

console.error("Python 3 is required.");
process.exit(1);
