import test from "node:test";
import assert from "node:assert/strict";

import { mapOverviewSvg } from "../dist/map-overview.js";

test("renders map overview rows as compact same-color SVG runs", () => {
  const svg = mapOverviewSvg({
    width: 4,
    height: 2,
    rows: ["?~~.", "##@."],
    step: 2,
  });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 4 2"/);
  // One water run, one land run, one entity run, one player tile and one land run.
  assert.equal((svg.match(/<rect /g) || []).length, 6);
  assert.match(svg, /fill="#2e698a"/);
  assert.match(svg, /fill="#c7a35a"/);
  assert.match(svg, /fill="#e8664f"/);
  assert.doesNotMatch(svg, />undefined</);
});

test("uses row length when width is absent and tolerates empty rows", () => {
  const svg = mapOverviewSvg({ rows: ["..", ".."] });
  assert.match(svg, /viewBox="0 0 2 2"/);
  const empty = mapOverviewSvg({ rows: [] });
  assert.match(empty, /<svg[^>]*viewBox="0 0 1 1"/);
});
