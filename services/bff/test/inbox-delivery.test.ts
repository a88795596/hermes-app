import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import websocket from "@fastify/websocket";
import type { InboxDelivery, InboxItem } from "@hermes-mobile/protocol";
import { inboxTitle, MAX_INBOX_TITLE_BYTES } from "@hermes-mobile/protocol";
import Fastify from "fastify";
import pg from "pg";
import WebSocket from "ws";
import { connectorFrame } from "../src/connector-frame.js";
import { profileId } from "../src/projections.js";
import { migratePush } from "../src/push.js";
import { registerPersonalRoutes } from "../src/routes/personal.js";
import { openStore } from "../src/store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("收件箱标题取首个非空行并保留 Unicode 字符边界", () => {
  assert.equal(inboxTitle("\n  ## 今日早报\r\n正文第一行\n正文第二行"), "今日早报");
  assert.equal(inboxTitle("\r单行消息"), "单行消息");
  assert.equal(inboxTitle("\n\t"), "新消息");
  assert.equal(inboxTitle("#"), "新消息");
  assert.equal(inboxTitle("😀".repeat(65)), "😀".repeat(63) + "…");
});

test("连接器投递兼容无标题帧并校验独立标题", () => {
  const frame = { type: "delivery", event_id: randomUUID(), delivery_id: randomUUID(), profile_ref: "work", text: "完整正文" };
  assert.deepEqual(connectorFrame(frame), frame);
  assert.deepEqual(connectorFrame({ ...frame, title: "早报" }), { ...frame, title: "早报" });
  assert.equal((connectorFrame({ ...frame, title: "a".repeat(MAX_INBOX_TITLE_BYTES) }) as InboxDelivery).title?.length, MAX_INBOX_TITLE_BYTES);
  for (const title of [null, " ", "含\u0000字符", "\ud800", "a".repeat(MAX_INBOX_TITLE_BYTES + 1), "中".repeat(86)]) {
    assert.throws(() => connectorFrame({ ...frame, title }), { statusCode: 422 });
  }
});

test("投递帧保留可选 Hermes 会话 ID 并拒绝无效值", () => {
  const frame = { type: "delivery", event_id: randomUUID(), delivery_id: randomUUID(), profile_ref: "work", text: "文件已生成",
    session_id: "session-report_2026.11-15" };
  assert.deepEqual(connectorFrame(frame), frame);
  for (const session_id of [null, "", " ", "bad\u0000id", "bad\nid", "id:thread", "id/path", "会话", "\ud800", "a".repeat(513)]) {
    assert.throws(() => connectorFrame({ ...frame, session_id }), { statusCode: 422 });
  }
});

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
    const post = (payload: object, token = config.inboxDeliveryToken) => app.inject({
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
    for (const title of [null, " ", "含\u0000字符", "\ud800", "a".repeat(MAX_INBOX_TITLE_BYTES + 1), "中".repeat(86)]) {
      assert.equal((await post({ ...delivery, title })).statusCode, 422);
    }

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
    await store.query("UPDATE inbox SET data = data - 'title' - 'profile_id' WHERE id = $1", [legacy.delivery_id]);
    const legacyReceipt = await store.query("SELECT payload FROM connector_ingest WHERE kind = 'delivery' AND id = $1", [legacy.delivery_id]);
    assert.deepEqual(legacyReceipt.rows[0].payload, { profile_ref: legacy.profile_ref, text: legacy.text });

    const titled: InboxDelivery = { delivery_id: randomUUID(), profile_ref: "default", title: "周报已完成",
      text: "# 周报\n\n正文第一行\n正文第二行\n正文第三行" };
    assert.equal((await post(titled)).statusCode, 204);
    assert.equal((await post(titled)).statusCode, 204);
    assert.equal((await post({ ...titled, title: "不同标题" })).statusCode, 409);
    const titledAck = once(connector, "message", { signal: t.signal });
    connector.send(JSON.stringify({ type: "delivery", event_id: titled.delivery_id, ...titled }));
    assert.deepEqual(JSON.parse((await titledAck)[0].toString()), { type: "ack", id: titled.delivery_id });

    const inbox = await app.inject({ url: "/mobile/v1/inbox", headers: device });
    assert.equal(inbox.statusCode, 200);
    assert.deepEqual(inbox.json().data.map(({ inbox_id, profile_id, title, text }: InboxItem) => ({ inbox_id, profile_id, title, text })), [
      { inbox_id: titled.delivery_id, profile_id: profileId("default"), title: titled.title, text: titled.text },
      { inbox_id: legacy.delivery_id, profile_id: profileId("work"), title: legacy.text, text: legacy.text },
      { inbox_id: delivery.delivery_id, profile_id: profileId("work"), title: delivery.text, text: delivery.text },
    ]);
    assert.deepEqual((await store.query("SELECT inbox_id FROM push_outbox ORDER BY inbox_id")).rows.map(({ inbox_id }) => inbox_id),
      [delivery.delivery_id, legacy.delivery_id, titled.delivery_id].sort());
  } finally {
    mobile?.terminate();
    connector?.terminate();
    await app.close();
    await store.close();
    await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.end();
  }
});

