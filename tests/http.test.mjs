import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { API_SCHEMA_VERSION, clampInt, json, parseRconJson, readJson } from "../dist/http/plumbing.js";
import { contentType, handleStatic, resolveStaticTarget, staticRedirect } from "../dist/http/static.js";
import { Router, matchRoute } from "../dist/http/router.js";

// Pure HTTP plumbing / static / router tests: no manager, no game, no ports.
// Static tests use temp directories only.

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

function fakeRequest(url, method = "GET") {
  return { url, method, headers: { host: "localhost" } };
}

test("json() keeps the schema_version envelope and content headers", () => {
  const res = fakeResponse();
  json(res, 201, { ok: true, save: "test.zip" });
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers["Content-Type"], "application/json");
  assert.equal(Number(res.headers["Content-Length"]), Buffer.byteLength(res.body));
  const parsed = JSON.parse(res.body);
  assert.deepEqual(parsed, { schema_version: API_SCHEMA_VERSION, ok: true, save: "test.zip" });
  // schema_version comes first so existing clients keep a stable field order.
  assert.deepEqual(Object.keys(parsed), ["schema_version", "ok", "save"]);
});

test("json() wraps non-object bodies in data and lets objects override schema_version", () => {
  const arrayRes = fakeResponse();
  json(arrayRes, 200, [1, 2, 3]);
  assert.deepEqual(JSON.parse(arrayRes.body), { schema_version: API_SCHEMA_VERSION, data: [1, 2, 3] });
  const nullRes = fakeResponse();
  json(nullRes, 404, null);
  assert.deepEqual(JSON.parse(nullRes.body), { schema_version: API_SCHEMA_VERSION, data: null });
  const overrideRes = fakeResponse();
  json(overrideRes, 200, { schema_version: 99, ok: true });
  assert.deepEqual(JSON.parse(overrideRes.body), { schema_version: 99, ok: true });
});

test("readJson() parses bodies, returns null for empty bodies and rejects oversized ones", async () => {
  assert.deepEqual(await readJson(Readable.from([Buffer.from('{"a":1}')])), { a: 1 });
  assert.equal(await readJson(Readable.from([])), null);
  await assert.rejects(readJson(Readable.from([Buffer.from("not json")])), SyntaxError);
  await assert.rejects(readJson(Readable.from([Buffer.alloc(1_000_001)])), {
    message: "Request body too large",
  });
});

test("clampInt() truncates and clamps finite values, falling back on non-finite input", () => {
  assert.equal(clampInt("7", 3, 1, 10), 7);
  assert.equal(clampInt(7.9, 3, 1, 10), 7);
  assert.equal(clampInt(0, 3, 1, 10), 1);
  assert.equal(clampInt(99, 3, 1, 10), 10);
  assert.equal(clampInt("nope", 3, 1, 10), 3);
  assert.equal(clampInt(undefined, 3, 1, 10), 3);
  assert.equal(clampInt(Infinity, 3, 1, 10), 3);
});

test("parseRconJson() returns parsed JSON and throws the caller's message on malformed replies", () => {
  assert.deepEqual(parseRconJson('{"ok":true}', "bad reply"), { ok: true });
  assert.deepEqual(parseRconJson('  {"nested":{"a":[1,2]}}  ', "bad reply"), { nested: { a: [1, 2] } });
  assert.equal(parseRconJson("null", "bad reply"), null);
  assert.throws(() => parseRconJson("not json", "RCON build returned invalid JSON"), {
    message: "RCON build returned invalid JSON",
  });
  assert.throws(() => parseRconJson("", "empty reply"), { message: "empty reply" });
});

test("contentType() maps dashboard asset extensions", () => {
  assert.equal(contentType("/x/index.html"), "text/html; charset=utf-8");
  assert.equal(contentType("/x/app.js"), "application/javascript; charset=utf-8");
  assert.equal(contentType("/x/runs.css"), "text/css; charset=utf-8");
  assert.equal(contentType("/x/data.json"), "application/json; charset=utf-8");
  assert.equal(contentType("/x/icon.png"), "image/png");
  assert.equal(contentType("/icons/brain.svg"), "image/svg+xml");
  assert.equal(contentType("/x/file.bin"), "application/octet-stream");
});

test("staticRedirect() preserves the legacy /runs.html aliases", () => {
  assert.equal(staticRedirect("/index.html", new URLSearchParams()), null);
  assert.equal(staticRedirect("/runs.html", new URLSearchParams()), "/");
  assert.equal(staticRedirect("/runs.html", new URLSearchParams({ run: "abc" })), "/run.html?run=abc");
  assert.equal(
    staticRedirect("/runs.html", new URLSearchParams({ run: "abc", recording: "1" })),
    "/recording.html?run=abc",
  );
  assert.equal(staticRedirect("/runs.html", new URLSearchParams({ recording: "1" })), "/recording.html");
  assert.equal(staticRedirect("/runs.html", new URLSearchParams({ run: "a b" })), "/run.html?run=a%20b");
});

