import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ActionJobQueue, splitJobPayload } from "../dist/action-jobs.js";

// The queue dispatches every job item back into the manager's own action routes
// over node:http, so these tests run it against a fake node:http API. No
// manager, RCON connection, native controller or Factorio process is involved.

const INTERNAL_KEY = "test-internal-key";

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function startFakeApi(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const entry = {
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      requests.push(entry);
      Promise.resolve(handler(entry, requests)).then(
        (reply) => {
          res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
          res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
        },
        () => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "fake api handler failed" }));
        },
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    requests,
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      await closed;
    },
  };
}

/** Starts a fake manager API and a queue wired to it, then always tears both down. */
async function harness(handler, run, options = {}) {
  const api = await startFakeApi(handler);
  const queue = new ActionJobQueue({
    port: api.port,
    internalKey: INTERNAL_KEY,
    cleanupIntervalMs: 60_000,
    ...options,
  });
  try {
    await run({ api, queue });
  } finally {
    queue.close();
    await api.close();
  }
}

async function waitFor(predicate, label = "condition", timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const successReply = () => ({ body: { data: { results: [{ ok: true }] } } });

test("splitJobPayload expands build entities and target lists into one item per action", () => {
  assert.deepEqual(
    splitJobPayload("build", {
      entities: [{ name: "transport-belt" }, { name: "inserter" }],
      clear_obstacles: true,
    }),
    [
      { entities: [{ name: "transport-belt" }], clear_obstacles: true },
      { entities: [{ name: "inserter" }], clear_obstacles: true },
    ],
  );
  // A missing clear_obstacles flag defaults to clearing, matching the API default.
  assert.deepEqual(splitJobPayload("build", { entities: [{ name: "stone-furnace" }] }), [
    { entities: [{ name: "stone-furnace" }], clear_obstacles: true },
  ]);
  assert.deepEqual(splitJobPayload("build", { entities: [{ name: "x" }], clear_obstacles: false }), [
    { entities: [{ name: "x" }], clear_obstacles: false },
  ]);
  assert.deepEqual(splitJobPayload("build", {}), []);
  for (const action of ["mine", "move", "path", "rotate", "set-recipe", "launch-rocket"]) {
    assert.deepEqual(splitJobPayload(action, { targets: [{ x: 1 }, { x: 2 }] }), [
      { targets: [{ x: 1 }] },
      { targets: [{ x: 2 }] },
    ]);
  }
  // Single-shot actions dispatch their payload as the only item.
  assert.deepEqual(splitJobPayload("craft", { item: "iron-gear-wheel", count: 2 }), [
    { item: "iron-gear-wheel", count: 2 },
  ]);
  assert.deepEqual(splitJobPayload("research", null), [{}]);
});

test("jobs run one at a time in submission order", async () => {
  const gate = deferred();
  const starts = [];
  let inFlight = 0;
  let maxInFlight = 0;
  await harness(
    async (request) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      starts.push(request.body.targets[0].x);
      if (request.body.targets[0].x === 1) await gate.promise;
      inFlight--;
      return { body: { data: { results: [{ ok: true, x: request.body.targets[0].x }] } } };
    },
    async ({ api, queue }) => {
      const first = queue.submit("move", { targets: [{ x: 1 }] }, null);
      await waitFor(() => starts.length === 1, "first dispatch");
      const second = queue.submit("move", { targets: [{ x: 2 }] }, null);
      assert.equal(queue.get(first.id).status, "running");
      assert.equal(queue.get(second.id).status, "queued");
      assert.deepEqual(queue.publicJob(second.id).progress, { completed: 0, total: 1 });
      assert.deepEqual(starts, [1]);
      gate.resolve();
      await queue.drain();
      assert.equal(maxInFlight, 1);
      assert.deepEqual(starts, [1, 2]);
      assert.equal(queue.get(first.id).status, "completed");
      assert.equal(queue.get(second.id).status, "completed");
      assert.deepEqual(
        api.requests.map((request) => request.body.targets[0].x),
        [1, 2],
      );
      assert.equal(api.requests.length, 2);
    },
  );
});

