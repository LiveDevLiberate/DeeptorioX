import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  AREA_EDIT_COPY_LIMIT,
  AREA_EDIT_DEFAULT_LIMIT,
  AREA_EDIT_MAX_LIMIT,
  copySettingsCommand,
  normalizeCopyTargets,
  observeAreaCommand,
  parseTilePoint,
} from "../dist/area-edit.js";
import { registerAreaEditRoutes } from "../dist/api/area-edit.js";
import { Router } from "../dist/http/router.js";
import { API_SCHEMA_VERSION } from "../dist/http/plumbing.js";

// P0-4 area edit: pure Lua builder assertions plus route registration smoke
// with a fake Router/context. No manager, game, RCON or child process involved.

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

function fakeContext({ connected = true, rconCommand, response } = {}) {
  const calls = [];
  const context = {
    state: { save: null, logs: [], rcon: { connected, lastError: null } },
    rconCommand: async (command, timeoutMs) => {
      calls.push({ command, timeoutMs });
      if (rconCommand) return rconCommand(command, timeoutMs);
      return response ?? JSON.stringify({ ok: true });
    },
  };
  return { context, calls };
}

async function dispatch(router, req) {
  const res = fakeResponse();
  const handled = await router.dispatch(req, res);
  assert.equal(handled, true, "route should be handled");
  return res;
}

function jsonBody(res) {
  assert.ok(res.body, "response body should be set");
  return JSON.parse(res.body);
}

function occurrenceCount(text, needle) {
  return text.split(needle).length - 1;
}

test("observeAreaCommand scans a bounded area, excludes non-deconstructable types and prints JSON", () => {
  const lua = observeAreaCommand({ x: 130, y: -42, radius: 32, limit: 250 });
  assert.ok(lua.startsWith("/sc "));
  assert.ok(lua.includes("local p=game.players[1]"));
  assert.ok(lua.includes("local cx=130 local cy=-42 local radius=32 local limit=250"));
  assert.ok(lua.includes("local player_only=false"));
  assert.ok(lua.includes("local min_x=math.floor(cx-radius)"));
  assert.ok(lua.includes("local found=s.find_entities_filtered{area={{min_x,min_y},{max_x+1,max_y+1}}}"));
  // Environment/resource types are excluded; buildable entities stay visible.
  for (const type of ["resource", "character", "cliff", "item-entity", "corpse"]) {
    assert.ok(lua.includes(`["${type}"]=true`), `should exclude ${type}`);
  }
  // An explicit `types` request overrides the default exclusion list.
  assert.ok(lua.includes("(type_filter[e.type]==true or not excluded[e.type])"));
  assert.ok(lua.includes("seen[key]"), "deduplicates entities");
  assert.ok(lua.includes("table.sort(candidates"), "sorting keeps truncation deterministic");
  assert.ok(lua.includes("table.insert(entities,{name=e.name,type=e.type,x=math.floor(e.position.x)"));
  assert.ok(
    lua.includes(
      "health=health,player_created=player_created,belt_items=belt_items,fluid=fluid,network_id=network_id}",
    ),
  );
  // Belt contents merge every transport line (both lanes), deduplicating lines.
  assert.ok(lua.includes("get_max_transport_line_index"));
  assert.ok(lua.includes("line_equals"));
  assert.ok(lua.includes("truncated=matched>#entities"));
  assert.ok(
    lua.includes(
      "done{ok=true,area={x=cx,y=cy,radius=radius,min_x=min_x,min_y=min_y,max_x=max_x,max_y=max_y},counts={total=total,matched=matched,included=#entities}",
    ),
  );
  // The area scan never mutates: no deconstruction/mining/copy calls inside it.
  assert.ok(!lua.includes("copy_settings"));
  assert.ok(!lua.includes("mine("));
});

test("observeAreaCommand injects type/filter/player_only filters and clamps the limit", () => {
  const lua = observeAreaCommand({
    x: 0,
    y: 0,
    radius: 16,
    types: ["furnace", "assembling-machine"],
    filters: ["transport-belt", "inserter"],
    limit: 99999,
    playerOnly: true,
  });
  assert.ok(lua.includes('local type_filter={["furnace"]=true,["assembling-machine"]=true}'));
  assert.ok(lua.includes('local name_filter={["transport-belt"]=true,["inserter"]=true}'));
  assert.ok(lua.includes("local player_only=true"));
  assert.ok(lua.includes(`local limit=${AREA_EDIT_MAX_LIMIT}`));
  assert.ok(lua.includes("pcall(function() player_created=e.last_user~=nil end)"));
  assert.ok(lua.includes("if (not player_only) or player_created then"));
  // Invalid identifier characters can never reach the generated Lua source.
  const injection = observeAreaCommand({ x: 0, y: 0, radius: 1, types: ['evil"]=true;os.execute("x")'] });
  assert.ok(!injection.includes("os.execute"));
  assert.ok(injection.includes("local type_filter={}"));
});

