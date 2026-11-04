import { spawnSync } from "node:child_process";

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
const args = ["scripts/generate-tool-manifest.py", ...process.argv.slice(2)];
for (const [command, prefix] of candidates) {
  const probe = spawnSync(command, [...prefix, "--version"], { stdio: "ignore" });
  if (probe.status !== 0) continue;
  const result = spawnSync(command, [...prefix, ...args], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
console.error("Python 3 is required to generate the tool manifest.");
process.exit(1);
