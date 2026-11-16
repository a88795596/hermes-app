import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import websocket from "@fastify/websocket";
import type { Command, CommandResult } from "@hermes-mobile/protocol";
import Fastify from "fastify";
import pg from "pg";
import WebSocket from "ws";
import { registerBridge } from "../src/bridge.js";
import { applyResult } from "../src/ingress.js";
import { requestModel, requestNativeCommand, requestReasoning, respond, submit } from "../src/mutations.js";
import { nativeCommandRequest } from "../src/projections.js";
import { openStore } from "../src/store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL 并发发送与重置由事务锁排序，不留下旧绑定待发命令", { skip: !databaseUrl, timeout: 10_000 }, async () => {
  const schema = `native_race_${randomUUID().replaceAll("-", "")}`;
  const database = new pg.Pool({ connectionString: databaseUrl });
  await database.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const store = openStore(url.href);
  const refs = new Set(["work"]);
  try {
    await store.migrate();
    for (let index = 0; index < 4; index++) {
      const topicId = randomUUID();
      const oldSession = `old-${index}`;
      await store.query("INSERT INTO topics (id, profile_ref, title, status, session_id) VALUES ($1, 'work', '并发测试', 'ready', $2)", [topicId, oldSession]);
      const resetId = randomUUID();
      const submissionId = randomUUID();
      const operations = [
        () => store.transaction((db) => submit(db, refs, topicId, submissionId, "继续", [], false)),
        () => store.transaction((db) => requestNativeCommand(db, refs, topicId, resetId, "/new", "ready")),
      ];
      if (index % 2) operations.reverse();
      const results = await Promise.allSettled(operations.map((operation) => operation()));
      assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
      const rejected = results.find((result) => result.status === "rejected");
      assert.equal(rejected?.reason.code, "NATIVE_COMMAND_PENDING");
      const pending = (await store.query<{ payload: Command }>("SELECT payload FROM commands WHERE topic_id = $1", [topicId])).rows;
      assert.equal(pending.length, 1);
      if (pending[0].payload.kind === "submit") {
        await store.transaction((db) => applyResult(db, { type: "command_result", command_id: submissionId, status: "error", error: "测试未执行" }, refs));
        await store.transaction((db) => requestNativeCommand(db, refs, topicId, resetId, "/new", "ready"));
      }
      const nextId = randomUUID();
      const final: CommandResult = { type: "command_result", command_id: resetId, status: "ok",
        native_result: { output: "已重置", reset: true, session_id: `new-${index}` } };
      const racing = await Promise.allSettled([
        store.transaction((db) => applyResult(db, final, refs)),
        store.transaction((db) => submit(db, refs, topicId, nextId, "重置后继续", [], false)),
      ]);
      assert.equal(racing[0].status, "fulfilled");
      if (racing[1].status === "rejected") {
        assert.equal(racing[1].reason.code, "NATIVE_COMMAND_PENDING");
        await store.transaction((db) => submit(db, refs, topicId, nextId, "重置后继续", [], false));
      }
      const queued = (await store.query<{ payload: Command }>("SELECT payload FROM commands WHERE topic_id = $1 AND result IS NULL", [topicId])).rows;
      assert.equal(queued.length, 1);
      assert.equal(queued[0].payload.session_id, `new-${index}`);
    }
  } finally {
    await store.close();
    await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.end();
  }
});

