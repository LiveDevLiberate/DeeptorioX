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

  const passthrough = spawnSync(
    process.env.PYTHON || "python3",
    ["factorio.py", "blueprint-tools", "info", "public/blueprint-viewer/sample.txt"],
    { encoding: "utf8" },
  );
  assert.equal(passthrough.status, 0, passthrough.stderr);
  assert.match(passthrough.stdout, /entities 477/);

  const toolkitInfo = spawnSync(process.env.PYTHON || "python3", ["tools/preview_toolkit_cli.py", "--info"], {
    encoding: "utf8",
  });
  assert.equal(toolkitInfo.status, 0, toolkitInfo.stderr);
  const info = JSON.parse(toolkitInfo.stdout);
  assert.match(info.vendor, /factorio-preview-toolkit/);
  assert.equal(info.config_exists, true);
  assert.equal(info.rclone_binaries_vendored, false);

  const config = spawnSync(
    process.env.PYTHON || "python3",
    ["tools/preview_toolkit_cli.py", "--config", "--json"],
    { encoding: "utf8" },
  );
  assert.equal(config.status, 0, config.stderr);
  assert.match(config.stdout, /map_preview_size/);
  const mapView = fs.readFileSync("public/toolkit-viewer/js/mapView.js", "utf8");
  assert.match(mapView, /defaultZoomScale = 0\.5/);
  assert.match(mapView, /defaultZoomScale \* Math\.pow/);
  assert.match(fs.readFileSync("public/toolkit-viewer/index.html", "utf8"), /Zoom: 50%/);
});
