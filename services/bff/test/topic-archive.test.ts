import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { ConnectorEvent } from "@hermes-mobile/protocol";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { applyEvent } from "../src/ingress.js";
import { openStore } from "../src/store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("迁移会话时间并持久归档，后续回复保留历史并更新活动时间", { skip: !databaseUrl }, async () => {
  const schema = `topic_archive_${randomUUID().replaceAll("-", "")}`;
  const database = new pg.Pool({ connectionString: databaseUrl });
  await database.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const store = openStore(url.href);
  const app = buildApp({ databaseUrl: url.href, pairingToken: "pairing-secret", connectorToken: "connector-secret" });
  try {
    const createdAt = "2025-06-10T08:00:00.000Z";
    const untouchedCreatedAt = "2025-06-11T08:00:00.000Z";
    const lastActivity = "2025-07-20T08:00:00.000Z";
    const topicId = randomUUID();
    const untouchedId = randomUUID();
    const hiddenId = randomUUID();
    await store.migrate();
    await store.query("ALTER TABLE topics DROP COLUMN IF EXISTS updated_at, DROP COLUMN IF EXISTS archived");
    await store.query(`INSERT INTO topics (id, profile_ref, title, status, session_id, created_at) VALUES
      ($1, 'default', '旧会话', 'ready', 'archive-test', $4),
      ($2, 'default', '没有消息的会话', 'creating', NULL, $5),
      ($3, 'private', '不可访问的会话', 'creating', NULL, $4)`, [topicId, untouchedId, hiddenId, createdAt, untouchedCreatedAt]);
    await store.query("INSERT INTO commands (id, topic_id, payload, receipt, created_at) VALUES ($1, $2, $3, '{}', $4)",
      [randomUUID(), topicId, { kind: "submit" }, lastActivity]);

    const paired = await app.inject({ method: "POST", url: "/mobile/v1/pairings/redeem",
      payload: { pairing_token: "pairing-secret", device_name: "archive test" } });
    assert.equal(paired.statusCode, 200);
    const headers = { authorization: `Bearer ${paired.json().data.token}` };
    const get = async (path: string) => {
      const result = await app.inject({ url: `/mobile/v1${path}`, headers });
      assert.equal(result.statusCode, 200);
      return result.json().data;
    };
    const archive = (id: string, archived: unknown, authenticated = true) => app.inject({
      method: "PUT", url: `/mobile/v1/topics/${id}/archive`, headers: authenticated ? headers : {}, payload: { archived },
    });
    const path = `/topics/${topicId}`;
    const initial = await get("/topics");
    assert.deepEqual(initial.map(({ topic_id }: { topic_id: string }) => topic_id), [topicId, untouchedId]);
    assert.equal(initial[0].created_at, createdAt);
    assert.equal(initial[0].updated_at, lastActivity);
    assert.equal(initial[0].archived, false);
    assert.equal(initial[1].updated_at, untouchedCreatedAt);

    const submission_id = randomUUID();
    const submit = () => app.inject({ method: "POST", url: `/mobile/v1${path}/submissions`, headers,
      payload: { submission_id, text: "你好" } });
    assert.equal((await submit()).statusCode, 202);
    const sent = (await get(path)).topic;
    assert(sent.updated_at > lastActivity);
    assert.equal(sent.created_at, createdAt);
    assert.equal((await submit()).statusCode, 202);
    assert.equal((await get(path)).topic.updated_at, sent.updated_at);

    assert.equal((await archive(topicId, true, false)).statusCode, 401);
    assert.equal((await archive(hiddenId, true)).statusCode, 404);
    assert.equal((await archive(topicId, "true")).statusCode, 422);
    assert.equal((await archive(topicId, true)).statusCode, 200);
    assert.equal((await archive(topicId, true)).statusCode, 200);
    assert.equal((await get("/topics")).length, 1);
    assert.equal((await get("/topics?include_archived=true"))[0].archived, true);
    assert.equal((await get(path)).topic.updated_at, sent.updated_at);

    const frame: ConnectorEvent = { type: "message", event_id: randomUUID(), topic_id: topicId,
      message_id: randomUUID(), submission_id, text: "回复", status: "final" };
    const ingest = () => store.transaction((db) => applyEvent(db, frame, new Set(["default"]), new Map([[topicId, "archive-test"]])));
    await store.query("UPDATE topics SET updated_at = $2 WHERE id = $1", [topicId, lastActivity]);
    await ingest();
    const replied = await get(path);
    assert(replied.topic.updated_at > lastActivity);
    assert.equal(replied.topic.archived, true);
    assert.deepEqual(replied.messages.map(({ text }: { text: string }) => text), ["你好", "回复"]);
    await ingest();
    await store.migrate();
    assert.equal((await get(path)).topic.updated_at, replied.topic.updated_at);
    assert.equal((await get("/topics")).length, 1);

    assert.equal((await archive(topicId, false)).statusCode, 200);
    assert.equal((await get("/topics"))[0].archived, false);
    assert.equal((await get(path)).topic.updated_at, replied.topic.updated_at);
  } finally {
    await app.close();
    await store.close();
    await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.end();
  }
});
