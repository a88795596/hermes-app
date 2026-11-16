import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as yieldTurn, setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import type { Command, NativeCommand, NativeCommandResult } from '@hermes-mobile/protocol';
import { CanonicalConnector } from '../src/connector.js';
import { Gateway, type JsonObject } from '../src/gateway.js';
import { NativeCommandFailure, type NativeCommands } from '../src/native-commands.js';
import { Spool } from '../src/spool.js';
import { commandDigest } from '../src/wire.js';

function harness(t: TestContext, pending = false) {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-canonical-native-'));
  const spool = new Spool(join(directory, 'spool.sqlite'));
  const binding = { topicId: randomUUID(), sessionId: 'canonical-native', profileId: 'work', profileRef: 'work' };
  const other = { ...binding, topicId: randomUUID(), sessionId: 'canonical-other' };
  for (const item of [binding, other]) {
    spool.begin(item.topicId, 'create');
    spool.finish(item.topicId, {}, item);
  }
  const calls: { method: string; sessionId: unknown }[] = [];
  const nativeCalls: string[] = [];
  const resultCalls: { profile: string; sessionId: string; requestId: string }[] = [];
  let response: (command: string) => Promise<NativeCommandResult> = async (command) => ({ output: `原生完整输出 ${command}` });
  let resolution: () => Promise<NativeCommandResult> = async () => { throw new NativeCommandFailure('仍在执行', 'unknown'); };
  const commands: NativeCommand[] = ['status', 'version', 'new', 'undo', 'compress', 'restart', 'insights'].map((name) => ({
    name, aliases: name === 'new' ? ['reset'] : [], description: name, category: 'Session', supported: true,
  }));
  const native: NativeCommands = {
    async catalog() { return commands; },
    async execute(_profile, _sessionId, _requestId, command) {
      nativeCalls.push(command);
      return response(command);
    },
    async runtime() { return binding.sessionId; },
    async result(profile, sessionId, requestId) {
      resultCalls.push({ profile, sessionId, requestId });
      return resolution();
    },
  };
  let closed = 0;
  t.mock.method(Gateway, 'connect', async () => ({
    connected: true, identity: { profileId: 'work', authorityEpoch: '1' }, close() { closed++; },
    async rpc(method: string, params: JsonObject) {
      calls.push({ method, sessionId: params.session_id });
      if (method === 'session.events.since') return { events: [], snapshot_required: false };
      if (method === 'session.resume') return { session_id: params.session_id, stored_session_id: params.session_id,
        subscription_id: 'subscription', authority_epoch: 1, replay_epoch: 'epoch', last_sequence: 0,
        execution_generation: 1, revision: 1, running: false, pending: [], prompts: [] };
      if (method === 'config.get') return { value: '1' };
      if (method === 'prompt.submit') return { admission_id: `admission-${params.submission_id}`,
        ref: { session_id: params.session_id, profile_id: 'work' }, sequence: 1,
        status: 'queued', outcome: null, authority_epoch: 1, execution_generation: null };
      throw new Error(`意外 RPC ${method}`);
    },
  }));
  const base = { type: 'command', topic_id: binding.topicId, session_id: binding.sessionId, profile_ref: binding.profileRef } as const;
  const command = (text: string): Command => ({ ...base, command_id: randomUUID(), kind: 'native_command', body: { command: text } });
  const submit = (otherTopic = false): Command => {
    const id = randomUUID();
    return { ...base, ...(otherTopic && { topic_id: other.topicId, session_id: other.sessionId }),
      command_id: id, kind: 'submit', body: { submission_id: id, text: '继续' } };
  };
  const unresolved = command('/compress');
  if (pending) {
    spool.begin(unresolved.command_id, commandDigest(unresolved));
    spool.beginNative({ commandId: unresolved.command_id, name: 'compress', binding });
  }
  const create = () => new CanonicalConnector('unused', spool, () => {}, async () => Buffer.alloc(0), undefined, native);
  let connector = create();
  t.after(() => { connector.close(); spool.close(); rmSync(directory, { recursive: true, force: true }); });
  return { spool, get connector() { return connector; }, calls, nativeCalls, resultCalls, binding, command, submit, unresolved,
    closed: () => closed,
    reply: (next: typeof response) => { response = next; },
    resultReply: (next: typeof resolution) => { resolution = next; },
    restart: () => { connector.close(); connector = create(); },
    receipt: (request: Command) => JSON.parse(spool.command(request.command_id)!.result!) as JsonObject,
  };
}

test('Canonical 优先保留插件 status/version 原生输出，重复请求不会再次执行', async (t) => {
  const app = harness(t);
  for (const text of ['/status', '/version']) {
    const request = app.command(text);
    await app.connector.command(request, () => true);
    await app.connector.command(request, () => true);
    assert.deepEqual(app.receipt(request).native_result, { output: `原生完整输出 ${text}` });
  }
  assert.deepEqual(app.nativeCalls, ['/status', '/version']);
  assert.equal(app.calls.some(({ method }) => ['session.info', 'subagent.list'].includes(method)), false);
});

