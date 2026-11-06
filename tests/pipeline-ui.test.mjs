import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("pipeline UI loads the agent graph and is linked from the dashboards", () => {
  const html = fs.readFileSync("public/pipeline.html", "utf8");
  const js = fs.readFileSync("public/pipeline.js", "utf8");
  assert.ok(html.includes('id="pipelineForm"'));
  assert.ok(html.includes('src="/pipeline.js"'));
  assert.ok(js.includes('"/api/agent/observe/pipeline"'));
  assert.ok(js.includes("bottlenecks"));
  assert.ok(js.includes("power_network_groups"));
  assert.ok(fs.readFileSync("public/index.html", "utf8").includes('href="/pipeline.html"'));
  assert.ok(fs.readFileSync("public/run.html", "utf8").includes('href="/pipeline.html"'));
});