test("resolveStaticTarget() maps paths under the public dir and forbids escapes", () => {
  const publicDir = path.join(os.tmpdir(), "autorio-public");
  assert.deepEqual(resolveStaticTarget(publicDir, "/"), {
    kind: "file",
    filePath: path.join(publicDir, "index.html"),
  });
  assert.deepEqual(resolveStaticTarget(publicDir, "/js/runs.js"), {
    kind: "file",
    filePath: path.join(publicDir, "js/runs.js"),
  });
  assert.deepEqual(resolveStaticTarget(publicDir, "/../secret.txt"), { kind: "forbidden" });
});

test("handleStatic() serves files with no-store, redirects aliases and 404s misses", async () => {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), "autorio-static-"));
  try {
    fs.writeFileSync(path.join(publicDir, "index.html"), "<!doctype html><title>autorio</title>");
    fs.writeFileSync(path.join(publicDir, "app.js"), "console.log('app');");
    const served = fakeResponse();
    await handleStatic(fakeRequest("/"), served, { publicDir });
    assert.equal(served.statusCode, 200);
    assert.equal(served.headers["Content-Type"], "text/html; charset=utf-8");
    assert.equal(served.headers["Cache-Control"], "no-store");
    assert.equal(served.body.toString("utf8"), "<!doctype html><title>autorio</title>");

    const script = fakeResponse();
    await handleStatic(fakeRequest("/app.js"), script, { publicDir });
    assert.equal(script.statusCode, 200);
    assert.equal(script.headers["Content-Type"], "application/javascript; charset=utf-8");

    const redirect = fakeResponse();
    await handleStatic(fakeRequest("/runs.html?run=abc"), redirect, { publicDir });
    assert.equal(redirect.statusCode, 302);
    assert.equal(redirect.headers.Location, "/run.html?run=abc");

    const missing = fakeResponse();
    await handleStatic(fakeRequest("/missing.html"), missing, { publicDir });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.body, "Not found");
  } finally {
    fs.rmSync(publicDir, { recursive: true, force: true });
  }
});

test("matchRoute() enforces methods, exact paths, regex params and named params", () => {
  const route = { method: "GET", path: "/api/saves", handler: () => undefined };
  assert.deepEqual(matchRoute(route, "GET", "/api/saves"), {});
  assert.equal(matchRoute(route, "POST", "/api/saves"), undefined);
  assert.equal(matchRoute(route, "GET", "/api/other"), undefined);

  const regexRoute = {
    method: ["GET", "POST"],
    path: /^\/api\/runs\/([^/]+)(?:\/(stop|resume))?$/,
    params: ["id", "action"],
    handler: () => undefined,
  };
  assert.deepEqual(matchRoute(regexRoute, "GET", "/api/runs/abc"), { id: "abc" });
  assert.deepEqual(matchRoute(regexRoute, "POST", "/api/runs/abc/stop"), { id: "abc", action: "stop" });
  assert.equal(matchRoute(regexRoute, "PUT", "/api/runs/abc"), undefined);
  assert.equal(matchRoute(regexRoute, "GET", "/api/runs"), undefined);

  const anyMethod = { path: /^\/api\/agent\/act\//, handler: () => undefined };
  assert.deepEqual(matchRoute(anyMethod, "DELETE", "/api/agent/act/build"), {});
});

test("Router keeps registration order as precedence and reports unmatched requests", () => {
  const calls = [];
  const router = new Router();
  router.add({
    path: /^\/api\/x\//,
    name: "guard",
    handler: () => {
      calls.push("guard");
      return false;
    },
  });
  router.add({
    method: "GET",
    path: "/api/x/y",
    name: "specific",
    handler: () => {
      calls.push("specific");
    },
  });
  assert.equal(router.match("GET", "/api/x/y").route.name, "guard");
  assert.equal(router.match("GET", "/api/nope"), undefined);
  assert.equal(router.list().length, 2);
});

test("Router.dispatch() runs handlers in order, honors fall-through and reports handled state", async () => {
  const res = fakeResponse();
  const router = new Router();
  router.add({
    path: /^\/api\//,
    handler: () => false,
  });
  router.add({
    method: "GET",
    path: "/api/handled",
    handler: ({ res: response, url }) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ query: url.searchParams.get("q") }));
    },
  });
  assert.equal(await router.dispatch(fakeRequest("/api/handled?q=1"), res), true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { query: "1" });

  const unknown = fakeResponse();
  assert.equal(await router.dispatch(fakeRequest("/api/unknown"), unknown), false);
  assert.equal(unknown.statusCode, 0);
  assert.equal(unknown.body, undefined);
});
