import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { CanonicalConnector } from '../src/connector.js';
import { Spool } from '../src/spool.js';

for (const [replay, external] of [[true, false], [false, false], [true, true]]) {
  test(`Canonical ${external ? '服务端' : replay ? '事件' : '回执'}附件在终态前持久化，并可在传输中断后恢复`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'hermes-output-'));
    const filename = join(directory, 'spool.sqlite');
    let spool = new Spool(filename);
    const topicId = randomUUID();
    const submissionId = randomUUID();
    const attachmentId = randomUUID();
    const sessionId = 'session-files';
    const admissionId = 'admission-files';
    const attachment = { attachment_id: attachmentId, name: 'report.md', mime: 'text/markdown', size: 3 };
    spool.begin(topicId, 'create');
    spool.finish(topicId, {}, { topicId, sessionId, profileId: 'default', profileRef: 'default' });
    spool.begin(submissionId, 'submit', { topicId, submissionId });
    spool.finish(submissionId, {}, undefined, { topicId, admissionId, submissionId: external ? null : submissionId, status: 'queued', text: '' });
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const endpoint = { profile_id: 'default', instance_id: 'test', authority_epoch: 1 };
    const binary = join(directory, 'hermes');
    writeFileSync(binary, `#!/bin/sh\ncat <<'END'\n${JSON.stringify({ endpoint, url: `ws://127.0.0.1:${address.port}/api/ws`, ticket: 'test',
      protocol: 'hermes-gateway-v1', protocols: ['hermes-gateway-v1', 'hermes-gateway-ticket.test'] })}\nEND\n`, { mode: 0o700 });
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { session_authority: true } } }));
      socket.on('message', (raw) => {
        const { id, method } = JSON.parse(String(raw));
        const result = method === 'runtime.describe' ? { ...endpoint, capabilities: ['durable-admission-v1', 'event-replay-v1'],
          session_create: { sources: ['tool'], parameters: ['source', 'request_id'] } }
          : method === 'client.capabilities' ? { server_requests: [] }
          : method === 'config.get' ? { value: '1' }
          : method === 'session.events.since' ? { snapshot_required: false, events: replay ? [{ type: 'message.complete',
            session_id: sessionId, replay_epoch: 'epoch', seq: 1, admission_id: admissionId,
            payload: { text: 'MEDIA:/report.md', outcome: 'completed' } }] : [] }
          : method === 'session.resume' ? { session_id: sessionId, stored_session_id: sessionId, authority_epoch: 1,
            replay_epoch: 'epoch', last_sequence: replay ? 1 : 0, subscription_id: 'subscription', execution_generation: 1,
            revision: 1, running: false, prompts: [], pending: [] }
          : { admission_id: admissionId, ref: { session_id: sessionId, profile_id: 'default' }, submission_id: submissionId,
            sequence: 1, status: 'terminal', outcome: 'completed', authority_epoch: 1, execution_generation: 1,
            result: { final_response: 'MEDIA:/report.md' } };
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
      });
    });
    let receiving = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let connector = new CanonicalConnector(binary, spool, () => {}, async () => Buffer.alloc(0),
      async () => { receiving = true; await gate; return { text: '', attachments: [attachment] }; });
    t.after(() => {
      connector.close();
      release();
      for (const socket of server.clients) socket.terminate();
      server.close();
      spool.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const watch = { type: 'command', command_id: randomUUID(), topic_id: topicId, profile_ref: 'default', session_id: sessionId,
      kind: 'watch', body: {} } as const;
    await connector.command(watch, () => true);
    assert.equal(receiving, true);
    assert.equal(spool.turn(topicId, admissionId)?.status, 'streaming');
    assert(!spool.events(new Set([topicId]), new Set(), 30).some(({ body }) => body.status === 'final'));
    connector.close();
    spool.close();
    spool = new Spool(filename);
    connector = new CanonicalConnector(binary, spool, () => {}, async () => Buffer.alloc(0),
      async () => ({ text: '', attachments: [attachment] }));
    await connector.command(watch, () => true);
    for (let tries = 0; tries < 100 && spool.turn(topicId, admissionId)?.status !== 'final'; tries += 1) await delay(10);
    assert.equal(spool.turn(topicId, admissionId)?.status, 'final');
    assert.deepEqual(spool.turn(topicId, admissionId)?.attachments, [attachment]);
    const final = spool.events(new Set([topicId]), new Set(), 30).map(({ body }) => body)
      .find((body) => body.type === 'message' && body.status === 'final');
    assert.equal(final?.text, '');
    assert.deepEqual(final?.attachments, [attachment]);
  });
}
