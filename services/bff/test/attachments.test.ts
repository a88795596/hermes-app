import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { on, once } from "node:events";
import test from "node:test";
import pg from "pg";
import WebSocket from "ws";
import { buildApp } from "../src/app.js";
import { openStore } from "../src/store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("已发送的附件可在回执和刷新后预览，连接器只在待处理期间能读取原件", { skip: !databaseUrl, timeout: 10_000 }, async (t) => {
  const schema = `attachments_${randomUUID().replaceAll("-", "")}`;
  const database = new pg.Pool({ connectionString: databaseUrl });
  await database.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const app = buildApp({ databaseUrl: url.href, pairingToken: "pairing-secret", connectorToken: "connector-secret" });
  let connector: WebSocket | undefined;
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const paired = await app.inject({ method: "POST", url: "/mobile/v1/pairings/redeem",
      payload: { pairing_token: "pairing-secret", device_name: "attachment test" } });
    const headers = { authorization: `Bearer ${paired.json().data.token}` };
    const machine = { authorization: "Bearer connector-secret", "x-hermes-mobile-attachments": "1" };
    const profile_id = (await app.inject({ url: "/mobile/v1/profiles", headers })).json().data[0].profile_id;
    const topicId = randomUUID();
    const post = (url: string, payload: object) => app.inject({ method: "POST", url: `/mobile/v1${url}`, headers, payload });
    assert.equal((await post("/topics", { request_id: topicId, profile_id })).statusCode, 202);

    connector = new WebSocket(origin.replace(/^http/, "ws") + "/internal/connector/v1/events", { headers: machine });
    const incoming = on(connector, "message", { close: ["close"], signal: t.signal });
    await once(connector, "open", { signal: t.signal });
    async function next() {
      const item = await incoming.next();
      assert(!item.done);
      return JSON.parse(item.value[0].toString());
    }
    async function receipt(command_id: string, fields: object) {
      connector!.send(JSON.stringify({ type: "command_result", command_id, status: "ok", ...fields }));
      assert.deepEqual(await next(), { type: "ack", id: command_id });
    }
    assert.equal((await next()).kind, "create");
    await receipt(topicId, { session_id: "mobile_attachment_test" });

    const path = `/topics/${topicId}`;
    const submission_id = randomUUID();
    const text = "请读我刚选的附件。";
    const file = { name: "报告.txt", mime: "text/plain", size: 3, content_base64: "YWJj" };
    const image = { name: "截图.png", mime: "image/png", size: 68,
      content_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLG0AAAAASUVORK5CYII=" };
    const upload = { submission_id, text, attachments: [file, image] };
    assert.equal((await app.inject({ method: "POST", url: `/mobile/v1${path}/submissions`, payload: upload })).statusCode, 401);
    const result = await post(`${path}/submissions`, upload);
    assert.equal(result.statusCode, 202);
    const { content_base64, ...metadata } = file;
    const sent = result.json().data.attachments;
    const [documentId, imageId] = sent.map((item: { attachment_id?: string }) => item.attachment_id);
    assert.ok(documentId && imageId && documentId !== imageId, "每个已发送附件都需要持久预览 ID");
    assert.deepEqual(sent, [{ ...metadata, attachment_id: documentId },
      { name: image.name, mime: image.mime, size: image.size, attachment_id: imageId }]);
    const frame = await next();
    assert.deepEqual(frame.body, { submission_id, text, steer_if_running: true, attachments: [
      { ...metadata, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
      { name: image.name, mime: image.mime, size: image.size, sha256: "2ae67197d8706fbe5a6fdf6a46b7f6ba46a3a9568a905f7f1d2d10ee22cc3e36" },
    ] });
    const download = (position: number) => `/internal/connector/v1/submissions/${submission_id}/attachments/${position}`;
    assert.equal((await app.inject({ url: download(1), headers })).statusCode, 401);
    assert.equal((await app.inject({ url: download(1), headers: machine })).body, "abc");
    assert.deepEqual((await app.inject({ url: download(2), headers: machine })).rawPayload, Buffer.from(image.content_base64, "base64"));
    const preview = `/mobile/v1/attachments/${imageId}`;
    assert.equal((await app.inject({ url: preview })).statusCode, 401);
    assert.equal((await app.inject({ url: preview, headers: machine })).statusCode, 401);
    assert.equal((await app.inject({ url: preview, headers })).headers["content-type"], "image/png");
    await receipt(submission_id, { admission_id: "run-attachment" });
    assert.equal((await app.inject({ url: download(1), headers: machine })).statusCode, 404);
    assert.deepEqual((await app.inject({ url: preview, headers })).rawPayload, Buffer.from(image.content_base64, "base64"));
    assert.equal((await app.inject({ url: `/mobile/v1/attachments/${documentId}`, headers })).body, "abc");
    assert.deepEqual((await post(`${path}/submissions`, upload)).json().data, result.json().data);
    assert.equal((await post(`${path}/submissions`, { ...upload, attachments: [{ ...file, content_base64: "YWJk" }, image] })).statusCode, 409);

    const second = randomUUID();
    const larger = Buffer.alloc(300 * 1024, "x");
    const video = await post(`${path}/submissions`, { submission_id: second, text: "", attachments: [
      { name: "录像.mp4", mime: "video/mp4", size: larger.length, content_base64: larger.toString("base64") },
    ] });
    assert.equal(video.statusCode, 202);
    assert.equal((await next()).body.text, "");
    assert.deepEqual((await app.inject({ url: `/internal/connector/v1/submissions/${second}/attachments/1`, headers: machine })).rawPayload, larger);
    await receipt(second, { admission_id: "run-attachment-only" });
    const detail = await app.inject({ url: `/mobile/v1${path}`, headers });
    assert.deepEqual(detail.json().data.messages.map((message: { text: string }) => message.text), [text, ""]);
    assert.deepEqual(detail.json().data.messages[0].attachments, sent);
    const videoPreview = `/mobile/v1/attachments/${detail.json().data.messages[1].attachments[0].attachment_id}`;
    const range = await app.inject({ url: videoPreview, headers: { ...headers, range: "bytes=2-5" } });
    assert.equal(range.statusCode, 206);
    assert.equal(range.headers["content-type"], "video/mp4");
    assert.deepEqual(range.rawPayload, larger.subarray(2, 6));
    assert(!detail.body.includes(content_base64));
    assert(!detail.body.includes(image.content_base64));
    const restricted = buildApp({ databaseUrl: url.href, pairingToken: "pairing-secret", connectorToken: "connector-secret",
      profileRefs: ["other"] });
    try {
      assert.equal((await restricted.inject({ url: preview, headers })).statusCode, 404);
    } finally {
      await restricted.close();
    }

    for (const attachment of [{ ...file, name: "../file.txt" }, { ...file, content_base64: "YWJ=" },
      { ...file, size: 4 }, { ...file, mime: "image/png" }]) {
      assert.equal((await post(`${path}/submissions`, { submission_id: randomUUID(), text, attachments: [attachment] })).statusCode, 422);
    }
  } finally {
    connector?.terminate();
    await app.close();
    await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.end();
  }
});