test('Canonical 目录说明 API 历史修改不兼容，new/reset/undo/compress 均不发出副作用', async (t) => {
  const app = harness(t);
  const data = await app.connector.query({ type: 'topic_query', request_id: randomUUID(), kind: 'commands',
    topic_id: app.binding.topicId, session_id: app.binding.sessionId, profile_ref: app.binding.profileRef });
  assert.equal(data.kind, 'commands');
  if (data.kind !== 'commands') return;
  for (const name of ['new', 'undo', 'compress']) {
    const item: NativeCommand = data.commands.find((entry) => entry.name === name)!;
    assert.equal(item.supported, false);
    assert.match(item.unavailable_reason!, /HTTP Runs/);
  }
  for (const text of ['/new', '/reset', '/undo', '/compress']) {
    const request = app.command(text);
    await app.connector.command(request, () => true);
    assert.equal(app.receipt(request).status, 'error');
  }
  assert.deepEqual(app.nativeCalls, []);
  assert.equal(app.spool.binding(app.binding.topicId)?.sessionId, app.binding.sessionId);
  assert.equal(app.closed(), 0);
});

test('Canonical 同话题命令串行，其他话题仍可执行且不关闭共用网关', async (t) => {
  const app = harness(t);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  app.reply(async () => { entered(); await gate; return { output: '原生状态' }; });
  const reading = app.connector.command(app.command('/status'), () => true);
  await started;
  const request = app.submit();
  const queued = app.connector.command(request, () => true);
  await yieldTurn();
  assert.equal(app.calls.some(({ method }) => method === 'prompt.submit'), false);
  const other = app.submit(true);
  await app.connector.command(other, () => true);
  assert.equal(app.receipt(other).status, 'ok');
  assert.equal(app.spool.command(request.command_id), undefined);
  release();
  await Promise.all([reading, queued]);
  assert.equal(app.receipt(request).status, 'ok');
  assert.equal(app.closed(), 0);
});

test('Canonical 未确认的历史修改重启后保留 fence，不能向旧会话继续提交', async (t) => {
  const app = harness(t, true);
  assert.equal(app.receipt(app.unresolved).status, 'unknown');
  const request = app.submit();
  await app.connector.command(request, () => true);
  assert.equal(app.receipt(request).status, 'error');
  assert.match(String(app.receipt(request).error), /尚未确认/);
  assert.equal(app.spool.nativePending(app.binding.topicId).length, 1);
  assert.deepEqual(app.calls, []);
  assert.deepEqual(app.nativeCalls, []);
});

test('Canonical 未知原生命令结果不重放，意外续接元数据不能替换绑定', async (t) => {
  const app = harness(t);
  app.reply(async () => { throw new NativeCommandFailure('执行结果未知', 'unknown'); });
  const restart = app.command('/restart');
  await app.connector.command(restart, () => true);
  await app.connector.command(restart, () => true);
  assert.equal(app.receipt(restart).status, 'unknown');
  assert.deepEqual(app.nativeCalls, ['/restart']);
  app.reply(async () => ({ output: '意外续接', session_id: 'other-session', reset: true }));
  const request = app.command('/status');
  await app.connector.command(request, () => true);
  assert.equal(app.receipt(request).status, 'unknown');
  assert.equal(app.spool.binding(app.binding.topicId)?.sessionId, app.binding.sessionId);
});

for (const restart of [false, true]) test(`Canonical 长命令${restart ? '重启后' : ''}只查询原始结果，等待时允许继续聊天`, { timeout: 6000 }, async (t) => {
  const app = harness(t);
  app.reply(async () => { throw new NativeCommandFailure('报告仍在生成', 'unknown'); });
  const request = app.command('/insights');
  await app.connector.command(request, () => true);
  assert.equal(app.receipt(request).status, 'unknown');
  assert.equal(app.spool.nativePending(app.binding.topicId).length, 0);
  assert.equal(app.spool.nativeRequests(app.binding.topicId).length, 1);
  if (restart) app.restart();
  await app.connector.command(request, () => true);
  const message = app.submit();
  await app.connector.command(message, () => true);
  assert.equal(app.receipt(message).status, 'ok');
  assert.equal(app.spool.activeTurns(app.binding.topicId).length, 1);
  app.resultReply(async () => ({ output: '已生成的原生报告' }));
  const deadline = Date.now() + 4000;
  while (app.receipt(request).status === 'unknown' && Date.now() < deadline) await delay(20);
  assert.equal(app.receipt(request).status, 'ok');
  assert.deepEqual(app.receipt(request).native_result, { output: '已生成的原生报告' });
  assert.deepEqual(app.nativeCalls, ['/insights']);
  assert.deepEqual(app.resultCalls, [{ profile: app.binding.profileRef, sessionId: app.binding.sessionId,
    requestId: request.command_id }]);
  assert.equal(app.spool.nativeRequests(app.binding.topicId).length, 0);
});
