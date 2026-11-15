import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { on, once } from "node:events";
import test from "node:test";
import pg from "pg";
import WebSocket from "ws";
import { buildApp } from "../src/app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("说明和附件按同一次提交持久化，只有连接器可读取附件字节", { skip: !databaseUrl, timeout: 10_000 }, async (t) => {
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
    const upload = { submission_id, text, attachments: [file] };
    assert.equal((await app.inject({ method: "POST", url: `/mobile/v1${path}/submissions`, payload: upload })).statusCode, 401);
    const result = await post(`${path}/submissions`, upload);
    assert.equal(result.statusCode, 202);
    const { content_base64, ...metadata } = file;
    assert.deepEqual(result.json().data.attachments, [metadata]);
    const frame = await next();
    assert.deepEqual(frame.body, { submission_id, text, steer_if_running: true, attachments: [
      { ...metadata, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    ] });
    const download = `/internal/connector/v1/submissions/${submission_id}/attachments/1`;
    assert.equal((await app.inject({ url: download, headers })).statusCode, 401);
    assert.equal((await app.inject({ url: download, headers: machine })).body, "abc");
    await receipt(submission_id, { admission_id: "run-attachment" });
    assert.equal((await app.inject({ url: download, headers: machine })).statusCode, 404);
    assert.equal((await post(`${path}/submissions`, upload)).json().data.message_id, result.json().data.message_id);
    assert.equal((await post(`${path}/submissions`, { ...upload, attachments: [{ ...file, content_base64: "YWJk" }] })).statusCode, 409);

    const second = randomUUID();
    const larger = Buffer.alloc(300 * 1024, "x");
    assert.equal((await post(`${path}/submissions`, { submission_id: second, text: "", attachments: [
      { ...metadata, size: larger.length, content_base64: larger.toString("base64") },
    ] })).statusCode, 202);
    assert.equal((await next()).body.text, "");
    assert.deepEqual((await app.inject({ url: `/internal/connector/v1/submissions/${second}/attachments/1`, headers: machine })).rawPayload, larger);
    await receipt(second, { admission_id: "run-attachment-only" });
    const detail = await app.inject({ url: `/mobile/v1${path}`, headers });
    assert.deepEqual(detail.json().data.messages.map((message: { text: string }) => message.text), [text, ""]);
    assert(!detail.body.includes(content_base64));

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
