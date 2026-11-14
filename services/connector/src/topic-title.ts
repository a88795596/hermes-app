import { MAX_TOPIC_TITLE_BYTES, type ConnectorEvent } from '@hermes-mobile/protocol';
import type { Binding } from './spool.js';
import { boundedText, stableId } from './wire.js';

export function topicTitleEvent({ topicId, sessionId }: Binding, value: unknown, key: string[]) {
  if (typeof value !== 'string') return;
  const title = boundedText(value.replace(/[\s\p{Cc}]+/gu, ' ').trim(), MAX_TOPIC_TITLE_BYTES).trimEnd();
  if (!title) return;
  const id = stableId([topicId, sessionId, 'title', ...key, title]);
  const body = { type: 'topic_title', topic_id: topicId, event_id: id, session_id: sessionId, title } satisfies ConnectorEvent;
  return { id, body };
}
