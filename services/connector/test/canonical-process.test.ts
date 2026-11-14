import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { CanonicalConnector } from '../src/connector.js';
import type { JsonObject } from '../src/gateway.js';
import { Spool } from '../src/spool.js';

test('Canonical Gateway 在提交返回终态回执时仍保存已缓冲的过程', { timeout: 5000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-mobile-canonical-'));
  const spool = new Spool(join(dir, 'connector.sqlite'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const binary = join(dir, 'hermes');
  const connector = new CanonicalConnector(binary, spool, () => {});
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
  writeFileSync(binary, `#!/bin/sh\ncat <<'HERMES_ATTACH'\n${JSON.stringify(attach)}\nHERMES_ATTACH\n`, { mode: 0o700 });

  server.on('connection', (socket: WebSocket) => {
    const send = (frame: JsonObject) => socket.send(JSON.stringify({ jsonrpc: '2.0', ...frame }));
    send({ method: 'event', params: { type: 'gateway.ready', payload: { session_authority: true } } });
    socket.on('message', (raw) => {
      const { id, method } = JSON.parse(String(raw));
      const reply = (result: JsonObject) => send({ id, result });
      if (method === 'runtime.describe') reply({ ...endpoint, capabilities: ['durable-admission-v1', 'event-replay-v1'],
        session_create: { sources: ['tool'], parameters: ['source', 'request_id'] } });
      if (method === 'client.capabilities') reply({ server_requests: [] });
      if (method === 'session.create') reply({ session_id: sessionId, stored_session_id: sessionId, authority_epoch: 1,
        replay_epoch: 'epoch', last_sequence: 0, subscription_id: 'subscription', execution_generation: 0,
        revision: 0, running: false, prompts: [], pending: [] });
      if (method === 'config.get') reply({ value: '0' });
      if (method === 'config.set') reply({ value: '1' });
      if (method === 'prompt.submit') {
        const events: [string, JsonObject][] = [
          ['reasoning.delta', { text: '先检查。' }],
          ['tool.start', { tool_id: 'call-1', name: 'read_file', args: { path: 'private-path' } }],
          ['tool.complete', { tool_id: 'call-1', name: 'read_file', is_error: true }],
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
    body: { submission_id: submissionId, text: '检查' } }, () => true);
  const replies = spool.events(new Set([topicId]), new Set(), 50).map(({ body }) => body).filter(({ type }) => type === 'message');
  assert.equal(replies[0]?.text, '');
  assert.equal(replies.at(-1)?.status, 'final');
  assert.equal(replies.at(-1)?.text, '已检查。');
  assert.deepEqual(replies.at(-1)?.process, [
    { kind: 'reasoning', text: '先检查。' }, { kind: 'tool', id: 'call-1', name: 'read_file', status: 'failed' },
  ]);
});
