import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("ported blueprint viewer assets and registry loader are wired", () => {
  for (const name of [
    "viewer.html",
    "viewer.css",
    "viewer.js",
    "flow.js",
    "gamedata.js",
    "icons.js",
    "autorio-load.js",
  ]) {
    assert.ok(fs.statSync(`public/blueprint-viewer/${name}`).size > 0, `${name} missing`);
  }
  const html = fs.readFileSync("public/blueprint-viewer/viewer.html", "utf8");
  assert.match(html, /viewer\.js/);
  assert.match(html, /autorio-load\.js/);
  assert.match(html, /\/api\/blueprint-icons\.js/);
  const loader = fs.readFileSync("public/blueprint-viewer/autorio-load.js", "utf8");
  assert.match(loader, /\/api\/runs\/.*blueprints/);
  assert.match(loader, /FBPViewerLoad/);
  const runJs = fs.readFileSync("public/run.js", "utf8");
  assert.match(runJs, /blueprint-viewer\/viewer\.html/);
  assert.match(fs.readFileSync("public/blueprint-viewer/NOTICE.md", "utf8"), /factorio-blueprint-tools/);
});
