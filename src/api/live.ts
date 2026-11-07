import { Router } from "../http/router.js";
import { json, readJsonBody } from "../http/plumbing.js";
import { asString, errorMessage } from "../validation.js";
import type { LiveChatMessage } from "../bilibili-live.js";
import type { LiveChatService } from "../live-chat.js";

/**
 * Live danmaku / interaction-host routes.
 *
 * Operator routes: connect, disconnect, status, replies (the narrator can also
 * read replies.jsonl directly).
 * Agent routes: live-chat (read-only observation) and live-reply (queue one
 * spoken line, e.g. from an operator console or an external host). Danmaku is
 * never sent back to Bilibili.
 */
export function registerLiveRoutes(router: Router, live: LiveChatService): void {
  router.add({
    method: "POST",
    path: "/api/live/connect",
    name: "/api/live/connect",
    handler: async (request) => {
      const { req, res } = request;
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      const room = parsed.body.room_id ?? parsed.body.roomId;
      const roomId = asString(room) ?? (typeof room === "number" ? String(room) : "");
      if (!roomId.trim()) return json(res, 400, { error: "Missing room_id" });
      try {
        return json(res, 202, { ok: true, data: await live.start(roomId.trim()) });
      } catch (error) {
        const message = errorMessage(error) || "Failed to connect to the live chat";
        const status = /WebSocket global|room_id must/.test(message) ? 400 : 502;
        return json(res, status, { ok: false, error: message, data: live.status() });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/live/disconnect",
    name: "/api/live/disconnect",
    handler: (request) => {
      live.stop();
      return json(request.res, 200, { ok: true, data: live.status() });
    },
  });

  router.add({
    method: "GET",
    path: "/api/live/status",
    name: "/api/live/status",
    handler: (request) => json(request.res, 200, { ok: true, data: live.status() }),
  });

  router.add({
    method: "GET",
    path: "/api/agent/live-chat",
    name: "/api/agent/live-chat",
    handler: (request) => {
      const { res, url } = request;
      const afterSeq = Number(url.searchParams.get("after_seq") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const kindsParam = (url.searchParams.get("kinds") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry): entry is LiveChatMessage["kind"] => entry === "danmaku" || entry === "super_chat");
      const messages = live.messagesAfter(
        Number.isFinite(afterSeq) ? afterSeq : 0,
        Number.isFinite(limit) ? limit : 20,
        kindsParam.length > 0 ? kindsParam : undefined,
      );
      return json(res, 200, {
        ok: true,
        data: {
          messages,
          next_seq: messages.length > 0 ? messages[messages.length - 1].seq : Math.max(0, afterSeq),
          status: live.status(),
        },
      });
    },
  });

  router.add({
    method: "GET",
    path: "/api/live/replies",
    name: "/api/live/replies",
    handler: (request) => {
      const { res, url } = request;
      const afterSeq = Number(url.searchParams.get("after_seq") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const replies = live.repliesAfter(
        Number.isFinite(afterSeq) ? afterSeq : 0,
        Number.isFinite(limit) ? limit : 20,
      );
      return json(res, 200, {
        ok: true,
        data: {
          replies,
          next_seq: replies.length > 0 ? replies[replies.length - 1].seq : Math.max(0, afterSeq),
        },
      });
    },
  });

  router.add({
    method: "POST",
    path: "/api/agent/live-reply",
    name: "/api/agent/live-reply",
    handler: async (request) => {
      const { req, res } = request;
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      const text = asString(parsed.body.text);
      if (!text || !text.trim()) return json(res, 400, { error: "Missing text" });
      const sourceSeqs = Array.isArray(parsed.body.source_seqs)
        ? parsed.body.source_seqs.filter((value): value is number => typeof value === "number")
        : [];
      try {
        return json(res, 200, { ok: true, data: live.enqueueReply(text, sourceSeqs) });
      } catch (error) {
        return json(res, 400, { error: errorMessage(error) || "Invalid reply" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/live/host/start",
    name: "/api/live/host/start",
    handler: (request) => {
      try {
        return json(request.res, 200, { ok: true, data: live.startHost() });
      } catch (error) {
        return json(request.res, 500, { error: errorMessage(error) || "Failed to start the live host" });
      }
    },
  });

  router.add({
    method: "POST",
    path: "/api/live/host/stop",
    name: "/api/live/host/stop",
    handler: (request) => {
      live.stopHost();
      return json(request.res, 200, { ok: true, data: live.status().host });
    },
  });
}
