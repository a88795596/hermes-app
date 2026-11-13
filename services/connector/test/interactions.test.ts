import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { Command } from '@hermes-mobile/protocol';
import type { JsonObject } from '../src/gateway.js';
import { createHttpConnector } from '../src/http-mode.js';
import { Spool } from '../src/spool.js';

async function harness(t: TestContext, replyStatus = 'resolved') {
  const calls: { path: string; body: JsonObject }[] = [];
  const frames: JsonObject[] = [];
  const topicId = randomUUID();
  const sessionId = 'mobile_test';
  const runId = 'run_' + '1'.repeat(32);
  let pending = true;
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
          { slug: 'custom:local', name: 'Local', models: ['local-model'], api_url: 'http://private-endpoint' },
          { slug: 'unconfigured', name: 'Unconfigured', models: ['ignored'], authenticated: false },
        ],
      }));
    } else if (path === '/v1/runs') {
      res.statusCode = 202;
      res.end(JSON.stringify({ run_id: runId }));
    } else if (path === `/v1/runs/${runId}`) {
      res.end(JSON.stringify({ run_id: runId, status: pending ? 'running' : 'completed', output: 'Done',
        pending_controls: pending ? [{
          kind: 'clarify', prompt_id: 'ask', execution_generation: 3, question: 'Which environments?',
          choices: ['Staging', 'Production'], multi_select: true,
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
  return { calls, frames, restart, command };
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
      reject(new Error('Hermes question was not projected'));
    }, 2000);
  });
  const { control_id, choices, multi_select } = control;
  assert(typeof control_id === 'string');
  return { control_id, choices, multi_select };
}

test('HTTP model picker returns the configured provider catalog and remembers a selection across a restart', async (t) => {
  const { command, calls, restart } = await harness(t);
  assert.deepEqual((await command({ kind: 'model_options', body: {} }))?.model_result, {
    type: 'catalog',
    catalog: {
      provider: 'nous', model: 'default-model',
      providers: [
        { id: 'nous', name: 'Nous', models: ['default-model'] },
        { id: 'custom:local', name: 'Local', models: ['local-model'] },
      ],
    },
  });
  assert.equal((await command({ kind: 'select_model', body: { provider: 'nous', model: 'restricted' } }))?.status, 'error');
  const selection = { provider: 'custom:local', model: 'local-model' };
  assert.deepEqual((await command({ kind: 'select_model', body: selection }))?.model_result, { type: 'selected', selection });
  restart();
  const id = randomUUID();
  await command({ kind: 'submit', body: { submission_id: id, text: 'Hello' } }, id);
  assert.deepEqual(calls.find((call) => call.path === '/v1/runs')?.body, {
    session_id: 'mobile_test', input: 'Hello', ...selection,
  });
});

test('HTTP Runs projects a multiple-choice question and routes the answer to the waiting run', async (t) => {
  const { command, calls, frames } = await harness(t);
  const id = randomUUID();
  await command({ kind: 'submit', body: { submission_id: id, text: 'Ask me which environments to use' } }, id);
  const control = await waitForQuestion(frames);
  assert.equal(control.multi_select, true);
  assert.deepEqual(control.choices, ['Staging', 'Production']);
  const responseId = randomUUID();
  const answer = JSON.stringify(['Staging', 'Production']);
  const response = await command({ kind: 'respond', body: { control_id: control.control_id, response_id: responseId, answer } }, responseId);
  assert.equal(response?.control_status, 'closed');
  assert.deepEqual(calls.find((call) => call.path.endsWith('/clarify'))?.body, {
    request_id: 'ask', execution_generation: 3, answer,
  });
});

test('HTTP Runs closes an already-resolved question without acknowledging the submitted answer', async (t) => {
  const { command, frames } = await harness(t, 'already_resolved');
  const id = randomUUID();
  await command({ kind: 'submit', body: { submission_id: id, text: 'Ask me which environments to use' } }, id);
  const { control_id } = await waitForQuestion(frames);
  const responseId = randomUUID();
  const response = await command({ kind: 'respond', body: { control_id, response_id: responseId, answer: 'Staging' } }, responseId);
  assert.equal(response?.control_status, 'closed');
  assert.equal(response.status, 'error');
});
