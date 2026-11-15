import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import websocket from "@fastify/websocket";
import type { Command } from "@hermes-mobile/protocol";
import Fastify from "fastify";
import { connectorFrame } from "../src/connector-frame.js";
import { registerPersonalRoutes } from "../src/routes/personal.js";
import type { Store } from "../src/store.js";

test("模型回执保留已保存默认值的确认，拒绝不合法范围", () => {
  const frame = { type: "command_result", command_id: randomUUID(), status: "ok", model_result: {
    type: "selected", selection: { provider: "nous", model: "example" }, global: true,
  } };
  assert.deepEqual(connectorFrame(frame), frame);
  for (const global of ["true", 1, null]) {
    assert.throws(() => connectorFrame({ ...frame, model_result: { ...frame.model_result, global } }));
  }
});

test("模型请求保留 Global 范围、风险确认与幂等性，只使用话题绑定的 profile", async (t) => {
  const topic = { id: randomUUID(), profile_ref: "work", status: "ready", session_id: "mobile_model" };
  const commands = new Map<string, { payload: Command; receipt: unknown }>();
  let busy = false;
  const db = {
    async query(sql: string, args: unknown[] = []) {
      if (sql.includes("FROM devices")) return { rows: [{ id: "paired-device" }] };
      if (sql.startsWith("SELECT * FROM topics")) return { rows: [topic] };
      if (sql.startsWith("SELECT payload, receipt FROM commands")) {
        const saved = commands.get(args[0] as string);
        return { rows: saved ? [saved] : [] };
      }
      if (sql.startsWith("INSERT INTO commands")) commands.set(args[0] as string, { payload: args[2] as Command, receipt: args[3] });
      return { rows: [], rowCount: sql.includes("FROM submissions") && busy ? 1 : 0 };
    },
  };
  const store = { ...db, transaction: (fn: (value: typeof db) => unknown) => fn(db) } as unknown as Store;
  const app = Fastify();
  app.register(websocket);
  app.register(async (api) => registerPersonalRoutes(api, store, {
    profileRefs: ["default", "work"], pairingToken: "pairing-secret", connectorToken: "connector-secret",
  }));
  t.after(() => app.close());
  const select = (body: Record<string, unknown>, authenticated = true) => app.inject({
    method: "POST", url: `/mobile/v1/topics/${topic.id}/model-requests`,
    headers: authenticated ? { authorization: `Bearer ${"a".repeat(43)}` } : {},
    payload: { request_id: randomUUID(), provider: "custom:local", model: "local-model", ...body },
  });
  assert.equal((await select({}, false)).statusCode, 401);
  for (const global of ["true", 1, null]) assert.equal((await select({ global })).statusCode, 422);
  assert.equal((await select({ global: true, profile_ref: "default" })).statusCode, 422);
  for (const global of [true, false, undefined]) {
    const request_id = randomUUID();
    const body = { request_id, ...(global === undefined ? {} : { global }), confirm: "a".repeat(64) };
    assert.equal((await select(body)).statusCode, 202);
    assert.equal((await select(body)).statusCode, 202);
    assert.deepEqual(commands.get(request_id)?.payload, {
      type: "command", command_id: request_id, topic_id: topic.id, profile_ref: "work", session_id: "mobile_model",
      kind: "select_model", body: { provider: "custom:local", model: "local-model", ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== "request_id")) },
    });
    assert.equal((await select({ ...body, global: !global })).statusCode, 409);
  }
  busy = true;
  assert.equal((await select({ global: true })).statusCode, 409);
  topic.profile_ref = "private";
  assert.equal((await select({ global: true })).statusCode, 404);
  assert.equal(commands.size, 3);
});
