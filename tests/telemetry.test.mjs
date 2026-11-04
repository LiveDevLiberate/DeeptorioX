import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  combatScanCommand,
  fluidNetworkCommand,
  telemetrySampleCommand,
} from "../dist/observation-builders.js";
import { TELEMETRY_COMMAND } from "../dist/benchmarks.js";
import {
  createTelemetrySampler,
  DEFAULT_SAMPLE_INTERVAL_MS,
  DEFAULT_WINDOW_MS,
} from "../dist/telemetry-sampler.js";
import { normalizeCombatData, normalizeFluidData, registerTelemetryRoutes } from "../dist/api/telemetry.js";
import { Router } from "../dist/http/router.js";
import { API_SCHEMA_VERSION } from "../dist/http/plumbing.js";

// Independent production telemetry sampler + production/fluids/combat routes.
// No manager, game, RCON socket or timer is needed: the sampler takes an
// injected command/clock/logger and the routes run through a real Router with
// fake IncomingMessage/ServerResponse objects.

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
      if (chunk !== undefined) this.body = chunk;
    },
  };
}

function fakeRequest(url, method = "POST", body) {
  const chunks =
    body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  return Object.assign(Readable.from(chunks), { url, method, headers: { host: "localhost" } });
}

function silentLogger() {
  const warns = [];
  const debugs = [];
  return {
    warns,
    debugs,
    logger: {
      warn: (msg, context) => warns.push({ msg, context }),
      debug: (msg, context) => debugs.push({ msg, context }),
    },
  };
}

/** Telemetry reply compatible with benchmarks.parseSnapshot. */
function telemetryReply({
  tick = 1,
  iron = 0,
  copper = 0,
  rockets = 0,
  research = {},
  current = null,
  progress = null,
} = {}) {
  return JSON.stringify({
    tick,
    speed: 1,
    paused: false,
    player: "Player",
    character: true,
    production: { "iron-plate": iron, "copper-plate": copper },
    consumption: { "iron-ore": iron },
    fluids_produced: {},
    fluids_consumed: {},
    research,
    current_research: current,
    research_progress: progress,
    rockets,
  });
}

const EMPTY_SNAPSHOT = {
  tick: 0,
  samples: 0,
  window_seconds: 0,
  production_per_minute: {},
  deltas: {},
  research: { researched: {}, current_research: null, research_progress: null, new_research: [] },
  rockets: { total: 0, delta: 0, per_minute: 0 },
};

test("sampler derives rates, deltas, research and rockets from cumulative counts", async () => {
  let clock = 1_000_000;
  const replies = [
    telemetryReply({ tick: 100, iron: 10 }),
    telemetryReply({
      tick: 400,
      iron: 70,
      copper: 5,
      rockets: 1,
      research: { automation: true },
      current: "logistics",
      progress: 0.5,
    }),
  ];
  const sampler = createTelemetrySampler({
    command: async () => replies.shift(),
    now: () => clock,
    logger: silentLogger().logger,
  });
  assert.equal(await sampler.sampleOnce(), true);
  clock += 60_000;
  assert.equal(await sampler.sampleOnce(), true);
  const snapshot = sampler.snapshot();
  assert.equal(snapshot.samples, 2);
  assert.equal(snapshot.tick, 400);
  assert.equal(snapshot.window_seconds, 60);
  assert.deepEqual(snapshot.deltas, { "iron-plate": 60, "copper-plate": 5 });
  assert.deepEqual(snapshot.production_per_minute, {
    "iron-plate": 60,
    "copper-plate": 5,
  });
  assert.deepEqual(snapshot.research.researched, { automation: true });
  assert.deepEqual(snapshot.research.new_research, ["automation"]);
  assert.equal(snapshot.research.current_research, "logistics");
  assert.equal(snapshot.research.research_progress, 0.5);
  assert.deepEqual(snapshot.rockets, { total: 1, delta: 1, per_minute: 1 });
  assert.deepEqual(sampler.rates("iron-plate"), {
    item: "iron-plate",
    produced_delta: 60,
    produced_per_minute: 60,
  });
  assert.equal(sampler.rates("copper-plate").produced_delta, 5);
  assert.equal(sampler.rates("steel-plate"), undefined);
  assert.equal(sampler.errorCount, 0);
});