test("observeAreaCommand validates coordinates and clamps limits", () => {
  assert.throws(() => observeAreaCommand({ x: Number.NaN, y: 0, radius: 1 }), /finite x, y and radius/);
  assert.throws(() => observeAreaCommand({ x: 0, y: 0, radius: Number.POSITIVE_INFINITY }), /finite/);
  assert.ok(observeAreaCommand({ x: 0, y: 0, radius: 1, limit: 0 }).includes("local limit=1"));
  assert.ok(
    observeAreaCommand({ x: 0, y: 0, radius: 1, limit: Number.NaN }).includes(
      `local limit=${AREA_EDIT_DEFAULT_LIMIT}`,
    ),
  );
});

test("copySettingsCommand emits reach-checked copy_settings calls per target", () => {
  const lua = copySettingsCommand([{ source: { x: 130, y: -42 }, target: { x: 131, y: -42 } }]);
  assert.ok(lua.startsWith("/sc "));
  assert.ok(lua.includes("local dry_run=false"));
  assert.ok(lua.includes("local function find_entity(x,y)"));
  assert.ok(lua.includes("local function copy_one(sx,sy,tx,ty)"));
  assert.ok(lua.includes("table.insert(results,copy_one(130,-42,131,-42))"));
  assert.ok(lua.includes("target.copy_settings(source,p)"), "uses the verified 2.1 API as the player");
  assert.ok(lua.includes("p.can_reach_entity(source)==true"));
  assert.ok(lua.includes("p.can_reach_entity(target)==true"));
  for (const error of [
    "no_source_entity",
    "no_target_entity",
    "out_of_reach",
    "incompatible_types",
    "settings_copy_failed",
  ]) {
    assert.ok(lua.includes(`result.error='${error}'`), `should report ${error}`);
  }
  assert.ok(lua.includes("local source_reach=false local target_reach=false"));
  assert.ok(lua.includes("if not source_reach or not target_reach then result.error='out_of_reach'"));
  assert.ok(lua.includes("if source.type~=target.type then result.error='incompatible_types'"));
  assert.ok(
    lua.includes(
      "done{ok=(failed==0),dry_run=dry_run,counts={total=#results,ok=ok_count,failed=failed},results=results}",
    ),
  );
  assert.ok(lua.includes("helpers.table_to_json"));
});

test("copySettingsCommand dry-run never calls copy_settings and flags dry_run", () => {
  const lua = copySettingsCommand([{ source: { x: 1, y: 2 }, target: { x: 3, y: 4 } }], { dryRun: true });
  assert.ok(lua.includes("local dry_run=true"));
  assert.ok(lua.includes("if dry_run then result.ok=true result.dry_run=true return result end"));
  // The call still appears in the source (guarded), but the dry-run branch returns first.
  const dryBranchIndex = lua.indexOf("if dry_run then result.ok=true");
  const copyCallIndex = lua.indexOf("target.copy_settings(source,p)");
  assert.ok(dryBranchIndex > 0 && copyCallIndex > dryBranchIndex);
});

test("copySettingsCommand keeps malformed entries as per-target invalid_target results", () => {
  const lua = copySettingsCommand([
    { source: { x: "not-a-number", y: 1 }, target: { x: 2, y: 3 } },
    { source: { x: 1, y: 2 }, target: { x: 3, y: 4 } },
    { source: null, target: { x: 3, y: 4 } },
  ]);
  assert.equal(occurrenceCount(lua, "table.insert(results,"), 3);
  assert.ok(lua.includes("table.insert(results,{ok=false,error='invalid_target',index=0})"));
  assert.ok(lua.includes("table.insert(results,{ok=false,error='invalid_target',index=2})"));
  assert.ok(lua.includes("table.insert(results,copy_one(1,2,3,4))"));
});

test("copySettingsCommand caps targets at the copy limit", () => {
  const targets = Array.from({ length: AREA_EDIT_COPY_LIMIT + 10 }, (_, index) => ({
    source: { x: index, y: 0 },
    target: { x: index, y: 1 },
  }));
  const lua = copySettingsCommand(targets);
  assert.equal(occurrenceCount(lua, "table.insert(results,copy_one("), AREA_EDIT_COPY_LIMIT);
  assert.equal(occurrenceCount(lua, "table.insert(results,"), AREA_EDIT_COPY_LIMIT);
});

