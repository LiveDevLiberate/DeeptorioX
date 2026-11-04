import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger, configureLogger, logger, normalizeLevel } from "../dist/logger.js";
import { HEALTH_SCHEMA_VERSION, healthPayload, healthStatusCode } from "../dist/health.js";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autorio-observability-"));
}

function readRecords(file) {
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function withTempDir(run) {
  const dir = tempDir();
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("logger appends JSONL records with level, ISO timestamp and context", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "nested", "manager.log");
    const log = createLogger({ file, console: false });
    log.info("manager ready", { port: 3000 });
    log.warn("slow request", { duration_ms: 12 });
    const records = readRecords(file);
    assert.equal(records.length, 2);
    assert.equal(records[0].level, "info");
    assert.equal(records[0].msg, "manager ready");
    assert.equal(records[0].port, 3000);
    assert.ok(!Number.isNaN(Date.parse(records[0].ts)), "ts must be an ISO timestamp");
    assert.equal(records[1].level, "warn");
    assert.equal(records[1].duration_ms, 12);
    // Appending from a fresh logger keeps earlier records.
    createLogger({ file, console: false }).info("second writer");
    assert.equal(readRecords(file).length, 3);
  });
});

test("logger filters levels and honors AUTORIO_LOG_LEVEL", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "levels.log");
    const log = createLogger({ file, level: "warn", console: false });
    log.debug("hidden debug");
    log.info("hidden info");
    log.warn("shown warn");
    log.error("shown error");
    assert.deepEqual(
      readRecords(file).map((record) => record.level),
      ["warn", "error"],
    );
    // Debug is enabled when the environment selects it.
    const previous = process.env.AUTORIO_LOG_LEVEL;
    process.env.AUTORIO_LOG_LEVEL = "debug";
    try {
      const debugFile = path.join(dir, "debug.log");
      createLogger({ file: debugFile, console: false }).debug("visible debug");
      assert.equal(readRecords(debugFile)[0].msg, "visible debug");
    } finally {
      if (previous === undefined) delete process.env.AUTORIO_LOG_LEVEL;
      else process.env.AUTORIO_LOG_LEVEL = previous;
    }
    // An unknown level name falls back to info and an empty log stays uncreated.
    assert.equal(normalizeLevel("verbose"), "info");
    const invalidFile = path.join(dir, "invalid.log");
    createLogger({ file: invalidFile, level: "verbose", console: false }).debug("hidden");
    assert.equal(fs.existsSync(invalidFile), false);
  });
});

test("logger never writes secrets for password/token/api_key/secret/authorization keys", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "redact.log");
    const log = createLogger({ file, console: false });
    log.info("connect", {
      password: "hunter2",
      token: "tok_live_123",
      api_key: "key-1",
      apiKey: "key-2",
      secret: "s3cr3t",
      authorization: "Bearer abc",
      headers: { Authorization: "Bearer nested", accept: "application/json" },
      nested: [{ password: "pw", safe: 1 }],
      safe: "ok",
    });
    const [record] = readRecords(file);
    for (const key of ["password", "token", "api_key", "apiKey", "secret", "authorization"]) {
      assert.equal(record[key], "[redacted]", `${key} must be redacted`);
    }
    assert.equal(record.headers.Authorization, "[redacted]");
    assert.equal(record.headers.accept, "application/json");
    assert.equal(record.nested[0].password, "[redacted]");
    assert.equal(record.nested[0].safe, 1);
    assert.equal(record.safe, "ok");
    const text = fs.readFileSync(file, "utf8");
    for (const secret of ["hunter2", "tok_live_123", "s3cr3t", "Bearer abc", "Bearer nested", "pw"]) {
      assert.ok(!text.includes(secret), `log file must not contain ${secret}`);
    }
  });
});

test("child loggers inherit the sink and merge scoped context", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "children.log");
    const parent = createLogger({ file, console: false });
    const http = parent.child({ component: "http", token: "child-secret", request_id: "r1" });
    const nested = http.child({ route: "/api/health" });
    parent.info("root");
    http.info("request", { status: 200 });
    nested.warn("slow", { duration_ms: 3 });
    const records = readRecords(file);
    assert.equal(records[0].component, undefined);
    assert.equal(records[1].component, "http");
    assert.equal(records[1].token, "[redacted]");
    assert.equal(records[1].request_id, "r1");
    assert.equal(records[1].status, 200);
    assert.equal(records[2].level, "warn");
    assert.equal(records[2].component, "http");
    assert.equal(records[2].route, "/api/health");
    assert.equal(records[2].request_id, "r1");
    assert.equal(records[2].duration_ms, 3);
  });
});

