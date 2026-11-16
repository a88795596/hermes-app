import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Spool, type Binding } from '../src/spool.js';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'native-spool-'));
  const path = join(directory, 'spool.sqlite');
  let spool = new Spool(path);
  const binding: Binding = { topicId: randomUUID(), sessionId: 'mobile_before', profileId: 'work', profileRef: 'work' };
  spool.begin(binding.topicId, 'create');
  spool.finish(binding.topicId, {}, binding);
  t.after(() => { spool.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get spool() { return spool; }, binding, path,
    reopen: () => { spool.close(); spool = new Spool(path); },
    pending: (name = 'compress') => {
      const commandId = randomUUID();
      spool.begin(commandId, commandId);
      spool.beginNative({ commandId, name, binding });
      return commandId;
    } };
}

test('原生变更 fence 跨重启保留，绑定与最终回执同事务更新并保留选择', (t) => {
  const app = fixture(t);
  const selectionId = randomUUID();
  app.spool.begin(selectionId, selectionId);
  app.spool.finish(selectionId, {}, undefined, undefined, { topicId: app.binding.topicId, provider: 'openai', model: 'native-model' });
  const reasoningId = randomUUID();
  app.spool.begin(reasoningId, reasoningId);
  app.spool.finish(reasoningId, {}, undefined, undefined, { topicId: app.binding.topicId, effort: 'high' });
  const id = app.pending();
  const unknown = { type: 'command_result', command_id: id, status: 'unknown', error: '等待原生回执' };
  app.spool.finishNative(id, unknown);
  app.reopen();
  assert.equal(app.spool.nativePending(app.binding.topicId)[0].commandId, id);
  const final = { type: 'command_result', command_id: id, status: 'ok', native_result: { output: '已压缩', session_id: '20261116_continuation' } };
  app.spool.finishNative(id, final, '20261116_continuation');
  assert.equal(app.spool.binding(app.binding.topicId)?.sessionId, '20261116_continuation');
  assert.equal(app.spool.transport(app.binding.topicId), 'http');
  assert.deepEqual(JSON.parse(app.spool.command(id)!.result!), final);
  assert.deepEqual(app.spool.nativePending(), []);
  assert.deepEqual({ ...app.spool.modelSelection(app.binding.topicId) }, { provider: 'openai', model: 'native-model' });
  assert.equal(app.spool.reasoningEffort(app.binding.topicId), 'high');
  app.spool.ack(id, JSON.stringify(unknown));
  assert.deepEqual(app.spool.results(new Set(), 20).find((row) => row.id === id)?.body, final);
  app.spool.finishNative(id, unknown, 'mobile_before');
  assert.equal(app.spool.binding(app.binding.topicId)?.sessionId, '20261116_continuation');
  assert.deepEqual(JSON.parse(app.spool.command(id)!.result!), final);
  app.spool.ack(id, JSON.stringify(final));
  assert.equal(app.spool.results(new Set(), 20).some((row) => row.id === id), false);
});

test('升级原生 pending 表保留旧变更 fence，允许同话题多个普通请求恢复', (t) => {
  const app = fixture(t);
  const id = randomUUID();
  const legacy = new DatabaseSync(app.path);
  legacy.exec(`DROP TABLE native_pending;
    CREATE TABLE native_pending (command_id TEXT PRIMARY KEY, topic_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);`);
  legacy.prepare('INSERT INTO native_pending (command_id, topic_id, body) VALUES (?, ?, ?)')
    .run(id, app.binding.topicId, JSON.stringify({ commandId: id, name: 'compress', binding: app.binding }));
  legacy.close();
  app.reopen();
  assert.equal(app.spool.nativePending(app.binding.topicId)[0].commandId, id);
  for (const name of ['status', 'usage']) {
    const commandId = randomUUID();
    app.spool.begin(commandId, commandId);
    app.spool.beginNative({ commandId, name, binding: app.binding, mutating: false });
  }
  assert.equal(app.spool.nativeRequests(app.binding.topicId).length, 3);
  assert.equal(app.spool.nativePending(app.binding.topicId).length, 1);
});

test('续接冲突回滚绑定和回执，繁忙会话不能开始原生上下文变更', (t) => {
  const app = fixture(t);
  const other = { ...app.binding, topicId: randomUUID(), sessionId: 'occupied' };
  app.spool.begin(other.topicId, other.topicId);
  app.spool.finish(other.topicId, {}, other);
  const id = app.pending();
  assert.throws(() => app.spool.finishNative(id, { status: 'ok' }, 'occupied'));
  assert.equal(app.spool.command(id)?.result, null);
  assert.equal(app.spool.binding(app.binding.topicId)?.sessionId, 'mobile_before');
  assert.equal(app.spool.nativePending().length, 1);
  app.spool.finishNative(id, { status: 'error', error: '原生拒绝' });
  const run = randomUUID();
  app.spool.begin(run, run);
  app.spool.finish(run, {}, undefined, { topicId: app.binding.topicId, admissionId: 'run_busy',
    submissionId: randomUUID(), status: 'unknown', text: '' });
  assert.throws(() => app.pending('undo'), /等待当前会话任务/);
  assert.deepEqual(app.spool.nativePending(), []);
});
