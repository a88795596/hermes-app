import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { Command, NativeCommand } from '@hermes-mobile/protocol';
import { createNativeCommands, nativeCommandList, parseNativeApiKeys, resolveNativeCommand, tuiCommandList } from '../src/native-commands.js';
import { createHttpConnector } from '../src/http-mode.js';
import { Gateway, GatewayRefusal, type JsonObject } from '../src/gateway.js';
import { CanonicalConnector } from '../src/connector.js';
import { QueryUnavailable } from '../src/topic-query.js';
import { Spool } from '../src/spool.js';

const entry = (name: string, supported = false): NativeCommand => ({
  name, description: `原生 ${name}`, category: 'Session', aliases: [], supported,
  ...(!supported && { unavailable_reason: '当前通道未开放。' }),
});

test('原生命令按配置档案使用独立 API 密钥，缺失或无效配置拒绝请求', async (t) => {
  const seen: string[] = [];
  const server = createServer(async (request, response) => {
    seen.push(`${request.url} ${request.headers.authorization}`);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ commands: [entry('status', true)] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  const keys = parseNativeApiKeys('default-secret', JSON.stringify({ finance: 'finance-secret' }));
  const native = createNativeCommands(origin, keys);
  await native.catalog('default');
  await native.catalog('finance');
  await assert.rejects(native.catalog('mia'), /密钥/);
  assert.deepEqual(seen, [
    '/p/default/api/platforms/hermes_mobile/events Bearer default-secret',
    '/p/finance/api/platforms/hermes_mobile/events Bearer finance-secret',
  ]);
  assert.throws(() => parseNativeApiKeys('default-secret', '{'), /HERMES_API_KEYS/);
  assert.throws(() => parseNativeApiKeys('default-secret', '{"default":"other"}'), /HERMES_API_KEYS/);
  assert.throws(() => parseNativeApiKeys('default-secret', '{"finance":"bad\\nkey"}'), /HERMES_API_KEYS/);
});

test('动态目录保留新增原生命令和别名，畸形元数据不能成为可执行菜单', () => {
  const commands = [entry('future-command'), { ...entry('compress'), aliases: ['compact'], args_hint: '[--preview]', subcommands: ['--preview'] }];
  assert.deepEqual(nativeCommandList(commands), commands);
  assert.equal(resolveNativeCommand('/COMPACT --preview', commands).entry.name, 'compress');
  assert.equal(resolveNativeCommand('/COMPACT --preview', commands).args, '--preview');
  assert.throws(() => resolveNativeCommand('/missing', commands));
  assert.throws(() => resolveNativeCommand('/compress\n/restart', commands));
  for (const invalid of [null, [{ ...entry('x'), supported: 'true' }], [entry('x'), entry('x')],
    [{ ...entry('x'), aliases: ['bad/name'] }], [{ ...entry('x'), name: '../restart' }],
    [{ ...entry('x'), aliases: ['restart'] }, entry('restart')]]) {
    assert.throws(() => nativeCommandList(invalid));
  }
  assert.deepEqual(tuiCommandList({ categories: [{ name: 'Session', pairs: [['/compress', '压缩上下文']] }],
    canon: { '/compress': '/compress', '/compact': '/compress' } }), [{
    ...entry('compress'), description: '压缩上下文', aliases: ['compact'], unavailable_reason: '当前会话通道未开放此原生命令。',
  }]);
});

test('Canonical 目录回退只读取真实 RPC，支持现有查询且隔离未知运行时命令', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-native-canonical-'));
  const spool = new Spool(join(directory, 'spool.sqlite'));
  const topicId = randomUUID(), sessionId = 'canonical-native';
  spool.begin(topicId, 'create');
  spool.finish(topicId, {}, { topicId, sessionId, profileId: 'work', profileRef: 'work' });
  const snapshot = { session_id: sessionId, stored_session_id: sessionId, subscription_id: 'sub',
    authority_epoch: 1, replay_epoch: 'epoch', last_sequence: 0,
    revision: 2, execution_generation: 1, running: false, pending: [], prompts: [] };
  const calls: string[] = [];
  let unavailable = false;
  t.mock.method(Gateway, 'connect', async () => ({ connected: true, identity: { profileId: 'work', authorityEpoch: '1' }, close() {},
    async rpc(method: string, params: JsonObject) {
      calls.push(method);
      assert.equal(params.session_id, sessionId);
      if (method === 'session.events.since') return { events: [], snapshot_required: false };
      if (method === 'session.resume') return snapshot;
      if (method === 'config.get') return { value: '1' };
      if (method === 'commands.catalog') {
        if (unavailable) throw new GatewayRefusal(-32601, 'unknown_method');
        return { categories: [{ name: 'Session', pairs: [['/status', 'status'], ['/version', 'version'], ['/compress', 'compress']] }],
          canon: { '/status': '/status', '/version': '/version', '/v': '/version', '/compact': '/compress' } };
      }
      if (method === 'session.info') return { profile_id: 'work', version: '0.19.0' };
      throw new Error(`意外 RPC ${method}`);
    },
  }));
  const connector = new CanonicalConnector('unused', spool, () => {}, async () => Buffer.alloc(0));
  t.after(() => { connector.close(); spool.close(); rmSync(directory, { recursive: true, force: true }); });
  const query = { type: 'topic_query' as const, kind: 'commands' as const, request_id: randomUUID(),
    topic_id: topicId, session_id: sessionId, profile_ref: 'work' };
  const catalog = await connector.query(query);
  assert.equal(catalog.kind, 'commands');
  if (catalog.kind !== 'commands') return;
  assert.deepEqual(catalog.commands.map(({ name, supported }) => [name, supported]), [['status', true], ['version', true], ['compress', false]]);
  for (const [command, expected] of [['/v', 'ok'], ['/compress', 'error']] as const) {
    const command_id = randomUUID();
    await connector.command({ type: 'command', kind: 'native_command', command_id,
      topic_id: topicId, session_id: sessionId, profile_ref: 'work', body: { command } }, () => true);
    const receipt = JSON.parse(spool.command(command_id)!.result!);
    assert.equal(receipt.status, expected);
    if (expected === 'ok') assert.deepEqual(receipt.native_result, { output: 'Hermes 0.19.0' });
  }
  assert.equal(calls.includes('command.dispatch'), false);
  const before = calls.length;
  await assert.rejects(connector.query({ ...query, profile_ref: 'outside' }), /绑定/);
  assert.equal(calls.length, before);
  unavailable = true;
  await assert.rejects(connector.query(query), QueryUnavailable);
});

async function harness(t: TestContext) {
  const topicId = randomUUID(), sessionId = 'mobile_native';
  const calls: { method: string; path: string; body: JsonObject }[] = [];
  let execution: JsonObject = { ok: true, output: '原生输出' };
  let resolution: JsonObject = { ok: false, status: 'unknown', error: '原生命令仍在运行' };
  let runtime: JsonObject = { system_prompt: '用原生人格回答' };
  let runtimeStatus = 200;
  let executionGate: Promise<void> | undefined;
  let stopping = false;
  let stoppedReads = 0;
  const activeRun = `run_${'a'.repeat(32)}`;
  let title = '原生标题';
  let patchTitle: string | undefined;
  let mismatched = false;
  const catalog = [entry('status'), entry('usage'), entry('title'), entry('compress'),
    { ...entry('restart', true), aliases: ['reboot'] }, entry('version', true)];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer native-key');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ method: request.method!, path: request.url!, body });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/p/work/api/platforms/hermes_mobile/events') {
      if (body.kind === 'runtime') response.statusCode = runtimeStatus;
      if (body.kind === 'execute' && executionGate) await executionGate;
      response.end(JSON.stringify(body.kind === 'catalog' ? { commands: catalog } : body.kind === 'result' ? resolution
        : body.kind === 'runtime' ? runtime : execution));
    } else if (request.url?.startsWith('/p/work/api/sessions/')) {
      if (request.method === 'PATCH') title = patchTitle ?? String(body.title);
      response.end(JSON.stringify({ session: { id: mismatched ? 'other-session' : request.url.split('/').at(-1), title, model: 'native-model', message_count: 5 } }));
    } else if (request.url === `/p/work/v1/runs/${activeRun}/stop`) {
      stopping = true;
      response.end(JSON.stringify({ run_id: activeRun, status: 'stopping' }));
    } else if (request.url === `/p/work/v1/runs/${activeRun}`) {
      response.end(JSON.stringify({ run_id: activeRun, status: stopping && ++stoppedReads >= 2 ? 'cancelled' : 'stopping' }));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const directory = mkdtempSync(join(tmpdir(), 'hermes-native-'));
  const spool = new Spool(join(directory, 'spool.sqlite'));
  spool.begin(topicId, 'create');
  spool.finish(topicId, {}, { topicId, sessionId, profileRef: 'work', profileId: 'work' });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = createNativeCommands(url, 'native-key');
  let connector = createHttpConnector({ url, token: 'native-key', spool, send() {}, downloadAttachment: async () => Buffer.alloc(0) });
  t.after(() => { connector.close(); spool.close(); server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  const command = (text: string): Extract<Command, { kind: 'native_command' }> => ({ type: 'command', kind: 'native_command', command_id: randomUUID(),
    topic_id: topicId, session_id: sessionId, profile_ref: 'work', body: { command: text } });
  return { calls, spool, client, command, catalog, topicId,
    activeRun: () => {
      const id = randomUUID();
      spool.begin(id, id);
      spool.finish(id, {}, undefined, { topicId, admissionId: activeRun, submissionId: randomUUID(),
        status: 'streaming', text: JSON.stringify({ text: '', prompts: [] }) });
      return activeRun;
    },
    query: () => connector.query({ type: 'topic_query', kind: 'commands', request_id: randomUUID(), topic_id: topicId, session_id: spool.binding(topicId)!.sessionId, profile_ref: 'work' }),
    invoke: (request: Command) => connector.command(request, () => true),
    restart: () => { connector.close(); connector = createHttpConnector({ url, token: 'native-key', spool, send() {}, downloadAttachment: async () => Buffer.alloc(0) }); },
    reply: (value: JsonObject) => { execution = value; },
    resolved: (value: JsonObject) => { resolution = value; },
    runtime: (value: JsonObject) => { runtime = value; },
    runtimeStatus: (value: number) => { runtimeStatus = value; },
    holdExecution: () => { let release!: () => void; executionGate = new Promise<void>((resolve) => { release = resolve; }); return release; },
    titleReply: (value: string) => { patchTitle = value; },
    mismatch: () => { mismatched = true; },
  };
}

test('HTTP 目录来自原生插件，仅为已有完整接口开放当前会话能力', async (t) => {
  const app = await harness(t);
  const result = await app.query();
  assert.equal(result.kind, 'commands');
  if (result.kind !== 'commands') return;
  assert.deepEqual(result.commands.map(({ name, supported }) => [name, supported]), [
    ['status', true], ['usage', false], ['title', true], ['compress', false], ['restart', true], ['version', true],
  ]);
  assert.deepEqual(app.calls, [{ method: 'POST', path: '/p/work/api/platforms/hermes_mobile/events',
    body: { kind: 'catalog', profile_ref: 'work' } }]);
});

test('compress 续接原子更新绑定并保持 HTTP transport，未知结果重启后只查询不重放', async (t) => {
  const app = await harness(t);
  app.catalog.find(({ name }) => name === 'compress')!.supported = true;
  app.reply({ ok: false, status: 'unknown', error: '原生压缩仍在执行' });
  const request = app.command('/compress');
  await app.invoke(request);
  assert.equal(app.spool.nativePending(app.topicId).length, 1);
  const submit = { ...request, command_id: randomUUID(), kind: 'submit', body: { submission_id: randomUUID(), text: '继续' } } satisfies Command;
  await app.invoke(submit);
  assert.equal(JSON.parse(app.spool.command(submit.command_id)!.result!).status, 'error');
  assert.equal(app.calls.some(({ path }) => path.endsWith('/v1/runs')), false);
  const title = app.command('/title 不能越过压缩');
  await app.invoke(title);
  assert.equal(JSON.parse(app.spool.command(title.command_id)!.result!).status, 'error');
  assert.equal(app.calls.some(({ method }) => method === 'PATCH'), false);
  app.resolved({ ok: true, output: '已压缩', native_result: { session_id: '20261116_123456_a1b2c3' } });
  app.restart();
  for (let count = 0; count < 50 && app.spool.nativePending(app.topicId).length; count++) await delay(50);
  assert.equal(app.spool.nativePending(app.topicId).length, 0);
  assert.equal(app.spool.binding(app.topicId)!.sessionId, '20261116_123456_a1b2c3');
  assert.equal(app.spool.transport(app.topicId), 'http');
  assert.deepEqual(JSON.parse(app.spool.command(request.command_id)!.result!).native_result,
    { output: '已压缩', session_id: '20261116_123456_a1b2c3' });
  await app.invoke(request);
  assert.equal(app.calls.filter(({ body }) => body.kind === 'execute').length, 1);
  assert.equal(app.calls.filter(({ body }) => body.kind === 'result').length, 1);
  assert.equal((await app.query()).kind, 'commands');
  await app.invoke({ ...submit, command_id: randomUUID(), session_id: '20261116_123456_a1b2c3' });
  assert.equal(app.calls.find(({ path }) => path.endsWith('/v1/runs'))?.body.session_id, '20261116_123456_a1b2c3');
  assert.match(String(app.calls.find(({ path }) => path.endsWith('/v1/runs'))?.body.instructions), /^用原生人格回答\n\n/u);
});

test('原生变更与 submit 同话题串行，未知变更 fence 不允许新提交越过', async (t) => {
  const app = await harness(t);
  app.catalog.find(({ name }) => name === 'compress')!.supported = true;
  app.reply({ ok: false, status: 'unknown', error: '仍在压缩' });
  const release = app.holdExecution();
  const request = app.command('/compress');
  const compressing = app.invoke(request);
  const submit = { ...request, command_id: randomUUID(), kind: 'submit', body: { submission_id: randomUUID(), text: '继续' } } satisfies Command;
  const submitting = app.invoke(submit);
  for (let count = 0; count < 50 && !app.calls.some(({ body }) => body.kind === 'execute'); count++) await delay(5);
  assert.equal(app.spool.command(submit.command_id), undefined);
  release();
  await Promise.all([compressing, submitting]);
  assert.equal(app.calls.some(({ path }) => path.endsWith('/v1/runs')), false);
  assert.equal(JSON.parse(app.spool.command(submit.command_id)!.result!).status, 'error');
});

test('只读长命令未知结果跨重启恢复，同话题多个结果等待不阻止聊天', async (t) => {
  const app = await harness(t);
  app.catalog.push(entry('insights', true));
  app.catalog.find(({ name }) => name === 'usage')!.supported = true;
  app.reply({ ok: false, status: 'unknown', error: '报告仍在生成' });
  const requests = [app.command('/insights'), app.command('/usage')];
  for (const request of requests) await app.invoke(request);
  assert.equal(app.spool.nativeRequests(app.topicId).length, 2);
  assert.equal(app.spool.nativePending(app.topicId).length, 0);
  await app.invoke({ ...app.command('/unused'), kind: 'submit', body: { submission_id: randomUUID(), text: '继续聊天' } });
  assert.equal(app.calls.filter(({ path }) => path.endsWith('/v1/runs')).length, 1);
  app.activeRun();
  app.resolved({ ok: true, output: '原生报告已完成' });
  app.restart();
  for (let count = 0; count < 50 && app.spool.nativeRequests(app.topicId).length; count++) await delay(50);
  assert.equal(app.spool.nativeRequests(app.topicId).length, 0);
  for (const request of requests) {
    assert.deepEqual(JSON.parse(app.spool.command(request.command_id)!.result!).native_result, { output: '原生报告已完成' });
    await app.invoke(request);
  }
  assert.equal(app.calls.filter(({ body }) => body.kind === 'execute').length, 2);
  assert.equal(app.calls.filter(({ body }) => body.kind === 'result').length, 2);
  assert.equal(app.spool.activeTurns(app.topicId).length, 1);
});

test('旧会话报告在 new 旋转绑定后仍能恢复完成且不回写旧绑定', async (t) => {
  const app = await harness(t);
  app.catalog.push(entry('insights', true), entry('new', true));
  app.reply({ ok: false, status: 'unknown', error: '报告仍在生成' });
  const report = app.command('/insights');
  await app.invoke(report);
  app.reply({ ok: true, output: '已重置', native_result: { reset: true, session_id: 'report_continued_session' } });
  await app.invoke(app.command('/new'));
  app.resolved({ ok: true, output: '旧会话的原生报告已完成' });
  app.restart();
  for (let count = 0; count < 50 && app.spool.nativeRequests(app.topicId).length; count++) await delay(50);
  assert.equal(app.spool.nativeRequests(app.topicId).length, 0);
  assert.equal(app.spool.binding(app.topicId)?.sessionId, 'report_continued_session');
  assert.deepEqual(JSON.parse(app.spool.command(report.command_id)!.result!).native_result, { output: '旧会话的原生报告已完成' });
  assert.equal(app.calls.filter(({ body }) => body.kind === 'execute').length, 2);
  assert.equal(app.calls.find(({ body }) => body.kind === 'result')?.body.session_id, 'mobile_native');
});

test('旧会话 title 晚到回执仅保留原生输出，不覆盖新会话标题和绑定', async (t) => {
  const app = await harness(t);
  app.catalog.find(({ name }) => name === 'title')!.supported = true;
  app.catalog.push(entry('new', true));
  app.reply({ ok: false, status: 'unknown', error: '旧会话标题更新尚未确认' });
  const title = app.command('/title 旧会话标题');
  await app.invoke(title);
  app.reply({ ok: true, output: '已重置', native_result: { reset: true, session_id: 'new_title_session', title: '新会话标题' } });
  const reset = app.command('/new 新会话标题');
  await app.invoke(reset);
  app.resolved({ ok: true, output: '会话标题：旧会话标题', native_result: { title: '旧会话标题' } });
  app.restart();
  for (let count = 0; count < 50 && app.spool.nativeRequests(app.topicId).length; count++) await delay(50);
  assert.equal(app.spool.nativeRequests(app.topicId).length, 0);
  assert.equal(app.spool.binding(app.topicId)?.sessionId, 'new_title_session');
  assert.deepEqual(JSON.parse(app.spool.command(title.command_id)!.result!).native_result, { output: '会话标题：旧会话标题' });
  assert.equal(JSON.parse(app.spool.command(reset.command_id)!.result!).native_result.title, '新会话标题');
  assert.equal(app.calls.filter(({ body }) => body.kind === 'execute').length, 2);
});

test('每轮读取原生人格并与投递指令合并，读取失败不会提交无人格的 run', async (t) => {
  const app = await harness(t);
  const submit = (): Command => ({ ...app.command('/unused'), kind: 'submit', body: { submission_id: randomUUID(), text: '你好' } });
  for (const prompt of ['用简短中文回答', '用技术风格回答']) {
    app.runtime({ system_prompt: prompt });
    await app.invoke(submit());
    assert.ok(String(app.calls.filter(({ path }) => path.endsWith('/v1/runs')).at(-1)?.body.instructions).startsWith(`${prompt}\n\n`));
  }
  app.runtime({ ok: false, status: 'error', error: '无法读取原生人格' });
  const failed = submit();
  await app.invoke(failed);
  assert.equal(JSON.parse(app.spool.command(failed.command_id)!.result!).status, 'error');
  assert.equal(app.calls.filter(({ path }) => path.endsWith('/v1/runs')).length, 2);
});

test('旧插件明确缺失 runtime 保留原聊天，能力确认后不会因接口故障丢失人格', async (t) => {
  const app = await harness(t);
  const submit = (): Command => ({ ...app.command('/unused'), kind: 'submit', body: { submission_id: randomUUID(), text: '你好' } });
  app.runtimeStatus(404);
  await app.invoke(submit());
  assert.equal(app.calls.filter(({ path }) => path.endsWith('/v1/runs')).length, 1);
  assert.equal(app.spool.nativeRuntimeSupported('work'), false);
  app.runtimeStatus(503);
  const offline = submit();
  await app.invoke(offline);
  assert.equal(JSON.parse(app.spool.command(offline.command_id)!.result!).status, 'error');
  assert.equal(app.calls.filter(({ path }) => path.endsWith('/v1/runs')).length, 1);
  app.runtime({ error: { code: 'platform_http_events_unsupported', message: 'Legacy platform has no HTTP callback' } });
  await app.invoke(submit());
  assert.equal(app.calls.filter(({ path }) => path.endsWith('/v1/runs')).length, 2);
  app.runtimeStatus(200);
  app.runtime({ system_prompt: '当前人格' });
  await app.invoke(submit());
  assert.equal(app.spool.nativeRuntimeSupported('work'), true);
  app.restart();
  app.runtimeStatus(404);
  const removed = submit();
  await app.invoke(removed);
  assert.equal(JSON.parse(app.spool.command(removed.command_id)!.result!).status, 'error');
  assert.equal(app.calls.filter(({ path }) => path.endsWith('/v1/runs')).length, 3);
});

test('new 等待原生 run 终止后才 reset，回执清空会话选择并保留话题', async (t) => {
  const app = await harness(t);
  app.catalog.push({ ...entry('new', true), aliases: ['reset'] });
  const run = app.activeRun();
  for (const selection of [{ provider: 'openai', model: 'previous' }, { effort: 'high' as const }]) {
    const id = randomUUID();
    app.spool.begin(id, id);
    app.spool.finish(id, {}, undefined, undefined, { topicId: app.topicId, ...selection });
  }
  app.reply({ ok: true, output: '已开始新会话', native_result: { session_id: '20261116_reset', reset: true, title: '新工作' } });
  const request = app.command('/new 新工作');
  await app.invoke(request);
  assert.equal(app.spool.turn(app.topicId, run)?.status, 'cancelled');
  assert.equal(app.spool.binding(app.topicId)?.sessionId, '20261116_reset');
  assert.equal(app.spool.modelSelection(app.topicId), undefined);
  assert.equal(app.spool.reasoningEffort(app.topicId), undefined);
  assert.deepEqual(JSON.parse(app.spool.command(request.command_id)!.result!).native_result,
    { output: '已开始新会话', session_id: '20261116_reset', reset: true, title: '新工作' });
  const dispatchIndex = app.calls.findIndex(({ body }) => body.kind === 'execute');
  assert.ok(dispatchIndex > app.calls.findIndex(({ path }) => path.endsWith('/stop')));
  assert.equal(app.calls.slice(0, dispatchIndex).filter(({ path }) => path.endsWith(`/runs/${run}`)).length, 2);
});

test('原生确认回执不重置绑定或选择，批准以新的请求 ID 透传并执行', async (t) => {
  const app = await harness(t);
  app.catalog.push(entry('new', true));
  const selected = randomUUID();
  app.spool.begin(selected, selected);
  app.spool.finish(selected, {}, undefined, undefined, { topicId: app.topicId, provider: 'nous', model: 'chosen' });
  app.reply({ ok: true, output: '请确认', native_result: { confirmation: '是否重置当前会话？' } });
  const request = app.command('/new');
  await app.invoke(request);
  assert.deepEqual(JSON.parse(app.spool.command(request.command_id)!.result!).native_result,
    { output: '请确认', confirmation: '是否重置当前会话？' });
  assert.equal(app.spool.binding(app.topicId)?.sessionId, 'mobile_native');
  assert.equal(app.spool.modelSelection(app.topicId)?.model, 'chosen');
  assert.equal(app.spool.nativePending(app.topicId).length, 0);
  app.reply({ ok: true, output: '已重置', native_result: { reset: true, session_id: 'confirmed_new' } });
  const approved = { ...app.command('/new'), body: { command: '/new', approval: 'once' as const } };
  await app.invoke(approved);
  assert.equal(app.spool.binding(app.topicId)?.sessionId, 'confirmed_new');
  assert.equal(app.spool.modelSelection(app.topicId), undefined);
  const sent = app.calls.filter(({ body }) => body.kind === 'execute');
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].body.request_id, sent[1].body.request_id);
  assert.equal(sent[0].body.approval, undefined);
  assert.equal(sent[1].body.approval, 'once');
});

test('原生命令使用绑定的档案和会话，确认与未知回执都不自动重放', async (t) => {
  const app = await harness(t);
  for (const status of ['ok', 'unknown'] as const) {
    app.reply(status === 'ok' ? { ok: true, output: '网关正在等待当前任务结束。' }
      : { ok: false, status: 'unknown', error: '原生回执未确认' });
    const request = app.command('/reboot');
    await app.invoke(request);
    await app.invoke(request);
    app.restart();
    await app.invoke(request);
    const receipt = JSON.parse(app.spool.command(request.command_id)!.result!);
    assert.equal(receipt.status, status);
    if (status === 'ok') assert.deepEqual(receipt.native_result, { output: '网关正在等待当前任务结束。' });
    const sends = app.calls.filter(({ body }) => body.kind === 'execute' && body.request_id === request.command_id);
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0].body, { kind: 'execute', profile_ref: 'work', request_id: request.command_id,
      session_id: 'mobile_native', command: '/reboot' });
  }
  const blocked = app.command('/compress');
  await app.invoke(blocked);
  assert.equal(JSON.parse(app.spool.command(blocked.command_id)!.result!).status, 'error');
  const wrongProfile = { ...app.command('/restart'), profile_ref: 'outside' };
  const before = app.calls.length;
  await app.invoke(wrongProfile);
  assert.equal(app.calls.length, before);
});

