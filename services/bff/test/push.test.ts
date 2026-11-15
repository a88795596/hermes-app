import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import pg from "pg";
import type { ConnectorEvent } from "@hermes-mobile/protocol";
import { applyEvent, applyInboxDelivery } from "../src/ingress.js";
import { migratePush, startPushWorker } from "../src/push.js";
import { openStore } from "../src/store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("收件箱推送包含来源和正文预览，默认时间敏感，长正文不超过推送大小限制", { skip: !databaseUrl, timeout: 15_000 }, async (t) => {
  const schema = `push_${randomUUID().replaceAll("-", "")}`;
  const database = new pg.Pool({ connectionString: databaseUrl });
  await database.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const store = openStore(url.href);
  const app = Fastify();
  let stop: (() => Promise<void>) | undefined;
  try {
    await store.migrate();
    await migratePush(store);
    const deviceId = randomUUID();
    await store.query("INSERT INTO devices (id, token_hash, name) VALUES ($1, $2, $3)", [deviceId, Buffer.from("push-test"), "推送测试"]);
    await store.query("INSERT INTO push_devices (device_id, token) VALUES ($1, $2)", [deviceId, "ExpoPushToken[push_test]"]);
    const attachment = { attachment_id: randomUUID(), name: "周报.md", mime: "text/markdown", size: 3 };
    await store.query("INSERT INTO received_attachments (id, profile_ref, metadata, content, sha256) VALUES ($1, $2, $3, $4, $5)",
      [attachment.attachment_id, "work", attachment, Buffer.from("abc"), "test"]);
    const deliveries = [
      { delivery_id: randomUUID(), profile_ref: "default", text: "明天下午三点开会，请带上周报。" },
      { delivery_id: randomUUID(), profile_ref: "work", text: "## 今日早报\n\n- **部署完成**\n- 查看 [报告](https://example.com/report?token=private) 和 `日志`。" },
      { delivery_id: randomUUID(), profile_ref: "work", text: "🚀".repeat(1_000) },
      { delivery_id: randomUUID(), profile_ref: "work", text: "[".repeat(128 * 1024) },
      { delivery_id: randomUUID(), profile_ref: "work", text: "", attachments: [attachment] },
      { delivery_id: randomUUID(), profile_ref: "work", text: "\n\t　", attachments: [attachment] },
    ];
    for (const delivery of deliveries) {
      await store.transaction((db) => applyInboxDelivery(db, delivery, new Set(["default", "work"])));
    }
    const sent: { title: string; body: string; to: string; interruptionLevel: string; priority: string; sound: string; data: { inbox_id: string } }[] = [];
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(input, "https://exp.host/--/api/v2/push/send");
      assert.equal(init?.method, "POST");
      const messages = JSON.parse(String(init?.body));
      sent.push(...messages);
      return Response.json({ data: messages.map(() => ({ status: "ok", id: randomUUID() })) });
    });
    t.mock.timers.enable({ apis: ["setInterval"] });
    stop = startPushWorker(store, app.log);
    t.mock.timers.tick(3_000);
    await stop();

    assert.equal(sent.length, 6);
    const notification = (index: number) => sent.find((item) => item.data.inbox_id === deliveries[index]!.delivery_id)!;
    assert.equal(notification(0).body, "明天下午三点开会，请带上周报。");
    assert.equal(notification(0).title, "Hermes 收件箱");
    assert.equal(notification(1).title, "Hermes · work");
    assert.equal(notification(1).body, "今日早报 部署完成 查看 报告 和 日志。");
    assert.equal(notification(2).body, "🚀".repeat(499) + "…");
    assert.equal(notification(3).body, "[".repeat(499) + "…");
    assert.equal(notification(4).body, "周报.md");
    assert.equal(notification(5).body, "周报.md");
    for (const item of sent) {
      assert.equal(item.to, "ExpoPushToken[push_test]");
      assert.equal(item.interruptionLevel, "time-sensitive");
      assert.equal(item.priority, "high");
      assert.equal(item.sound, "default");
      assert.deepEqual(Object.keys(item.data), ["inbox_id"]);
      assert.ok(Buffer.byteLength(JSON.stringify(item)) < 4_096);
    }
    assert.equal((await store.query("SELECT * FROM push_outbox")).rowCount, 0);
    assert.equal((await store.query("SELECT data->>'text' AS text FROM inbox WHERE id = $1", [deliveries[2]!.delivery_id])).rows[0].text,
      deliveries[2]!.text);
  } finally {
    await stop?.();
    await app.close();
    await store.close();
    await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.end();
  }
});