test("升级为仍有原件的旧提交补回预览，重复升级和重试使用相同引用", { skip: !databaseUrl }, async () => {
  const schema = `legacy_files_${randomUUID().replaceAll("-", "")}`;
  const database = new pg.Pool({ connectionString: databaseUrl });
  await database.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const store = openStore(url.href);
  const app = buildApp({ databaseUrl: url.href, pairingToken: "pair-test", connectorToken: "connector-test" });
  try {
    await store.migrate();
    const topicId = randomUUID();
    const [retained, purged] = [randomUUID(), randomUUID()];
    const metadata = { name: "旧附件.txt", mime: "text/plain", size: 3 };
    const reference = { ...metadata, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
    await store.query("INSERT INTO topics (id, profile_ref, title, status, session_id) VALUES ($1, 'default', '旧话题', 'ready', 'old-session')", [topicId]);
    for (const submission_id of [retained, purged]) {
      const message = { message_id: randomUUID(), role: "user", text: "描述", status: "accepted", submission_id, attachments: [metadata] };
      const command = { type: "command", kind: "submit", command_id: submission_id, topic_id: topicId, profile_ref: "default",
        session_id: "old-session", body: { submission_id, text: message.text, attachments: [reference], steer_if_running: true } };
      const result = submission_id === purged ? { type: "command_result", command_id: purged, status: "ok", admission_id: "old-run" } : null;
      await store.query("INSERT INTO messages (id, topic_id, data) VALUES ($1,$2,$3)", [message.message_id, topicId, message]);
      await store.query("INSERT INTO submissions (id, topic_id, message_id, data) VALUES ($1,$2,$3,$4)", [submission_id, topicId, message.message_id, {}]);
      await store.query("INSERT INTO commands (id, topic_id, payload, receipt, dispatched, result) VALUES ($1,$2,$3,$4,true,$5)",
        [submission_id, topicId, command, message, result]);
    }
    await store.query("INSERT INTO submission_attachments (submission_id, position, content) VALUES ($1,1,$2)", [retained, Buffer.from("abc")]);
    await app.ready();
    const paired = await app.inject({ method: "POST", url: "/mobile/v1/pairings/redeem",
      payload: { pairing_token: "pair-test", device_name: "migration test" } });
    const headers = { authorization: `Bearer ${paired.json().data.token}` };
    const topicPath = `/mobile/v1/topics/${topicId}`;
    const history = () => app.inject({ url: topicPath, headers }).then((reply) => reply.json().data.messages);
    const [old, unavailable] = await history();
    const id = old.attachments[0].attachment_id;
    assert.ok(id, "仍有原始字节的旧附件应能预览");
    assert.deepEqual(unavailable.attachments, [metadata]);
    await store.migrate();
    assert.deepEqual(await history(), [old, unavailable]);
    assert.equal((await app.inject({ url: `/mobile/v1/attachments/${id}`, headers })).body, "abc");
    assert.equal((await app.inject({ url: `/internal/connector/v1/submissions/${retained}/attachments/1`,
      headers: { authorization: "Bearer connector-test" } })).body, "abc");
    const retry = await app.inject({ method: "POST", url: `${topicPath}/submissions`, headers,
      payload: { submission_id: retained, text: "描述", attachments: [{ ...metadata, content_base64: "YWJj" }] } });
    assert.equal(retry.statusCode, 202);
    assert.deepEqual(retry.json().data.attachments, old.attachments);
  } finally {
    await app.close();
    await store.close();
    await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.end();
  }
});