test("a single sample reports the tick but no rates or deltas", async () => {
  const sampler = createTelemetrySampler({ command: async () => telemetryReply({ tick: 42, iron: 9 }) });
  assert.equal(await sampler.sampleOnce(), true);
  const snapshot = sampler.snapshot();
  assert.equal(snapshot.tick, 42);
  assert.equal(snapshot.samples, 1);
  assert.equal(snapshot.window_seconds, 0);
  assert.deepEqual(snapshot.deltas, {});
  assert.deepEqual(snapshot.production_per_minute, {});
  assert.equal(snapshot.rockets.total, 0);
  assert.equal(sampler.rates("iron-plate"), undefined);
});

test("sampler is fail-soft: errors and malformed replies skip samples and keep the last good one", async () => {
  const { logger, warns } = silentLogger();
  const replies = [new Error("RCON not connected"), "not json", telemetryReply({ tick: 7, iron: 1 })];
  const sampler = createTelemetrySampler({
    command: async () => {
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    },
    logger,
  });
  assert.equal(await sampler.sampleOnce(), false);
  assert.equal(await sampler.sampleOnce(), false);
  assert.equal(sampler.sampleCount, 0);
  assert.equal(sampler.errorCount, 2);
  assert.equal(warns.length, 1);
  assert.equal(warns[0].msg, "telemetry sample skipped");
  assert.equal(await sampler.sampleOnce(), true);
  assert.equal(sampler.sampleCount, 1);
  assert.equal(sampler.errorCount, 2);
  assert.equal(sampler.snapshot().tick, 7);
});

test("replies without a connected character are skipped by the shared parser", async () => {
  const { logger, warns } = silentLogger();
  const sampler = createTelemetrySampler({
    command: async () => JSON.stringify({ tick: 5, character: false }),
    logger,
  });
  assert.equal(await sampler.sampleOnce(), false);
  assert.equal(sampler.errorCount, 1);
  assert.match(warns[0].context.error, /Connected player 1/);
});

test("sampler keeps a bounded sliding window and drops expired samples", async () => {
  let clock = 1_000_000;
  const replies = [
    telemetryReply({ tick: 1, iron: 10 }),
    telemetryReply({ tick: 2, iron: 70 }),
    telemetryReply({ tick: 3, iron: 100 }),
  ];
  const sampler = createTelemetrySampler({
    command: async () => replies.shift(),
    intervalMs: 1_000,
    windowMs: 1_000,
    now: () => clock,
  });
  await sampler.sampleOnce();
  clock += 600;
  await sampler.sampleOnce();
  clock += 900;
  await sampler.sampleOnce();
  const snapshot = sampler.snapshot();
  // t=1000000 expired (cutoff 1000500); oldest kept sample is t=1000600.
  assert.equal(snapshot.samples, 2);
  assert.equal(snapshot.window_seconds, 0.9);
  assert.deepEqual(snapshot.deltas, { "iron-plate": 30 });
  assert.equal(snapshot.production_per_minute["iron-plate"], 2000);
  assert.equal(sampler.rates("iron-plate").produced_per_minute, 2000);
});

test("counter resets are ignored rather than reported as negative production", async () => {
  let clock = 0;
  const replies = [telemetryReply({ tick: 1, iron: 100 }), telemetryReply({ tick: 2, iron: 10 })];
  const sampler = createTelemetrySampler({
    command: async () => replies.shift(),
    now: () => clock,
  });
  await sampler.sampleOnce();
  clock += 5_000;
  await sampler.sampleOnce();
  assert.deepEqual(sampler.snapshot().deltas, {});
  assert.deepEqual(sampler.snapshot().production_per_minute, {});
  assert.equal(sampler.rates("iron-plate"), undefined);
});