test("per-item dispatches carry progress and unwrap the first result", async () => {
  await harness(
    (request) => {
      const x = request.body.targets[0].x;
      if (x === 1)
        return {
          body: {
            data: {
              results: [
                { ok: true, name: "iron-ore" },
                { ok: true, name: "ignored" },
              ],
            },
          },
        };
      if (x === 2) return { body: { data: { tiles: 3 } } };
      return { body: { schema_version: 2 } };
    },
    async ({ queue }) => {
      const job = queue.submit("mine", { targets: [{ x: 1 }, { x: 2 }, { x: 3 }] }, null);
      await queue.drain();
      assert.equal(job.status, "completed");
      assert.equal(job.total, 3);
      assert.equal(job.completed, 3);
      assert.deepEqual(queue.publicJob(job.id).progress, { completed: 3, total: 3 });
      // `data.results[0] ?? data ?? envelope`: only the first result is kept.
      assert.deepEqual(job.results, [{ ok: true, name: "iron-ore" }, { tiles: 3 }, { schema_version: 2 }]);
    },
  );
});

test("per-item progress is visible while the next item is still running", async () => {
  const gate = deferred();
  await harness(
    async (request) => {
      if (request.body.targets[0].x === 2) await gate.promise;
      return successReply();
    },
    async ({ api, queue }) => {
      const job = queue.submit("mine", { targets: [{ x: 1 }, { x: 2 }] }, null);
      await waitFor(() => api.requests.length === 2, "second item dispatch");
      assert.equal(job.status, "running");
      assert.deepEqual(queue.publicJob(job.id).progress, { completed: 1, total: 2 });
      gate.resolve();
      await queue.drain();
      assert.deepEqual(queue.publicJob(job.id).progress, { completed: 2, total: 2 });
    },
  );
});

test("HTTP error responses become failed item results without failing the job", async () => {
  await harness(
    (request) => {
      const x = request.body.targets[0].x;
      if (x === 1) return { status: 409, body: { error: "cancelled" } };
      if (x === 2)
        return {
          status: 500,
          body: { error: "rcon_failed", data: { results: [{ ok: false, reason: "boom" }] } },
        };
      return { status: 503, body: {} };
    },
    async ({ queue }) => {
      const job = queue.submit("mine", { targets: [{ x: 1 }, { x: 2 }, { x: 3 }] }, null);
      await queue.drain();
      assert.equal(job.status, "completed");
      assert.equal(job.completed, 3);
      assert.equal(job.error, null);
      assert.deepEqual(job.results, [
        { ok: false, error: "cancelled", detail: { error: "cancelled" } },
        { ok: false, error: "rcon_failed", detail: { ok: false, reason: "boom" } },
        { ok: false, error: "HTTP 503", detail: {} },
      ]);
      assert.deepEqual(queue.publicJob(job.id).results, job.results);
    },
  );
});

test("idempotency keys deduplicate by action and dispatch the work once", async () => {
  const records = [];
  await harness(
    successReply,
    async ({ api, queue }) => {
      const first = queue.submit("craft", { item: "iron-gear-wheel", count: 1 }, "dup-key");
      const repeated = queue.submit("craft", { item: "iron-gear-wheel", count: 1 }, "dup-key");
      const otherAction = queue.submit("research", { technology: "automation" }, "dup-key");
      const unkeyedA = queue.submit("craft", { item: "iron-gear-wheel", count: 1 }, null);
      const unkeyedB = queue.submit("craft", { item: "iron-gear-wheel", count: 1 }, null);
      assert.equal(repeated.id, first.id);
      assert.notEqual(otherAction.id, first.id);
      assert.notEqual(unkeyedA.id, unkeyedB.id);
      await queue.drain();
      assert.equal(api.requests.length, 4);
      assert.equal(records.filter((entry) => entry.event === "submitted").length, 4);
      assert.equal(queue.get(first.id).status, "completed");
    },
    { onRecord: (event, record) => records.push({ event, record }) },
  );
});

test("cancelling the running job stops it between items and stops the native controller", async () => {
  const gate = deferred();
  const started = deferred();
  let stopCalls = 0;
  await harness(
    async (request) => {
      if (request.body.targets[0].x === 1) {
        started.resolve();
        await gate.promise;
      }
      return successReply();
    },
    async ({ api, queue }) => {
      const job = queue.submit("mine", { targets: [{ x: 1 }, { x: 2 }, { x: 3 }] }, null);
      await started.promise;
      const cancelled = await queue.cancel(job.id);
      assert.equal(cancelled.id, job.id);
      assert.equal(queue.publicJob(job.id).cancel_requested, true);
      assert.equal(stopCalls, 1);
      gate.resolve();
      await queue.drain();
      assert.equal(job.status, "cancelled");
      assert.equal(job.completed, 1);
      assert.equal(job.results.length, 1);
      assert.equal(job.error, null);
      assert.ok(job.completed_at);
      // Remaining items are never dispatched.
      assert.equal(api.requests.length, 1);
    },
    {
      nativeStop: () => {
        stopCalls++;
        // A failed native stop must not reject cancellation.
        throw new Error("native stop failed");
      },
    },
  );
});

