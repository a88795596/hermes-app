import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { CanonicalConnector } from '../src/connector.js';
import type { JsonObject } from '../src/gateway.js';
import { Spool } from '../src/spool.js';

test('Canonical Gateway 在提交返回终态回执时仍保存已缓冲的过程', { timeout: 5000 }, async (t) => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLG0AAAAASUVORK5CYII=';
  const dir = mkdtempSync(join(tmpdir(), 'hermes-mobile-canonical-'));
  const spool = new Spool(join(dir, 'connector.sqlite'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const binary = join(dir, 'hermes');
  const connector = new CanonicalConnector(binary, spool, () => {}, async (_id, position) => Buffer.from(position === 1 ? png : 'YWJj', 'base64'));
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
  const sessionId = 'session-test';
  const topicId = randomUUID();
  const admissionId = 'admission-test';
  const submissionId = randomUUID();
  const protocol = 'hermes-gateway-v1';
  const attach = { endpoint, url: `ws://127.0.0.1:${address.port}/api/ws`, ticket: 'test', protocol,
    protocols: [protocol, 'hermes-gateway-ticket.test'] };
  const stageCalls: [string, JsonObject][] = [];
  let submitted: JsonObject | undefined;
  writeFileSync(binary, `#!/bin/sh\ncat <<'HERMES_ATTACH'\n${JSON.stringify(attach)}\nHERMES_ATTACH\n`, { mode: 0o700 });

  server.on('connection', (socket: WebSocket) => {
    const send = (frame: JsonObject) => socket.send(JSON.stringify({ jsonrpc: '2.0', ...frame }));
    send({ method: 'event', params: { type: 'gateway.ready', payload: { session_authority: true } } });
    socket.on('message', (raw) => {
      const { id, method, params } = JSON.parse(String(raw));
      const reply = (result: JsonObject) => send({ id, result });
      if (method === 'runtime.describe') reply({ ...endpoint, capabilities: ['durable-admission-v1', 'event-replay-v1'],
        session_create: { sources: ['tool'], parameters: ['source', 'request_id'] } });
      if (method === 'client.capabilities') reply({ server_requests: [] });
      if (method === 'session.create') reply({ session_id: sessionId, stored_session_id: sessionId, authority_epoch: 1,
        replay_epoch: 'epoch', last_sequence: 0, subscription_id: 'subscription', execution_generation: 0,
        revision: 0, running: false, prompts: [], pending: [] });
      if (method === 'session.events.since') reply({ events: [], snapshot_required: true });
      if (method === 'session.resume') reply({ session_id: sessionId, stored_session_id: sessionId, authority_epoch: 1,
        replay_epoch: 'new-epoch', last_sequence: 0, subscription_id: 'subscription', execution_generation: 0,
        revision: 0, running: false, prompts: [], pending: [], info: { title: '断线期间的原生标题' } });
      if (method === 'config.get') reply({ value: '0' });
      if (method === 'config.set') reply({ value: '1' });
      if (method === 'image.attach_bytes') {
        stageCalls.push([method, params]);
        reply({ attached: true, path: '/hermes/cache/images/upload.png', mime: 'image/png' });
      }
      if (method === 'file.attach') {
        stageCalls.push([method, params]);
        reply({ attached: true, path: '/hermes/attachments/report.txt', ref_text: '@file:/hermes/attachments/report.txt' });
      }
      if (method === 'prompt.submit') {
        submitted = params;
        const events: [string, JsonObject][] = [
          ['session.info', { title: 'Hermes 原生标题' }],
          ['reasoning.delta', { text: '先检查。 Authorization: Bearer abc123' }],
          ['reasoning.delta', { text: '456789012345678901' }],
          ['message.interim', { text: '正在读取附件。', already_streamed: false }],
          ['tool.start', { tool_id: 'call-1', name: 'read_file', args: { path: 'private-path' } }],
          ['tool.complete', { tool_id: 'call-1', name: 'read_file', is_error: true }],
          ['message.delta', { text: '正在重新', segment: 1, offset: 0 }],
          ['message.delta', { text: '读取附件。', segment: 1, offset: 4 }],
          ['message.delta', { text: null }],
          ['tool.start', { tool_id: 'call-2', name: 'read_file' }],
          ['tool.complete', { tool_id: 'call-2', name: 'read_file', is_error: false }],
          ['message.complete', { text: '', outcome: 'completed' }],
        ];
        events.forEach(([type, payload], index) => send({ method: 'event', params: {
          type, payload, session_id: sessionId, replay_epoch: 'epoch', seq: index + 1, admission_id: admissionId,
        } }));
        reply({ admission_id: admissionId, ref: { session_id: sessionId, profile_id: 'default' },
          sequence: 1, status: 'terminal', outcome: 'completed', authority_epoch: 1, execution_generation: 1,
          result: { final_response: '已检查。' } });
      }
    });
  });

  const base = { type: 'command', topic_id: topicId, profile_ref: 'default' } as const;
  await connector.command({ ...base, command_id: topicId, kind: 'create', body: { request_id: topicId } }, () => true);
  await connector.command({ ...base, command_id: submissionId, session_id: sessionId, kind: 'submit',
    body: { submission_id: submissionId, text: '检查', attachments: [
      { name: 'pixel.png', mime: 'image/png', size: 68, sha256: '2ae67197d8706fbe5a6fdf6a46b7f6ba46a3a9568a905f7f1d2d10ee22cc3e36' },
      { name: 'report.txt', mime: 'text/plain', size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
    ] } }, () => true);
  assert.deepEqual(stageCalls, [
    ['image.attach_bytes', { session_id: sessionId, filename: 'pixel.png', content_base64: png }],
    ['file.attach', { session_id: sessionId, name: 'report.txt', data_url: 'data:text/plain;base64,YWJj' }],
  ]);
  assert.match(String(submitted?.text), /检查/);
  assert.match(String(submitted?.text), /@file:\/hermes\/attachments\/report.txt/);
  assert.deepEqual(submitted?.attachments, [{ path: '/hermes/cache/images/upload.png', mime: 'image/png' }]);
  const frames = spool.events(new Set([topicId]), new Set(), 50).map(({ body }) => body);
  assert(!JSON.stringify(frames).includes('abc123'));
  assert.deepEqual(frames.filter(({ type }) => type === 'topic_title').map(({ session_id, title }) => ({ session_id, title })),
    [{ session_id: sessionId, title: 'Hermes 原生标题' }]);
  const replies = frames.filter(({ type }) => type === 'message');
  assert.equal(replies.at(-1)?.status, 'final');
  assert.equal(replies.at(-1)?.text, '已检查。');
  assert.deepEqual(replies.at(-1)?.process, [
    { kind: 'reasoning', text: '先检查。 Authorization: Bearer [已隐藏]' }, { kind: 'commentary', text: '正在读取附件。' },
    { kind: 'tool', id: 'call-1', name: 'read_file', status: 'failed' },
    { kind: 'commentary', text: '正在重新读取附件。' },
    { kind: 'tool', id: 'call-2', name: 'read_file', status: 'succeeded' },
  ]);
  const resumed = new CanonicalConnector(binary, spool, () => {}, async () => { throw new Error('意外的附件下载'); });
  t.after(() => resumed.close());
  await resumed.command({ ...base, command_id: randomUUID(), session_id: sessionId, kind: 'watch', body: {} }, () => true);
  const titles = spool.events(new Set([topicId]), new Set(), 50).map(({ body }) => body).filter(({ type }) => type === 'topic_title');
  assert.equal(titles.at(-1)?.title, '断线期间的原生标题');
  const webapp = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer dashboard-key');
    if (req.method === 'POST' && req.url === '/api/webapp/socket-ticket?socket=gateway&profile=default') {
      res.end(JSON.stringify({ ticket: attach.ticket }));
    } else if (req.method === 'GET' && req.url === '/api/skills?profile=default') {
      res.end(JSON.stringify([
        { name: 'report', description: '处理报告', category: 'work', enabled: true },
        { name: 'disabled', enabled: false },
      ]));
    } else {
      res.writeHead(404).end();
    }
  });
  webapp.on('upgrade', (req, socket, head) => {
    server.handleUpgrade(req, socket, head, (peer) => server.emit('connection', peer, req));
  });
  await new Promise<void>((resolve) => webapp.listen(0, '127.0.0.1', resolve));
  const webappAddress = webapp.address();
  assert(webappAddress && typeof webappAddress !== 'string');
  const remote = new CanonicalConnector({ origin: 'http://127.0.0.1:' + webappAddress.port, token: 'dashboard-key' },
    spool, () => {}, async () => { throw new Error('意外的附件下载'); });
  t.after(() => { remote.close(); webapp.close(); webapp.closeAllConnections(); });
  assert.deepEqual(await remote.query({ type: 'topic_query', kind: 'skills', topic_id: topicId,
    session_id: sessionId, profile_ref: 'default', request_id: randomUUID() }),
  { kind: 'skills', skills: [{ name: 'report', description: '处理报告', category: 'work' }] });
});