test("start() samples immediately, unrefs its timer, and start/stop/clear are idempotent", async () => {
  let calls = 0;
  const sampler = createTelemetrySampler({
    command: async () => {
      calls += 1;
      return telemetryReply({ tick: calls });
    },
    intervalMs: 3_600_000,
  });
  assert.equal(sampler.running, false);
  assert.equal(sampler.sampleCount, 0);
  sampler.start();
  sampler.start();
  assert.equal(sampler.running, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(sampler.sampleCount, 1);
  sampler.stop();
  sampler.stop();
  assert.equal(sampler.running, false);
  assert.equal(sampler.errorCount, 0);
  sampler.clear();
  assert.equal(sampler.sampleCount, 0);
  assert.deepEqual(sampler.snapshot(), EMPTY_SNAPSHOT);
  // stop() before start() is a no-op.
  const idle = createTelemetrySampler({ command: async () => telemetryReply() });
  idle.stop();
  assert.equal(idle.running, false);
});

test("shouldSample gates ticks without contacting RCON or counting errors", async () => {
  let calls = 0;
  const sampler = createTelemetrySampler({
    command: async () => {
      calls += 1;
      return telemetryReply();
    },
    shouldSample: () => false,
  });
  assert.equal(await sampler.sampleOnce(), false);
  sampler.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  sampler.stop();
  assert.equal(calls, 0);
  assert.equal(sampler.errorCount, 0);
  assert.equal(sampler.sampleCount, 0);
});

test("default sampler configuration is the documented 5 s / 15 min", () => {
  assert.equal(DEFAULT_SAMPLE_INTERVAL_MS, 5_000);
  assert.equal(DEFAULT_WINDOW_MS, 15 * 60 * 1000);
});

test("telemetrySampleCommand reuses TELEMETRY_COMMAND as the single source of truth", () => {
  const lua = telemetrySampleCommand();
  assert.equal(lua, TELEMETRY_COMMAND);
  assert.ok(lua.startsWith("/sc "));
  for (const field of [
    "tick=game.tick",
    "production=i.input_counts",
    "research=research",
    "rockets=f.rockets_launched",
  ]) {
    assert.ok(lua.includes(field), `missing ${field}`);
  }
});

test("fluidNetworkCommand builds a bounded fluidbox scan with aggregation", () => {
  const defaults = fluidNetworkCommand({ radius: 32 });
  assert.ok(defaults.startsWith("/sc "));
  assert.ok(defaults.includes("local x=nil local y=nil local radius=32"));
  for (const type of ["storage-tank", "pipe", "pump", "oil-refinery", "chemical-plant", "pumpjack"]) {
    assert.ok(defaults.includes(`['${type}']=true`), `missing entity type ${type}`);
  }
  assert.ok(defaults.includes("pcall(function() fb_count=#e.fluidbox end)"));
  assert.ok(defaults.includes("e.fluidbox.get_capacity(index)"));
  assert.ok(defaults.includes("total.level=total.amount/total.capacity"));
  assert.ok(defaults.includes("#entities<200"));
  assert.ok(defaults.includes("helpers.table_to_json"));
  const centered = fluidNetworkCommand({ x: 12, y: -34, radius: 8 });
  assert.ok(centered.includes("local x=12 local y=-34 local radius=8"));
  assert.ok(!/undefined|NaN/.test(defaults + centered));
});

test("combatScanCommand builds a read-only enemy/turret/player scan", () => {
  const defaults = combatScanCommand({ radius: 64 });
  assert.ok(defaults.startsWith("/sc "));
  assert.ok(defaults.includes("local x=nil local y=nil local radius=64"));
  for (const token of [
    "unit-spawner",
    "spider-unit",
    "is_enemy",
    "defines.inventory.turret_ammo",
    "counts.by_force",
    "counts.by_type",
    "p.character.health",
    "nests",
    "turrets",
    "helpers.table_to_json",
  ]) {
    assert.ok(defaults.includes(token), `missing ${token}`);
  }
  const centered = combatScanCommand({ x: 5, y: 6, radius: 32 });
  assert.ok(centered.includes("local x=5 local y=6 local radius=32"));
  assert.ok(!/undefined|NaN/.test(defaults + centered));
});

test("normalizeFluidData fills the documented defaults without throwing on garbage", () => {
  assert.deepEqual(normalizeFluidData(null), {
    window: {},
    counts: {},
    fluids: {},
    entities: [],
    scanned: 0,
    truncated: false,
  });
  const normalized = normalizeFluidData({
    window: null,
    counts: { pipe: 2 },
    fluids: { water: { amount: 10, capacity: 100, level: 0.1 } },
    entities: "nope",
    scanned: "7",
    truncated: 1,
  });
  assert.deepEqual(normalized.counts, { pipe: 2 });
  assert.deepEqual(normalized.fluids.water, { amount: 10, capacity: 100, level: 0.1 });
  assert.deepEqual(normalized.entities, []);
  assert.equal(normalized.scanned, 0);
  assert.equal(normalized.truncated, false);
});

test("normalizeCombatData fills player/count/recent-damage defaults without throwing", () => {
  const defaults = normalizeCombatData(null);
  assert.deepEqual(defaults.window, {});
  assert.deepEqual(defaults.counts, { by_force: {}, by_type: {}, enemy_total: 0, turrets: 0 });
  assert.deepEqual(defaults.nests, []);
  assert.deepEqual(defaults.turrets, []);
  assert.equal(defaults.player, null);
  assert.equal(defaults.recent_damage, null);
  assert.match(defaults.recent_damage_note, /player\.health/);
  assert.equal(defaults.scanned, 0);
  const normalized = normalizeCombatData({
    counts: { by_force: null, by_type: { unit: 2 }, enemy_total: "x" },
    nests: "nope",
    turrets: null,
    player: "bad",
    recent_damage: 12,
  });
  assert.deepEqual(normalized.counts.by_force, {});
  assert.deepEqual(normalized.counts.by_type, { unit: 2 });
  assert.equal(normalized.counts.enemy_total, 0);
  assert.deepEqual(normalized.nests, []);
  assert.deepEqual(normalized.turrets, []);
  assert.equal(normalized.player, null);
  assert.equal(normalized.recent_damage, 12);
});

test("registerTelemetryRoutes registers the three observation routes", () => {
  const router = new Router();
  registerTelemetryRoutes(router, {}, { snapshot: () => EMPTY_SNAPSHOT, sampleOnce: async () => false });
  const paths = router.list().map((route) => `${route.method} ${route.path}`);
  assert.deepEqual(paths, [
    "POST /api/agent/observe/production",
    "POST /api/agent/observe/fluids",
    "POST /api/agent/observe/combat",
  ]);
});

function fixtureRouter(ctx, sampler) {
  const router = new Router();
  registerTelemetryRoutes(router, ctx, sampler);
  return router;
}

test("observe/production returns the sampler window with the standard v2 envelope", async () => {
  const snapshot = {
    ...EMPTY_SNAPSHOT,
    tick: 400,
    samples: 3,
    window_seconds: 60,
    deltas: { "iron-plate": 60 },
    production_per_minute: { "iron-plate": 60 },
    research: {
      researched: { automation: true },
      current_research: null,
      research_progress: null,
      new_research: [],
    },
    rockets: { total: 1, delta: 1, per_minute: 1 },
  };
  const router = fixtureRouter({}, { snapshot: () => snapshot, sampleOnce: async () => true });
  const res = fakeResponse();
  await router.dispatch(fakeRequest("/api/agent/observe/production"), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schema_version, API_SCHEMA_VERSION);
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body.data), [
    "window_seconds",
    "production_per_minute",
    "deltas",
    "research",
    "rockets",
    "samples",
    "generated_at",
  ]);
  assert.equal(body.data.window_seconds, 60);
  assert.deepEqual(body.data.deltas, { "iron-plate": 60 });
  assert.equal(body.data.samples, 3);
  assert.ok(!Number.isNaN(Date.parse(body.data.generated_at)));
});