test("copySettingsCommand accepts non-array targets as an empty no-op command", () => {
  const lua = copySettingsCommand(undefined);
  assert.ok(lua.includes("local results={}"));
  assert.ok(!lua.includes("table.insert(results,copy_one("));
  assert.ok(lua.includes("counts={total=#results,ok=ok_count,failed=failed}"));
});

test("parseTilePoint and normalizeCopyTargets validate/cap copy payloads", () => {
  assert.deepEqual(parseTilePoint({ x: 5, y: -6 }), { x: 5, y: -6 });
  assert.deepEqual(parseTilePoint({ x: "5", y: "-6" }), { x: 5, y: -6 });
  assert.equal(parseTilePoint({ x: "nope", y: 1 }), null);
  assert.equal(parseTilePoint({ x: Number.NaN, y: 1 }), null);
  assert.equal(parseTilePoint(null), null);
  assert.equal(parseTilePoint("5,6"), null);
  assert.equal(normalizeCopyTargets(undefined).length, 0);
  const many = Array.from({ length: 3 }, () => ({}));
  assert.deepEqual(normalizeCopyTargets(many), many);
  const oversized = Array.from({ length: AREA_EDIT_COPY_LIMIT + 1 }, () => ({}));
  assert.equal(normalizeCopyTargets(oversized).length, AREA_EDIT_COPY_LIMIT);
});

test("registerAreaEditRoutes registers observe-area, copy dry-run and copy action paths", () => {
  const router = new Router();
  const { context } = fakeContext();
  registerAreaEditRoutes(router, context);
  const routes = router.list().map((route) => ({ method: route.method, path: route.path, name: route.name }));
  assert.deepEqual(routes, [
    { method: "POST", path: "/api/agent/observe/area", name: "/api/agent/observe/area" },
    { method: "POST", path: "/api/agent/observe/copy-settings", name: "/api/agent/observe/copy-settings" },
    { method: "POST", path: "/api/agent/act/copy-settings", name: "/api/agent/act/copy-settings" },
  ]);
});

test("POST /api/agent/observe/area returns the 200 area envelope and passes clamped parameters", async () => {
  const router = new Router();
  const payload = {
    ok: true,
    area: { x: 10, y: 20, radius: 32, min_x: -22, min_y: -12, max_x: 42, max_y: 52 },
    counts: { total: 2, matched: 2, included: 2 },
    entities: [
      {
        name: "stone-furnace",
        type: "furnace",
        x: 10,
        y: 20,
        position: { x: 10.5, y: 20.5 },
        health: 200,
        player_created: true,
      },
    ],
    truncated: false,
  };
  const { context, calls } = fakeContext({ response: JSON.stringify(payload) });
  registerAreaEditRoutes(router, context);
  const res = await dispatch(
    router,
    fakeRequest("/api/agent/observe/area", "POST", {
      window: { x: 10, y: 20, radius: 32 },
      limit: 250,
      types: ["furnace"],
      filters: ["stone-furnace"],
      player_only: true,
    }),
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "application/json");
  const body = jsonBody(res);
  assert.deepEqual(Object.keys(body), ["schema_version", "ok", "data"]);
  assert.equal(body.schema_version, API_SCHEMA_VERSION);
  assert.equal(body.ok, true);
  assert.deepEqual(body.data, payload);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].command.includes("local cx=10 local cy=20 local radius=32"));
  assert.ok(calls[0].command.includes('local type_filter={["furnace"]=true}'));
  assert.ok(calls[0].command.includes("local player_only=true"));
  assert.equal(calls[0].timeoutMs, 15_000);
});

test("area routes return 409 when RCON is disconnected without calling RCON", async () => {
  for (const path of [
    "/api/agent/observe/area",
    "/api/agent/observe/copy-settings",
    "/api/agent/act/copy-settings",
  ]) {
    const router = new Router();
    const { context, calls } = fakeContext({ connected: false });
    registerAreaEditRoutes(router, context);
    const body = path.endsWith("area") ? { window: {} } : { targets: [] };
    const res = await dispatch(router, fakeRequest(path, "POST", body));
    assert.equal(res.statusCode, 409);
    assert.deepEqual(jsonBody(res), { schema_version: API_SCHEMA_VERSION, error: "RCON not connected" });
    assert.equal(calls.length, 0);
  }
});

test("area routes return 400 for malformed JSON and missing copy targets", async () => {
  const router = new Router();
  const { context } = fakeContext({ response: JSON.stringify({ ok: true }) });
  registerAreaEditRoutes(router, context);

  const badJson = await dispatch(router, fakeRequest("/api/agent/observe/area", "POST", "not json"));
  assert.equal(badJson.statusCode, 400);
  const badJsonBody = jsonBody(badJson);
  assert.equal(typeof badJsonBody.error, "string");
  assert.ok(badJsonBody.error.length > 0);

  for (const path of ["/api/agent/observe/copy-settings", "/api/agent/act/copy-settings"]) {
    const missing = await dispatch(router, fakeRequest(path, "POST", {}));
    assert.equal(missing.statusCode, 400);
    assert.deepEqual(jsonBody(missing), { schema_version: API_SCHEMA_VERSION, error: "Missing targets" });
  }
});

