import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { registerRunsRoutes } from "../dist/api/runs.js";
import { Router } from "../dist/http/router.js";

function fakeResponse() {
  return {
    statusCode: 0,
    headers: undefined,
    body: "",
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk.toString();
    },
  };
}

function fakeRequest(url, method = "GET", body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.url = url;
  request.method = method;
  request.headers = { host: "localhost" };
  return request;
}

function fakeManager() {
  const catalogue = [
    {
      id: "0123456789abcdef",
      sha256: "a".repeat(64),
      blueprint_type: "blueprint",
      label: "Smelting",
      description: null,
      version: 1,
      entity_count: 3,
      tile_count: 1,
      width: 3,
      height: 3,
      top_entities: [{ name: "stone-furnace", count: 2 }],
      source: "saved",
      created_at: "2026-11-05T00:00:00.000Z",
      size_bytes: 100,
    },
  ];
  const calls = [];
  return {
    calls,
    blueprints: (id) => (id === "run-active" ? catalogue : []),
    activeRunId: () => "run-active",
    get: (id) => (id === "run-active" ? { id } : undefined),
    blueprint: (id, blueprintId) =>
      id === "run-active" && blueprintId === catalogue[0].id
        ? { ...catalogue[0], wire: "0wire", payload: { blueprint: { label: "Smelting" } } }
        : undefined,
    registerBlueprint: (id, input) => {
      calls.push({ id, input });
      return catalogue[0];
    },
    updateBlueprint: (id, blueprintId, input) => {
      calls.push({ id, blueprintId, input, action: "update" });
      return { ...catalogue[0], ...input };
    },
    deleteBlueprint: (id, blueprintId) => {
      calls.push({ id, blueprintId, action: "delete" });
      return true;
    },
  };
}

async function dispatch(router, req) {
  const res = fakeResponse();
  assert.equal(await router.dispatch(req, res), true);
  return res;
}

test("GET /api/blueprints lists the active run catalogue", async () => {
  const runManager = fakeManager();
  const router = new Router();
  registerRunsRoutes(router, { runManager });
  const res = await dispatch(router, fakeRequest("/api/blueprints"));
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.run_id, "run-active");
  assert.equal(body.count, 1);
  assert.equal(body.blueprints[0].label, "Smelting");
});

test("POST /api/blueprints registers a blueprint for the active run", async () => {
  const runManager = fakeManager();
  const router = new Router();
  registerRunsRoutes(router, { runManager });
  const res = await dispatch(
    router,
    fakeRequest("/api/blueprints", "POST", { blueprint: "0abc", label: "Smelting", source: "built" }),
  );
  assert.equal(res.statusCode, 201);
  assert.deepEqual(runManager.calls, [
    {
      id: "run-active",
      input: { blueprint: "0abc", label: "Smelting", source: "built", description: undefined },
    },
  ]);
});

test("run-scoped blueprint list and detail routes", async () => {
  const runManager = fakeManager();
  const router = new Router();
  registerRunsRoutes(router, { runManager });
  const list = await dispatch(router, fakeRequest("/api/runs/run-active/blueprints"));
  assert.equal(list.statusCode, 200);
  assert.equal(JSON.parse(list.body).blueprints.length, 1);
  const detail = await dispatch(router, fakeRequest("/api/runs/run-active/blueprints/0123456789abcdef"));
  assert.equal(detail.statusCode, 200);
  assert.equal(JSON.parse(detail.body).wire, "0wire");
  const missing = await dispatch(router, fakeRequest("/api/runs/missing/blueprints"));
  assert.equal(missing.statusCode, 404);
});

test("PATCH and DELETE manage one run-scoped blueprint", async () => {
  const runManager = fakeManager();
  const router = new Router();
  registerRunsRoutes(router, { runManager });
  const patched = await dispatch(
    router,
    fakeRequest("/api/runs/run-active/blueprints/0123456789abcdef", "PATCH", { label: "Renamed" }),
  );
  assert.equal(patched.statusCode, 200);
  assert.equal(JSON.parse(patched.body).blueprint.label, "Renamed");
  const deleted = await dispatch(
    router,
    fakeRequest("/api/runs/run-active/blueprints/0123456789abcdef", "DELETE"),
  );
  assert.equal(deleted.statusCode, 200);
  assert.equal(JSON.parse(deleted.body).deleted, "0123456789abcdef");
  assert.deepEqual(
    runManager.calls.map((call) => call.action),
    ["update", "delete"],
  );
});
