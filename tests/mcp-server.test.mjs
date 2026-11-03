import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../dist/mcp-server.js", import.meta.url));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Fake manager: records every request and answers from a route table keyed by
// "<METHOD> <pathname>". Tests install routes before issuing tools/call.
async function startFakeManager() {
  const requests = [];
  const routes = new Map();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      const url = new URL(req.url, "http://127.0.0.1");
      const request = { method: req.method, path: url.pathname, headers: req.headers, body };
      requests.push(request);
      const handler = routes.get(`${req.method} ${url.pathname}`);
      const reply = handler ? handler(request) : { status: 404, body: { error: "not found" } };
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    requests,
    route: (method, pathname, handler) => routes.set(`${method} ${pathname}`, handler),
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Minimal MCP stdio client: writes newline-delimited JSON-RPC and resolves
// responses by id, keeping every stdout line for the transport-purity check.
function startMcpServer(baseUrl) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AUTORIO_API_BASE: baseUrl },
  });
  const pending = new Map();
  const messages = [];
  const stderr = [];
  let nextId = 1;

  const output = createInterface({ input: child.stdout });
  output.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      messages.push({ raw: line, parseError: error.message });
      return;
    }
    messages.push(message);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function request(method, params) {
    const id = nextId++;
    const response = new Promise((resolve) => pending.set(id, { resolve }));
    send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    return withTimeout(response, 5000, `${method} response`);
  }
  function notify(method, params) {
    send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }
  async function stop() {
    child.stdin.end();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), 3000);
    });
    const result = await Promise.race([exited, timeout]);
    clearTimeout(timer);
    if (result === "timeout") child.kill();
  }

  return { request, notify, stop, messages, stderr };
}

let fake;
let mcp;

before(async () => {
  assert.ok(fs.existsSync(serverPath), `Missing ${serverPath}; run "npm run build" first`);
  fake = await startFakeManager();
  mcp = startMcpServer(fake.baseUrl);
});

after(async () => {
  await mcp?.stop();
  await fake?.close();
});

test("initialize negotiates the protocol version and advertises tools", async () => {
  const response = await mcp.request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "autor-mcp-test", version: "1.0.0" },
  });
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.result.protocolVersion, "2025-03-26");
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.equal(response.result.serverInfo.name, "autorio");
  assert.equal(typeof response.result.serverInfo.version, "string");
  mcp.notify("notifications/initialized", {});

  // Older supported versions are echoed; unknown versions fall back to latest.
  const older = await mcp.request("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(older.result.protocolVersion, "2024-11-05");
  const unknown = await mcp.request("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.result.protocolVersion, "2025-03-26");
});

test("tools/list exposes the autorio gameplay tools with input schemas", async () => {
  const response = await mcp.request("tools/list", {});
  const tools = response.result.tools;
  assert.ok(Array.isArray(tools));
  const names = tools.map((tool) => tool.name);
  for (const expected of [
    "observe_world",
    "observe_map",
    "observe_player",
    "observe_research",
    "observe_recipes",
    "observe_factory",
    "observe_layout",
    "observe_connections",
    "observe_placement",
    "observe_resources",
    "build",
    "mine",
    "move",
    "rotate",
    "set_recipe",
    "craft",
    "insert",
    "extract",
    "research",
    "launch_rocket",
    "server_status",
    "list_runs",
    "list_benchmarks",
    "job_status",
    "cancel_job",
  ]) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
  for (const tool of tools) {
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(typeof tool.inputSchema.properties, "object");
  }
  const build = tools.find((tool) => tool.name === "build");
  assert.deepEqual(build.inputSchema.required, ["entities"]);
  assert.equal(build.inputSchema.properties.entities.type, "array");
  assert.match(build.description, /job_status/);
});

