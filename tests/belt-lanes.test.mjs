import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { summarizeBeltLanesData } from "../dist/belt-lanes.js";
import { registerAgentRoutes } from "../dist/api/agent.js";
import { Router } from "../dist/http/router.js";

// Belt lane observation: raw Lua scan -> left/right lane summary (saturation,
// balance, lane mix, side-load feeders) plus the HTTP route wiring.

function belt(overrides) {
  return {
    name: "transport-belt",
    type: "transport-belt",
    x: 0,
    y: 20,
    direction: 4,
    left: { index: 1, items: [] },
    right: { index: 2, items: [] },
    inputs: {},
    ...overrides,
  };
}

function rawPayload() {
  return {
    ok: true,
    window: { x: 10, y: 20, radius: 32 },
    mode: "window",
    counts: { scanned: 4 },
    belts: [
      belt({
        x: 11,
        left: { index: 1, items: [{ name: "coal", count: 4 }] },
        right: { index: 2, items: [{ name: "iron-ore", count: 2 }] },
        inputs: { rear: { name: "transport-belt", type: "transport-belt" } },
      }),
      belt({ x: 10, inputs: { left: { name: "fast-inserter", type: "inserter" } } }),
      belt({
        x: 12,
        direction: 0,
        type: "underground-belt",
        name: "underground-belt",
        left: {
          index: 3,
          items: [
            { name: "coal", count: 1 },
            { name: "iron-ore", count: 1 },
          ],
        },
        right: { index: 4, items: [] },
        inputs: {
          rear: { name: "transport-belt", type: "transport-belt" },
          right: { name: "splitter", type: "splitter" },
        },
      }),
      belt({ x: 13, direction: 12, left: { index: 1, items: [{ name: "copper-plate", count: 4 }] } }),
    ],
    truncated: false,
  };
}

test("summarizes left/right lanes with saturation, balance and lane mix", () => {
  const summary = summarizeBeltLanesData(rawPayload());
  assert.equal(summary.mode, "window");
  assert.deepEqual(summary.window, { x: 10, y: 20, radius: 32 });
  assert.deepEqual(summary.counts, {
    belts: 4,
    scanned: 4,
    with_items: 3,
    empty: 1,
    lane_mix: 1,
    one_lane_empty: 2,
    imbalanced: 1,
    side_load: 2,
  });

  // Sorted north-to-south, west-to-east: x 10, 11, 12, 13 at the same y.
  const [emptyBelt, mixedLanes, underground, oneLane] = summary.belts;
  assert.equal(emptyBelt.x, 10);
  assert.equal(emptyBelt.item_count, 0);
  assert.equal(emptyBelt.side_load, "left");
  assert.deepEqual(emptyBelt.feeder_sides, ["left"]);

  assert.equal(mixedLanes.x, 11);
  assert.deepEqual(mixedLanes.lanes.left.items, [{ name: "coal", count: 4 }]);
  assert.deepEqual(mixedLanes.lanes.right.items, [{ name: "iron-ore", count: 2 }]);
  assert.equal(mixedLanes.lanes.left.saturation, 1);
  assert.equal(mixedLanes.lanes.right.saturation, 0.5);
  assert.equal(mixedLanes.saturation, 0.75);
  assert.deepEqual(mixedLanes.lane_balance, { left: 4, right: 2, delta: 2, ratio: 0.667 });
  assert.equal(mixedLanes.direction_name, "east");
  assert.equal(mixedLanes.side_load, null);

  // Underground belt lines use defines.transport_line underground indices; the
  // raw index stays visible for debugging.
  assert.equal(underground.type, "underground-belt");
  assert.equal(underground.lanes.left.index, 3);
  assert.equal(underground.lanes.right.index, 4);
  assert.equal(underground.lane_mix, true);
  assert.deepEqual(underground.lane_mix_lanes, ["left"]);
  assert.equal(underground.side_load, "right");
  assert.deepEqual(summary.warnings, [
    {
      kind: "lane_mix",
      x: 12,
      y: 20,
      lane: "left",
      items: [
        { name: "coal", count: 1 },
        { name: "iron-ore", count: 1 },
      ],
    },
  ]);

  assert.equal(oneLane.lane_balance.ratio, 1);
  assert.equal(oneLane.direction_name, "west");
  assert.equal(oneLane.saturation, 0.5);
});

test("passes through non-object payloads and keeps truncated/mode flags", () => {
  assert.equal(summarizeBeltLanesData("not json"), "not json");
  const empty = summarizeBeltLanesData({ counts: {}, belts: [], truncated: true, mode: "targets" });
  assert.equal(empty.mode, "targets");
  assert.equal(empty.truncated, true);
  assert.deepEqual(empty.belts, []);
  assert.equal(empty.counts.belts, 0);
});

function fakeResponse() {
  return {
    statusCode: 0,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk !== undefined) this.body = chunk.toString();
    },
  };
}

function fakeRequest(url, method, body) {
  const chunks =
    body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  const request = Readable.from(chunks);
  request.url = url;
  request.method = method;
  request.headers = { host: "localhost" };
  return request;
}

function fakeContext() {
  const calls = [];
  const context = {
    state: { save: null, logs: [], rcon: { connected: true, lastError: null } },
    runManager: {},
    rconCommand: async (command) => {
      calls.push(String(command));
      return JSON.stringify(rawPayload());
    },
    actionJobs: {},
    nativeController: {},
  };
  return { context, calls };
}

async function dispatch(router, req) {
  const res = fakeResponse();
  const handled = await router.dispatch(req, res);
  assert.equal(handled, true, "route should be handled");
  return res;
}

test("POST /api/agent/observe/belts summarizes the Lua scan", async () => {
  const router = new Router();
  const { context, calls } = fakeContext();
  registerAgentRoutes(router, context);
  const res = await dispatch(
    router,
    fakeRequest("/api/agent/observe/belts", "POST", { window: { radius: 40 }, limit: 7 }),
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.data.counts.belts, 4);
  assert.ok(calls[0].includes("local x=nil local y=nil local radius=40 local limit=7"));
  assert.ok(calls[0].includes("left_split_line"));
});

test("POST /api/agent/observe/belts accepts explicit belt tiles", async () => {
  const router = new Router();
  const { context, calls } = fakeContext();
  registerAgentRoutes(router, context);
  const res = await dispatch(
    router,
    fakeRequest("/api/agent/observe/belts", "POST", { targets: [{ x: 5, y: 6 }] }),
  );
  assert.equal(res.statusCode, 200);
  assert.ok(calls[0].includes("table.insert(targets,{x=5,y=6})"));
  assert.ok(calls[0].includes("local limit=100"));
});
