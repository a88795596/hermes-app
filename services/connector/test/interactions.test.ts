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
import { createDashboardManagement } from '../src/management.js';
import { Spool } from '../src/spool.js';
import { bridgeFrame } from '../src/wire.js';
import type { ReceiveAttachments } from '../src/attachments.js';

async function harness(t: TestContext, replyStatus = 'resolved', runEvents?: JsonObject[], received?: { output: string; receive: ReceiveAttachments }, profileRef = 'default') {
  const calls: { path: string; body: JsonObject }[] = [];
  const frames: JsonObject[] = [];
  const topicId = randomUUID();
  const sessionId = 'mobile_test';
  const runId = 'run_' + '1'.repeat(32);
  let pending = !runEvents;
  let sessionAvailable = true;
  let modelWriteStatus = 200;
  let modelWarning = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = req.headers['content-type']?.startsWith('multipart/form-data') ? { raw } : raw ? JSON.parse(raw) : {};
    const path = req.url!.replace(`/p/${profileRef}`, '');
    calls.push({ path, body });
    res.setHeader('content-type', 'application/json');
    if (path === `/api/chat/file-upload?profile=${profileRef}`) {
      assert.equal(req.headers.authorization, 'Bearer dashboard-key');
      res.end(JSON.stringify({ ok: true, size: 3, path: '/opt/data/uploads/report.txt' }));
    } else if (path === '/v1/skills') {
      res.statusCode = 500;
      res.end('{}');
    } else if (path === `/api/skills?profile=${profileRef}`) {
      assert.equal(req.headers.authorization, 'Bearer dashboard-key');
      res.end(JSON.stringify([{ name: 'example', category: 'dev', description: '示例技能', enabled: true }]));
    } else if (path === `/api/model/set?profile=${profileRef}`) {
      assert.equal(req.headers['x-hermes-session-token'], 'dashboard-key');
      res.statusCode = modelWriteStatus;
      res.end(JSON.stringify(modelWarning && !body.confirm_expensive_model
        ? { ok: false, confirm_required: true, confirm_message: '此模型价格较高，是否继续？' }
        : { ok: modelWriteStatus === 200 }));
    } else if (path === '/api/model/options?include_unconfigured=false') {
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
      res.end(JSON.stringify(sessionAvailable ? { session: { id: sessionId, title: 'Hermes 原生标题' } } : {}));
    } else if (path === '/api/platforms/hermes_mobile/events' && body.kind === 'runtime') {
      res.end(JSON.stringify({ system_prompt: '' }));
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
      res.end(JSON.stringify({ run_id: runId, status: pending ? 'running' : 'completed', output: received?.output ?? '已完成',
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
  const options = { url: `http://127.0.0.1:${address.port}`, token: 'test-key', send: (frame: JsonObject) => frames.push(frame),
    webapp: { origin: `http://127.0.0.1:${address.port}`, token: 'dashboard-key' },
    manage: createDashboardManagement(`http://127.0.0.1:${address.port}`, 'dashboard-key'),
    receiveAttachments: received?.receive,
    downloadAttachment: async (_id: string, number: number) => Buffer.from(number === 1 ? 'YWJj' : png, 'base64') };
  let spool = new Spool(filename);
  const createId = randomUUID();
  spool.begin(createId, 'create');
  spool.finish(createId, {}, { topicId, sessionId, profileId: profileRef, profileRef });
  let connector = createHttpConnector({ ...options, spool });
  t.after(() => {
    connector.close();
    spool.close();
    server.close();
    server.closeAllConnections();
    rmSync(directory, { recursive: true, force: true });
  });
  function restart(withManagement = true) {
    connector.close();
    spool.close();
    spool = new Spool(filename);
    connector = createHttpConnector({ ...options, spool, manage: withManagement ? options.manage : undefined });
  }
  async function command(payload: { kind: Command['kind']; body: unknown }, id = randomUUID() as string) {
    const frame = bridgeFrame(JSON.stringify({
      ...payload, type: 'command', command_id: id, topic_id: topicId, profile_ref: profileRef, session_id: sessionId,
    }));
    assert(frame.type === 'command');
    await connector.command(frame, () => true);
    return frames.find((frame) => frame.type === 'command_result' && frame.command_id === id);
  }
  return { calls, frames, restart, command,
    status: () => {
      const frame = bridgeFrame(JSON.stringify({ type: 'topic_query', kind: 'status', request_id: randomUUID(),
        topic_id: topicId, session_id: sessionId, profile_ref: profileRef, include_context: true, include_reasoning: true }));
      assert(frame.type === 'topic_query' && frame.include_context && frame.include_reasoning);
      return connector.query(frame);
    },
    modelWrite: (status = 200, warning = false) => { modelWriteStatus = status; modelWarning = warning; },
    turn: () => spool.turn(topicId, runId),
    skills: () => connector.query({ type: 'topic_query', kind: 'skills', request_id: randomUUID(),
      topic_id: topicId, session_id: sessionId, profile_ref: profileRef }),
    disconnectSession: () => { sessionAvailable = false; } };
}

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLG0AAAAASUVORK5CYII=';

test('HTTP Runs 等附件入库后才完成，纯附件回复也发出终态消息', async (t) => {
  let release!: () => void;
  let receiving = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const attachment = { attachment_id: randomUUID(), name: 'clip.mp4', mime: 'video/mp4', size: 3 };
  const { command, frames, turn, restart } = await harness(t, 'resolved', [], {
    output: 'MEDIA:/clip.mp4', receive: async (_profile, _topic, _message, text) => {
      assert.equal(text, 'MEDIA:/clip.mp4');
      receiving = true;
      await gate;
      return { text: '', attachments: [attachment] };
    },
  });
  const submission_id = randomUUID();
  await command({ kind: 'submit', body: { submission_id, text: '生成视频' } }, submission_id);
  for (let tries = 0; tries < 100 && !receiving; tries += 1) await delay(10);
  assert.equal(receiving, true);
  assert.notEqual(turn()?.status, 'final');
  assert(!frames.some((frame) => frame.type === 'submission' && frame.status === 'final'));
  release();
  for (let tries = 0; tries < 100 && turn()?.status !== 'final'; tries += 1) await delay(10);
  assert.equal(turn()?.status, 'final');
  const final = frames.find((frame) => frame.type === 'message' && frame.status === 'final');
  assert.equal(final?.text, '');
  assert.deepEqual(final?.attachments, [attachment]);
  restart();
  assert.deepEqual(turn()?.attachments, [attachment]);
});

test('HTTP Runs 同一轮收到描述、Hermes 本地文件引用和真实图片', async (t) => {
  const { command, calls } = await harness(t);
  const submission_id = randomUUID();
  const result = await command({ kind: 'submit', body: { submission_id, text: '对比两份附件。', attachments: [
    { name: 'report.txt', mime: 'text/plain', size: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
    { name: 'pixel.png', mime: 'image/png', size: 68, sha256: '2ae67197d8706fbe5a6fdf6a46b7f6ba46a3a9568a905f7f1d2d10ee22cc3e36' },
  ] } }, submission_id);
  assert.equal(result?.status, 'ok');
  const staged = calls.find(({ path }) => path === '/api/chat/file-upload?profile=default');
  assert.match(String(staged?.body.raw), /name="file"; filename="report\.txt"\r\nContent-Type: text\/plain\r\n\r\nabc\r\n/);
  const input = calls.find(({ path }) => path === '/v1/runs')?.body.input as { role: string; content: JsonObject[] }[];
  assert.equal(input[0].role, 'user');
  assert.match(String(input[0].content[0].text), /对比两份附件。/);
  assert.match(String(input[0].content[0].text), /\/opt\/data\/uploads\/report.txt/);
  assert.deepEqual(input[0].content[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } });
});

test('附件摘要不匹配时停止提交', async (t) => {
  const { command, calls } = await harness(t);
  const submission_id = randomUUID();
  const result = await command({ kind: 'submit', body: { submission_id, text: '读取附件', attachments: [
    { name: 'report.txt', mime: 'text/plain', size: 3, sha256: '0'.repeat(64) },
  ] } }, submission_id);
  assert.equal(result?.status, 'error');
  assert.deepEqual(calls, []);
});

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

test('旧 HTTP 会话监听时同步 Hermes 已保存的标题', async (t) => {
  const { command, calls, frames } = await harness(t);
  await command({ kind: 'watch', body: {} });
  assert.deepEqual(calls.map(({ path }) => path), ['/api/sessions/mobile_test']);
  const frame = frames.find(({ type }) => type === 'topic_title');
  assert.equal(frame?.title, 'Hermes 原生标题');
  assert.equal(frame?.session_id, 'mobile_test');
});

test('HTTP 聊天每轮提供当前会话投递目标，保留用户原始输入', async (t) => {
  for (const profile of ['default', 'work']) {
    const { command, calls, restart } = await harness(t, 'resolved', undefined, undefined, profile);
    for (const text of ['生成一份文件', '再生成一份']) {
      const submission_id = randomUUID();
      await command({ kind: 'submit', body: { submission_id, text } }, submission_id);
      const body = calls.filter((call) => call.path === '/v1/runs').at(-1)?.body;
      assert.equal(body?.input, text);
      assert.match(String(body?.instructions), /hermes_mobile:mobile_test/);
      assert.match(String(body?.instructions), /mobile-send --to/);
      assert.ok(String(body?.instructions).includes(`--profile "${profile}"`));
      assert.match(String(body?.instructions), /收件箱/);
      restart();
    }
  }
});

test('原版 Runs 技能接口出错时查询原版控制台技能目录', async (t) => {
  const { calls, skills } = await harness(t);
  assert.deepEqual(await skills(), { kind: 'skills', skills: [{ name: 'example', category: 'dev', description: '示例技能' }] });
  assert.deepEqual(calls.map(({ path }) => path), ['/v1/skills', '/api/skills?profile=default']);
});

test('HTTP 模式的模型选择器返回已配置的服务商目录，并在重启后保留选择', async (t) => {
  const { command, calls, restart, status } = await harness(t);
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
  assert.deepEqual(await status(), { kind: 'status', status: { activity: 'idle', model: 'local-model' } });
  const id = randomUUID();
  await command({ kind: 'submit', body: { submission_id: id, text: '你好' } }, id);
  const body = calls.find((call) => call.path === '/v1/runs')?.body;
  assert.deepEqual(body && { ...body, instructions: undefined }, {
    session_id: 'mobile_test', input: '你好', ...selection,
    instructions: undefined,
  });
  assert.equal(calls.some((call) => call.path.startsWith('/api/model/set')), false);
});

test('Global 模型选择只保存当前 profile 默认值，重复请求不会重复写入', async (t) => {
  const { command, calls, restart } = await harness(t, 'resolved', undefined, undefined, 'work');
  const selection = { provider: 'custom:local', model: 'local-model', global: true };
  const id = randomUUID();
  const payload = { kind: 'select_model' as const, body: selection };
  assert.deepEqual((await command(payload, id))?.model_result,
    { type: 'selected', selection: { provider: selection.provider, model: selection.model }, global: true });
  restart();
  assert.equal((await command(payload, id))?.status, 'ok');
  assert.deepEqual(calls.filter((call) => call.path.startsWith('/api/model/set')), [{
    path: '/api/model/set?profile=work', body: { scope: 'main', provider: 'custom:local', model: 'local-model' },
  }]);
  assert.equal(((await command({ kind: 'model_options', body: {} }))?.model_result as JsonObject)?.type, 'catalog');
  const submission_id = randomUUID();
  await command({ kind: 'submit', body: { submission_id, text: '继续' } }, submission_id);
  assert.equal(calls.find((call) => call.path === '/v1/runs')?.body.model, 'local-model');
});

test('Global 模型写入需要风险确认，凭证绑定选择且不能复用', async (t) => {
  const { command, calls, modelWrite } = await harness(t, 'resolved', undefined, undefined, 'work');
  modelWrite(200, true);
  const selection = { provider: 'custom:local', model: 'local-model', global: true };
  const prompt = (await command({ kind: 'select_model', body: selection }))?.model_result as JsonObject;
  assert.equal(prompt.type, 'confirmation');
  assert.match(String(prompt.confirm), /^[a-f0-9]{64}$/);
  assert.equal((await command({ kind: 'select_model', body: { ...selection, model: 'default-model', provider: 'nous', confirm: prompt.confirm } }))?.status, 'error');
  assert.equal((await command({ kind: 'select_model', body: { ...selection, global: false, confirm: prompt.confirm } }))?.status, 'error');
  assert.equal((await command({ kind: 'select_model', body: { ...selection, confirm: prompt.confirm } }))?.status, 'ok');
  assert.equal((await command({ kind: 'select_model', body: { ...selection, confirm: prompt.confirm } }))?.status, 'error');
  assert.deepEqual(calls.filter((call) => call.path.startsWith('/api/model/set')).map((call) => call.body.confirm_expensive_model), [undefined, true]);
});

test('Global 写入失败不能报告成功或改变会话模型，global 只接受布尔值', async (t) => {
  const { command, modelWrite } = await harness(t);
  for (const global of ['true', 1, null]) {
    await assert.rejects(command({ kind: 'select_model', body: { provider: 'nous', model: 'default-model', global } }));
  }
  modelWrite(503);
  const failed = await command({ kind: 'select_model', body: { provider: 'custom:local', model: 'local-model', global: true } });
  assert.equal(failed?.status, 'unknown');
  assert.equal(failed?.model_result, undefined);
  const catalog = (await command({ kind: 'model_options', body: {} }))?.model_result as JsonObject;
  assert.equal((catalog.catalog as JsonObject).model, 'default-model');
});

test('Global 确认在重启后失效，缺少控制台配置时不写入或切换模型', async (t) => {
  const { command, calls, modelWrite, restart } = await harness(t);
  modelWrite(200, true);
  const selection = { provider: 'custom:local', model: 'local-model', global: true };
  const prompt = (await command({ kind: 'select_model', body: selection }))?.model_result as JsonObject;
  restart();
  assert.equal((await command({ kind: 'select_model', body: { ...selection, confirm: prompt.confirm } }))?.status, 'error');
  restart(false);
  assert.equal((await command({ kind: 'select_model', body: selection }))?.status, 'error');
  assert.equal(calls.filter((call) => call.path.startsWith('/api/model/set')).length, 1);
  const catalog = (await command({ kind: 'model_options', body: {} }))?.model_result as JsonObject;
  assert.equal((catalog.catalog as JsonObject).model, 'default-model');
});

test('HTTP Runs 保留话题的思考强度，恢复默认后不再覆盖 Hermes 配置', async (t) => {
  const { command, calls, restart, status } = await harness(t);
  assert.equal((await command({ kind: 'select_reasoning', body: { effort: 'high' } }))?.status, 'ok');
  restart();
  assert.deepEqual(await status(), { kind: 'status', status: { activity: 'idle', reasoning_effort: 'high' } });
  const highId = randomUUID();
  await command({ kind: 'submit', body: { submission_id: highId, text: '使用高强度' } }, highId);
  assert.deepEqual(calls.find((call) => call.path === '/v1/runs')?.body.model_options, { reasoning_effort: 'high' });

  assert.equal((await command({ kind: 'select_reasoning', body: { effort: null } }))?.status, 'ok');
  const reset = await status();
  assert(reset.kind === 'status');
  assert.equal(reset.status.reasoning_effort, undefined);
  const defaultId = randomUUID();
  await command({ kind: 'submit', body: { submission_id: defaultId, text: '使用档案默认值' } }, defaultId);
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
  const connector = new CanonicalConnector('unused', spool, () => {}, async () => { throw new Error('意外的附件下载'); });
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

  const modelId = randomUUID();
  await connector.command({ ...command, command_id: modelId, kind: 'select_model',
    body: { provider: 'nous', model: 'example', global: true } }, () => true);
  const modelResult = JSON.parse(spool.command(modelId)!.result!);
  assert.equal(modelResult.status, 'error');
  assert.match(modelResult.error, /HTTP Runs/);
  assert.equal(mutations.length, 1);

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
  const completed = frames.findIndex((frame) => frame.type === 'submission' && frame.status === 'final');
  assert(completed > frames.indexOf(finalReply()!), '应先投影最终回复，再同步提交状态');
});