test("logger mirrors one human-readable line per record to the console sink", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "human.log");
    const lines = [];
    const log = createLogger({ file, console: { write: (line) => lines.push(line) } });
    log.info("Server listening", { component: "manager", port: 3000 });
    assert.equal(lines.length, 1);
    assert.match(lines[0], / INFO\s+\[manager\] Server listening port=3000\n$/);
    assert.equal(lines[0].match(/\n/g).length, 1);
    log.warn("first\nsecond");
    assert.equal(lines.length, 2);
    assert.equal(lines[1].match(/\n/g).length, 1);
    assert.match(lines[1], / first second\n$/);
    createLogger({ file, console: false }).info("silent");
    assert.equal(lines.length, 2);
  });
});

test("logger survives errors, buffers and circular context", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "resilience.log");
    const log = createLogger({ file, console: { write: () => {} } });
    const circular = { name: "loop" };
    circular.self = circular;
    assert.doesNotThrow(() =>
      log.error("failed", {
        error: new Error("boom"),
        buffer: Buffer.from("secret-bytes"),
        circular,
        at: new Date("2026-01-01T00:00:00.000Z"),
      }),
    );
    const [record] = readRecords(file);
    assert.equal(record.error.name, "Error");
    assert.equal(record.error.message, "boom");
    assert.equal(record.buffer, "<Buffer 12 bytes>");
    assert.equal(record.at, "2026-01-01T00:00:00.000Z");
    assert.equal(record.circular.self, "[circular]");
  });
});

test("configureLogger reconfigures the shared logger and its children", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "configured.log");
    configureLogger({ file, level: "debug", console: false });
    try {
      assert.equal(logger.level, "debug");
      assert.equal(logger.file, file);
      logger.debug("configured", { component: "test" });
      logger.child({ component: "http" }).info("request", { status: 204 });
      const records = readRecords(file);
      assert.equal(records[0].msg, "configured");
      assert.equal(records[0].component, "test");
      assert.equal(records[1].component, "http");
      assert.equal(records[1].status, 204);
    } finally {
      configureLogger({ file: null, console: false });
    }
  });
});

const ISO_START = "2026-01-01T00:00:00.000Z";

test("health payload reports ok for healthy probes", () => {
  const payload = healthPayload({
    timestamp: () => new Date("2026-01-01T00:01:05.000Z"),
    startedAt: Date.parse(ISO_START),
    game: () => ({ running: true, rcon: true }),
    activeRun: () => ({ id: "run-1", state: "running", agent: "codex" }),
    versions: { node: "v20.0.0", api_schema: 2 },
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "ok");
  assert.equal(payload.timestamp, "2026-01-01T00:01:05.000Z");
  assert.equal(payload.uptime_seconds, 65);
  assert.deepEqual(payload.game, { running: true, rcon_connected: true });
  assert.deepEqual(payload.active_run, { id: "run-1", state: "running", agent: "codex" });
  assert.deepEqual(payload.versions, { node: "v20.0.0", api_schema: 2 });
  assert.deepEqual(payload.problems, []);
  assert.equal(payload.schema_version, HEALTH_SCHEMA_VERSION);
  assert.equal(healthStatusCode(payload), 200);
});

test("an idle manager with no game running is still healthy", () => {
  const payload = healthPayload({
    timestamp: () => Date.parse(ISO_START),
    startedAt: Date.parse(ISO_START),
    game: () => ({ running: false, rcon: false }),
    activeRun: () => null,
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "ok");
  assert.equal(payload.uptime_seconds, 0);
  assert.deepEqual(payload.game, { running: false, rcon_connected: false });
  assert.equal(payload.active_run, null);
  assert.equal(healthStatusCode(payload), 200);
});

test("defaults are safe when no probes are supplied", () => {
  const payload = healthPayload();
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "ok");
  assert.equal(payload.uptime_seconds, 0);
  assert.deepEqual(payload.game, { running: false, rcon_connected: false });
  assert.equal(payload.active_run, null);
  assert.deepEqual(payload.versions, {});
  assert.ok(!Number.isNaN(Date.parse(payload.timestamp)));
  assert.equal(healthStatusCode(payload), 200);
});

test("throwing probes degrade the payload instead of throwing", () => {
  const payload = healthPayload({
    timestamp: () => {
      throw new Error("clock failed");
    },
    startedAt: () => {
      throw new Error("start failed");
    },
    game: () => {
      throw new Error("game failed");
    },
    activeRun: () => {
      throw new Error("run failed");
    },
    versions: () => {
      throw new Error("versions failed");
    },
  });
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "degraded");
  assert.equal(healthStatusCode(payload), 503);
  assert.deepEqual(payload.problems, ["timestamp", "started_at", "game", "active_run", "versions"]);
  assert.ok(!Number.isNaN(Date.parse(payload.timestamp)));
  assert.equal(payload.uptime_seconds, 0);
  assert.deepEqual(payload.game, { running: false, rcon_connected: false });
  assert.equal(payload.active_run, null);
  assert.deepEqual(payload.versions, {});
});

