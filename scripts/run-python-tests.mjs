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

for (const [command, prefix] of candidates) {
  const probe = spawnSync(command, [...prefix, "--version"], { stdio: "ignore" });
  if (probe.status !== 0) continue;
  const result = spawnSync(command, [...prefix, "-m", "unittest", "discover", "-s", "tests", "-v"], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

console.error("Python 3 is required for the factorio.py client tests.");
process.exit(1);
