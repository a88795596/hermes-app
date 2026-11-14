import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Command } from '@hermes-mobile/protocol';
import { CanonicalConnector } from '../src/connector.js';
import { Gateway, type JsonObject } from '../src/gateway.js';
import { createHttpConnector } from '../src/http-mode.js';
import { Spool } from '../src/spool.js';
import { bridgeFrame } from '../src/wire.js';

async function harness(t: TestContext, replyStatus = 'resolved', runEvents?: JsonObject[]) {
  const calls: { path: string; body: JsonObject }[] = [];
  const frames: JsonObject[] = [];
  const topicId = randomUUID();
  const sessionId = 'mobile_test';
  const runId = 'run_' + '1'.repeat(32);
  let pending = !runEvents;
  let sessionAvailable = true;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const path = req.url!.replace('/p/default', '');
    calls.push({ path, body });
    res.setHeader('content-type', 'application/json');
    if (path === '/api/model/options?include_unconfigured=false') {
      res.end(JSON.stringify({
        provider: 'nous', model: 'default-model',
        providers: [
          { slug: 'nous', name: 'Nous', models: ['default-model', 'restricted'], unavailable_models: ['restricted'] },
          { slug: 'custom:local', name: '本地服务商', models: ['local-model'], api_url: 'http://private-endpoint' },
          { slug: 'unconfigured', name: '未配置的服务商', models: ['ignored'], authenticated: false },
        ],
      }));
    } else if (path === `/api/sessions/${sessionId}`) {
      res.statusCode = sessionAvailable ? 200 : 503;
      res.end(JSON.stringify(sessionAvailable ? { session: { id: sessionId } } : {}));
    } else if (path === '/v1/runs') {
      res.statusCode = 202;
      res.end(JSON.stringify({ run_id: runId }));
    } else if (path === `/v1/runs/${runId}/events` && runEvents) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': open\n\n');
      // The terminal status is available before this subscriber receives the buffered events.
      await delay(50);
      res.end(runEvents.map((event, seq) => `data: ${JSON.stringify({ ...event, run_id: runId, seq })}\n\n`).join(''));
    } else if (path === `/v1/runs/${runId}`) {
      res.end(JSON.stringify({ run_id: runId, status: pending ? 'running' : 'completed', output: '已完成',
        pending_controls: pending ? [{
          kind: 'clarify', prompt_id: 'ask', execution_generation: 3, question: '要使用哪些环境？',
          choices: ['预发布环境', '生产环境'], multi_select: true,
        }] : [] }));
    } else if (path === `/v1/runs/${runId}/clarify`) {
      pending = false;
      res.end(JSON.stringify({ run_id: runId, prompt_id: 'ask', status: replyStatus }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const directory = mkdtempSync(join(tmpdir(), 'hermes-mobile-interactions-'));
  const filename = join(directory, 'connector.sqlite');
  const options = { url: `http://127.0.0.1:${address.port}`, token: 'test-key', send: (frame: JsonObject) => frames.push(frame) };
  let spool = new Spool(filename);
  const createId = randomUUID();
  spool.begin(createId, 'create');
  spool.finish(createId, {}, { topicId, sessionId, profileId: 'default', profileRef: 'default' });
  let connector = createHttpConnector({ ...options, spool });
  t.after(() => {
    connector.close();
    spool.close();
    server.close();
    server.closeAllConnections();
    rmSync(directory, { recursive: true, force: true });
  });
  function restart() {
    connector.close();
    spool.close();
    spool = new Spool(filename);
    connector = createHttpConnector({ ...options, spool });
  }
  async function command(payload: Pick<Command, 'kind' | 'body'>, id = randomUUID() as string) {
    await connector.command({
      ...payload, type: 'command', command_id: id, topic_id: topicId, profile_ref: 'default', session_id: sessionId,
    } as Command, () => true);
    return frames.find((frame) => frame.type === 'command_result' && frame.command_id === id);
  }
  return { calls, frames, restart, command, disconnectSession: () => { sessionAvailable = false; } };
}

async function waitForQuestion(frames: JsonObject[]) {
  const control = await new Promise<JsonObject>((resolve, reject) => {
    const wait = setInterval(() => {
      const frame = frames.find((item) => item.type === 'control');
      if (!frame) return;
      clearInterval(wait);
      clearTimeout(timeout);
      resolve(frame);
    }, 10);
    const timeout = setTimeout(() => {
      clearInterval(wait);
      reject(new Error('未投影 Hermes 的提问'));
    }, 2000);
  });
  const { control_id, choices, multi_select } = control;
  assert(typeof control_id === 'string');
  return { control_id, choices, multi_select };
}

test('HTTP 模式的模型选择器返回已配置的服务商目录，并在重启后保留选择', async (t) => {
  const { command, calls, restart } = await harness(t);
  assert.deepEqual((await command({ kind: 'model_options', body: {} }))?.model_result, {
    type: 'catalog',
    catalog: {
      provider: 'nous', model: 'default-model',
      providers: [
        { id: 'nous', name: 'Nous', models: ['default-model'] },
        { id: 'custom:local', name: '本地服务商', models: ['local-model'] },
      ],
    },
  });
  assert.equal((await command({ kind: 'select_model', body: { provider: 'nous', model: 'restricted' } }))?.status, 'error');
  const selection = { provider: 'custom:local', model: 'local-model' };
  assert.deepEqual((await command({ kind: 'select_model', body: selection }))?.model_result, { type: 'selected', selection });
  restart();
  const id = randomUUID();
  await command({ kind: 'submit', body: { submission_id: id, text: '你好' } }, id);
  assert.deepEqual(calls.find((call) => call.path === '/v1/runs')?.body, {
    session_id: 'mobile_test', input: '你好', ...selection,
  });
});

test('HTTP Runs 保留话题的思考强度，恢复默认后不再覆盖 Hermes 配置', async (t) => {
  const { command, calls, restart } = await harness(t);
  assert.equal((await command({ kind: 'select_reasoning', body: { effort: 'high' } }))?.status, 'ok');
  restart();
  await command({ kind: 'submit', body: { submission_id: randomUUID(), text: '使用高强度' } });
  assert.deepEqual(calls.find((call) => call.path === '/v1/runs')?.body.model_options, { reasoning_effort: 'high' });

  assert.equal((await command({ kind: 'select_reasoning', body: { effort: null } }))?.status, 'ok');
  await command({ kind: 'submit', body: { submission_id: randomUUID(), text: '使用档案默认值' } });
  assert.equal(calls.filter((call) => call.path === '/v1/runs').at(-1)?.body.model_options, undefined);
});

test('HTTP 模式无法访问会话时拒绝切换思考强度', async (t) => {
  const { command, disconnectSession } = await harness(t);
  disconnectSession();
  assert.equal((await command({ kind: 'select_reasoning', body: { effort: 'high' } }))?.status, 'error');
});

test('Canonical Gateway 按话题绑定的会话和当前版本切换思考强度', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-mobile-reasoning-'));
  const spool = new Spool(join(directory, 'connector.sqlite'));
  const topicId = randomUUID();
  const sessionId = 'canonical-session';
  spool.begin(topicId, 'create');
  spool.finish(topicId, {}, { topicId, sessionId, profileId: 'default', profileRef: 'default' });
  const snapshot = { session_id: sessionId, stored_session_id: sessionId, subscription_id: 'sub',
    authority_epoch: 1, replay_epoch: 'replay', last_sequence: 0,
    revision: 4, execution_generation: 2, running: false, pending: [], prompts: [] };
  const mutations: JsonObject[] = [];
  let deferred = false;
  t.mock.method(Gateway, 'connect', async () => ({
    connected: true, identity: { profileId: 'default', authorityEpoch: '1' }, close() {},
    async rpc(method: string, params: JsonObject) {
      if (method === 'session.events.since') return { events: [], snapshot_required: false };
      if (method === 'session.resume') return snapshot;
      if (method === 'config.get') return { value: '1' };
      assert.equal(method, 'session.mutate');
      mutations.push(params);
      return { session_id: sessionId, operation: 'reasoning', effort: 'none', revision: 5, execution_generation: 3,
        ...(deferred ? { status: 'deferred' } : {}) };
    },
  }));
  const connector = new CanonicalConnector('unused', spool, () => {});
  t.after(() => { connector.close(); spool.close(); rmSync(directory, { recursive: true, force: true }); });

  const id = randomUUID();
  const frame = { type: 'command', command_id: id, topic_id: topicId, profile_ref: 'default',
    session_id: sessionId, kind: 'select_reasoning', body: { effort: 'none' } };
  assert.throws(() => bridgeFrame(JSON.stringify({ ...frame, body: { effort: 'unsupported' } })));
  const command = bridgeFrame(JSON.stringify(frame));
  assert(command.type === 'command');
  await connector.command(command, () => true);
  assert.deepEqual(mutations, [{ session_id: sessionId, request_id: id, operation: 'reasoning',
    payload: { effort: 'none' }, expected_revision: 4, expected_generation: 2 }]);
  assert.equal(JSON.parse(spool.command(id)!.result!).status, 'ok');

  deferred = true;
  const deferredId = randomUUID();
  await connector.command({ ...command, command_id: deferredId }, () => true);
  assert.equal(JSON.parse(spool.command(deferredId)!.result!).status, 'unknown');
});

test('HTTP Runs 投影多选问题并将回答转发给等待中的执行', async (t) => {
  const { command, calls, frames } = await harness(t);
  const id = randomUUID();
  await command({ kind: 'submit', body: { submission_id: id, text: '问我需要使用哪些环境' } }, id);
  const control = await waitForQuestion(frames);
  assert.equal(control.multi_select, true);
  assert.deepEqual(control.choices, ['预发布环境', '生产环境']);
  const responseId = randomUUID();
  const answer = JSON.stringify(['预发布环境', '生产环境']);
  const response = await command({ kind: 'respond', body: { control_id: control.control_id, response_id: responseId, answer } }, responseId);
  assert.equal(response?.control_status, 'closed');
  assert.deepEqual(calls.find((call) => call.path.endsWith('/clarify'))?.body, {
    request_id: 'ask', execution_generation: 3, answer,
  });
});

test('HTTP Runs 关闭已处理的问题，拒绝再次提交的回答', async (t) => {
  const { command, frames } = await harness(t, 'already_resolved');
  const id = randomUUID();
  await command({ kind: 'submit', body: { submission_id: id, text: '问我需要使用哪些环境' } }, id);
  const { control_id } = await waitForQuestion(frames);
  const responseId = randomUUID();
  const response = await command({ kind: 'respond', body: { control_id, response_id: responseId, answer: '预发布环境' } }, responseId);
  assert.equal(response?.control_status, 'closed');
  assert.equal(response.status, 'error');
  assert.equal(response.error, '此请求已过期或已回答。');
});

test('HTTP Runs 将思考、阶段说明和工具状态随最终回复保存', { timeout: 5000 }, async (t) => {
  const { command, frames } = await harness(t, 'resolved', [
    { event: 'reasoning.delta', text: '先检查' },
    { event: 'reasoning.delta', text: '目录。' },
    { event: 'message.delta', delta: '我先看看。' },
    { event: 'message.interim', text: '我先看看。', already_streamed: true },
    { event: 'tool.started', tool: 'read_file', tool_call_id: 'call-1', preview: '工具参数' },
    { event: 'tool.completed', tool: 'read_file', tool_call_id: 'call-1', error: false, preview: '工具原始输出' },
    { event: 'message.delta', delta: '已完成' },
    { event: 'run.completed', output: '已完成' },
  ]);
  const id = randomUUID();
  await command({ kind: 'submit', body: { submission_id: id, text: '检查目录' } }, id);
  const finalReply = () => frames.find((frame) => frame.type === 'message' && frame.status === 'final');
  while (!finalReply()) await delay(10, undefined, { signal: t.signal });
  const replies = frames.filter((frame) => frame.type === 'message');
  assert.equal(replies[0].text, '');
  assert.deepEqual(replies[0].process, [{ kind: 'reasoning', text: '先检查' }]);
  assert(replies.some((frame) => frame.status === 'streaming' && frame.text === '已完成'));
  assert.equal(finalReply()?.text, '已完成');
  assert.deepEqual(finalReply()?.process, [
    { kind: 'reasoning', text: '先检查目录。' },
    { kind: 'commentary', text: '我先看看。' },
    { kind: 'tool', id: 'call-1', name: 'read_file', status: 'succeeded' },
  ]);
  assert(replies.every((frame) => frame.message_id === finalReply()?.message_id && frame.submission_id === id));
});