test("tools/call maps observe_world to POST /api/agent/observe/world", async () => {
  const body = { ok: true, data: { tiles: [], entities: [] }, truncated: false };
  fake.route("POST", "/api/agent/observe/world", () => ({ status: 200, body }));
  const response = await mcp.request("tools/call", {
    name: "observe_world",
    arguments: { x: 5, y: 6, radius: 7, include: ["terrain"] },
  });
  assert.equal(response.result.isError, undefined);
  assert.deepEqual(JSON.parse(response.result.content[0].text), body);
  assert.deepEqual(response.result.structuredContent, body);
  const request = fake.requests.filter((entry) => entry.path === "/api/agent/observe/world").at(-1);
  assert.equal(request.method, "POST");
  assert.deepEqual(request.body, { window: { x: 5, y: 6, radius: 7 }, include: ["terrain"] });
});

test("tools/call submits build through the asynchronous job API", async () => {
  const job = {
    job_id: "job-build-1",
    action: "build",
    status: "queued",
    progress: { completed: 0, total: 1 },
    results: [],
    error: null,
    cancel_requested: false,
  };
  fake.route("POST", "/api/agent/jobs", () => ({ status: 202, body: job }));
  const entities = [{ name: "stone-furnace", anchor: { x: 10, y: 10 } }];
  const response = await mcp.request("tools/call", {
    name: "build",
    arguments: { entities, clear_obstacles: false, idempotency_key: "build-1" },
  });
  assert.equal(response.result.isError, undefined);
  assert.deepEqual(response.result.structuredContent, job);
  assert.deepEqual(JSON.parse(response.result.content[0].text), job);
  const request = fake.requests.filter((entry) => entry.path === "/api/agent/jobs").at(-1);
  assert.equal(request.method, "POST");
  assert.deepEqual(request.body, {
    action: "build",
    payload: { entities, clear_obstacles: false },
    idempotency_key: "build-1",
  });
});

test("job_status polls GET /api/agent/jobs/:id and cancel_job posts /cancel", async () => {
  const job = {
    job_id: "job-build-1",
    action: "build",
    status: "completed",
    progress: { completed: 1, total: 1 },
    results: [{ ok: true }],
    error: null,
    cancel_requested: false,
  };
  fake.route("GET", "/api/agent/jobs/job-build-1", () => ({ status: 200, body: job }));
  fake.route("POST", "/api/agent/jobs/job-build-1/cancel", () => ({ status: 202, body: job }));

  const status = await mcp.request("tools/call", {
    name: "job_status",
    arguments: { job_id: "job-build-1" },
  });
  assert.deepEqual(status.result.structuredContent, job);
  const statusRequest = fake.requests.filter((entry) => entry.path === "/api/agent/jobs/job-build-1").at(-1);
  assert.equal(statusRequest.method, "GET");
  assert.equal(statusRequest.body, undefined);

  const cancel = await mcp.request("tools/call", {
    name: "cancel_job",
    arguments: { job_id: "job-build-1" },
  });
  assert.deepEqual(cancel.result.structuredContent, job);
  const cancelRequest = fake.requests
    .filter((entry) => entry.path === "/api/agent/jobs/job-build-1/cancel")
    .at(-1);
  assert.equal(cancelRequest.method, "POST");
  assert.deepEqual(cancelRequest.body, {});
});

test("server_status maps to GET /api/server/status", async () => {
  const body = { running: false, port: 3000, save: null };
  fake.route("GET", "/api/server/status", () => ({ status: 200, body }));
  const response = await mcp.request("tools/call", { name: "server_status", arguments: {} });
  assert.deepEqual(response.result.structuredContent, body);
  const request = fake.requests.filter((entry) => entry.path === "/api/server/status").at(-1);
  assert.equal(request.method, "GET");
});

