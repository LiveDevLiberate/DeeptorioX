import test from "node:test";
import assert from "node:assert/strict";
import { buildPipelineGraph } from "../dist/pipeline-graph.js";
import { agentConnectionsCommand } from "../dist/command-builders.js";

function fixtureGraph() {
  return buildPipelineGraph(
    { problems: { no_power: [{ name: "assembling-machine-1", x: 10, y: 10 }] } },
    {
      machines: [{ name: "assembling-machine-1", x: 10, y: 10, inserters: 1 }],
      belts: [
        {
          name: "transport-belt",
          x: 0,
          y: 0,
          direction: 4,
          next: { name: "transport-belt", x: 1, y: 0 },
          next_connection: "straight",
        },
        { name: "transport-belt", x: 1, y: 0, direction: 4, next: null, next_connection: "dead_end" },
      ],
      inserters: [
        {
          name: "inserter",
          x: 9,
          y: 10,
          direction: 4,
          source: { name: "transport-belt", type: "transport-belt", x: 8, y: 10 },
          target: { name: "assembling-machine-1", type: "assembling-machine", x: 10, y: 10 },
        },
      ],
      issues: [
        { kind: "belt_no_input", name: "transport-belt", x: 0, y: 0 },
        { kind: "belt_dead_end", name: "transport-belt", x: 1, y: 0 },
      ],
    },
    {
      entities: [
        {
          name: "assembling-machine-1",
          type: "assembling-machine",
          x: 10,
          y: 10,
          status: "no_power",
          recipe: "iron-gear-wheel",
          tile_size: { width: 3, height: 3 },
        },
      ],
    },
    { x: 0, y: 0, radius: 20 },
  );
}

test("spatial eval: pipeline graph finds ports, broken belt and bottlenecks", () => {
  const graph = fixtureGraph();
  assert.equal(graph.counts.machines, 1);
  assert.equal(graph.machines[0].input_count, 1);
  assert.equal(graph.machines[0].recipe, "iron-gear-wheel");
  assert.ok(graph.bottlenecks.some((entry) => entry.kind === "belt_no_input"));
  assert.ok(graph.bottlenecks.some((entry) => entry.kind === "belt_dead_end"));
  assert.ok(graph.bottlenecks.some((entry) => entry.kind === "no_power"));
  assert.equal(graph.belt_segments[0].length, 2);
});

test("spatial eval: inserter observation uses pickup-side direction semantics", () => {
  const lua = agentConnectionsCommand({ x: 0, y: 0, radius: 1 });
  assert.ok(lua.includes("source=summary(entity_at(tx+dx,ty+dy))"));
  assert.ok(lua.includes("target=summary(entity_at(tx-dx,ty-dy))"));
});
