import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import websocket from "@fastify/websocket";
import type { Command, CommandResult, Message } from "@hermes-mobile/protocol";
import Fastify from "fastify";
import pg from "pg";
import WebSocket from "ws";
import { applyEvent, applyResult } from "../src/ingress.js";
import { submit } from "../src/mutations.js";
import { connectorFrame } from "../src/connector-frame.js";
import { detail as topicDetail } from "../src/projections.js";
import { registerPersonalRoutes } from "../src/routes/personal.js";
import { openStore, type Store } from "../src/store.js";

async function setup(t: TestContext) {
  const topic = { id: randomUUID(), profile_ref: "default", status: "ready", session_id: "bound-session",
    title: "当前任务", created_at: new Date(), updated_at: new Date(), archived: false };
  const original: Message = { message_id: randomUUID(), role: "user", text: "整理报告", status: "streaming", submission_id: randomUUID() };
  const messages = new Map<string, { topic_id: string; data: Message }>([[original.message_id, { topic_id: topic.id, data: original }]]);
  const submissions = new Map<string, { topic_id: string; message_id: string; data: { status: string } }>([
    [original.submission_id!, { topic_id: topic.id, message_id: original.message_id, data: { status: "streaming" } }],
  ]);
  const commands = new Map<string, { payload: Command; receipt: unknown; result: CommandResult | null }>();
  const db = {
    async query(sql: string, args: unknown[] = []) {
      let rows: unknown[] = [];
      if (sql.includes("FROM devices")) rows = [{ id: "paired-device" }];
      else if (sql.startsWith("SELECT * FROM topics")) rows = args[0] === topic.id ? [topic] : [];
      else if (sql.startsWith("SELECT id, profile_ref, session_id FROM topics")) rows = [topic];
      else if (sql.startsWith("SELECT c.payload")) rows = [...commands.values()].filter(({ result }) => !result);
      else if (sql.includes("FROM commands")) rows = commands.has(String(args[0])) ? [commands.get(String(args[0]))] : [];
      else if (sql.startsWith("SELECT message_id, data FROM submissions")) {
        const submission = submissions.get(String(args[0]));
        rows = submission?.topic_id === args[1] ? [submission] : [];
      } else if (sql.startsWith("SELECT data FROM messages")) rows = [...messages.values()].filter(({ topic_id }) => topic_id === args[0]);
      else if (sql.startsWith("SELECT data FROM controls")) rows = [];
      else if (sql.startsWith("INSERT INTO messages")) messages.set(String(args[0]), { topic_id: String(args[1]), data: args[2] as Message });
      else if (sql.startsWith("INSERT INTO submissions")) submissions.set(String(args[0]), {
        topic_id: String(args[1]), message_id: String(args[2]), data: args[3] as { status: string },
      });
      else if (sql.startsWith("INSERT INTO commands")) commands.set(String(args[0]), { payload: args[2] as Command, receipt: args[3], result: null });
      else if (sql.startsWith("UPDATE commands SET result")) commands.get(String(args[0]))!.result = args[1] as CommandResult;
      else if (sql.startsWith("UPDATE submissions SET data")) submissions.get(String(args[0]))!.data = args[1] as { status: string };
      else if (sql.startsWith("UPDATE messages SET data")) {
        const message = messages.get(String(args[0]))!;
        const { error: _error, ...previous } = message.data;
        message.data = { ...previous, ...args[1] as Partial<Message> };
      } else if (!sql.startsWith("UPDATE commands SET dispatched") && !sql.startsWith("UPDATE topics SET updated_at")
        && !sql.startsWith("DELETE FROM submission_attachments")) {
        throw new Error(`Unexpected SQL: ${sql}`);
      }
      return { rows, rowCount: rows.length };
    },
  };
  const store = { ...db, transaction: (fn: (value: typeof db) => unknown) => fn(db) } as unknown as Store;
  const app = Fastify();
  app.register(websocket);
  app.register(async (api) => registerPersonalRoutes(api, store, {
    profileRefs: ["default"], pairingToken: "pairing-secret", connectorToken: "connector-secret",
  }));
  t.after(() => app.close());
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const headers = { authorization: `Bearer ${"a".repeat(43)}` };
  const body = { submission_id: randomUUID(), text: "请用中文，并保留出处。" };
  const send = (payload: unknown = body, authenticated = true, topicId = topic.id) => app.inject({
    method: "POST", url: `/mobile/v1/topics/${topicId}/submissions`, headers: authenticated ? headers : {}, payload: payload as object,
  });
  const connect = async () => {
    const ws = new WebSocket(origin.replace(/^http/, "ws") + "/internal/connector/v1/events", {
      headers: { authorization: "Bearer connector-secret" },
    });
    t.after(() => ws.terminate());
    assert.equal(JSON.parse((await once(ws, "message", { signal: t.signal }))[0].toString()).kind, "watch");
    return ws;
  };
  const status = async () => (await app.inject({ url: "/mobile/v1/status", headers })).json().data;
  const detail = async () => (await app.inject({ url: `/mobile/v1/topics/${topic.id}`, headers })).json().data;
  return { app, store, topic, original, submissions, commands, body, send, connect, status, detail };
}

