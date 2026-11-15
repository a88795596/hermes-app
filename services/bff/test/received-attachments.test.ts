import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import type { Attachment, InboxItem } from "@hermes-mobile/protocol";
import pg from "pg";
import WebSocket from "ws";
import { buildApp } from "../src/app.js";
import { connectorFrame } from "../src/connector-frame.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("回复帧接受纯附件并拒绝不完整或超量的附件引用", () => {
  const attachment = { attachment_id: randomUUID(), name: "报告.html", mime: "text/html", size: 3 };
  const frame = { type: "message", event_id: randomUUID(), topic_id: randomUUID(), message_id: randomUUID(),
    text: "", status: "final", attachments: [attachment] };
  assert.deepEqual(connectorFrame(frame), frame);
  for (const attachments of [
    [{ ...attachment, attachment_id: undefined }], [{ ...attachment, name: "../报告.html" }],
    [{ ...attachment, mime: "text/html; charset=utf-8" }], [{ ...attachment, size: 50 * 1024 * 1024 + 1 }],
    [{ ...attachment, content_base64: "YWJj" }], Array.from({ length: 11 }, () => attachment),
  ]) assert.throws(() => connectorFrame({ ...frame, attachments }), { statusCode: 422 });
});

test("接收文件持久保存、按配置档案关联，并支持鉴权下载和媒体字节范围", { skip: !databaseUrl, timeout: 20_000 }, async (t) => {
  const schema = `received_attachments_${randomUUID().replaceAll("-", "")}`;
  const database = new pg.Pool({ connectionString: databaseUrl });
  await database.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const app = buildApp({ databaseUrl: url.href, pairingToken: "pairing-secret", connectorToken: "connector-secret",
    inboxDeliveryToken: "delivery-secret", profileRefs: ["default", "work"] });
  let connector: WebSocket | undefined;
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const headers = (token: string) => ({ authorization: `Bearer ${token}` });
    const paired = await app.inject({ method: "POST", url: "/mobile/v1/pairings/redeem",
      payload: { pairing_token: "pairing-secret", device_name: "接收文件测试" } });
    const device = headers(paired.json().data.token);
    const attachmentId = randomUUID();
    const uploadPath = `/internal/attachments/v1/${attachmentId}`;
    const downloadPath = `/mobile/v1/attachments/${attachmentId}`;
    const content = Buffer.from("<!doctype html><h1>报告</h1><script>alert(1)</script>");
    const upload = { profile_ref: "work", name: "报告.html", mime: "text/html", size: content.length,
      content_base64: content.toString("base64") };
    const put = (payload: object, token = "delivery-secret", path = uploadPath) => app.inject({
      method: "PUT", url: path, headers: token ? headers(token) : {}, payload,
    });
    for (const token of ["", "pairing-secret", paired.json().data.token]) {
      assert.equal((await put(upload, token)).statusCode, 401);
    }
    assert.equal((await put({ ...upload, profile_ref: "private" })).statusCode, 404);
    assert.equal((await put(upload, "delivery-secret", "/internal/attachments/v1/invalid")).statusCode, 422);
    for (const fields of [{ name: "../报告.html" }, { size: 0 }, { size: 50 * 1024 * 1024 + 1 },
      { size: upload.size + 1 }, { content_base64: "invalid" }, { mime: "image/png" }]) {
      assert.equal((await put({ ...upload, ...fields })).statusCode, 422);
    }
    const first = await put(upload);
    assert.equal(first.statusCode, 200);
    const attachment: Attachment = { attachment_id: attachmentId, name: upload.name, mime: upload.mime, size: upload.size };
    assert.deepEqual(first.json().data, attachment);
    assert.deepEqual((await put(upload, "connector-secret")).json().data, attachment);
    assert.equal((await put({ ...upload, profile_ref: "default" })).statusCode, 409);
    assert.equal((await put({ ...upload, name: "不同文件.html" })).statusCode, 409);
    assert.equal((await put({ ...upload, content_base64: Buffer.alloc(content.length, "x").toString("base64") })).statusCode, 409);
    assert.equal((await app.inject({ url: downloadPath, headers: device })).statusCode, 404);

    const delivery = { delivery_id: randomUUID(), profile_ref: "work", text: "", attachments: [attachment] };
    const deliver = (payload: object) => app.inject({ method: "POST", url: "/internal/inbox/v1/deliveries",
      headers: headers("delivery-secret"), payload });
    assert.equal((await deliver({ ...delivery, profile_ref: "default" })).statusCode, 404);
    assert.equal((await deliver({ ...delivery, attachments: [{ ...attachment, mime: "text/plain" }] })).statusCode, 422);
    assert.equal((await deliver({ ...delivery, attachments: [{ ...attachment, attachment_id: randomUUID() }] })).statusCode, 404);
    assert.equal((await deliver(delivery)).statusCode, 204);
    assert.equal((await deliver(delivery)).statusCode, 204);
    assert.equal((await deliver({ ...delivery, text: "不同正文" })).statusCode, 409);
    const inbox = await app.inject({ url: "/mobile/v1/inbox", headers: device });
    const item = inbox.json().data[0] as InboxItem;
    assert.deepEqual(item.attachments, [attachment]);
    assert.equal(item.title, upload.name);
    assert.equal(item.text, "");
    assert(!inbox.body.includes("content_base64"));
    for (const token of ["", "delivery-secret", "connector-secret"]) {
      assert.equal((await app.inject({ url: downloadPath, headers: token ? headers(token) : {} })).statusCode, 401);
    }
    const download = await app.inject({ url: downloadPath, headers: device });
    assert.deepEqual(download.rawPayload, content);
    assert.equal(download.headers["content-type"], "text/html");
    assert.equal(download.headers["x-content-type-options"], "nosniff");
    assert.match(String(download.headers["content-disposition"]), /^attachment;/u);
    assert.match(String(download.headers["content-security-policy"]), /sandbox/u);
    assert.equal(download.headers["accept-ranges"], "bytes");
    for (const [range, start, end] of [["bytes=0-4", 0, 4], ["bytes=-4", content.length - 4, content.length - 1],
      ["bytes=4-", 4, content.length - 1], ["bytes=0-9999", 0, content.length - 1]] as const) {
      const partial = await app.inject({ url: downloadPath, headers: { ...device, range } });
      assert.equal(partial.statusCode, 206);
      assert.deepEqual(partial.rawPayload, content.subarray(start, end + 1));
      assert.equal(partial.headers["content-range"], `bytes ${start}-${end}/${content.length}`);
      assert.equal(Number(partial.headers["content-length"]), end - start + 1);
    }
    for (const range of ["bytes=9999-", "bytes=5-1", "bytes=-0", "bytes=0-1,3-4", "bytes=abc"]) {
      const rejected = await app.inject({ url: downloadPath, headers: { ...device, range } });
      assert.equal(rejected.statusCode, 416);
      assert.equal(rejected.headers["content-range"], `bytes */${content.length}`);
    }
    const head = await app.inject({ method: "HEAD", url: downloadPath, headers: device });
    assert.equal(head.statusCode, 200);
    assert.equal(Number(head.headers["content-length"]), content.length);
    assert.equal(head.body, "");

    const larger = Buffer.alloc(6 * 1024 * 1024, "x");
    const videoId = randomUUID();
    const video = await put({ profile_ref: "default", name: "录像.mp4", mime: "video/mp4", size: larger.length,
      content_base64: larger.toString("base64") }, "connector-secret", `/internal/attachments/v1/${videoId}`);
    assert.equal(video.statusCode, 200);
    const videoAttachment = video.json().data;
    const profiles = (await app.inject({ url: "/mobile/v1/profiles", headers: device })).json().data;
    const profile_id = profiles.find((profile: { label: string }) => profile.label === "default").profile_id;
    const topicId = randomUUID();
    assert.equal((await app.inject({ method: "POST", url: "/mobile/v1/topics", headers: device,
      payload: { request_id: topicId, profile_id } })).statusCode, 202);
    connector = new WebSocket(origin.replace(/^http/u, "ws") + "/internal/connector/v1/events", { headers: headers("connector-secret") });
    const command = await once(connector, "message", { signal: t.signal });
    assert.equal(JSON.parse(command[0].toString()).kind, "create");
    const created = once(connector, "message", { signal: t.signal });
    connector.send(JSON.stringify({ type: "command_result", command_id: topicId, status: "ok", session_id: "received-media" }));
    await created;
    const messageId = randomUUID();
    for (const fields of [{ status: "streaming", attachments: [videoAttachment] }, { status: "final" }]) {
      const ack: ReturnType<typeof once> = once(connector, "message", { signal: t.signal });
      const event_id = randomUUID();
      connector.send(JSON.stringify({ type: "message", event_id, topic_id: topicId, message_id: messageId, text: "", ...fields }));
      assert.deepEqual(JSON.parse((await ack)[0].toString()), { type: "ack", id: event_id });
    }
    const topic = (await app.inject({ url: `/mobile/v1/topics/${topicId}`, headers: device })).json().data;
    assert.deepEqual(topic.messages[0].attachments, [videoAttachment]);
    const videoDownload = await app.inject({ url: `/mobile/v1/attachments/${videoId}`, headers: { ...device, range: "bytes=0-3" } });
    assert.equal(videoDownload.statusCode, 206);
    assert.equal(videoDownload.body, "xxxx");
    const restricted = buildApp({ databaseUrl: url.href, pairingToken: "pairing-secret", connectorToken: "connector-secret",
      profileRefs: ["default"] });
    try {
      assert.equal((await restricted.inject({ url: downloadPath, headers: device })).statusCode, 404);
      assert.equal((await restricted.inject({ url: `/mobile/v1/attachments/${videoId}`, headers: device })).statusCode, 200);
    } finally {
      await restricted.close();
    }
  } finally {
    connector?.terminate();
    await app.close();
    await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.end();
  }
});
