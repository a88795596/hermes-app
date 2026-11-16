import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import type { Command } from '@hermes-mobile/protocol';
import { CanonicalConnector } from '../src/connector.js';
import type { JsonObject } from '../src/gateway.js';
import { createHttpConnector } from '../src/http-mode.js';
import { Spool } from '../src/spool.js';
import { bridgeFrame, commandDigest } from '../src/wire.js';

async function harness(t: TestContext, response: JsonObject | 'disconnect' = { status: 'queued' }) {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-steering-'));
  const spool = new Spool(join(dir, 'connector.sqlite'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const binary = join(dir, 'hermes');
  let connector = new CanonicalConnector(binary, spool, () => {}, async () => Buffer.from('abc'));
  t.after(() => {
    connector.close();
    for (const socket of server.clients) socket.terminate();
    server.close();
    spool.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const endpoint = { profile_id: 'default', instance_id: 'test', authority_epoch: 1 };
  const sessionId = 'session-steering';
  const topicId = randomUUID();
  const originalId = randomUUID();
  const admissionId = 'admission-original';
  const protocol = 'hermes-gateway-v1';
  const attach = { endpoint, url: `ws://127.0.0.1:${address.port}/api/ws`, ticket: 'test', protocol,
    protocols: [protocol, 'hermes-gateway-ticket.test'] };
  writeFileSync(binary, `#!/bin/sh\ncat <<'ATTACH'\n${JSON.stringify(attach)}\nATTACH\n`, { mode: 0o700 });
  const calls: { method: string; params: JsonObject }[] = [];
  const receipt = { admission_id: admissionId, ref: { session_id: sessionId, profile_id: 'default' },
    sequence: 1, status: 'started', outcome: null, authority_epoch: 1, execution_generation: 7 };
  const snapshot = { session_id: sessionId, stored_session_id: sessionId, authority_epoch: 1,
    replay_epoch: 'epoch', last_sequence: 0, subscription_id: 'subscription', execution_generation: 7,
    revision: 0, running: true, prompts: [], pending: [{ ...receipt, input_id: originalId, steering: false }] };
  server.on('connection', (socket) => {
    const send = (frame: JsonObject) => socket.send(JSON.stringify({ jsonrpc: '2.0', ...frame }));
    send({ method: 'event', params: { type: 'gateway.ready', payload: { session_authority: true } } });
    socket.on('message', (raw) => {
      const { id, method, params } = JSON.parse(String(raw));
      calls.push({ method, params });
      const reply = (result: JsonObject) => send({ id, result });
      if (method === 'runtime.describe') reply({ ...endpoint, capabilities: ['durable-admission-v1', 'event-replay-v1'],
        session_create: { sources: ['tool'], parameters: ['source', 'request_id'] } });
      if (method === 'client.capabilities') reply({ server_requests: [] });
      if (method === 'session.create') reply({ ...snapshot, running: false, pending: [], execution_generation: 0 });
      if (method === 'session.resume') reply(snapshot);
      if (method === 'config.get') reply({ value: '1' });
      if (method === 'file.attach') reply({ attached: true, ref_text: '@file:/report.txt' });
      if (method === 'prompt.submit') reply(params.submission_id === originalId ? receipt : {
        ...receipt, admission_id: `admission-${params.submission_id}`, status: 'queued', execution_generation: null,
      });
      if (method === 'session.steer') {
        if (response === 'disconnect') socket.terminate();
        else if (response.error) send({ id, error: response.error });
        else reply({ text: params.text, execution_generation: 7, authority_epoch: 1, ...response });
      }
    });
  });
  const base = { type: 'command', topic_id: topicId, profile_ref: 'default' } as const;
  await connector.command({ ...base, command_id: topicId, kind: 'create', body: { request_id: topicId } }, () => true);
  await connector.command({ ...base, session_id: sessionId, command_id: originalId, kind: 'submit',
    body: { submission_id: originalId, text: '检查项目' } }, () => true);
  calls.length = 0;
  const id = randomUUID();
  const command: Extract<Command, { kind: 'submit' }> = { ...base, session_id: sessionId, command_id: id, kind: 'submit',
    body: { submission_id: id, text: '也检查无障碍支持', steer_if_running: true } };
  const invoke = async () => {
    await connector.command(command, () => true);
    const result = spool.command(id)?.result;
    assert(result, 'steering must leave a durable result');
    return JSON.parse(result) as JsonObject;
  };
  return { calls, command, invoke, snapshot, spool, topicId, originalId, admissionId, id,
    restart: () => {
      connector.close();
      connector = new CanonicalConnector(binary, spool, () => {}, async () => Buffer.from('abc'));
    } };
}

test('submission wire validates the internal steering flag without changing replay identity', () => {
  const id = randomUUID();
  const frame = { type: 'command', command_id: id, topic_id: randomUUID(), profile_ref: 'default', session_id: 'session',
    kind: 'submit', body: { submission_id: id, text: '补充要求', steer_if_running: true } };
  assert.deepEqual(bridgeFrame(JSON.stringify(frame)), frame);
  for (const body of [
    { ...frame.body, submission_id: randomUUID() }, { ...frame.body, steer_if_running: false },
    { ...frame.body, steer_if_running: 'true' }, { ...frame.body, text: '  ' },
    { ...frame.body, text: '\u0000' }, { ...frame.body, text: 'a'.repeat(256 * 1024 + 1) },
  ]) assert.throws(() => bridgeFrame(JSON.stringify({ ...frame, body })));
  const automatic = bridgeFrame(JSON.stringify(frame));
  const legacy = bridgeFrame(JSON.stringify({ ...frame, body: { submission_id: id, text: '补充要求' } }));
  assert(automatic.type === 'command' && legacy.type === 'command');
  assert.equal(commandDigest(automatic), commandDigest(legacy));
  assert.notEqual(commandDigest(automatic), commandDigest({ ...legacy, kind: 'submit', body: { submission_id: id, text: '不同要求' } }));
  assert.throws(() => bridgeFrame(JSON.stringify({ ...frame, kind: 'steer' })));
});

test('steering uses the proven running generation and never creates another admission', { timeout: 5000 }, async (t) => {
  const { calls, command, invoke, spool, topicId, originalId, admissionId, id, restart } = await harness(t);
  assert.deepEqual(await invoke(), { type: 'command_result', command_id: id, status: 'ok', steering: true });
  assert.deepEqual(calls, [
    { method: 'session.resume', params: { session_id: 'session-steering', omit_messages: true } },
    { method: 'session.steer', params: { session_id: 'session-steering', text: '也检查无障碍支持', execution_generation: 7 } },
  ]);
  assert.equal(spool.hasIntent(topicId, id), false);
  assert.equal(spool.turn(topicId, admissionId)?.submissionId, originalId);
  assert.equal(spool.turn(topicId, admissionId)?.status, 'streaming');
  assert.equal((await invoke()).status, 'ok');
  assert.equal(calls.length, 2, 'a repeated command must not deliver the steer twice');
  restart();
  assert.equal((await invoke()).status, 'ok');
  assert.equal(calls.length, 2, 'a restarted connector must not deliver the steer twice');
  command.body.text = '改变同一命令的内容';
  await assert.rejects(invoke, /重复使用了命令 ID/);
});

test('idle, legacy-policy and attachment submissions retain ordinary admission', { timeout: 5000 }, async (t) => {
  for (const state of ['idle', 'legacy', 'attachment'] as const) {
    await t.test(state, async (t) => {
      const { invoke, snapshot, calls, command, spool, topicId, id, restart } = await harness(t);
      if (state === 'idle') snapshot.running = false;
      if (state === 'legacy') delete command.body.steer_if_running;
      if (state === 'attachment') command.body.attachments = [{ name: 'report.txt', mime: 'text/plain', size: 3,
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }];
      assert.deepEqual(await invoke(), { type: 'command_result', command_id: id, status: 'ok', admission_id: `admission-${id}` });
      assert.deepEqual(calls.map(({ method }) => method), state === 'idle' ? ['session.resume', 'prompt.submit']
        : state === 'attachment' ? ['file.attach', 'prompt.submit'] : ['prompt.submit']);
      assert.equal(spool.hasIntent(topicId, id), true);
      assert.equal(spool.turn(topicId, `admission-${id}`)?.submissionId, id);
      assert.equal(calls.at(-1)?.params.steer_if_running, undefined);
      if (state === 'legacy') {
        command.body.steer_if_running = true;
        restart();
        assert.equal((await invoke()).admission_id, `admission-${id}`);
        assert.equal(calls.length, 1, 'an upgraded parser must reuse the old spool result');
      }
    });
  }
});

test('running native sessions can accept guidance without a mobile-owned admission', { timeout: 5000 }, async (t) => {
  const { invoke, snapshot, calls } = await harness(t);
  snapshot.pending = [];
  assert.equal((await invoke()).steering, true);
  assert.deepEqual(calls.map(({ method }) => method), ['session.resume', 'session.steer']);
});

test('only proven non-delivery may fall back to ordinary admission', { timeout: 10000 }, async (t) => {
  const cases: { name: string; response: JsonObject | 'disconnect'; status: string; fallback?: boolean }[] = [
    { name: 'unsupported method', response: { error: { code: -32601, data: { reason: 'method_not_found' } } }, status: 'ok', fallback: true },
    { name: 'unsupported control', response: { error: { code: 4001, data: { reason: 'unsupported_control' } } }, status: 'ok', fallback: true },
    { name: 'generation ended at RPC', response: { error: { code: 4001, data: { reason: 'stale_generation' } } }, status: 'ok', fallback: true },
    { name: 'confirmed undelivered', response: { status: 'rejected', delivered: false }, status: 'ok', fallback: true },
    { name: 'permission denied', response: { error: { code: 4030, data: { reason: 'permission_denied' } } }, status: 'error' },
    { name: 'unconfirmed rejection', response: { status: 'rejected' }, status: 'unknown' },
    { name: 'wrong generation', response: { status: 'queued', execution_generation: 8 }, status: 'unknown' },
    { name: 'unmatched rejection', response: { status: 'rejected', delivered: false, execution_generation: 8 }, status: 'unknown' },
    { name: 'wrong authority', response: { status: 'queued', authority_epoch: 2 }, status: 'unknown' },
    { name: 'untyped generation', response: { status: 'queued', execution_generation: '7' }, status: 'unknown' },
    { name: 'contradictory delivery', response: { status: 'queued', delivered: false }, status: 'unknown' },
    { name: 'wrong text', response: { status: 'queued', text: '另一条消息' }, status: 'unknown' },
    { name: 'lost acknowledgment', response: 'disconnect', status: 'unknown' },
  ];
  for (const { name, response, status, fallback } of cases) await t.test(name, async (t) => {
    const { invoke, calls, spool, topicId, id } = await harness(t, response);
    const reply = await invoke();
    assert.equal(reply.status, status);
    assert.equal(reply.steering, fallback ? undefined : true);
    assert.equal(reply.admission_id, fallback ? `admission-${id}` : undefined);
    assert.equal((await invoke()).status, status);
    assert.equal(calls.filter(({ method }) => method === 'session.steer').length, 1);
    assert.equal(calls.filter(({ method }) => method === 'prompt.submit').length, fallback ? 1 : 0);
    assert.equal(spool.hasIntent(topicId, id), !!fallback);
  });
});

test('legacy HTTP sessions ignore automatic steering policy and create an ordinary run', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-steering-legacy-'));
  const spool = new Spool(join(dir, 'connector.sqlite'));
  const topicId = randomUUID();
  spool.begin(topicId, 'create');
  spool.finish(topicId, {}, { topicId, sessionId: 'mobile_old', profileId: 'default', profileRef: 'default' });
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/p/default/api/platforms/hermes_mobile/events') res.end(JSON.stringify({ system_prompt: '' }));
    else if (req.method === 'POST') res.writeHead(202).end(JSON.stringify({ run_id: 'run_' + '1'.repeat(32) }));
    else res.end(JSON.stringify({ run_id: 'run_' + '1'.repeat(32), status: 'completed', output: 'done' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const connector = createHttpConnector({ url: `http://127.0.0.1:${address.port}`, token: 'test', spool, send: () => {},
    downloadAttachment: async () => { throw new Error('Unexpected attachment'); } });
  t.after(() => { connector.close(); server.close(); server.closeAllConnections(); spool.close(); rmSync(dir, { recursive: true, force: true }); });
  const id = randomUUID();
  await connector.command({ type: 'command', command_id: id, topic_id: topicId, profile_ref: 'default', session_id: 'mobile_old',
    kind: 'submit', body: { submission_id: id, text: '补充', steer_if_running: true } }, () => true);
  const result = JSON.parse(spool.command(id)!.result!);
  assert.equal(result.status, 'ok');
  assert.equal(result.steering, undefined);
  assert.equal(result.admission_id, 'run_' + '1'.repeat(32));
  assert.deepEqual(calls.filter((call) => call.startsWith('POST')),
    ['POST /p/default/api/platforms/hermes_mobile/events', 'POST /p/default/v1/runs']);
});
