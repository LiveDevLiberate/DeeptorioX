import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const js = fs.readFileSync(path.join(root, "public", "runs.js"), "utf8");
const styleFiles = ["tokens.css", "base.css", "recording.css", "dashboard.css", "recording-modern.css"];
const css = [
  fs.readFileSync(path.join(root, "public", "runs.css"), "utf8"),
  ...styleFiles.map((file) => fs.readFileSync(path.join(root, "public", "styles", file), "utf8")),
].join("\n");

test("launch form exposes map seed/resource configuration and submits map_gen", () => {
  for (const id of [
    "mapConfig",
    "mapSeed",
    "mapStartingArea",
    "mapPeaceful",
    "mapResources",
    "mapReset",
    "mapConfigSummary",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(js, /map_gen: buildMapGen\(\)/);
  assert.match(js, /function buildMapGen\(/);
  assert.match(js, /autoplace_controls/);
  assert.match(js, /api\("\/api\/map-config"\)/);
  assert.match(css, /\.map-config-table/);
});
