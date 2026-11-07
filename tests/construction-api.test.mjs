import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { registerConstructionRoutes } from "../dist/api/construction.js";
import { ConstructionPlanError } from "../dist/construction.js";
import { Router } from "../dist/http/router.js";

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

function fakeRequest(url, method = "GET", body) {
  const chunks =
    body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  const request = Readable.from(chunks);
  request.url = url;
  request.method = method;
  request.headers = { host: "localhost" };
  return request;
}

async function dispatch(router, request) {
  const response = fakeResponse();
  await router.dispatch(request, response);
  return response;
}

function body(response) {
  return JSON.parse(response.body);
}

function fakeContext() {
  const created = [];
  const plan = {
    plan_id: "pln_test",
    kind: "build",
    scope: "in_cluster",
    status: "issued",
    max_entities: 1,
  };
  const runManager = {
    constructionStatus: () => ({ mode: "planned", plan_required: true, audit_revision: 3 }),
    createConstructionPlan: (input) => {
      if (input.kind === "bad") {
        throw new ConstructionPlanError("PLAN_SCOPE_VIOLATION", "outside the cluster", { outside: 1 });
      }
      created.push(input);
      return plan;
    },
    constructionPlan: (id) => (id === "pln_test" ? plan : undefined),
    cancelConstructionPlan: (id) => {
      if (id !== "pln_test") throw new ConstructionPlanError("PLAN_BAD_REQUEST", "Plan not found", {}, 404);
      return { ...plan, status: "invalidated" };
    },
  };
  return { context: { runManager }, created, plan };
}

test("construction routes expose mode, issue plans and return structured errors", async () => {
  const router = new Router();
  const { context, created } = fakeContext();
  registerConstructionRoutes(router, context);

  const status = await dispatch(router, fakeRequest("/api/agent/construction"));
  assert.equal(status.statusCode, 200);
  assert.equal(body(status).data.mode, "planned");
  assert.equal(body(status).data.plan_required, true);

  const request = { kind: "build", entities: [{ name: "pipe", anchor: { x: 1, y: 2 } }] };
  const issued = await dispatch(router, fakeRequest("/api/agent/plan", "POST", request));
  assert.equal(issued.statusCode, 201);
  assert.equal(body(issued).data.plan_id, "pln_test");
  assert.deepEqual(created, [request]);

  const rejected = await dispatch(
    router,
    fakeRequest("/api/agent/plan", "POST", { kind: "bad", entities: [] }),
  );
  assert.equal(rejected.statusCode, 409);
  assert.equal(body(rejected).error, "PLAN_SCOPE_VIOLATION");
  assert.equal(body(rejected).outside, 1);

  const lookup = await dispatch(router, fakeRequest("/api/agent/plan/pln_test"));
  assert.equal(lookup.statusCode, 200);
  assert.equal(body(lookup).data.kind, "build");

  const missing = await dispatch(router, fakeRequest("/api/agent/plan/other"));
  assert.equal(missing.statusCode, 404);
  assert.equal(body(missing).error, "PLAN_NOT_FOUND");

  const cancelled = await dispatch(router, fakeRequest("/api/agent/plan/pln_test/cancel", "POST", {}));
  assert.equal(cancelled.statusCode, 200);
  assert.equal(body(cancelled).data.status, "invalidated");
});