test("copy-settings routes run dry-run or execute and add the truncated flag", async () => {
  const targets = Array.from({ length: AREA_EDIT_COPY_LIMIT + 3 }, (_, index) => ({
    source: { x: index, y: 0 },
    target: { x: index, y: 1 },
  }));
  const rconPayload = {
    ok: true,
    dry_run: true,
    counts: { total: AREA_EDIT_COPY_LIMIT, ok: 0, failed: 3 },
    results: [],
  };

  const dryRouter = new Router();
  const dry = fakeContext({ response: JSON.stringify(rconPayload) });
  registerAreaEditRoutes(dryRouter, dry.context);
  const dryRes = await dispatch(
    dryRouter,
    fakeRequest("/api/agent/observe/copy-settings", "POST", { targets }),
  );
  assert.equal(dryRes.statusCode, 200);
  assert.ok(dry.calls[0].command.includes("local dry_run=true"));
  const dryBody = jsonBody(dryRes);
  assert.equal(dryBody.ok, true);
  assert.equal(dryBody.data.truncated, true);
  assert.equal(occurrenceCount(dry.calls[0].command, "table.insert(results,copy_one("), AREA_EDIT_COPY_LIMIT);

  const actRouter = new Router();
  const act = fakeContext({ response: JSON.stringify({ ...rconPayload, dry_run: false }) });
  registerAreaEditRoutes(actRouter, act.context);
  const actRes = await dispatch(actRouter, fakeRequest("/api/agent/act/copy-settings", "POST", { targets }));
  assert.equal(actRes.statusCode, 200);
  assert.ok(act.calls[0].command.includes("local dry_run=false"));
  assert.equal(jsonBody(actRes).data.truncated, true);

  // `dry_run:true` on the action route previews through the same command shape.
  const preview = await dispatch(
    actRouter,
    fakeRequest("/api/agent/act/copy-settings", "POST", { targets: [], dry_run: true }),
  );
  assert.equal(preview.statusCode, 200);
  assert.ok(act.calls[1].command.includes("local dry_run=true"));
  assert.equal(jsonBody(preview).data.truncated, false);
});

test("copy-settings reports malformed entries as per-target errors in the 200 payload", async () => {
  const router = new Router();
  const { context, calls } = fakeContext({ response: JSON.stringify({ ok: false, results: [] }) });
  registerAreaEditRoutes(router, context);
  const res = await dispatch(
    router,
    fakeRequest("/api/agent/observe/copy-settings", "POST", {
      targets: [{ source: {}, target: { x: 2, y: 3 } }],
    }),
  );
  assert.equal(res.statusCode, 200);
  assert.ok(calls[0].command.includes("error='invalid_target',index=0"));
});

test("area routes return 500 with the RCON error message when the command fails", async () => {
  const router = new Router();
  const { context } = fakeContext({
    rconCommand: () => {
      throw new Error("RCON command failed: connection lost");
    },
  });
  registerAreaEditRoutes(router, context);
  const res = await dispatch(router, fakeRequest("/api/agent/observe/area", "POST", { window: {} }));
  assert.equal(res.statusCode, 500);
  assert.deepEqual(jsonBody(res), {
    schema_version: API_SCHEMA_VERSION,
    error: "RCON command failed: connection lost",
  });

  const malformed = new Router();
  const malformedCtx = fakeContext({ response: "not json" });
  registerAreaEditRoutes(malformed, malformedCtx.context);
  const bad = await dispatch(malformed, fakeRequest("/api/agent/act/copy-settings", "POST", { targets: [] }));
  assert.equal(bad.statusCode, 500);
  assert.deepEqual(jsonBody(bad), {
    schema_version: API_SCHEMA_VERSION,
    error: "RCON copy-settings returned invalid JSON",
  });
});

test("observe-area envelopes remain schema-compatible with the Lua payload", () => {
  // Guard against accidental response-shape drift: the route forwards the Lua
  // JSON unchanged, and the Lua builder prints exactly the documented keys.
  const lua = observeAreaCommand({ x: 1, y: 2, radius: 3 });
  assert.ok(lua.includes("done{ok=true,area={"));
  assert.ok(lua.includes("counts={total="));
  assert.ok(lua.includes("entities=entities"));
  assert.ok(lua.includes("truncated=matched>#entities"));
  assert.ok(lua.includes("player_only=player_only"));
});