test("指定会话的文件投递写入匹配档案的消息列表并保留幂等和附件权限", { skip: !databaseUrl, timeout: 15_000 }, async (t) => {
  const schema = `session_delivery_${randomUUID().replaceAll("-", "")}`;
  const database = new pg.Pool({ connectionString: databaseUrl });
  await database.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const store = openStore(url.href);
  const app = Fastify();
  let mobile: WebSocket | undefined;
  try {
    await store.migrate();
    await migratePush(store);
    const config = { pairingToken: "pairing-secret", connectorToken: "connector-secret", inboxDeliveryToken: "delivery-secret",
      profileRefs: ["default", "work"] };
    app.register(websocket);
    app.register(async (api) => registerPersonalRoutes(api, store, config));
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const headers = { authorization: `Bearer ${config.inboxDeliveryToken}` };
    const post = (payload: object) => app.inject({ method: "POST", url: "/internal/inbox/v1/deliveries", headers, payload });
    const paired = await app.inject({ method: "POST", url: "/mobile/v1/pairings/redeem",
      payload: { pairing_token: config.pairingToken, device_name: "会话投递测试" } });
    const device = { authorization: `Bearer ${paired.json().data.token}` };
    const ticket = await app.inject({ method: "POST", url: "/mobile/v1/ws-tickets", headers: device });
    mobile = new WebSocket(`${origin.replace(/^http/u, "ws")}/mobile/v1/events?ticket=${ticket.json().data.ticket}`);
    await once(mobile, "message", { signal: t.signal });

    const topicId = randomUUID();
    const otherTopicId = randomUUID();
    for (const [id, profile, session, status] of [
      [topicId, "work", "session-work", "ready"], [otherTopicId, "default", "session-work", "ready"],
      [randomUUID(), "work", "session-next", "ready"], [randomUUID(), "work", "session-pending", "creating"],
    ]) await store.query("INSERT INTO topics (id, profile_ref, title, status, session_id, updated_at) VALUES ($1, $2, '测试会话', $3, $4, '2020-01-01')",
      [id, profile, status, session]);
    const content = Buffer.from("会话文件内容");
    const attachmentId = randomUUID();
    const uploaded = await app.inject({ method: "PUT", url: `/internal/attachments/v1/${attachmentId}`, headers,
      payload: { profile_ref: "work", name: "报告.txt", mime: "text/plain", size: content.length, content_base64: content.toString("base64") } });
    assert.equal(uploaded.statusCode, 200);
    const attachment = uploaded.json().data;
    const delivery = { delivery_id: randomUUID(), profile_ref: "work", session_id: "session-work", text: "", attachments: [attachment] };
    for (const session_id of [null, "", " ", "bad\u0000id", "bad\nid", "id:thread", "id/path", "会话", "\ud800", "a".repeat(513)]) {
      assert.equal((await post({ ...delivery, session_id })).statusCode, 422);
    }
    for (const session_id of ["session-missing", "session-pending"]) {
      assert.equal((await post({ ...delivery, session_id })).statusCode, 404);
    }
    assert.equal((await post({ ...delivery, profile_ref: "default" })).statusCode, 404, "附件不能跨档案引用");
    assert.equal((await post({ ...delivery, profile_ref: "default", session_id: "session-next", attachments: undefined, text: "跨档案" })).statusCode, 404);
    assert.equal((await post({ ...delivery, attachments: [{ ...attachment, size: content.length + 1 }] })).statusCode, 422);
    const updated = once(mobile, "message", { signal: t.signal });
    assert.deepEqual((await Promise.all([post(delivery), post(delivery)])).map((receipt) => receipt.statusCode), [204, 204]);
    assert.deepEqual(JSON.parse((await updated)[0].toString()), { type: "changed" });
    const detail = (await app.inject({ url: `/mobile/v1/topics/${topicId}`, headers: device })).json().data;
    assert.deepEqual(detail.messages, [{ message_id: delivery.delivery_id, role: "assistant", text: "", status: "final", attachments: [attachment] }]);
    assert.ok(detail.topic.updated_at > "2020-01-01T00:00:00.000Z");
    assert.deepEqual((await app.inject({ url: `/mobile/v1/topics/${otherTopicId}`, headers: device })).json().data.messages, []);
    const file = await app.inject({ url: `/mobile/v1/attachments/${attachmentId}`, headers: device });
    assert.equal(file.statusCode, 200);
    assert.deepEqual(file.rawPayload, content);
    assert.equal((await post({ ...delivery, session_id: "session-next" })).statusCode, 409);
    assert.equal((await post({ ...delivery, session_id: undefined })).statusCode, 409);
    assert.equal((await post({ ...delivery, text: "修改正文" })).statusCode, 409);
    assert.equal((await store.query("SELECT id FROM inbox")).rowCount, 0);
    assert.equal((await store.query("SELECT inbox_id FROM push_outbox")).rowCount, 0);

    const occupiedId = randomUUID();
    const occupied = { message_id: occupiedId, role: "user", text: "保留原消息", status: "final" };
    await store.query("INSERT INTO messages (id, topic_id, data) VALUES ($1, $2, $3)", [occupiedId, otherTopicId, occupied]);
    assert.equal((await post({ ...delivery, delivery_id: occupiedId })).statusCode, 409);
    assert.deepEqual((await store.query("SELECT data FROM messages WHERE id = $1", [occupiedId])).rows[0].data, occupied);
    assert.equal((await store.query("SELECT id FROM connector_ingest WHERE kind = 'delivery' AND id = $1", [occupiedId])).rowCount, 0);

    const inboxDelivery = { delivery_id: randomUUID(), profile_ref: "work", text: "仍投递收件箱" };
    assert.equal((await post(inboxDelivery)).statusCode, 204);
    assert.equal((await post({ ...inboxDelivery, session_id: "session-work" })).statusCode, 409);
  } finally {
    mobile?.terminate();
    await app.close();
    await store.close();
    await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.end();
  }
});
