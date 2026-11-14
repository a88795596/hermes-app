import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { on, once } from "node:events";
import test from "node:test";
import pg from "pg";
import WebSocket from "ws";
import { buildApp } from "../src/app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("自动标题取首条消息，并只采用最新成功完成轮次的摘要", { skip: !databaseUrl, timeout: 10_000 }, async () => {
  const schema = `topic_titles_${randomUUID().replaceAll("-", "")}`;
  const database = new pg.Pool({ connectionString: databaseUrl });
  await database.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const app = buildApp({ databaseUrl: url.href, pairingToken: "pairing-secret", connectorToken: "connector-secret" });
  let connector: WebSocket | undefined;
  try {
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const paired = await app.inject({ method: "POST", url: "/mobile/v1/pairings/redeem",
      payload: { pairing_token: "pairing-secret", device_name: "title test" } });
    const headers = { authorization: `Bearer ${paired.json().data.token}` };
    const get = (path: string) => app.inject({ url: `/mobile/v1${path}`, headers });
    const post = (path: string, payload: object) => app.inject({ method: "POST", url: `/mobile/v1${path}`, headers, payload });
    const profile_id = (await get("/profiles")).json().data[0].profile_id;
    const topicId = randomUUID();
    const path = `/topics/${topicId}`;
    const create = { request_id: topicId, profile_id };
    const opened = await post("/topics", create);
    assert.equal(opened.statusCode, 202);
    assert.equal(opened.json().data.title, "新会话");

    connector = new WebSocket(origin.replace(/^http/, "ws") + "/internal/connector/v1/events", {
      headers: { authorization: "Bearer connector-secret", "x-hermes-mobile-topic-title": "1" },
    });
    const incoming = on(connector, "message", { close: ["close"], signal: AbortSignal.timeout(8_000) });
    await once(connector, "open");
    async function next() {
      const item = await incoming.next();
      assert(!item.done);
      return JSON.parse(item.value[0].toString());
    }
    const send = (frame: object) => connector!.send(JSON.stringify(frame));
    async function result(command_id: string, fields: object = {}) {
      send({ type: "command_result", command_id, status: "ok", ...fields });
      assert.deepEqual(await next(), { type: "ack", id: command_id });
    }
    async function event(type: string, data: object) {
      const event_id = randomUUID();
      send({ type, topic_id: topicId, event_id, ...data });
      assert.deepEqual(await next(), { type: "ack", id: event_id });
    }
    async function submit(text: string) {
      const submission_id = randomUUID();
      assert.equal((await post(`${path}/submissions`, { submission_id, text })).statusCode, 202);
      assert.equal((await next()).command_id, submission_id);
      await result(submission_id, { admission_id: `run-${submission_id}` });
      return submission_id;
    }
    const title = async () => (await get(path)).json().data.topic.title;

    assert.equal((await next()).kind, "create");
    await result(topicId, { session_id: "mobile_title_test" });
    const first = await submit("  排查  同步\n延迟  ");
    const second = await submit("修复移动端的重试逻辑");
    assert.equal(await title(), "排查 同步 延迟");
    assert.equal((await post("/topics", create)).statusCode, 202);
    assert.equal((await post("/topics", { ...create, title: "手工命名" })).statusCode, 409);

    await event("message", { message_id: randomUUID(), submission_id: first, status: "final", text: "发现轮询频率过低" });
    await event("submission", { submission_id: first, status: "final" });
    const firstSummary = await next();
    assert.equal(firstSummary.kind, "summarize_title");
    assert.equal(firstSummary.session_id, "mobile_title_test");
    assert.match(firstSummary.body.input, /发现轮询频率过低/);
    assert.doesNotMatch(firstSummary.body.input, /修复移动端的重试逻辑/);

    await event("message", { message_id: randomUUID(), submission_id: second, status: "final", text: "已补上退避重试" });
    await event("submission", { submission_id: second, status: "final" });
    const secondSummary = await next();
    assert.equal(secondSummary.kind, "summarize_title");
    assert.match(secondSummary.body.input, /发现轮询频率过低/);
    assert.match(secondSummary.body.input, /已补上退避重试/);
    await result(firstSummary.command_id, { title: "排查同步延迟" });
    assert.equal(await title(), "排查 同步 延迟");
    await result(secondSummary.command_id, { title: "修复同步重试" });
    assert.equal(await title(), "修复同步重试");
    assert.equal((await get("/topics")).json().data[0].title, "修复同步重试");

    const third = await submit("继续检查连接状态");
    await event("submission", { submission_id: third, status: "final" });
    await result((await next()).command_id, { status: "error" });
    assert.equal(await title(), "修复同步重试");
    const fourth = await submit("中断这轮");
    await event("submission", { submission_id: fourth, status: "cancelled" });
    const commands = await database.query(`SELECT count(*)::int AS count FROM ${schema}.commands WHERE payload->>'kind' = 'summarize_title'`);
    assert.equal(commands.rows[0].count, 3);

    const manualId = randomUUID();
    const manual = await post("/topics", { request_id: manualId, profile_id, title: "手工命名" });
    assert.equal(manual.json().data.title, "手工命名");
    assert.equal((await next()).command_id, manualId);
    await result(manualId, { session_id: "mobile_manual_test" });
    const submission_id = randomUUID();
    assert.equal((await post(`/topics/${manualId}/submissions`, { submission_id, text: "保留旧标题" })).statusCode, 202);
    assert.equal((await next()).command_id, submission_id);
    await result(submission_id, { admission_id: "run-manual" });
    assert.equal((await get(`/topics/${manualId}`)).json().data.topic.title, "手工命名");
  } finally {
    connector?.terminate();
    await app.close();
    await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.end();
  }
});
