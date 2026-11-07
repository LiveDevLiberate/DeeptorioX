import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { registerLiveRoutes } from "../dist/api/live.js";
import { Router } from "../dist/http/router.js";

// Live chat / host routes with a fake LiveChatService (no manager, no network).

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

function fakeLive() {
  const calls = [];
  const status = {
    state: "connected",
    room_id: 123,
    live_status: 1,
    title: "测试直播间",
    popularity: 7,
    connected_at: new Date().toISOString(),
    last_message_at: null,
    last_error: null,
    messages_buffered: 1,
    last_message_seq: 1,
    replies_buffered: 1,
    last_reply_seq: 1,
    host: null,
    transport_available: true,
  };
  return {
    calls,
    async start(room) {
      calls.push({ start: room });
      if (room === "bad") throw new Error("boom");
      return { ...status, room_id: Number(room) };
    },
    stop() {
      calls.push({ stop: true });
    },
    status() {
      return status;
    },
    messagesAfter(afterSeq, limit, kinds) {
      calls.push({ messagesAfter: afterSeq, limit, kinds });
      return [{ seq: afterSeq + 1, kind: "danmaku", ts: 1, uid: 1, uname: "a", text: "hi" }];
    },
    repliesAfter(afterSeq, limit) {
      calls.push({ repliesAfter: afterSeq, limit });
      return [{ seq: afterSeq + 1, ts: "now", text: "reply", source_seqs: [], host: "persona" }];
    },
    enqueueReply(text, sourceSeqs) {
      calls.push({ enqueueReply: text, sourceSeqs });
      return { seq: 1, ts: "now", text, source_seqs: sourceSeqs, host: "persona" };
    },
    startHost() {
      calls.push({ startHost: true });
      return { running: true };
    },
    stopHost() {
      calls.push({ stopHost: true });
    },
  };
}

function routerWith(live) {
  const router = new Router();
  registerLiveRoutes(router, live);
  return router;
}

test("live status exposes the manager bridge state", async () => {
  const live = fakeLive();
  const res = await dispatch(routerWith(live), fakeRequest("/api/live/status", "GET"));
  assert.equal(res.statusCode, 200);
  const body = jsonBody(res);
  assert.equal(body.ok, true);
  assert.equal(body.data.room_id, 123);
});

test("connect validates the room id and maps failures to 502", async () => {
  const live = fakeLive();
  const router = routerWith(live);
  const missing = await dispatch(router, fakeRequest("/api/live/connect", "POST", {}));
  assert.equal(missing.statusCode, 400);
  assert.equal(jsonBody(missing).error, "Missing room_id");

  const ok = await dispatch(router, fakeRequest("/api/live/connect", "POST", { room_id: "123" }));
  assert.equal(ok.statusCode, 202);
  assert.equal(jsonBody(ok).data.room_id, 123);

  const failed = await dispatch(router, fakeRequest("/api/live/connect", "POST", { room_id: "bad" }));
  assert.equal(failed.statusCode, 502);
  assert.equal(jsonBody(failed).error, "boom");
});

test("danmaku and reply polling forward after_seq/limit/kinds", async () => {
  const live = fakeLive();
  const router = routerWith(live);
  const chat = await dispatch(
    router,
    fakeRequest("/api/agent/live-chat?after_seq=5&limit=2&kinds=danmaku,super_chat", "GET"),
  );
  assert.equal(chat.statusCode, 200);
  const chatBody = jsonBody(chat);
  assert.equal(chatBody.data.messages[0].seq, 6);
  assert.equal(chatBody.data.next_seq, 6);
  assert.deepEqual(live.calls.at(-1), { messagesAfter: 5, limit: 2, kinds: ["danmaku", "super_chat"] });

  const replies = await dispatch(router, fakeRequest("/api/live/replies?after_seq=0&limit=3", "GET"));
  assert.equal(replies.statusCode, 200);
  assert.equal(jsonBody(replies).data.replies[0].text, "reply");
});

