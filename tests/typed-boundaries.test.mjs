import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { ActionJobQueue, jobResultFromDispatch, splitJobPayload } from "../dist/action-jobs.js";
import { ObsRunRecorder, OBS_PROFILE, parseWindowItems, selectWindow } from "../dist/obs.js";
import { quotaError } from "../dist/quota.js";
import { verifyTimelapseMetadata } from "../dist/timelapse.js";

// Typed-boundary regression tests: the guards introduced around dynamic JSON
// (action-job envelopes, OBS websocket replies, agent error events, timelapse
// metadata) must keep the historical behaviour for valid payloads and fail
// softly instead of throwing TypeErrors for malformed ones. No manager, game,
// OBS instance or child process is involved.

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "autorio-typed-"));

async function withTempDir(run) {
  const dir = tempDir();
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("jobResultFromDispatch keeps the data.results[0] -> data -> envelope precedence", () => {
  assert.deepEqual(
    jobResultFromDispatch({ status: 200, body: { data: { results: [{ ok: true, id: 1 }] } } }),
    { ok: true, id: 1 },
  );
  // A data object without results is reported whole.
  assert.deepEqual(jobResultFromDispatch({ status: 200, body: { data: { ok: true, count: 2 } } }), {
    ok: true,
    count: 2,
  });
  // No data envelope at all falls back to the body itself.
  assert.deepEqual(jobResultFromDispatch({ status: 200, body: { ok: true } }), { ok: true });
  assert.equal(jobResultFromDispatch({ status: 200, body: null }), null);
  assert.equal(jobResultFromDispatch({ status: 200, body: "plain" }), "plain");
  // Falsy-but-present first results are preserved (null falls through, 0 does not).
  assert.equal(jobResultFromDispatch({ status: 200, body: { data: { results: [0] } } }), 0);
  assert.deepEqual(jobResultFromDispatch({ status: 200, body: { data: { results: [null] } } }), {
    results: [null],
  });
});

test("jobResultFromDispatch wraps non-2xx replies with the established error shape", () => {
  assert.deepEqual(
    jobResultFromDispatch({
      status: 409,
      body: { error: "RCON not connected", data: { results: [{ ok: true }] } },
    }),
    { ok: false, error: "RCON not connected", detail: { ok: true } },
  );
  assert.deepEqual(jobResultFromDispatch({ status: 500, body: "not json object" }), {
    ok: false,
    error: "HTTP 500",
    detail: "not json object",
  });
  // A malformed error field falls back to the HTTP status text.
  assert.deepEqual(jobResultFromDispatch({ status: 503, body: { error: 42 } }), {
    ok: false,
    error: "HTTP 503",
    detail: { error: 42 },
  });
});

test("splitJobPayload keeps per-item shapes for non-object payloads", () => {
  assert.deepEqual(splitJobPayload("build", { entities: [{ name: "inserter" }] }), [
    { entities: [{ name: "inserter" }], clear_obstacles: true },
  ]);
  assert.deepEqual(splitJobPayload("build", { entities: [{ name: "inserter" }], clear_obstacles: false }), [
    { entities: [{ name: "inserter" }], clear_obstacles: false },
  ]);
  // Non-object payloads have no entities/targets, so bracket actions have no work.
  assert.deepEqual(splitJobPayload("build", "not-an-object"), []);
  assert.deepEqual(splitJobPayload("build", null), []);
  assert.deepEqual(splitJobPayload("mine", { targets: "not-an-array" }), []);
  assert.deepEqual(splitJobPayload("move", null), []);
  // Whole-payload actions still forward the original value verbatim.
  assert.deepEqual(splitJobPayload("craft", { item: "iron-gear-wheel" }), [{ item: "iron-gear-wheel" }]);
  assert.deepEqual(splitJobPayload("research", null), [{}]);
});

test("queue reports malformed HTTP replies as failed jobs instead of crashing", async () => {
  const replies = [
    () => ({ status: 200, raw: "not json" }),
    () => ({ status: 200, body: { data: { results: [{ ok: true }] } } }),
  ];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const reply = replies.shift()?.() ?? { status: 200, body: {} };
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(reply.raw ?? JSON.stringify(reply.body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const queue = new ActionJobQueue({ port, internalKey: "typed-boundaries", cleanupIntervalMs: 60_000 });
  try {
    const failed = queue.submit("craft", { item: "iron-gear-wheel" }, null);
    await queue.drain();
    const failedJob = queue.publicJob(failed.id);
    assert.equal(failedJob.status, "failed");
    assert.match(failedJob.error, /not valid JSON|Unexpected/);

    const succeeded = queue.submit("craft", { item: "iron-gear-wheel" }, null);
    await queue.drain();
    assert.deepEqual(queue.publicJob(succeeded.id).results, [{ ok: true }]);
  } finally {
    queue.close();
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
  }
});

test("parseWindowItems normalizes OBS property lists and drops non-object entries", () => {
  const items = parseWindowItems([
    { itemName: "[Factorio] Factorio", itemValue: 11, itemEnabled: true },
    { itemName: 42, itemValue: "id" },
    "garbage",
    null,
  ]);
  assert.deepEqual(items, [
    { itemEnabled: true, itemName: "[Factorio] Factorio", itemValue: 11 },
    { itemEnabled: undefined, itemName: undefined, itemValue: "id" },
  ]);
  assert.equal(selectWindow(items, "game", "run-id"), 11);
  assert.deepEqual(parseWindowItems(undefined), []);
  assert.deepEqual(parseWindowItems({ propertyItems: [] }), []);
});

test("OBS recorder reports a missing response field instead of a TypeError", async () => {
  await withTempDir(async (dir) => {
    let closed = false;
    const calls = [];
    const client = {
      close() {
        closed = true;
      },
      async request(type) {
        calls.push(type);
        // Advertise a working profile switch but never return a record directory.
        if (type === "GetProfileList") return { currentProfileName: OBS_PROFILE, profiles: [OBS_PROFILE] };
        return {};
      },
    };
    await assert.rejects(ObsRunRecorder.start(dir, client), /OBS response is missing recordDirectory/);
    assert.equal(closed, true);
    assert.ok(calls.includes("GetRecordDirectory"));
  });
});

test("quotaError tolerates unknown event shapes and keeps classifying real errors", () => {
  for (const value of [null, undefined, "string", 42, true, [], { type: "error" }, { type: 42 }]) {
    assert.equal(quotaError(value), undefined);
  }
  assert.equal(quotaError({ type: "error", message: 42 }), undefined);
  assert.match(
    quotaError({ type: "turn.failed", error: { code: "usage_limit_exceeded", message: "Account limit" } }),
    /Account limit/,
  );
  assert.ok(quotaError({ type: "error", message: "You've hit your usage limit. Try again later." }));
  assert.equal(quotaError({ type: "error", message: "network disconnected" }), undefined);
});

test("verifyTimelapseMetadata rejects non-numeric metadata instead of throwing TypeError", () => {
  for (const value of [
    null,
    undefined,
    "metadata",
    [],
    { fps: "30", frames: 30 },
    { fps: 30, frames: "30" },
  ]) {
    assert.throws(() => verifyTimelapseMetadata(value), /Timelapse output verification failed/);
  }
  assert.doesNotThrow(() => verifyTimelapseMetadata({ fps: 30.000001907348633, frames: 35856 }));
});

test("failureCount only counts explicit per-item failures", async () => {
  const dir = tempDir();
  const previous = process.env.AUTORIO_DATA_DIR;
  process.env.AUTORIO_DATA_DIR = dir;
  try {
    const { failureCount } = await import("../dist/runs.js");
    assert.equal(failureCount([{ ok: false }, { ok: true }, null, "text", { ok: false }, {}]), 2);
    assert.equal(failureCount([]), 0);
  } finally {
    if (previous === undefined) delete process.env.AUTORIO_DATA_DIR;
    else process.env.AUTORIO_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