test("每轮成功完成只推送一次，发送时定位最终回复，空回复定位该轮提交", { skip: !databaseUrl, timeout: 15_000 }, async (t) => {
  const schema = `turn_push_${randomUUID().replaceAll("-", "")}`;
  const database = new pg.Pool({ connectionString: databaseUrl });
  await database.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const store = openStore(url.href);
  const app = Fastify();
  let stop: (() => Promise<void>) | undefined;
  try {
    await store.migrate();
    await migratePush(store);
    await migratePush(store);
    const deviceId = randomUUID();
    const topicId = randomUUID();
    await store.query("INSERT INTO devices (id, token_hash, name) VALUES ($1, $2, '测试设备')", [deviceId, Buffer.from("turn-push-test")]);
    await store.query("INSERT INTO push_devices (device_id, token) VALUES ($1, 'ExpoPushToken[turn_test]')", [deviceId]);
    await store.query("INSERT INTO topics (id, profile_ref, title, status, session_id) VALUES ($1, 'work', '部署报告', 'ready', 'turn-push')", [topicId]);
    const ingest = (frame: ConnectorEvent) => store.transaction((db) => applyEvent(db, frame, new Set(["work"]), new Map([[topicId, "turn-push"]])));
    async function turn() {
      const submissionId = randomUUID();
      const userId = randomUUID();
      await store.query("INSERT INTO messages (id, topic_id, data) VALUES ($1, $2, $3)",
        [userId, topicId, { message_id: userId, role: "user", text: "请生成报告", status: "streaming", submission_id: submissionId }]);
      await store.query("INSERT INTO submissions (id, topic_id, message_id, data) VALUES ($1, $2, $3, $4)",
        [submissionId, topicId, userId, { status: "streaming" }]);
      const reply: ConnectorEvent = { type: "message", event_id: randomUUID(), topic_id: topicId, message_id: randomUUID(),
        submission_id: submissionId, text: "**部署完成**，请查看报告。", status: "final" };
      const complete: ConnectorEvent = { type: "submission", event_id: randomUUID(), topic_id: topicId, submission_id: submissionId, status: "final" };
      return { userId, reply, complete };
    }
    const sent: { title: string; body: string; channelId: string; data: { topic_id: string; message_id: string } }[] = [];
    t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      const messages = JSON.parse(String(init?.body));
      sent.push(...messages);
      return Response.json({ data: messages.map(() => ({ status: "ok" })) });
    });
    t.mock.timers.enable({ apis: ["setInterval"] });
    async function flush() {
      stop = startPushWorker(store, app.log);
      t.mock.timers.tick(3_000);
      await stop();
    }
    const first = await turn();
    await ingest(first.reply);
    await flush();
    assert.equal(sent.length, 0, "回复投影完成时尚未结束本轮，不提前通知");
    await ingest(first.complete);
    await flush();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.title, "部署报告");
    assert.equal(sent[0]!.body, "部署完成，请查看报告。");
    assert.equal(sent[0]!.channelId, "inbox");
    assert.deepEqual(sent[0]!.data, { topic_id: topicId, message_id: first.reply.message_id });

    const reversed = await turn();
    await ingest(reversed.complete);
    await ingest(reversed.reply);
    const empty = await turn();
    await ingest(empty.complete);
    const failed = await turn();
    await ingest(failed.reply);
    await ingest({ ...failed.complete, status: "failed" });
    const cancelled = await turn();
    await ingest(cancelled.reply);
    await ingest({ ...cancelled.complete, status: "cancelled" });
    await ingest({ ...first.reply, event_id: randomUUID(), message_id: randomUUID(), submission_id: undefined });
    await flush();
    assert.equal(sent.length, 3);
    assert.deepEqual(sent[1]!.data, { topic_id: topicId, message_id: reversed.reply.message_id });
    assert.deepEqual(sent[2]!.data, { topic_id: topicId, message_id: empty.userId });
    assert.equal(sent[2]!.body, "本轮会话已完成");

    await ingest(first.complete);
    await ingest({ ...first.complete, event_id: randomUUID() });
    await ingest({ ...first.reply, event_id: randomUUID() });
    await ingest(empty.reply);
    await ingest({ ...empty.complete, event_id: randomUUID() });
    await flush();
    assert.equal(sent.length, 3, "重连重放和晚到正文不会重复推送已完成的一轮");

    for (const process of [undefined, [{ kind: "reasoning" as const, text: "已经核对。" }]]) {
      const hidden = await turn();
      await ingest({ ...hidden.reply, text: "", ...(process ? { process } : {}) });
      await Promise.all([ingest(hidden.complete), ingest({ ...hidden.complete, event_id: randomUUID() })]);
      const previousCount: number = sent.length;
      await flush();
      assert.equal(sent.length, previousCount + 1, "并发完成事件只推送一次");
      assert.deepEqual(sent.at(-1)!.data, { topic_id: topicId, message_id: hidden.userId }, "不可见的空回复或过程消息回退该轮提交");
      assert.equal(sent.at(-1)!.body, "本轮会话已完成");
    }
  } finally {
    await stop?.();
    await app.close();
    await store.close();
    await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.end();
  }
});