test("cancelling a queued job skips dispatch and records a finished cancelled job", async () => {
  const gate = deferred();
  const firstStarted = deferred();
  const records = [];
  await harness(
    async (request) => {
      if (request.body.targets[0].x === 1) {
        firstStarted.resolve();
        await gate.promise;
      }
      return successReply();
    },
    async ({ api, queue }) => {
      const first = queue.submit("move", { targets: [{ x: 1 }] }, null);
      await firstStarted.promise;
      const second = queue.submit("move", { targets: [{ x: 2 }] }, null);
      await queue.cancel(second.id);
      gate.resolve();
      await queue.drain();
      assert.equal(first.status, "completed");
      assert.equal(second.status, "cancelled");
      assert.equal(second.started_at, null);
      assert.equal(second.completed, 0);
      assert.deepEqual(second.results, []);
      assert.ok(second.completed_at);
      // Only the first job's target reached the API.
      assert.deepEqual(
        api.requests.map((request) => request.body.targets[0].x),
        [1],
      );
      const finished = records.filter((entry) => entry.event === "finished");
      assert.deepEqual(
        finished.map((entry) => entry.record.status),
        ["completed", "cancelled"],
      );
    },
    { onRecord: (event, record) => records.push({ event, record }) },
  );
});

test("cancel resolves for unknown ids without calling nativeStop", async () => {
  let stopCalls = 0;
  await harness(
    successReply,
    async ({ queue }) => {
      assert.equal(await queue.cancel("missing-job"), undefined);
      assert.equal(queue.get("missing-job"), undefined);
      assert.equal(queue.publicJob("missing-job"), undefined);
      assert.equal(stopCalls, 0);
    },
    { nativeStop: () => stopCalls++ },
  );
});

test("retention cleanup prunes finished jobs and frees their idempotency key", async () => {
  await harness(
    successReply,
    async ({ queue }) => {
      const job = queue.submit("craft", { item: "iron-gear-wheel" }, "retained-key");
      await queue.drain();
      assert.equal(queue.size(), 1);
      assert.ok(queue.publicJob(job.id));
      const completedAt = Date.parse(job.completed_at);
      assert.equal(queue.cleanup(completedAt + 59_000), 0);
      assert.equal(queue.size(), 1);
      assert.equal(queue.cleanup(completedAt + 61_000), 1);
      assert.equal(queue.size(), 0);
      assert.equal(queue.get(job.id), undefined);
      assert.equal(queue.publicJob(job.id), undefined);
      // The idempotency key was released together with the pruned job.
      const again = queue.submit("craft", { item: "iron-gear-wheel" }, "retained-key");
      assert.notEqual(again.id, job.id);
      await queue.drain();
    },
    { retentionMs: 60_000 },
  );
});

test("retention cleanup uses the injected clock when no timestamp is passed", async () => {
  const later = Date.now() + 3_601_000;
  await harness(
    successReply,
    async ({ queue }) => {
      const job = queue.submit("craft", { item: "iron-gear-wheel" }, "clocked-key");
      await queue.drain();
      assert.equal(queue.cleanup(), 1);
      assert.equal(queue.get(job.id), undefined);
    },
    { retentionMs: 1_000, now: () => later },
  );
});

