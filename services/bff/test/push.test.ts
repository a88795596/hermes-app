import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import pg from "pg";
import { applyInboxDelivery } from "../src/ingress.js";
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
    const deliveries = [
      { delivery_id: randomUUID(), profile_ref: "default", text: "明天下午三点开会，请带上周报。" },
      { delivery_id: randomUUID(), profile_ref: "work", text: "## 今日早报\n\n- **部署完成**\n- 查看 [报告](https://example.com/report?token=private) 和 `日志`。" },
      { delivery_id: randomUUID(), profile_ref: "work", text: "🚀".repeat(1_000) },
      { delivery_id: randomUUID(), profile_ref: "work", text: "[".repeat(128 * 1024) },
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

    assert.equal(sent.length, 4);
    const notification = (index: number) => sent.find((item) => item.data.inbox_id === deliveries[index]!.delivery_id)!;
    assert.equal(notification(0).body, "明天下午三点开会，请带上周报。");
    assert.equal(notification(0).title, "Hermes 收件箱");
    assert.equal(notification(1).title, "Hermes · work");
    assert.equal(notification(1).body, "今日早报 部署完成 查看 报告 和 日志。");
    assert.equal(notification(2).body, "🚀".repeat(499) + "…");
    assert.equal(notification(3).body, "[".repeat(499) + "…");
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
