import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { CanonicalConnector } from '../src/connector.js';
import type { JsonObject } from '../src/gateway.js';
import { Spool } from '../src/spool.js';
import { sessionStatus } from '../src/topic-query.js';

test('会话状态查询结合原生执行和所属会话的后台子任务', { timeout: 10000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-status-'));
  const spool = new Spool(join(directory, 'spool.sqlite'));
  const topicId = randomUUID();
  const sessionId = 'session-status';
  spool.begin(topicId, 'create');
  spool.finish(topicId, {}, { topicId, sessionId, profileId: 'default', profileRef: 'default' });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const binary = join(directory, 'hermes');
  const connector = new CanonicalConnector(binary, spool, () => {}, async () => Buffer.alloc(0));
  t.after(() => {
    connector.close();
    for (const socket of server.clients) socket.terminate();
    server.close();
    spool.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const endpoint = { profile_id: 'default', instance_id: 'test', authority_epoch: 1 };
  const protocol = 'hermes-gateway-v1';
  writeFileSync(binary, `#!/bin/sh\ncat <<'END'\n${JSON.stringify({ endpoint,
    url: `ws://127.0.0.1:${address.port}/api/ws`, ticket: 'test', protocol,
    protocols: [protocol, 'hermes-gateway-ticket.test'] })}\nEND\n`, { mode: 0o700 });
  let running = false;
  let usage: JsonObject = { model: 'test-model', context_used: 32_000, context_max: 128_000, total: 700_000 };
  let reasoning: JsonObject = {};
  let breakdown: JsonObject = {};
  let roster: JsonObject = { subagents: [] };
  let refusal: { code: number; data: { reason: string } } | undefined;
  const calls: { method: string; params: JsonObject }[] = [];
  server.on('connection', (socket) => {
    const send = (frame: JsonObject) => socket.send(JSON.stringify({ jsonrpc: '2.0', ...frame }));
    send({ method: 'event', params: { type: 'gateway.ready', payload: { session_authority: true } } });
    socket.on('message', (raw) => {
      const { id, method, params } = JSON.parse(String(raw));
      if (['session.info', 'session.resume', 'subagent.list', 'session.context_breakdown'].includes(method)) calls.push({ method, params });
      if (method === 'subagent.list' && refusal) {
        send({ id, error: refusal });
        return;
      }
      const result = method === 'runtime.describe' ? { ...endpoint, capabilities: ['durable-admission-v1', 'event-replay-v1'],
        session_create: { sources: ['tool'], parameters: ['source', 'request_id'] } }
        : method === 'client.capabilities' ? { server_requests: [] }
        : method === 'config.get' ? { value: '1' }
        : method === 'session.events.since' ? { snapshot_required: true, events: [] }
        : method === 'session.resume' ? { session_id: sessionId, stored_session_id: sessionId, authority_epoch: 1,
          replay_epoch: 'epoch', last_sequence: 0, subscription_id: 'subscription', execution_generation: 2,
          revision: 2, running, prompts: [], pending: [], message_count: 3, info: { profile_id: 'default', model: 'test-model', usage, ...reasoning } }
        : method === 'session.context_breakdown' ? breakdown
        : method === 'session.info' ? { profile_id: 'default', model: 'test-model' }
        : roster;
      send({ id, result });
    });
  });
  await connector.command({ type: 'command', command_id: randomUUID(), topic_id: topicId, profile_ref: 'default',
    session_id: sessionId, kind: 'watch', body: {} }, () => true);
  const query = (includeContext = true, includeReasoning = true) => connector.query({ type: 'topic_query', kind: 'status', request_id: randomUUID(),
    ...(includeContext && { include_context: true as const }),
    ...(includeReasoning && { include_reasoning: true as const }),
    topic_id: topicId, profile_ref: 'default', session_id: sessionId });
  const cases = [
    { name: '无移动端提交时仍识别原生执行', running: true, children: [], stale: false, activity: 'running' },
    { name: '父轮已结束，后台子任务仍运行', running: false, children: ['running'], stale: false, activity: 'running' },
    { name: '后台子任务排队期间仍保留执行状态', running: false, children: ['queued'], stale: false, activity: 'running' },
    { name: '父轮与所有子任务结束后空闲', running: false, children: ['completed', 'failed', 'error', 'timeout', 'interrupted'], stale: false, activity: 'idle' },
    { name: '原生空闲覆盖过期本地执行状态', running: false, children: [], stale: true, activity: 'idle' },
    { name: '原生尚未开始执行时保留已排队提交', running: false, children: [], stale: false, queued: true, activity: 'queued' },
  ];
  for (const value of cases) await t.test(value.name, async () => {
    running = value.running;
    roster = { subagents: value.children.map((status, index) => ({ subagent_id: `child-${index}`,
      child_session_id: `child-session-${index}`, status })) };
    spool.record(topicId, [], undefined, { topicId, admissionId: 'stale-local', submissionId: randomUUID(),
      text: '', status: value.queued ? 'queued' : value.stale ? 'streaming' : 'final' });
    calls.length = 0;
    assert.deepEqual(await query(), { kind: 'status', status: { activity: value.activity, model: 'test-model', message_count: 3,
      context_usage: { used: 32_000, max: 128_000 } } });
    assert.deepEqual(calls, [
      { method: 'subagent.list', params: { session_id: sessionId } },
      { method: 'session.resume', params: { session_id: sessionId, omit_messages: true } },
    ], '子任务必须按已验证的会话范围查询，并在之后读取最新父执行状态');
  });
  await t.test('旧版 BFF 查询仅返回其认识的状态字段', async () => {
    reasoning = { reasoning_effort: 'high' };
    const data = await query(false, false);
    assert(data.kind === 'status');
    assert.equal(data.status.context_usage, undefined);
    const contextOnly = await query(true, false);
    assert(contextOnly.kind === 'status' && contextOnly.status.context_usage);
    assert.equal(contextOnly.status.reasoning_effort, undefined);
    assert.equal(data.status.reasoning_effort, undefined);
  });
  await t.test('读取本会话原生思考档位，优先返回模型实际采用的档位', async () => {
    for (const [configured, wire, expected] of [
      ['xhigh', 'high', 'high'], ['none', '', 'none'], ['minimal', '', 'minimal'], ['new-value', '', undefined],
    ] as const) {
      reasoning = { reasoning_effort: configured, reasoning_effort_wire: wire };
      const data = await query();
      assert(data.kind === 'status');
      assert.equal(data.status.reasoning_effort, expected);
    }
  });
  await t.test('恢复旧会话时读取 Hermes 的上下文估算，累计吞吐量不计入占用', async () => {
    running = false;
    usage = { total: 700_000, input: 600_000 };
    roster = { subagents: [] };
    breakdown = { context_used: 0, context_max: 0, estimated_total: 9_250 };
    calls.length = 0;
    const data = await query();
    assert(data.kind === 'status');
    assert.deepEqual(data.status.context_usage, { used: 9_250, estimated: true });
    assert.deepEqual(calls.at(-1), { method: 'session.context_breakdown', params: { session_id: sessionId } });
  });
  for (const [code, reason] of [[-32601, 'unknown_method'], [4001, 'unsupported_projection']] as const) {
    await t.test(`旧网关 ${reason} 回退原生父状态`, async () => {
      running = true;
      refusal = { code, data: { reason } };
      spool.record(topicId, [], undefined, { topicId, admissionId: 'stale-local', submissionId: randomUUID(), text: '', status: 'final' });
      calls.length = 0;
      const result = await query();
      assert(result.kind === 'status');
      assert.equal(result.status.activity, 'running');
      assert.equal(calls[0]?.method, 'subagent.list');
    });
  }
  await t.test('查询失败不伪装为空闲或已完成', async () => {
    refusal = { code: 4001, data: { reason: 'stale_generation' } };
    await assert.rejects(query());
  });
  await t.test('畸形子任务响应不伪装为空闲', async () => {
    refusal = undefined;
    running = false;
    for (const invalid of [{}, { subagents: [null] }, { subagents: [{ status: 1 }] }, { subagents: [{ status: 'unrecognized' }] }]) {
      roster = invalid;
      await assert.rejects(query());
    }
  });
});

test('HTTP 旧会话缺少原生运行字段时继续从本地提交推断状态', () => {
  const turn = { topicId: 'topic', admissionId: 'run', submissionId: 'submission', text: '', status: 'streaming' } as const;
  assert.equal(sessionStatus({ model: 'legacy' }, [turn]).activity, 'running');
  assert.equal(sessionStatus({}, [{ ...turn, status: 'queued' }]).activity, 'queued');
  assert.equal(sessionStatus({}, []).activity, 'idle');
  assert.throws(() => sessionStatus({ running: 'false' }, []));
});

test('可用的上下文占用保留零值和估算标记，缺失或属于旧模型的用量不显示', () => {
  assert.deepEqual(sessionStatus({ model: 'm', context_length: 128_000,
    usage: { context_used: 0, context_estimated: true } }, [], [], true),
  { activity: 'idle', model: 'm', context_usage: { used: 0, max: 128_000, estimated: true } });
  for (const usage of [{ total: 500_000 }, { context_used: -1 }, { context_used: '5' },
    { model: 'previous', context_used: 42, context_max: 50 }]) {
    assert.deepEqual(sessionStatus({ model: 'm', usage }, [], [], true), { activity: 'idle', model: 'm' });
  }
});