test("observation tools compose the documented HTTP body shapes", async () => {
  fake.route("POST", "/api/agent/observe/player", () => ({ status: 200, body: { ok: true, data: {} } }));
  fake.route("POST", "/api/agent/observe/layout", () => ({ status: 200, body: { ok: true, data: {} } }));
  fake.route("POST", "/api/agent/observe/recipes", () => ({ status: 200, body: { ok: true, data: {} } }));
  await mcp.request("tools/call", { name: "observe_player", arguments: { inventory_slots: 40 } });
  await mcp.request("tools/call", { name: "observe_layout", arguments: { radius: 20, step: 2 } });
  await mcp.request("tools/call", {
    name: "observe_recipes",
    arguments: { recipes: 10, unlocked_only: true },
  });
  const lastBody = (pathname) => fake.requests.filter((entry) => entry.path === pathname).at(-1).body;
  assert.deepEqual(lastBody("/api/agent/observe/player"), { limits: { inventory_slots: 40 } });
  assert.deepEqual(lastBody("/api/agent/observe/layout"), { window: { radius: 20, step: 2 } });
  assert.deepEqual(lastBody("/api/agent/observe/recipes"), {
    limits: { recipes: 10 },
    filters: { unlocked: true },
  });
});

test("action tools map payloads and job action names", async () => {
  fake.route("POST", "/api/agent/jobs", () => ({ status: 202, body: { job_id: "job-x", status: "queued" } }));
  await mcp.request("tools/call", {
    name: "insert",
    arguments: { entity: { x: 3, y: 4 }, item: "coal", count: 5 },
  });
  await mcp.request("tools/call", {
    name: "extract",
    arguments: { entity: { x: 3, y: 4 }, item: "iron-plate", count: "all" },
  });
  await mcp.request("tools/call", {
    name: "research",
    arguments: { technology: "automation" },
  });
  await mcp.request("tools/call", {
    name: "launch_rocket",
    arguments: { targets: [{ x: 10, y: 12 }] },
  });
  const bodies = fake.requests
    .filter((entry) => entry.path === "/api/agent/jobs")
    .slice(-4)
    .map((entry) => entry.body);
  assert.deepEqual(bodies, [
    { action: "insert", payload: { entity: { x: 3, y: 4 }, item: "coal", count: 5 } },
    { action: "extract", payload: { entity: { x: 3, y: 4 }, item: "iron-plate", count: "all" } },
    { action: "research", payload: { technology: "automation" } },
    { action: "launch-rocket", payload: { targets: [{ x: 10, y: 12 }] } },
  ]);
});

test("HTTP failures become isError tool results, not protocol errors", async () => {
  fake.route("POST", "/api/agent/observe/world", () => ({
    status: 503,
    body: { error: "RCON not connected" },
  }));
  const response = await mcp.request("tools/call", {
    name: "observe_world",
    arguments: {},
  });
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /HTTP 503: RCON not connected/);
  assert.deepEqual(response.result.structuredContent, { error: "RCON not connected" });
});

test("invalid tool arguments return a JSON-RPC invalid-params error", async () => {
  const response = await mcp.request("tools/call", { name: "build", arguments: {} });
  assert.equal(response.result, undefined);
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /entities/);
});

test("unknown tools return a JSON-RPC invalid-params error", async () => {
  const response = await mcp.request("tools/call", { name: "not_a_tool", arguments: {} });
  assert.equal(response.result, undefined);
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /not_a_tool/);
});

test("ping returns an empty result", async () => {
  const response = await mcp.request("ping", {});
  assert.deepEqual(response.result, {});
});

test("unknown methods return a JSON-RPC method-not-found error", async () => {
  const response = await mcp.request("resources/list", {});
  assert.equal(response.result, undefined);
  assert.equal(response.error.code, -32601);
  assert.match(response.error.message, /resources\/list/);
});

test("stdout carries only newline-delimited JSON-RPC messages", () => {
  assert.ok(mcp.messages.length >= 10, "expected a response per request");
  for (const message of mcp.messages) {
    assert.ok(!message.parseError, `non-JSON stdout line: ${message.raw}`);
    assert.equal(message.jsonrpc, "2.0");
    assert.equal(typeof message.id, "number", "every response must answer a request id");
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");
    assert.ok(hasResult !== hasError, "response must carry exactly one of result or error");
  }
});
