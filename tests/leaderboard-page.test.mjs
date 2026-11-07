import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("leaderboard page and API client are linked from the runs dashboard", () => {
  const html = fs.readFileSync("public/leaderboard.html", "utf8");
  const js = fs.readFileSync("public/leaderboard.js", "utf8");
  assert.ok(html.includes('src="/leaderboard.js"'));
  assert.ok(js.includes("/api/leaderboard"));
  assert.ok(fs.readFileSync("public/index.html", "utf8").includes('href="/leaderboard.html"'));
});