test("统一发送校验外部参数，自动插话标记仅存在于内部命令", { timeout: 5_000 }, async (t) => {
  const { topic, commands, body, send, connect, status } = await setup(t);
  assert.equal((await send(body, false)).statusCode, 401);
  for (const invalid of [{ ...body, text: " " }, { ...body, text: "x".repeat(65_537) },
    { ...body, steer_if_running: true }, { ...body, target_submission_id: randomUUID() }]) {
    assert.equal((await send(invalid)).statusCode, 422);
  }
  assert.equal((await send(body, true, randomUUID())).statusCode, 404);
  const response = await send();
  assert.equal(response.statusCode, 202);
  assert.equal("steering" in response.json().data, false);
  assert.equal("steer_if_running" in response.json().data, false);
  const pending = commands.get(body.submission_id)!;
  assert.deepEqual(pending.payload.body, { ...body, steer_if_running: true });
  assert.equal(pending.payload.kind, "submit");
  assert.equal("steering_supported" in await status(), false);
  await connect();
  topic.status = "creating";
  assert.equal((await send({ ...body, submission_id: randomUUID() })).json().error.code, "TOPIC_NOT_READY");
  assert.equal((await send()).json().data.message_id, response.json().data.message_id);
});

test("统一发送保留升级前请求的幂等性，内部策略变化不视为正文变化", { timeout: 5_000 }, async (t) => {
  const { commands, body, send } = await setup(t);
  const first = (await send()).json().data;
  const command = commands.get(body.submission_id)!;
  assert.equal(command.payload.kind, "submit");
  if (command.payload.kind !== "submit") throw new Error("expected submit");
  delete command.payload.body.steer_if_running;
  assert.equal((await send()).json().data.message_id, first.message_id);
  command.payload.body.steer_if_running = true;
  assert.equal((await send()).json().data.message_id, first.message_id);
  assert.equal((await send({ ...body, text: "替换成另一个要求" })).json().error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(commands.size, 1);
});

test("自动插话和普通受理共用发送结果，但不覆盖原执行或暴露模式", { timeout: 5_000 }, async (t) => {
  const { original, commands, body, send, connect, detail } = await setup(t);
  const ws = await connect();
  for (const [status, steering, projected] of [
    ["ok", true, "final"], ["error", true, "failed"], ["unknown", true, "unknown"], ["ok", false, "queued"],
  ] as const) {
    const request = { ...body, submission_id: randomUUID() };
    const sent = once(ws, "message", { signal: t.signal });
    const response = await send(request);
    assert.equal(response.statusCode, 202);
    const message = response.json().data;
    assert.equal(message.status, "accepted");
    const command = JSON.parse((await sent)[0].toString());
    assert.equal(command.kind, "submit");
    assert.deepEqual(command.body, { ...request, steer_if_running: true });
    assert.equal(command.command_id, request.submission_id);
    const ack = once(ws, "message", { signal: t.signal });
    ws.send(JSON.stringify({ type: "command_result", command_id: request.submission_id, status,
      ...(steering ? { steering: true } : { admission_id: "normal-admission" }),
      ...(status === "ok" ? {} : { error: "消息未获确认" }) }));
    assert.deepEqual(JSON.parse((await ack)[0].toString()), { type: "ack", id: request.submission_id });
    const current = (await detail()).messages as Message[];
    const projectedMessage = current.find((item) => item.submission_id === request.submission_id)!;
    assert.equal(projectedMessage.status, projected);
    assert.equal("steering" in projectedMessage, false);
    assert.equal(current.find((item) => item.submission_id === original.submission_id)?.status, "streaming");
    assert.equal(current.some((item) => item.role === "assistant"), false);
    assert.equal((await send(request)).json().data.message_id, message.message_id);
  }
  assert.equal(commands.size, 4);
  assert.equal((await detail()).messages.length, 5);
});

test("插话结果标记只接受 true，并且不得伪装成普通受理或其他命令结果", { timeout: 5_000 }, async (t) => {
  const { store, commands, body, send } = await setup(t);
  const frame = { type: "command_result", command_id: body.submission_id, status: "ok", steering: true };
  assert.deepEqual(connectorFrame(frame), frame);
  for (const steering of [false, null, "true", 1]) assert.throws(() => connectorFrame({ ...frame, steering }), { statusCode: 422 });
  await send();
  const ingest = (fields: object) => store.transaction((db) => applyResult(db, {
    type: "command_result", command_id: body.submission_id, status: "ok", ...fields,
  }, new Set(["default"])));
  await assert.rejects(ingest({}), { statusCode: 422 });
  for (const extra of [{ admission_id: "not-a-steering-receipt" }, { session_id: "unexpected-session" },
    { control_status: "closed" }, { model_result: { type: "selected", selection: { provider: "p", model: "m" } } }]) {
    await assert.rejects(ingest({ steering: true, ...extra }), { statusCode: 422 });
  }
  const command = commands.get(body.submission_id)!;
  assert.equal(command.payload.kind, "submit");
  if (command.payload.kind !== "submit") throw new Error("expected submit");
  command.payload.body.attachments = [{ name: "报告.txt", mime: "text/plain", size: 3, sha256: "a".repeat(64) }];
  await assert.rejects(ingest({ steering: true }), { statusCode: 422 });
  delete command.payload.body.attachments;
  delete command.payload.body.steer_if_running;
  await assert.rejects(ingest({ steering: true }), { statusCode: 422 });
  command.payload = { ...command.payload, kind: "watch", body: {} };
  await assert.rejects(ingest({ steering: true }), { statusCode: 422 });
  assert.equal(command.result, null);
});

const databaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL 并发发送仅保存一条消息，自动插话确认不结束原执行", { skip: !databaseUrl, timeout: 10_000 }, async () => {
  const schema = `steering_${randomUUID().replaceAll("-", "")}`;
  const database = new pg.Pool({ connectionString: databaseUrl });
  await database.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const store = openStore(url.href);
  try {
    await store.migrate();
    const refs = new Set(["default"]);
    const topicId = randomUUID();
    const originalId = randomUUID();
    const originalMessageId = randomUUID();
    const submissionId = randomUUID();
    await store.query("INSERT INTO topics (id, profile_ref, title, status, session_id) VALUES ($1, 'default', '当前任务', 'ready', 'steer-test')", [topicId]);
    const original: Message = { message_id: originalMessageId, role: "user", text: "整理报告", status: "streaming", submission_id: originalId };
    await store.query("INSERT INTO messages (id, topic_id, data) VALUES ($1, $2, $3)", [originalMessageId, topicId, original]);
    await store.query("INSERT INTO submissions (id, topic_id, message_id, data) VALUES ($1, $2, $3, $4)",
      [originalId, topicId, originalMessageId, { status: "streaming" }]);
    const firstReply = randomUUID();
    const receiveReply = (message_id: string, status: "streaming" | "final", text: string) =>
      store.transaction((db) => applyEvent(db, { type: "message", event_id: randomUUID(), topic_id: topicId,
        message_id, submission_id: originalId, status, text }, refs, new Map([[topicId, "steer-test"]])));
    await receiveReply(firstReply, "streaming", "正在整理报告");
    const post = (text = "请使用中文") => store.transaction((db) => submit(db, refs, topicId, submissionId, text, [], true));
    const replies = await Promise.all([post(), post(), post()]);
    assert.equal(new Set(replies.map(({ message_id }) => message_id)).size, 1);
    const message = replies[0];
    assert.equal("steering" in message, false);
    assert.equal((await store.query("SELECT id FROM commands WHERE id = $1", [submissionId])).rowCount, 1);
    assert.equal((await store.query("SELECT id FROM submissions WHERE id = $1", [submissionId])).rowCount, 1);
    assert.equal((await store.query("SELECT id FROM messages WHERE topic_id = $1", [topicId])).rowCount, 3);
    await assert.rejects(post("不同的要求"), { code: "IDEMPOTENCY_CONFLICT" });
    await store.transaction((db) => applyResult(db, { type: "command_result", command_id: submissionId, status: "ok", steering: true }, refs));
    const { rows } = await store.query<{ id: string; data: Message }>("SELECT id, data FROM messages WHERE topic_id = $1", [topicId]);
    assert.equal(rows.find(({ id }) => id === message.message_id)?.data.status, "final");
    assert.deepEqual(rows.find(({ id }) => id === originalMessageId)?.data, original);
    assert.deepEqual((await store.query("SELECT data FROM submissions WHERE id = $1", [originalId])).rows[0].data, { status: "streaming" });
    await store.query("UPDATE commands SET payload = payload #- '{body,steer_if_running}' WHERE id = $1", [submissionId]);
    assert.equal((await post()).message_id, message.message_id);
    await receiveReply(firstReply, "final", "正在整理报告");
    const nextReply = randomUUID();
    await receiveReply(nextReply, "streaming", "开始用中文整理");
    await receiveReply(nextReply, "final", "中文报告已完成");
    const history = (await topicDetail(store, topicId, refs)).messages;
    assert.deepEqual(history.map(({ message_id, status }) => [message_id, status]), [
      [originalMessageId, "streaming"], [firstReply, "final"], [message.message_id, "final"], [nextReply, "final"],
    ]);
    assert.deepEqual(history.filter(({ role }) => role === "assistant").map(({ text, submission_id }) => [text, submission_id]), [
      ["正在整理报告", originalId], ["中文报告已完成", originalId],
    ]);
  } finally {
    await store.close();
    await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.end();
  }
});
