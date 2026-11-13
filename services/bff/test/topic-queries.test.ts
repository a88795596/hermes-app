import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import WebSocket from "ws";
import { registerPersonalRoutes } from "../src/routes/personal.js";
import type { Store } from "../src/store.js";

test("话题查询使用通过鉴权的话题所绑定的 Hermes 配置档案和会话", { timeout: 5_000 }, async (t) => {
  const app = Fastify();
  const topicId = "00000000-0000-4000-8000-000000000001";
  const deniedId = "00000000-0000-4000-8000-000000000002";
  const sessionId = "hermes-work-session";
  const topic = { id: topicId, profile_ref: "work", status: "ready", session_id: sessionId };
  const store = {
    async query(sql: string, args: unknown[]) {
      if (sql.includes("FROM devices")) return { rows: [{ id: "paired-device" }] };
      if (sql.startsWith("SELECT * FROM topics")) {
        const rows = args[0] === topicId ? [topic]
          : args[0] === deniedId ? [{ ...topic, id: deniedId, profile_ref: "private" }] : [];
        return { rows };
      }
      return { rows: [] };
    },
  } as unknown as Store;
  app.register(websocket);
  app.register(async (api) => registerPersonalRoutes(api, store, {
    profileRefs: ["default", "work"], pairingToken: "pairing-secret", connectorToken: "connector-secret",
  }));
  t.after(() => app.close());

  const path = "/mobile/v1/topics";
  const get = (resource: string, id = topicId) => app.inject({
    url: `${path}/${id}${resource}`, headers: { authorization: `Bearer ${"a".repeat(43)}` },
  });
  assert.equal((await app.inject(`${path}/${topicId}/skills`)).statusCode, 401);
  assert.equal((await get("/skills", deniedId)).statusCode, 404);
  assert.equal((await get("/skills")).statusCode, 503);

  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const ws = new WebSocket(origin.replace(/^http/, "ws") + "/internal/connector/v1/events", {
    headers: { authorization: "Bearer connector-secret", "x-hermes-mobile-topic-query": "1" },
  });
  try {
    await once(ws, "open", { signal: t.signal });
    const skills = Array.from({ length: 205 }, (_, index) => ({ name: `skill-${index}` }));
    const status = { activity: "running", model: "test-model", message_count: 0 };
    for (const [kind, expected] of [
      ["skills", skills],
      ["status", status],
      ["version", "0.22.7"],
    ] as const) {
      const incoming = once(ws, "message", { signal: t.signal }).then(([raw]) => {
        const frame = JSON.parse(raw.toString());
        assert.deepEqual(frame, {
          type: "topic_query", request_id: frame.request_id, kind,
          topic_id: topicId, profile_ref: "work", session_id: sessionId,
        });
        ws.send(JSON.stringify({
          type: "topic_query_result", request_id: frame.request_id, data: { kind, [kind]: expected },
        }));
      });
      const response = get("/" + kind);
      const result = await Promise.race([response, incoming.then(() => response)]);
      assert.equal(result.statusCode, 200);
      await incoming;
      assert.deepEqual(result.json().data, expected);
    }

    const incoming = once(ws, "message", { signal: t.signal });
    const pending = get("/skills");
    await incoming;
    const closed = once(ws, "close", { signal: t.signal });
    ws.close();
    assert.equal((await pending).statusCode, 503);
    await closed;
  } finally {
    ws.terminate();
  }
});
