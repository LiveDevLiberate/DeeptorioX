import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

test("both MIT toolkits are fully vendored with licenses and entrypoints", () => {
  for (const path of [
    "vendor/factorio-preview-toolkit/LICENSE",
    "vendor/factorio-preview-toolkit/src/FactorioPreviewToolkit/controller/controller.py",
    "vendor/factorio-preview-toolkit/viewer/index.html",
    "vendor/factorio-preview-toolkit/assets/sounds/vibraphone-14.ogg",
    "vendor/factorio-blueprint-tools/LICENSE",
    "vendor/factorio-blueprint-tools/fbp/cli.py",
    "vendor/factorio-blueprint-tools/fbp/flow.py",
    "vendor/factorio-blueprint-tools/vscode/media/viewer.js",
    "tools/fbp_cli.py",
    "tools/preview_toolkit_cli.py",
    "public/toolkit-viewer/index.html",
    "public/toolkit-viewer/viewer_config.js",
  ]) {
    assert.ok(fs.statSync(path).size > 0, `${path} missing`);
  }
  const result = spawnSync(
    process.env.PYTHON || "python3",
    ["tools/fbp_cli.py", "info", "public/blueprint-viewer/sample.txt", "--counts"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /entities 477/);
  assert.match(result.stdout, /transport-belt/);
});
