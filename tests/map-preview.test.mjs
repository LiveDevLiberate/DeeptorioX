import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mapPreviewFile } from "../dist/map-preview.js";

test("map preview files are restricted to generated PNG ids", () => {
  assert.equal(mapPreviewFile("not-an-id"), undefined);
  assert.equal(mapPreviewFile("../etc/passwd"), undefined);
  // A valid id that has not been generated is still absent.
  assert.equal(mapPreviewFile("0123456789abcdef"), undefined);
});

test("new-run and run pages expose the map preview controls", () => {
  const index = fs.readFileSync("public/index.html", "utf8");
  const run = fs.readFileSync("public/run.html", "utf8");
  const viewer = fs.readFileSync("public/map-viewer.js", "utf8");
  assert.match(index, /id="previewMap"/);
  assert.match(index, /id="launchMapPreview"/);
  assert.match(run, /id="seedPreviewGenerate"/);
  assert.match(run, /id="seedPreviewViewer"/);
  assert.match(viewer, /createMapViewer/);
  assert.match(viewer, /FactorioPreviewToolkit/);
  const runsJs = fs.readFileSync("public/runs.js", "utf8");
  const runJs = fs.readFileSync("public/run.js", "utf8");
  assert.match(runsJs, /toolkit-viewer\/index\.html/);
  assert.match(runsJs, /toolkit-preview-frame/);
  assert.match(runJs, /toolkit-viewer\/index\.html/);
  assert.match(runJs, /toolkit-preview-frame/);
  assert.match(runsJs, /all_planets/);
  assert.match(runJs, /all_planets/);
});

test("toolkit viewer config supports multi-planet image maps", () => {
  const config = fs.readFileSync("public/toolkit-viewer/viewer_config.js", "utf8");
  assert.match(config, /_imagesRaw/);
  assert.match(config, /JSON\.parse/);
});