test("manual reply endpoint validates text and queues it", async () => {
  const live = fakeLive();
  const router = routerWith(live);
  const missing = await dispatch(router, fakeRequest("/api/agent/live-reply", "POST", {}));
  assert.equal(missing.statusCode, 400);
  const ok = await dispatch(
    router,
    fakeRequest("/api/agent/live-reply", "POST", { text: "  主播马上回来  ", source_seqs: [3] }),
  );
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(live.calls.at(-1), { enqueueReply: "  主播马上回来  ", sourceSeqs: [3] });
});

test("host start/stop endpoints drive the separate interaction agent", async () => {
  const live = fakeLive();
  const router = routerWith(live);
  const start = await dispatch(router, fakeRequest("/api/live/host/start", "POST", {}));
  assert.equal(start.statusCode, 200);
  const stop = await dispatch(router, fakeRequest("/api/live/host/stop", "POST", {}));
  assert.equal(stop.statusCode, 200);
  assert.ok(live.calls.some((call) => call.startHost));
  assert.ok(live.calls.some((call) => call.stopHost));
});

test("disconnect stops the bridge", async () => {
  const live = fakeLive();
  const res = await dispatch(routerWith(live), fakeRequest("/api/live/disconnect", "POST", {}));
  assert.equal(res.statusCode, 200);
  assert.ok(live.calls.some((call) => call.stop));
});

test("reply errors, camelCase rooms and invalid kinds are handled", async () => {
  const live = fakeLive();
  live.enqueueReply = () => {
    throw new Error("reply rejected");
  };
  const router = routerWith(live);
  const badReply = await dispatch(router, fakeRequest("/api/agent/live-reply", "POST", { text: "hi" }));
  assert.equal(badReply.statusCode, 400);
  assert.equal(jsonBody(badReply).error, "reply rejected");

  const camel = await dispatch(router, fakeRequest("/api/live/connect", "POST", { roomId: "456" }));
  assert.equal(camel.statusCode, 202);
  const numeric = await dispatch(router, fakeRequest("/api/live/connect", "POST", { room_id: 789 }));
  assert.equal(numeric.statusCode, 202);
  const nonString = await dispatch(router, fakeRequest("/api/live/connect", "POST", { room_id: [] }));
  assert.equal(nonString.statusCode, 400);

  const live2 = fakeLive();
  const router2 = routerWith(live2);
  const filtered = await dispatch(
    router2,
    fakeRequest("/api/agent/live-reply", "POST", { text: "hi", source_seqs: [1, "x", null, 2] }),
  );
  assert.equal(filtered.statusCode, 200);
  assert.deepEqual(live2.calls.filter((call) => "enqueueReply" in call).at(-1), {
    enqueueReply: "hi",
    sourceSeqs: [1, 2],
  });

  const ignoredKinds = await dispatch(
    router,
    fakeRequest("/api/agent/live-chat?after_seq=0&limit=1&kinds=bogus", "GET"),
  );
  assert.equal(ignoredKinds.statusCode, 200);
  const last = live.calls.filter((call) => "messagesAfter" in call).at(-1);
  assert.deepEqual(last, { messagesAfter: 0, limit: 1, kinds: undefined });
});

test("missing WebSocket support maps to 400 and host start failures to 500", async () => {
  const live = fakeLive();
  live.start = async () => {
    throw new Error("Live danmaku needs the Node.js WebSocket global");
  };
  live.startHost = () => {
    throw new Error("host boom");
  };
  const router = routerWith(live);
  const connect = await dispatch(router, fakeRequest("/api/live/connect", "POST", { room_id: "1" }));
  assert.equal(connect.statusCode, 400);
  const host = await dispatch(router, fakeRequest("/api/live/host/start", "POST", {}));
  assert.equal(host.statusCode, 500);
  assert.equal(jsonBody(host).error, "host boom");
});
