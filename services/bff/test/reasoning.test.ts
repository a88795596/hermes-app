import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import websocket from "@fastify/websocket";
import type { Command, CommandResult } from "@hermes-mobile/protocol";
import Fastify from "fastify";
import WebSocket from "ws";
import { registerPersonalRoutes } from "../src/routes/personal.js";
import type { Store } from "../src/store.js";

test("思考强度只在连接器确认后投影到已配对设备的话题", { timeout: 5_000 }, async (t) => {
  const topic = { id: randomUUID(), profile_ref: "default", status: "ready", session_id: "bound-session",
    reasoning_effort: null as string | null, reasoning_status: null as string | null };
  const requestId = randomUUID();
  let activeRequestId = requestId;
  let saved: { payload: Command; receipt: unknown; result: CommandResult | null } | undefined;
  const db = {
    async query(sql: string, args: unknown[] = []) {
      if (sql.includes("FROM devices")) return { rows: [{ id: "paired-device" }] };
      if (sql.startsWith("SELECT * FROM topics")) return { rows: args[0] === topic.id ? [topic] : [] };
      if (sql.startsWith("SELECT id, profile_ref, session_id FROM topics")) return { rows: [topic] };
      if (sql.startsWith("SELECT c.payload")) return { rows: saved && !saved.result ? [saved] : [] };
      if (sql.includes("FROM commands")) return { rows: saved && args[0] === saved.payload.command_id ? [saved] : [] };
      if (sql.startsWith("INSERT INTO commands")) saved = { payload: args[2] as Command, receipt: args[3], result: null };
      if (sql.startsWith("UPDATE commands SET result") && saved) saved.result = args[1] as CommandResult;
      if (sql.startsWith("UPDATE topics SET reasoning_status")) topic.reasoning_status = "pending";
      if (sql.startsWith("UPDATE topics SET reasoning_effort")) {
        topic.reasoning_effort = args[1] as string | null;
        topic.reasoning_status = args[2] as string | null;
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const store = { ...db, transaction: (fn: (value: typeof db) => unknown) => fn(db) } as unknown as Store;
  const app = Fastify();
  app.register(websocket);
  app.register(async (api) => registerPersonalRoutes(api, store, {
    profileRefs: ["default"], pairingToken: "pairing-secret", connectorToken: "connector-secret",
  }));
  t.after(() => app.close());
  const url = `/mobile/v1/topics/${topic.id}`;
  const headers = { authorization: `Bearer ${"a".repeat(43)}` };
  const select = (effort: unknown, authenticated = true) => app.inject({
    method: "POST", url: `${url}/reasoning-requests`, headers: authenticated ? headers : {},
    payload: { request_id: activeRequestId, effort },
  });
  assert.equal((await select("high", false)).statusCode, 401);
  assert.equal((await select("unsupported")).statusCode, 422);

  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const ws = new WebSocket(origin.replace(/^http/, "ws") + "/internal/connector/v1/events", {
    headers: { authorization: "Bearer connector-secret", "x-hermes-mobile-reasoning": "1" },
  });
  try {
    const [watch] = await once(ws, "message", { signal: t.signal });
    assert.equal(JSON.parse(watch.toString()).kind, "watch");
    const sent = once(ws, "message", { signal: t.signal });
    assert.equal((await select("high")).statusCode, 202);
    assert.deepEqual(JSON.parse((await sent)[0].toString()), {
      type: "command", command_id: requestId, topic_id: topic.id, profile_ref: "default",
      session_id: "bound-session", kind: "select_reasoning", body: { effort: "high" },
    });
    const poll = () => app.inject({ url: `${url}/reasoning-requests/${activeRequestId}`, headers });
    const detail = async () => (await app.inject({ url, headers })).json().data.topic;
    assert.deepEqual((await poll()).json().data, { status: "pending" });
    assert.equal((await detail()).reasoning_effort, undefined);
    assert.equal((await detail()).reasoning_status, "pending");
    const ack = once(ws, "message", { signal: t.signal });
    ws.send(JSON.stringify({ type: "command_result", command_id: requestId, status: "ok" }));
    assert.deepEqual(JSON.parse((await ack)[0].toString()), { type: "ack", id: requestId });
    assert.deepEqual((await poll()).json().data, { status: "ok" });
    assert.equal((await detail()).reasoning_effort, "high");
    assert.equal((await detail()).reasoning_status, undefined);

    activeRequestId = randomUUID();
    const reset = once(ws, "message", { signal: t.signal });
    assert.equal((await select(null)).statusCode, 202);
    assert.deepEqual(JSON.parse((await reset)[0].toString()).body, { effort: null });
    const unknown = once(ws, "message", { signal: t.signal });
    ws.send(JSON.stringify({ type: "command_result", command_id: activeRequestId, status: "unknown" }));
    await unknown;
    assert.equal((await detail()).reasoning_status, "unknown");
    assert.equal((await detail()).reasoning_effort, undefined);
  } finally {
    ws.terminate();
  }
});
