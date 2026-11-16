import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { topicTitleEvent } from '../src/topic-title.js';

test('同步原生标题完整保留 100 个中文或四字节 Unicode 字符', () => {
  const binding = { topicId: randomUUID(), sessionId: 'mobile_title', profileRef: 'work', profileId: 'work' };
  for (const title of ['汉'.repeat(100), '🦉'.repeat(100)]) {
    const frame = topicTitleEvent(binding, title, ['native']);
    assert.equal(frame?.body.title, title);
  }
});