test('原生 title PATCH 回执匹配当前会话才更新标题，查询和参数错误不产生写入', async (t) => {
  const app = await harness(t);
  const change = app.command('/title 新标题');
  await app.invoke(change);
  assert.deepEqual(JSON.parse(app.spool.command(change.command_id)!.result!).native_result, { output: '会话标题：新标题', title: '新标题' });
  assert.deepEqual(app.calls.find(({ method }) => method === 'PATCH')?.body, { title: '新标题' });
  const inspect = app.command('/title');
  await app.invoke(inspect);
  assert.deepEqual(JSON.parse(app.spool.command(inspect.command_id)!.result!).native_result, { output: '会话标题：新标题' });
  const invalid = app.command('/status extra');
  await app.invoke(invalid);
  assert.equal(JSON.parse(app.spool.command(invalid.command_id)!.result!).status, 'error');
  assert.equal(app.calls.filter(({ method }) => method === 'PATCH').length, 1);
  app.mismatch();
  const mismatch = app.command('/title 错误回执');
  await app.invoke(mismatch);
  assert.equal(JSON.parse(app.spool.command(mismatch.command_id)!.result!).status, 'unknown');
});

test('title 保留原生规范化回执，清理空标题不得清除现有标题', async (t) => {
  const app = await harness(t);
  app.titleReply('新的 标题');
  const request = app.command('/title 新的  \u200b标题');
  await app.invoke(request);
  assert.deepEqual(JSON.parse(app.spool.command(request.command_id)!.result!).native_result,
    { output: '会话标题：新的 标题', title: '新的 标题' });
  assert.deepEqual(app.calls.find(({ method }) => method === 'PATCH')?.body, { title: '新的  \u200b标题' });
  for (const invisible of ['\u200b', '\ufeff', '\u200b\u2060\u202e']) {
    const invalid = app.command(`/title ${invisible}`);
    await app.invoke(invalid);
    assert.equal(JSON.parse(app.spool.command(invalid.command_id)!.result!).status, 'error');
  }
  assert.equal(app.calls.filter(({ method }) => method === 'PATCH').length, 1);
  app.titleReply('意外的标题');
  const mismatch = app.command('/title 请求的标题');
  await app.invoke(mismatch);
  const receipt = JSON.parse(app.spool.command(mismatch.command_id)!.result!);
  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.native_result, undefined);
});

test('title 上限为清理后的 100 个 Unicode 字符，包含中文和辅助平面字符', async (t) => {
  const app = await harness(t);
  for (const unit of ['字', '🐧']) {
    const title = unit.repeat(100);
    app.titleReply(title);
    const request = app.command(`/title ${title}`);
    await app.invoke(request);
    assert.deepEqual(JSON.parse(app.spool.command(request.command_id)!.result!).native_result,
      { output: `会话标题：${title}`, title });
    const invalid = app.command(`/title ${unit.repeat(101)}`);
    await app.invoke(invalid);
    assert.equal(JSON.parse(app.spool.command(invalid.command_id)!.result!).status, 'error');
  }
  assert.equal(app.calls.filter(({ method }) => method === 'PATCH').length, 2);
});