test("publicJob exposes the stable JSON field order and progress values", async () => {
  await harness(successReply, async ({ queue }) => {
    assert.equal(queue.currentJob, undefined);
    const job = queue.submit("craft", { item: "iron-gear-wheel", count: 2 }, "shape-key");
    const queued = queue.publicJob(job.id);
    assert.deepEqual(Object.keys(queued), [
      "job_id",
      "action",
      "idempotency_key",
      "status",
      "created_at",
      "started_at",
      "completed_at",
      "progress",
      "results",
      "error",
      "cancel_requested",
    ]);
    assert.match(queued.job_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(queued.action, "craft");
    assert.equal(queued.idempotency_key, "shape-key");
    assert.equal(queued.status, "queued");
    assert.ok(!Number.isNaN(Date.parse(queued.created_at)));
    assert.equal(queued.started_at, null);
    assert.equal(queued.completed_at, null);
    assert.deepEqual(queued.progress, { completed: 0, total: 1 });
    assert.deepEqual(queued.results, []);
    assert.equal(queued.error, null);
    assert.equal(queued.cancel_requested, false);
    await queue.drain();
    const finished = queue.publicJob(job.id);
    assert.equal(finished.status, "completed");
    assert.deepEqual(finished.progress, { completed: 1, total: 1 });
    assert.ok(!Number.isNaN(Date.parse(finished.started_at)));
    assert.ok(!Number.isNaN(Date.parse(finished.completed_at)));
    assert.deepEqual(finished.results, [{ ok: true }]);
    assert.equal(queue.currentJob, undefined);
  });
});

test("record hook receives submitted and finished records with the payload appended", async () => {
  const records = [];
  await harness(
    successReply,
    async ({ queue }) => {
      queue.submit("build", { entities: [{ name: "stone-furnace", anchor: { x: 0, y: 0 } }] }, null);
      await queue.drain();
    },
    { onRecord: (event, record) => records.push({ event, record }) },
  );
  assert.deepEqual(
    records.map((entry) => entry.event),
    ["submitted", "finished"],
  );
  const submitted = records[0].record;
  assert.equal(submitted.status, "queued");
  assert.deepEqual(submitted.progress, { completed: 0, total: 1 });
  assert.deepEqual(submitted.payload, { entities: [{ name: "stone-furnace", anchor: { x: 0, y: 0 } }] });
  const finished = records[1].record;
  assert.equal(finished.status, "completed");
  assert.deepEqual(finished.payload, submitted.payload);
  // The record shape is publicJob plus the payload appended last (jobs.jsonl order).
  const publicKeys = Object.keys(finished).filter((key) => key !== "payload");
  assert.deepEqual(Object.keys(finished), [...publicKeys, "payload"]);
  assert.equal(Object.keys(finished).at(-1), "payload");
  assert.deepEqual(
    publicKeys,
    Object.keys(submitted).filter((key) => key !== "payload"),
  );
});

test("dispatches use the injected port, internal header and JSON content type", async () => {
  let captured;
  await harness(
    (request) => {
      captured = request;
      return successReply();
    },
    async ({ queue }) => {
      queue.submit("craft", { item: "iron-gear-wheel" }, null);
      await queue.drain();
    },
  );
  assert.equal(captured.method, "POST");
  assert.equal(captured.path, "/api/agent/act/craft");
  assert.equal(captured.headers["x-autorio-internal"], INTERNAL_KEY);
  assert.match(captured.headers["content-type"], /^application\/json/);
  assert.deepEqual(captured.body, { item: "iron-gear-wheel" });
});

test("dispatch failures fail the job with an error message", async () => {
  // Malformed JSON from the action route rejects the internal dispatch.
  await harness(
    () => ({ status: 200, raw: "not json" }),
    async ({ queue }) => {
      const job = queue.submit("craft", { item: "iron-gear-wheel" }, null);
      await queue.drain();
      assert.equal(job.status, "failed");
      assert.equal(job.completed, 0);
      assert.deepEqual(job.results, []);
      assert.match(job.error, /JSON|token/i);
      assert.ok(job.completed_at);
    },
  );

  // A connection failure rejects the same way (e.g. manager exiting mid-job).
  const api = await startFakeApi(successReply);
  const { port } = api;
  await api.close();
  const queue = new ActionJobQueue({ port, internalKey: INTERNAL_KEY, cleanupIntervalMs: 60_000 });
  try {
    const job = queue.submit("craft", { item: "iron-gear-wheel" }, null);
    await queue.drain();
    assert.equal(job.status, "failed");
    assert.match(job.error, /ECONNREFUSED|connect/i);
  } finally {
    queue.close();
  }
});

test("dispatch timeout fails the job instead of hanging the queue", async () => {
  await harness(
    () => new Promise(() => {}),
    async ({ queue }) => {
      const job = queue.submit("craft", { item: "iron-gear-wheel" }, null);
      await queue.drain();
      assert.equal(job.status, "failed");
      assert.match(job.error, /internal action timed out/);
    },
    { timeoutMs: 100 },
  );
});

test("isCancelled folds the injected external condition into the job flag", async () => {
  let external = false;
  await harness(
    successReply,
    async ({ queue }) => {
      assert.equal(queue.currentJob, undefined);
      assert.equal(queue.isCancelled(), false);
      const job = queue.submit("craft", { item: "iron-gear-wheel" }, null);
      external = true;
      assert.equal(queue.isCancelled(), true);
      assert.equal(queue.isCancelled(job), true);
      external = false;
      assert.equal(queue.isCancelled(job), job.cancel_requested);
      job.cancel_requested = true;
      assert.equal(queue.isCancelled(job), true);
      job.cancel_requested = false;
      await queue.drain();
      assert.equal(queue.currentJob, undefined);
      assert.equal(queue.isCancelled(), false);
    },
    { isCancelled: () => external },
  );
});