test("observe/production takes one live sample when the sampler is empty", async () => {
  let sampled = false;
  const populated = { ...EMPTY_SNAPSHOT, samples: 1, tick: 9 };
  const sampler = {
    snapshot: () => (sampled ? populated : EMPTY_SNAPSHOT),
    sampleOnce: async () => {
      sampled = true;
      return true;
    },
  };
  const res = fakeResponse();
  await fixtureRouter({}, sampler).dispatch(fakeRequest("/api/agent/observe/production"), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.data.samples, 1);
  assert.equal(body.data.window_seconds, 0);
});

test("observe/production returns 409 telemetry not ready when no sample can be taken", async () => {
  const sampler = { snapshot: () => EMPTY_SNAPSHOT, sampleOnce: async () => false };
  const res = fakeResponse();
  await fixtureRouter({}, sampler).dispatch(fakeRequest("/api/agent/observe/production"), res);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(JSON.parse(res.body), {
    schema_version: API_SCHEMA_VERSION,
    error: "telemetry not ready",
  });
});

test("observe/production returns 400 for a malformed JSON body", async () => {
  const sampler = { snapshot: () => EMPTY_SNAPSHOT, sampleOnce: async () => false };
  const res = fakeResponse();
  await fixtureRouter({}, sampler).dispatch(
    fakeRequest("/api/agent/observe/production", "POST", "{not json"),
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /JSON|Unexpected/);
});

