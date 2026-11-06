import test from "node:test";
import assert from "node:assert/strict";
import { buildPipelineGraph } from "../dist/pipeline-graph.js";

test("pipeline graph exposes machine ports, belt segments, pipes, power and bottlenecks", () => {
  const factory = {
    problems: {
      no_power: [{ name: "assembling-machine-1", x: 10, y: 10 }],
    },
  };
  const connections = {
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
      {
        name: "transport-belt",
        x: 1,
        y: 0,
        direction: 4,
        next: { name: "transport-belt", x: 2, y: 0 },
        next_connection: "straight",
      },
      { name: "transport-belt", x: 2, y: 0, direction: 4, next: null, next_connection: "dead_end" },
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
    issues: [{ kind: "belt_no_input", name: "transport-belt", x: 0, y: 0 }],
  };
  const area = {
    entities: [
      {
        name: "assembling-machine-1",
        type: "assembling-machine",
        x: 10,
        y: 10,
        direction: 0,
        recipe: "iron-gear-wheel",
        status: "no_power",
        tile_size: { width: 3, height: 3 },
        bbox: { left: 8.5, top: 8.5, right: 11.5, bottom: 11.5 },
      },
      {
        name: "transport-belt",
        type: "transport-belt",
        x: 0,
        y: 0,
        direction: 4,
        belt_items: [{ name: "iron-ore", count: 2 }],
      },
      { name: "pipe", type: "pipe", x: 0, y: 20, direction: 0, fluid: { water: 10 } },
      { name: "pipe", type: "pipe", x: 0, y: 21, direction: 0 },
      { name: "small-electric-pole", type: "electric-pole", x: 5, y: 5, direction: 0, network_id: 1 },
      { name: "small-electric-pole", type: "electric-pole", x: 6, y: 5, direction: 0, network_id: 1 },
    ],
  };
  const graph = buildPipelineGraph(factory, connections, area, { x: 0, y: 0, radius: 40 });
  assert.equal(graph.counts.machines, 1);
  assert.equal(graph.counts.inserters, 1);
  assert.equal(graph.counts.belts, 3);
  assert.equal(graph.counts.belt_segments, 1);
  assert.equal(graph.counts.pipes, 2);
  assert.equal(graph.counts.power_poles, 2);
  assert.ok(graph.counts.edges >= 5);
  const machine = graph.machines[0];
  assert.equal(machine.recipe, "iron-gear-wheel");
  assert.equal(machine.status, "no_power");
  assert.equal(machine.tile_size.width, 3);
  assert.equal(machine.input_count, 1);
  assert.equal(machine.output_count, 0);
  assert.equal(machine.input_inserters[0], "inserter@9,10");
  assert.equal(graph.belt_segments[0].length, 3);
  assert.equal(graph.belt_segments[0].head.x, 0);
  assert.equal(graph.belt_segments[0].tail.x, 2);
  assert.ok(graph.edges.some((edge) => edge.kind === "pipe"));
  assert.ok(graph.edges.some((edge) => edge.kind === "power_network"));
  assert.equal(graph.counts.power_networks, 1);
  assert.deepEqual(graph.belts[0].items, [{ name: "iron-ore", count: 2 }]);
  assert.deepEqual(graph.pipes[0].fluid, { water: 10 });
  assert.ok(graph.bottlenecks.some((entry) => entry.kind === "no_power"));
  assert.ok(graph.bottlenecks.some((entry) => entry.kind === "belt_no_input"));
  assert.equal(graph.bottlenecks[0].severity, "critical");
});

test("empty pipeline observation is a valid empty graph", () => {
  const graph = buildPipelineGraph(
    { problems: {} },
    { machines: [], belts: [], inserters: [], issues: [] },
    { entities: [] },
    { x: 1, y: 2, radius: 3 },
  );
  assert.equal(graph.counts.nodes, 0);
  assert.equal(graph.counts.bottlenecks, 0);
  assert.deepEqual(graph.bottlenecks, []);
});
