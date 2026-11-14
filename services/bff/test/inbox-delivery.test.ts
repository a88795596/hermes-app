import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import websocket from "@fastify/websocket";
import type { InboxDelivery } from "@hermes-mobile/protocol";
import Fastify from "fastify";
import pg from "pg";
import WebSocket from "ws";
import { migratePush } from "../src/push.js";
import { registerPersonalRoutes } from "../src/routes/personal.js";
import { openStore } from "../src/store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("HTTP 投递不需要连接器，重复请求只写入一条收件箱消息和一条通知任务", { skip: !databaseUrl, timeout: 15_000 }, async (t) => {
  const schema = `inbox_delivery_${randomUUID().replaceAll("-", "")}`;
  const database = new pg.Pool({ connectionString: databaseUrl });
  await database.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const store = openStore(url.href);
  const app = Fastify();
  let mobile: WebSocket | undefined;
  let connector: WebSocket | undefined;
  try {
    await store.migrate();
    await migratePush(store);
    const config = {
      pairingToken: "pairing-secret", connectorToken: "connector-secret", inboxDeliveryToken: "delivery-secret",
      profileRefs: ["default", "work"],
    };
    app.register(websocket);
    app.register(async (api) => registerPersonalRoutes(api, store, config));
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const wsUrl = address.replace(/^http/, "ws");
    const headers = (token: string) => ({ authorization: `Bearer ${token}` });
    const delivery: InboxDelivery = { delivery_id: randomUUID(), profile_ref: "work", text: "定时任务已完成" };
    const post = (payload: InboxDelivery, token = config.inboxDeliveryToken) => app.inject({
      method: "POST", url: "/internal/inbox/v1/deliveries", headers: token ? headers(token) : {}, payload,
    });

    assert.equal((await post(delivery, "")).statusCode, 401);
    assert.equal((await post(delivery, config.connectorToken)).statusCode, 401);
    assert.equal((await post(delivery, config.pairingToken)).statusCode, 401);
    assert.equal((await post({ ...delivery, profile_ref: "private" })).statusCode, 404);
    assert.equal((await post({ ...delivery, delivery_id: "invalid" })).statusCode, 422);
    assert.equal((await post({ ...delivery, text: " " })).statusCode, 422);
    assert.equal((await post({ ...delivery, text: "a\u0000b" })).statusCode, 422);
    assert.equal((await post({ ...delivery, text: "中".repeat(44_000) })).statusCode, 422);

    const paired = await app.inject({ method: "POST", url: "/mobile/v1/pairings/redeem",
      payload: { pairing_token: config.pairingToken, device_name: "收件箱测试设备" } });
    assert.equal(paired.statusCode, 200);
    const device = headers(paired.json().data.token);
    assert.equal((await post(delivery, paired.json().data.token)).statusCode, 401);
    const push = await app.inject({ method: "PUT", url: "/mobile/v1/devices/current/push-registration", headers: device,
      payload: { token: "ExpoPushToken[inbox_test]" } });
    assert.equal(push.statusCode, 204);
    const ticket = await app.inject({ method: "POST", url: "/mobile/v1/ws-tickets", headers: device });
    mobile = new WebSocket(`${wsUrl}/mobile/v1/events?ticket=${ticket.json().data.ticket}`);
    await once(mobile, "message", { signal: t.signal });

    const updated = once(mobile, "message", { signal: t.signal });
    const receipts = await Promise.all([post(delivery), post(delivery)]);
    assert.deepEqual(receipts.map((receipt) => receipt.statusCode), [204, 204]);
    assert.deepEqual(JSON.parse((await updated)[0].toString()), { type: "changed" });
    assert.equal((await post({ ...delivery, text: "同一 ID 的不同正文" })).statusCode, 409);

    // 旧连接器可继续提交队列中尚未获得回执的投递。
    connector = new WebSocket(`${wsUrl}/internal/connector/v1/events`, { headers: headers(config.connectorToken) });
    await once(connector, "open", { signal: t.signal });
    const legacyAck = once(connector, "message", { signal: t.signal });
    connector.send(JSON.stringify({ type: "delivery", event_id: delivery.delivery_id, ...delivery }));
    assert.deepEqual(JSON.parse((await legacyAck)[0].toString()), { type: "ack", id: delivery.delivery_id });

    const legacy = { ...delivery, delivery_id: randomUUID(), text: "旧队列待投递消息" };
    const legacyPendingAck = once(connector, "message", { signal: t.signal });
    connector.send(JSON.stringify({ type: "delivery", event_id: legacy.delivery_id, ...legacy }));
    assert.deepEqual(JSON.parse((await legacyPendingAck)[0].toString()), { type: "ack", id: legacy.delivery_id });
    assert.equal((await post(legacy)).statusCode, 204);

    const inbox = await app.inject({ url: "/mobile/v1/inbox", headers: device });
    assert.equal(inbox.statusCode, 200);
    assert.deepEqual(inbox.json().data.map(({ inbox_id, text }: { inbox_id: string; text: string }) => ({ inbox_id, text })), [
      { inbox_id: legacy.delivery_id, text: legacy.text }, { inbox_id: delivery.delivery_id, text: delivery.text },
    ]);
    assert.deepEqual((await store.query("SELECT inbox_id FROM push_outbox ORDER BY inbox_id")).rows.map(({ inbox_id }) => inbox_id),
      [delivery.delivery_id, legacy.delivery_id].sort());
  } finally {
    mobile?.terminate();
    connector?.terminate();
    await app.close();
    await store.close();
    await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.end();
  }
});
