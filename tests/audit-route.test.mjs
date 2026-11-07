import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { registerAgentRoutes } from "../dist/api/agent.js";
import { Router } from "../dist/http/router.js";

// Refactor audit route: the audit must be anchored to the player-centered scan
// window echoed by the Lua observation, and only full-scope, base-radius audits
// may update the run's global refactor debt.

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

const FACTORY = {
  window: { x: 42, y: -7, radius: 120 },
  counts: {},
  totals: {},
  problems: {},
  containers: { total: 0, empty: 0 },
  empty_containers: [],
  alerts: [],
};
const CONNECTIONS = {
  window: { x: 42, y: -7, radius: 120 },
  counts: { belts: 0, inserters: 0, machines: 0, issues: 0 },
  inserters: [],
  belts: [],
  machines: [],
  issues: [],
};

function fakeContext() {
  const recorded = [];
  const context = {
    state: { save: null, logs: [], rcon: { connected: true, lastError: null } },
    runManager: {
      recordRefactorAudit: (audit) => {
        recorded.push(audit);
        return undefined;
      },
    },
    rconCommand: async (command) => {
      const payload = String(command).includes("empty_containers") ? FACTORY : CONNECTIONS;
      return JSON.stringify(payload);
    },
    actionJobs: {},
    nativeController: {},
  };
  return { context, recorded };
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

test("audit route uses the player-centered scan window and records full debt", async () => {
  const router = new Router();
  const { context, recorded } = fakeContext();
  registerAgentRoutes(router, context);
  const res = await dispatch(router, fakeRequest("/api/agent/observe/audit", "POST", {}));
  assert.equal(res.statusCode, 200);
  const body = jsonBody(res);
  assert.equal(body.ok, true);
  assert.deepEqual(body.data.window, { x: 42, y: -7, radius: 120 });
  assert.equal(body.data.debt_recorded, true);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].invalid_count, 0);
});

test("narrow or scoped-out audits stay advisory and do not overwrite run debt", async () => {
  const router = new Router();
  const { context, recorded } = fakeContext();
  registerAgentRoutes(router, context);
  for (const payload of [{ window: { x: 0, y: 0, radius: 40 }, scope: ["power"] }, { scope: ["rail"] }]) {
    const res = await dispatch(router, fakeRequest("/api/agent/observe/audit", "POST", payload));
    assert.equal(res.statusCode, 200);
    assert.equal(jsonBody(res).data.debt_recorded, false);
  }
  assert.equal(recorded.length, 0, "advisory audits must not update run debt");
});