function connectedContext(fixture, calls = []) {
  return {
    calls,
    ctx: {
      state: { rcon: { connected: true } },
      rconCommand: async (lua, timeoutMs) => {
        calls.push({ lua, timeoutMs });
        if (fixture instanceof Error) throw fixture;
        return fixture;
      },
    },
  };
}

const FLUID_REPLY = JSON.stringify({
  window: { x: 10, y: -20, radius: 20 },
  scanned: 3,
  truncated: false,
  counts: { pipe: 2, "storage-tank": 1 },
  fluids: { water: { name: "water", amount: 250, capacity: 25000, fluidboxes: 2, level: 0.01 } },
  entities: [
    {
      name: "pipe",
      type: "pipe",
      x: 11,
      y: -19,
      fluidboxes: [
        { index: 1, fluid: { name: "water", amount: 50, temperature: 15 }, capacity: 100, level: 0.5 },
      ],
    },
  ],
});

test("observe/fluids scans fluid networks with the standard envelope", async () => {
  const { ctx, calls } = connectedContext(FLUID_REPLY);
  const res = fakeResponse();
  await fixtureRouter(ctx, { snapshot: () => EMPTY_SNAPSHOT, sampleOnce: async () => false }).dispatch(
    fakeRequest("/api/agent/observe/fluids", "POST", { x: 10, y: -20, radius: 20 }),
    res,
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schema_version, API_SCHEMA_VERSION);
  assert.equal(body.ok, true);
  assert.deepEqual(body.data.counts, { pipe: 2, "storage-tank": 1 });
  assert.equal(body.data.fluids.water.amount, 250);
  assert.equal(body.data.entities.length, 1);
  assert.equal(body.data.scanned, 3);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].lua.includes("local x=10 local y=-20 local radius=20"));
  assert.equal(calls[0].timeoutMs, 15_000);
});