test("a single failing probe degrades only its own section", () => {
  const payload = healthPayload({
    timestamp: () => new Date("2026-01-01T00:10:00.000Z"),
    startedAt: Date.parse(ISO_START),
    game: () => {
      throw new Error("game failed");
    },
    activeRun: () => ({ id: "run-2", state: "saving", agent: "opencode" }),
    versions: { node: process.version },
  });
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "degraded");
  assert.deepEqual(payload.problems, ["game"]);
  assert.equal(payload.uptime_seconds, 600);
  assert.deepEqual(payload.game, { running: false, rcon_connected: false });
  assert.deepEqual(payload.active_run, { id: "run-2", state: "saving", agent: "opencode" });
  assert.deepEqual(payload.versions, { node: process.version });
  assert.equal(healthStatusCode(payload), 503);
});

test("malformed non-throwing probe values degrade the payload", () => {
  const payload = healthPayload({
    game: () => null,
    activeRun: () => "not-a-run",
    versions: () => ["not", "an", "object"],
    startedAt: () => Number.NaN,
  });
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "degraded");
  assert.ok(payload.problems.includes("game"));
  assert.ok(payload.problems.includes("active_run"));
  assert.ok(payload.problems.includes("versions"));
  assert.ok(payload.problems.includes("started_at"));
  assert.deepEqual(payload.game, { running: false, rcon_connected: false });
  assert.equal(payload.active_run, null);
  assert.deepEqual(payload.versions, {});
});

test("health schema version can follow the API schema", () => {
  assert.equal(healthPayload().schema_version, HEALTH_SCHEMA_VERSION);
  assert.equal(healthPayload({ schemaVersion: 2 }).schema_version, 2);
  assert.equal(healthPayload({ schemaVersion: Number.NaN }).schema_version, HEALTH_SCHEMA_VERSION);
});

test("status code mapping is 200 for ok and 503 for degraded", () => {
  assert.equal(healthStatusCode({ ok: true, status: "ok" }), 200);
  assert.equal(healthStatusCode({ ok: false, status: "degraded" }), 503);
  assert.equal(healthStatusCode({ ok: false, status: "ok" }), 503);
});

test("server wires GET /api/health and routed request logging without console.log", () => {
  const source = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  // `server.ts` (lifecycle + logging) and `src/api/server.ts` (route groups)
  // must both stay wired: keep the intent even as server.ts is decomposed.
  const api = source("../src/api/server.ts");
  const server = source("../src/server.ts");
  assert.match(api, /"\/api\/health"/);
  assert.match(api, /healthPayload\(/);
  assert.match(api, /healthStatusCode\(payload\)/);
  assert.match(api, /from "\.\.\/health\.js"/);
  assert.match(server, /from "\.\/logger\.js"/);
  assert.match(server, /configureLogger\(\{/);
  assert.match(server, /path\.join\(DATA_DIR, "manager\.log"\)/);
  assert.match(server, /logger\.info\("Server listening"/);
  assert.match(server, /logger\.child\(\{ component: "http" \}\)/);
  assert.match(server, /httpLog\.info\("request"/);
  assert.doesNotMatch(server, /console\.log\(/);
});
