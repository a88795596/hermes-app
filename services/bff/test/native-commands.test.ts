import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import websocket from "@fastify/websocket";
import type { Command, CommandResult } from "@hermes-mobile/protocol";
import Fastify from "fastify";
import WebSocket from "ws";
import { connectorFrame } from "../src/connector-frame.js";
import { registerBridge } from "../src/bridge.js";
import { applyResult } from "../src/ingress.js";
import { submit } from "../src/mutations.js";
import { registerPersonalRoutes } from "../src/routes/personal.js";
import type { Store } from "../src/store.js";
import { bridgeFrame } from "../../connector/src/wire.js";

const catalog = [{ name: "context", description: "查看上下文", category: "会话", aliases: ["ctx"],
  args_hint: "[all]", subcommands: ["all"], supported: true }];

async function harness(t: TestContext, capability?: boolean) {
  const topic = { id: randomUUID(), profile_ref: "work", status: "ready", session_id: "bound-session", title: "旧标题", auto_title: true };
  const commands = new Map<string, { payload: Command; receipt: unknown; result: CommandResult | null }>();
  const statements: string[] = [];
  const db = {
    async query(sql: string, args: unknown[] = []) {
      statements.push(sql);
      if (sql.includes("FROM devices")) return { rows: [{ id: "paired-device" }] };
      if (sql.startsWith("SELECT * FROM topics")) return { rows: args[0] === topic.id ? [topic] : [] };
      if (sql.startsWith("SELECT c.payload") || sql.startsWith("SELECT id, profile_ref, session_id FROM topics")) return { rows: [] };
      if (sql.includes("FROM commands")) {
        const row = commands.get(args[0] as string);
        return { rows: row && (args[1] === undefined || args[1] === row.payload.topic_id) ? [row] : [] };
      }
      if (sql.startsWith("INSERT INTO commands")) commands.set(args[0] as string,
        { payload: args[2] as Command, receipt: args[3], result: null });
      if (sql.startsWith("UPDATE commands SET result")) commands.get(args[0] as string)!.result = args[1] as CommandResult;
      if (sql.startsWith("UPDATE topics SET title")) { topic.title = args[1] as string; topic.auto_title = false; }
      if (sql.startsWith("UPDATE topics SET session_id")) {
        if (args[0] !== topic.id || args[2] !== topic.profile_ref || args[3] !== topic.session_id) return { rows: [], rowCount: 0 };
        topic.session_id = args[1] as string;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const store = { ...db, transaction: (fn: (value: typeof db) => unknown) => fn(db) } as unknown as Store;
  const app = Fastify();
  await app.register(websocket);
  app.register(async (api) => registerPersonalRoutes(api, store, {
    profileRefs: ["default", "work"], pairingToken: "pairing-secret", connectorToken: "connector-secret",
  }));
  await app.ready();
  const frames: Record<string, unknown>[] = [];
  if (capability !== undefined) {
    const socket = await app.injectWS("/internal/connector/v1/events", { headers: {
      authorization: "Bearer connector-secret", "x-hermes-mobile-topic-query": "1",
      ...(capability && { "x-hermes-mobile-native-commands": "1" }),
    } });
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      frames.push(frame);
      if (frame.type === "topic_query") socket.send(JSON.stringify({ type: "topic_query_result", request_id: frame.request_id,
        data: { kind: "commands", commands: catalog } }));
    });
    t.after(() => socket.terminate());
  }
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${"a".repeat(43)}` };
  const path = `/mobile/v1/topics/${topic.id}`;
  const post = (body: object, authenticated = true) => app.inject({ method: "POST", url: `${path}/command-requests`,
    headers: authenticated ? headers : {}, payload: body });
  return { app, store, topic, commands, frames, headers, path, post, statements };
}

test("原生命令目录和执行要求新版能力，旧连接器不接收未知帧", async (t) => {
  for (const capability of [undefined, false]) {
    const { app, path, headers, post, frames, commands } = await harness(t, capability);
    assert.equal((await app.inject({ url: `${path}/commands`, headers })).statusCode, 503);
    assert.equal((await post({ request_id: randomUUID(), command: "/context" })).statusCode, 503);
    assert.equal(commands.size, 0);
    assert.deepEqual(frames, []);
  }
});

test("原生命令目录使用授权话题的 profile 和 session，返回实时原生条目", async (t) => {
  const { app, topic, path, headers, frames } = await harness(t, true);
  assert.equal((await app.inject({ url: `${path}/commands` })).statusCode, 401);
  const reply = await app.inject({ url: `${path}/commands`, headers });
  assert.equal(reply.statusCode, 200);
  assert.deepEqual(reply.json().data, catalog);
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0], { type: "topic_query", kind: "commands", request_id: frames[0].request_id,
    topic_id: topic.id, profile_ref: "work", session_id: "bound-session" });
  topic.profile_ref = "private";
  assert.equal((await app.inject({ url: `${path}/commands`, headers })).statusCode, 404);
  assert.equal(frames.length, 1);
});

test("原生命令请求校验正文、绑定授权档案并使用同一请求 ID 查询结果", async (t) => {
  const { app, topic, path, headers, post, commands } = await harness(t, true);
  const request_id = randomUUID();
  const body = { request_id, command: "/title 工作会话" };
  assert.equal((await post(body, false)).statusCode, 401);
  assert.equal((await post({ ...body, profile_ref: "default" })).statusCode, 422);
  for (const command of ["", "/", "context", "/ context", "/context\nall", "/context\rall", "/context\u2028all", "/context\0all", "/title " + "汉".repeat(2730)]) {
    assert.equal((await post({ request_id, command })).statusCode, 422, JSON.stringify(command.slice(0, 30)));
  }
  assert.equal((await post(body)).statusCode, 202);
  assert.equal((await post(body)).statusCode, 202);
  assert.equal((await post({ ...body, command: "/usage" })).statusCode, 409);
  assert.equal(commands.size, 1);
  assert.deepEqual(commands.get(request_id)?.payload, { type: "command", kind: "native_command", command_id: request_id,
    topic_id: topic.id, profile_ref: "work", session_id: "bound-session", body: { command: body.command } });
  const poll = () => app.inject({ url: `${path}/command-requests/${request_id}`, headers });
  assert.deepEqual((await poll()).json().data, { status: "pending" });
  commands.get(request_id)!.result = { type: "command_result", command_id: request_id, status: "ok", native_result: { output: "已修改标题" } };
  assert.deepEqual((await poll()).json().data, { status: "ok", native_result: { output: "已修改标题" } });
  topic.profile_ref = "private";
  assert.equal((await post(body)).statusCode, 404);
  assert.equal((await poll()).statusCode, 404);
});

test("原生破坏性命令确认使用新请求，确认级别参与幂等校验", async (t) => {
  const { app, store, post, commands, path, headers, topic } = await harness(t, true);
  const request_id = randomUUID();
  const command = "/new 新会话";
  for (const approval of ["yes", "session", true, null]) {
    assert.equal((await post({ request_id, command, approval })).statusCode, 422);
  }
  await post({ request_id, command });
  const confirmation: CommandResult = { type: "command_result", command_id: request_id, status: "ok",
    native_result: { output: "请确认", confirmation: "确认重置会话？" } };
  await store.transaction((db) => applyResult(db, confirmation, new Set(["work"])));
  assert.equal(topic.session_id, "bound-session");
  assert.deepEqual((await app.inject({ url: `${path}/command-requests/${request_id}`, headers })).json().data,
    { status: "ok", native_result: confirmation.native_result });
  for (const approval of ["once", "always"] as const) {
    assert.equal((await post({ request_id, command, approval })).statusCode, 409);
    const approvedId = randomUUID();
    assert.equal((await post({ request_id: approvedId, command, approval })).statusCode, 202);
    assert.equal((await post({ request_id: approvedId, command, approval })).statusCode, 202);
    assert.deepEqual(commands.get(approvedId)?.payload.body, { command, approval });
    assert.equal((await post({ request_id: approvedId, command })).statusCode, 409);
  }
  await assert.rejects(store.transaction((db) => applyResult(db, { ...confirmation,
    native_result: { output: "已执行", reset: true, session_id: "new-session" } }, new Set(["work"]))));
  assert.deepEqual(commands.get(request_id)?.result, confirmation);
});

test("命令目录和执行报文在边界拒绝非法结构与超长正文", () => {
  const query = { type: "topic_query_result", request_id: randomUUID(), data: { kind: "commands", commands: catalog } };
  assert.deepEqual(connectorFrame(query), query);
  for (const patch of [{ supported: "yes" }, { aliases: [1] }, { description: "x".repeat(8193) }, { unknown: true },
    { subcommands: [1] }, { subcommands: Array(65).fill("one") }, { subcommands: ["x".repeat(257)] }]) {
    assert.throws(() => connectorFrame({ ...query, data: { kind: "commands", commands: [{ ...catalog[0], ...patch }] } }));
  }
  const command = { type: "command", kind: "native_command", command_id: randomUUID(), topic_id: randomUUID(),
    profile_ref: "work", session_id: "bound-session", body: { command: "/context all" } };
  assert.deepEqual(bridgeFrame(JSON.stringify(command)), command);
  for (const approval of ["once", "always"]) {
    const approved = { ...command, body: { ...command.body, approval } };
    assert.deepEqual(bridgeFrame(JSON.stringify(approved)), approved);
  }
  for (const approval of [true, "yes", "session", null]) {
    assert.throws(() => bridgeFrame(JSON.stringify({ ...command, body: { ...command.body, approval } })));
  }
  for (const text of ["/", "/ context", "/context\nall", "/context\0all", "/title " + "汉".repeat(2730)]) {
    assert.throws(() => bridgeFrame(JSON.stringify({ ...command, body: { command: text } })));
  }
  assert.throws(() => bridgeFrame(JSON.stringify({ ...command, body: { command: "/context", profile_ref: "outside" } })));
  const result = { type: "command_result", command_id: randomUUID(), status: "ok", native_result: { output: "" } };
  assert.deepEqual(connectorFrame(result), result);
  for (const native_result of [{ output: 1 }, { output: "x".repeat(256 * 1024 + 1) }, { output: "ok", extra: true }]) {
    assert.throws(() => connectorFrame({ ...result, native_result }));
  }
  for (const title of ["汉".repeat(100), "🦉".repeat(100)]) {
    const titled = { ...result, native_result: { output: "ok", title } };
    assert.deepEqual(connectorFrame(titled), titled);
  }
  assert.throws(() => connectorFrame({ ...result, native_result: { output: "ok", title: "🦉".repeat(101) } }));
  for (const native_result of [{ output: "ok", session_id: "rotated-session" }, { output: "ok", rewound_turns: 2 },
    { output: "", confirmation: "确认？" }]) {
    assert.deepEqual(connectorFrame({ ...result, native_result }), { ...result, native_result });
  }
  for (const patch of [{ session_id: "" }, { session_id: "x".repeat(513) }, { session_id: "bad\0id" }, { reset: false }, { reset: "true" },
    { rewound_turns: -1 }, { rewound_turns: 1.5 }, { rewound_turns: Number.MAX_SAFE_INTEGER + 1 }, { rewound_turns: "1" },
    { confirmation: "" }, { confirmation: "x".repeat(16 * 1024 + 1) }, { confirmation: true }]) {
    assert.throws(() => connectorFrame({ ...result, native_result: { output: "ok", ...patch } }));
  }
});

test("仅原生压缩可以旋转绑定，重复结果幂等，后续提交使用新会话", async (t) => {
  const { store, topic, post, commands, statements } = await harness(t, true);
  const command_id = randomUUID();
  await post({ request_id: command_id, command: "/compact" });
  const result = { type: "command_result" as const, command_id, status: "ok" as const,
    native_result: { output: "上下文已压缩", session_id: "rotated-session" } };
  const apply = (frame: CommandResult, refs = new Set(["work"])) => store.transaction((db) => applyResult(db, frame, refs));
  await assert.rejects(apply(result, new Set(["default"])));
  assert.equal(topic.session_id, "bound-session");
  await apply(result);
  assert.equal(topic.session_id, "rotated-session");
  await apply(result);
  assert.equal(statements.filter((sql) => sql.startsWith("UPDATE topics SET session_id")).length, 1);
  await assert.rejects(apply({ ...result, native_result: { ...result.native_result, session_id: "another-session" } }));
  const submissionId = randomUUID();
  await store.transaction((db) => submit(db, new Set(["work"]), topic.id, submissionId, "继续", [], false));
  assert.equal(commands.get(submissionId)?.payload.session_id, "rotated-session");
});

test("原生命令未知回执可以确认一次，已确认结果与过期绑定不能改写", async (t) => {
  for (const finalStatus of ["ok", "error"] as const) {
    const { store, topic, post, commands } = await harness(t, true);
    const command_id = randomUUID();
    await post({ request_id: command_id, command: "/compress" });
    const unknown: CommandResult = { type: "command_result", command_id, status: "unknown", error: "仍在压缩" };
    const final: CommandResult = { type: "command_result", command_id, status: finalStatus,
      ...(finalStatus === "ok" ? { native_result: { output: "已压缩", session_id: "new-session" } } : { error: "无法压缩" }) };
    const apply = (frame: CommandResult) => store.transaction((db) => applyResult(db, frame, new Set(["work"])));
    await apply(unknown);
    await apply(unknown);
    topic.session_id = "unexpected-session";
    await assert.rejects(apply(final));
    topic.session_id = "bound-session";
    await apply(final);
    await apply(final);
    assert.deepEqual(commands.get(command_id)?.result, final);
    await assert.rejects(apply(unknown));
    await assert.rejects(apply({ ...final, error: "重写终态" }));
  }
  const { store, topic, commands } = await harness(t, true);
  const command_id = randomUUID();
  commands.set(command_id, { payload: { type: "command", command_id, topic_id: topic.id, profile_ref: "work",
    session_id: topic.session_id, kind: "interrupt", body: { submission_id: randomUUID() } }, receipt: {},
    result: { type: "command_result", command_id, status: "unknown" } });
  await assert.rejects(store.transaction((db) => applyResult(db, { type: "command_result", command_id, status: "ok" }, new Set(["work"]))));
});

test("会话重置后历史原生报告可补齐输出，不能夹带当前会话变更", async (t) => {
  for (const status of ["ok", "error"] as const) {
    const { store, topic, post, commands, statements } = await harness(t, true);
    const command_id = randomUUID();
    await post({ request_id: command_id, command: "/insights 7" });
    const apply = (frame: CommandResult) => store.transaction((db) => applyResult(db, frame, new Set(["work"])));
    await apply({ type: "command_result", command_id, status: "unknown", error: "报告仍在生成" });
    const resetId = randomUUID();
    await post({ request_id: resetId, command: "/new" });
    await apply({ type: "command_result", command_id: resetId, status: "ok",
      native_result: { output: "已重置", reset: true, session_id: "new-session" } });
    const final: CommandResult = { type: "command_result", command_id, status,
      ...(status === "ok" ? { native_result: { output: "历史会话分析完成" } } : { error: "原生报告失败" }) };
    for (const metadata of [{ title: "旧标题" }, { session_id: "stale-session" }, { reset: true as const },
      { rewound_turns: 1 }, { confirmation: "再次确认？" }]) {
      await assert.rejects(apply({ ...final, status: "ok", native_result: { output: "不应生效", ...metadata } }));
    }
    await assert.rejects(store.transaction((db) => applyResult(db, final, new Set(["private"]))));
    statements.length = 0;
    await apply(final);
    await apply(final);
    assert.equal(topic.session_id, "new-session");
    assert.deepEqual(commands.get(command_id)?.result, final);
    assert.equal(statements.some((sql) => sql.startsWith("UPDATE topics")), false);
    await assert.rejects(apply({ ...final, error: "改写已确认历史" }));
  }
});

test("原生变更元数据只用于对应命令，撤回保留 App 消息与附件审计", async (t) => {
  const { store, post, commands, statements } = await harness(t, true);
  const apply = (frame: CommandResult) => store.transaction((db) => applyResult(db, frame, new Set(["work"])));
  for (const [command, native_result] of [["/context", { output: "bad", session_id: "other-session" }],
    ["/undo", { output: "bad", session_id: "other-session" }], ["/compress", { output: "bad", rewound_turns: 1 }],
    ["/context", { output: "bad", rewound_turns: 1 }], ["/compress", { output: "bad", session_id: "bound-session" }],
    ["/new", { output: "bad", reset: true }], ["/new", { output: "bad", session_id: "other-session" }],
    ["/compress", { output: "bad", reset: true, session_id: "other-session" }],
    ["/compress", { output: "bad", confirmation: "确认？" }],
    ["/new", { output: "bad", confirmation: "确认？", reset: true, session_id: "other-session" }],
    ["/new", { output: "bad", confirmation: "确认？", title: "未执行的标题" }],
    ["/undo", { output: "bad", confirmation: "确认？", rewound_turns: 1 }]] as const) {
    const command_id = randomUUID();
    await post({ request_id: command_id, command });
    await assert.rejects(apply({ type: "command_result", command_id, status: "ok", native_result }));
    assert.equal(commands.get(command_id)?.result, null);
  }
  const command_id = randomUUID();
  await post({ request_id: command_id, command: "/undo 2" });
  statements.length = 0;
  await apply({ type: "command_result", command_id, status: "ok", native_result: { output: "已撤回两轮上下文", rewound_turns: 2 } });
  assert.equal(commands.get(command_id)?.result?.native_result?.rewound_turns, 2);
  assert.equal(statements.some((sql) => /(?:UPDATE|DELETE FROM) (?:messages|submissions|controls|submission_attachments)/u.test(sql)), false);
});

test("原生命令成功必须有输出回执，其他命令不能夹带原生结果", async (t) => {
  const { store, topic, post, commands } = await harness(t, true);
  const request_id = randomUUID();
  await post({ request_id, command: "/context" });
  const base = { type: "command_result" as const, command_id: request_id };
  const apply = (frame: CommandResult) => store.transaction((db) => applyResult(db, frame, new Set(["work"])));
  await assert.rejects(apply({ ...base, status: "ok" }));
  await assert.rejects(apply({ ...base, status: "error", native_result: { output: "bad" } }));
  await assert.rejects(apply({ ...base, status: "ok", native_result: { output: "bad", title: "越权标题" } }));
  const saved = commands.get(request_id)!;
  saved.payload = { ...saved.payload, kind: "interrupt", body: { submission_id: randomUUID() } };
  await assert.rejects(apply({ ...base, status: "ok", native_result: { output: "wrong command" } }));
  saved.payload = { ...saved.payload, kind: "native_command", body: { command: "/context" } };
  await apply({ ...base, status: "ok", native_result: { output: "上下文用量" } });
  assert.equal(saved.payload.topic_id, topic.id);
  assert.deepEqual(saved.result?.native_result, { output: "上下文用量" });
});

test("仅成功的原生 title 命令同步手工标题，失败保留原值", async (t) => {
  const { store, topic, post } = await harness(t, true);
  for (const status of ["error", "ok"] as const) {
    const command_id = randomUUID();
    await post({ request_id: command_id, command: "/title 手工标题" });
    const result: CommandResult = { type: "command_result", command_id, status,
      ...(status === "ok" ? { native_result: { output: "已更新", title: "手工标题" } } : { error: "未修改" }) };
    await store.transaction((db) => applyResult(db, result, new Set(["work"])));
    assert.equal(topic.title, status === "ok" ? "手工标题" : "旧标题");
    assert.equal(topic.auto_title, status !== "ok");
  }
});

test("持久化命令在旧连接器重连时保留，支持能力后才派发", { timeout: 5_000 }, async (t) => {
  const command: Command = { type: "command", kind: "native_command", command_id: randomUUID(), topic_id: randomUUID(),
    profile_ref: "work", session_id: "bound-session", body: { command: "/context" } };
  let dispatched = 0;
  let scanned: () => void;
  const pendingRead = new Promise<void>((resolve) => { scanned = resolve; });
  const store = { async query(sql: string) {
    await new Promise(setImmediate);
    if (sql.startsWith("SELECT id, profile_ref, session_id")) return { rows: [{ id: command.topic_id,
      profile_ref: command.profile_ref, session_id: command.session_id }] };
    if (sql.startsWith("SELECT c.payload")) { scanned(); return { rows: [{ payload: command, reasoning_required: false }] }; }
    if (sql.startsWith("UPDATE commands SET dispatched")) dispatched++;
    return { rows: [] };
  } } as unknown as Store;
  const app = Fastify();
  await app.register(websocket, { preClose(done) {
    for (const socket of app.websocketServer.clients) socket.terminate();
    done();
  } });
  const bridge = registerBridge(app, store, new Set(["work"]), "connector-secret", () => {});
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const connect = (capable: boolean) => new WebSocket(origin.replace(/^http/u, "ws") + "/internal/connector/v1/events", { headers: {
    authorization: "Bearer connector-secret", ...(capable && { "x-hermes-mobile-native-commands": "1" }),
  } });
  const old = connect(false);
  const frames: Record<string, unknown>[] = [];
  old.on("message", (raw) => frames.push(JSON.parse(String(raw))));
  await once(old, "message", { signal: t.signal });
  await pendingRead;
  await new Promise(setImmediate);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, "watch");
  assert.equal(dispatched, 0);
  assert.equal(bridge.nativeCommandsSupported(), false);
  const closed = once(old, "close");
  old.terminate();
  await closed;
  const current = connect(true);
  const received = new Promise<unknown>((resolve) => current.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    if (frame.kind === "native_command") resolve(frame);
  }));
  assert.deepEqual(await received, command);
  assert.equal(dispatched, 1);
  assert.equal(bridge.nativeCommandsSupported(), true);
  current.terminate();
});