test("observe/fluids accepts the legacy nested window form and clamps the radius", async () => {
  const { ctx, calls } = connectedContext(FLUID_REPLY);
  const res = fakeResponse();
  await fixtureRouter(ctx, { snapshot: () => EMPTY_SNAPSHOT }).dispatch(
    fakeRequest("/api/agent/observe/fluids", "POST", { window: { x: 5, y: 6, radius: 9999 } }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.ok(calls[0].lua.includes("local x=5 local y=6 local radius=128"));
});

test("observe/fluids defaults to the player position when coordinates are omitted", async () => {
  const { ctx, calls } = connectedContext(FLUID_REPLY);
  const res = fakeResponse();
  await fixtureRouter(ctx, { snapshot: () => EMPTY_SNAPSHOT }).dispatch(
    fakeRequest("/api/agent/observe/fluids", "POST", { radius: 8 }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.ok(calls[0].lua.includes("local x=nil local y=nil local radius=8"));
});

test("observe/fluids returns 400 on bad JSON, 409 when RCON is disconnected, 500 on command failure", async () => {
  const disconnected = {
    state: { rcon: { connected: false } },
    rconCommand: async () => {
      throw new Error("should not be called");
    },
  };
  const badJson = fakeResponse();
  await fixtureRouter(disconnected, { snapshot: () => EMPTY_SNAPSHOT }).dispatch(
    fakeRequest("/api/agent/observe/fluids", "POST", "{oops"),
    badJson,
  );
  assert.equal(badJson.statusCode, 400);
  assert.match(JSON.parse(badJson.body).error, /JSON/);

  const disconnectedRes = fakeResponse();
  await fixtureRouter(disconnected, { snapshot: () => EMPTY_SNAPSHOT }).dispatch(
    fakeRequest("/api/agent/observe/fluids", "POST", {}),
    disconnectedRes,
  );
  assert.equal(disconnectedRes.statusCode, 409);
  assert.deepEqual(JSON.parse(disconnectedRes.body), {
    schema_version: API_SCHEMA_VERSION,
    error: "RCON not connected",
  });

  const failing = connectedContext(new Error("boom"));
  const failedRes = fakeResponse();
  await fixtureRouter(failing.ctx, { snapshot: () => EMPTY_SNAPSHOT }).dispatch(
    fakeRequest("/api/agent/observe/fluids", "POST", {}),
    failedRes,
  );
  assert.equal(failedRes.statusCode, 500);
  assert.deepEqual(JSON.parse(failedRes.body), { schema_version: API_SCHEMA_VERSION, error: "boom" });

  const invalidReply = connectedContext("not json");
  const invalidRes = fakeResponse();
  await fixtureRouter(invalidReply.ctx, { snapshot: () => EMPTY_SNAPSHOT }).dispatch(
    fakeRequest("/api/agent/observe/fluids", "POST", {}),
    invalidRes,
  );
  assert.equal(invalidRes.statusCode, 500);
  assert.match(JSON.parse(invalidRes.body).error, /RCON fluid scan returned invalid JSON/);
});

const COMBAT_REPLY = JSON.stringify({
  window: { x: 0, y: 0, radius: 64 },
  scanned: 5,
  counts: {
    by_force: { player: 0, enemy: 4 },
    by_type: { "unit-spawner": 1, unit: 3 },
    enemy_total: 4,
    turrets: 1,
  },
  nests: [{ name: "biter-spawner", force: "enemy", x: 10, y: 12, health: 350, max_health: 350 }],
  turrets: [
    {
      name: "gun-turret",
      type: "ammo-turret",
      x: 1,
      y: 2,
      health: 400,
      max_health: 400,
      ammo: { "firearm-magazine": 20 },
    },
  ],
  player: { name: "Player", health: 85, max_health: 100, health_deficit: 15, position: { x: 0, y: 0 } },
});

test("observe/combat returns enemy counts, turret ammo and player health", async () => {
  const { ctx, calls } = connectedContext(COMBAT_REPLY);
  const res = fakeResponse();
  await fixtureRouter(ctx, { snapshot: () => EMPTY_SNAPSHOT }).dispatch(
    fakeRequest("/api/agent/observe/combat", "POST", { x: 0, y: 0, radius: 64 }),
    res,
  );
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schema_version, API_SCHEMA_VERSION);
  assert.equal(body.ok, true);
  assert.deepEqual(body.data.counts.by_force, { player: 0, enemy: 4 });
  assert.equal(body.data.nests[0].name, "biter-spawner");
  assert.deepEqual(body.data.turrets[0].ammo, { "firearm-magazine": 20 });
  assert.equal(body.data.player.health, 85);
  assert.equal(body.data.recent_damage, null);
  assert.match(body.data.recent_damage_note, /player\.health/);
  assert.ok(calls[0].lua.includes("unit-spawner"));
  assert.ok(calls[0].lua.includes("turret_ammo"));
  assert.ok(calls[0].lua.includes("local x=0 local y=0 local radius=64"));
});

test("observe/combat returns 409 when RCON is disconnected and clamps the radius", async () => {
  const disconnected = { state: { rcon: { connected: false } }, rconCommand: async () => "{}" };
  const res = fakeResponse();
  await fixtureRouter(disconnected, { snapshot: () => EMPTY_SNAPSHOT }).dispatch(
    fakeRequest("/api/agent/observe/combat", "POST", {}),
    res,
  );
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).error, "RCON not connected");

  const { ctx, calls } = connectedContext(COMBAT_REPLY);
  const clamped = fakeResponse();
  await fixtureRouter(ctx, { snapshot: () => EMPTY_SNAPSHOT }).dispatch(
    fakeRequest("/api/agent/observe/combat", "POST", { radius: 100000 }),
    clamped,
  );
  assert.equal(clamped.statusCode, 200);
  assert.ok(calls[0].lua.includes("local radius=256"));
});