test("PostgreSQL 原生命令回执原子旋转绑定、释放写入锁并保留历史", { skip: !databaseUrl, timeout: 15_000 }, async (t) => {
  const schema = `native_commands_${randomUUID().replaceAll("-", "")}`;
  const database = new pg.Pool({ connectionString: databaseUrl });
  await database.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const store = openStore(url.href);
  const app = Fastify();
  let socket: WebSocket | undefined;
  try {
    await store.migrate();
    const topicId = randomUUID();
    const otherTopic = randomUUID();
    const refs = new Set(["work"]);
    await store.query("INSERT INTO topics (id, profile_ref, title, status, session_id) VALUES ($1, 'work', '原标题', 'ready', 'old-session'), ($2, 'private', '私有', 'ready', 'old-session')", [topicId, otherTopic]);
    const messageId = randomUUID();
    const controlId = randomUUID();
    await store.query("INSERT INTO messages (id, topic_id, data) VALUES ($1, $2, $3)", [messageId, topicId,
      { message_id: messageId, role: "assistant", text: "独立投递和附件仍在历史中", status: "final", attachments: [{ name: "report.txt" }] }]);
    await store.query("INSERT INTO controls (id, topic_id, data) VALUES ($1, $2, $3)", [controlId, topicId,
      { control_id: controlId, kind: "approval", prompt: "允许？", choices: ["yes"], status: "pending" }]);
    await app.register(websocket);
    const bridge = registerBridge(app, store, refs, "secret", () => {});
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    socket = new WebSocket(origin.replace(/^http/u, "ws") + "/internal/connector/v1/events", {
      headers: { authorization: "Bearer secret", "x-hermes-mobile-native-commands": "1", "x-hermes-mobile-reasoning": "1" },
    });
    const next = async () => JSON.parse(String((await once(socket!, "message", { signal: t.signal }))[0]));
    assert.equal((await next()).kind, "watch");
    const enqueue = async (command: string) => {
      const id = randomUUID();
      await store.transaction((db) => requestNativeCommand(db, refs, topicId, id, command, "ready"));
      const sent = next();
      bridge.pump();
      const payload = await sent;
      assert.equal(payload.command_id, id);
      return payload as Command;
    };
    const sendResult = async (result: CommandResult) => {
      const ack = next();
      socket!.send(JSON.stringify(result));
      assert.deepEqual(await ack, { type: "ack", id: result.command_id });
    };
    const report = await enqueue("/insights 7");
    await sendResult({ type: "command_result", command_id: report.command_id, status: "unknown", error: "报告仍在生成" });
    const compress = await enqueue("/compact");
    const blocked = { code: "NATIVE_COMMAND_PENDING" };
    const send = (id = randomUUID()) => store.transaction((db) => submit(db, refs, topicId, id, "继续", [], false));
    await assert.rejects(send(), blocked);
    await assert.rejects(store.transaction((db) => requestModel(db, refs, topicId, randomUUID(), { provider: "p", model: "m" })), blocked);
    await assert.rejects(store.transaction((db) => requestReasoning(db, refs, topicId, randomUUID(), "high", "ready")), blocked);
    await assert.rejects(store.transaction((db) => respond(db, refs, controlId, randomUUID(), "yes")), blocked);
    await assert.rejects(store.transaction((db) => requestNativeCommand(db, refs, topicId, randomUUID(), "/context", "ready")), blocked);
    await store.transaction((db) => requestNativeCommand(db, refs, topicId, compress.command_id, "/compact", "ready"));
    const unknown: CommandResult = { type: "command_result", command_id: compress.command_id, status: "unknown", error: "等待原生回执" };
    await sendResult(unknown);
    await assert.rejects(send(), blocked);
    assert.equal((await nativeCommandRequest(store, refs, topicId, compress.command_id)).status, "unknown");
    const final: CommandResult = { type: "command_result", command_id: compress.command_id, status: "ok",
      native_result: { output: "已压缩", session_id: "compressed-session" } };
    await assert.rejects(store.transaction((db) => applyResult(db, final, new Set(["private"]))), { statusCode: 404 });
    await store.query("UPDATE topics SET session_id = 'unrelated-session' WHERE id = $1", [topicId]);
    await assert.rejects(store.transaction((db) => applyResult(db, final, refs)), { statusCode: 422 });
    await store.query("UPDATE topics SET session_id = 'old-session' WHERE id = $1", [topicId]);
    await sendResult(final);
    await sendResult(final);
    assert.deepEqual(await nativeCommandRequest(store, refs, topicId, compress.command_id), { status: "ok", native_result: final.native_result });
    await assert.rejects(store.transaction((db) => applyResult(db, unknown, refs)), { statusCode: 409 });
    assert.equal((await store.query("SELECT session_id FROM topics WHERE id = $1", [otherTopic])).rows[0].session_id, "old-session");
    const submissionId = randomUUID();
    await send(submissionId);
    const pending = next();
    bridge.pump();
    const submission = await pending;
    assert.equal(submission.command_id, submissionId);
    assert.equal(submission.session_id, "compressed-session");
    await assert.rejects(store.transaction((db) => requestNativeCommand(db, refs, topicId, randomUUID(), "/undo", "ready")), { code: "TOPIC_BUSY" });
    await sendResult({ type: "command_result", command_id: submissionId, status: "error", error: "测试未执行模型" });
    const undo = await enqueue("/undo 1");
    await sendResult({ type: "command_result", command_id: undo.command_id, status: "ok", native_result: { output: "已撤回上下文", rewound_turns: 1 } });
    assert.equal((await store.query("SELECT count(*)::int AS count FROM messages WHERE topic_id = $1", [topicId])).rows[0].count, 2);
    await store.query("UPDATE topics SET reasoning_effort = 'high', reasoning_status = 'unknown' WHERE id = $1", [topicId]);
    const runningId = randomUUID();
    await send(runningId);
    const running = next();
    bridge.pump();
    assert.equal((await running).command_id, runningId);
    await sendResult({ type: "command_result", command_id: runningId, status: "ok", admission_id: randomUUID() });
    assert.equal((await store.query("SELECT data->>'status' AS status FROM submissions WHERE id = $1", [runningId])).rows[0].status, "queued");
    const reset = await enqueue("/new 新会话");
    // 原生 /new 由 Connector 先停当前执行；BFF 允许已受理的回复进入该路径。
    const eventId = randomUUID();
    const stopped = next();
    socket.send(JSON.stringify({ type: "submission", event_id: eventId, topic_id: topicId, submission_id: runningId, status: "cancelled" }));
    assert.deepEqual(await stopped, { type: "ack", id: eventId });
    await sendResult({ type: "command_result", command_id: reset.command_id, status: "ok",
      native_result: { output: "已开启新会话", reset: true, session_id: "reset-session", title: "新会话" } });
    const topic = (await store.query("SELECT * FROM topics WHERE id = $1", [topicId])).rows[0];
    assert.equal(topic.session_id, "reset-session");
    assert.equal(topic.title, "新会话");
    assert.equal(topic.reasoning_effort, null);
    assert.equal(topic.reasoning_status, null);
    assert.equal((await store.query("SELECT data->>'status' AS status FROM controls WHERE id = $1", [controlId])).rows[0].status, "closed");
    assert.equal((await store.query("SELECT count(*)::int AS count FROM messages WHERE topic_id = $1", [topicId])).rows[0].count, 3);
    assert.deepEqual((await store.query("SELECT data->'attachments' AS attachments FROM messages WHERE id = $1", [messageId])).rows[0].attachments, [{ name: "report.txt" }]);
    const lateReport: CommandResult = { type: "command_result", command_id: report.command_id, status: "ok",
      native_result: { output: "旧会话报告已完成" } };
    await assert.rejects(store.transaction((db) => applyResult(db, { ...lateReport,
      native_result: { output: "不应更新当前标题", title: "旧会话标题" } }, refs)), { statusCode: 422 });
    await sendResult(lateReport);
    await sendResult(lateReport);
    assert.deepEqual(await nativeCommandRequest(store, refs, topicId, report.command_id), { status: "ok", native_result: lateReport.native_result });
    const afterReport = (await store.query("SELECT * FROM topics WHERE id = $1", [topicId])).rows[0];
    assert.equal(afterReport.session_id, "reset-session");
    assert.equal(afterReport.title, "新会话");
    assert.equal(afterReport.updated_at.toISOString(), topic.updated_at.toISOString());
  } finally {
    socket?.terminate();
    await app.close();
    await store.close();
    await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.end();
  }
});
