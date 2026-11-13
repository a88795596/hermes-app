import type { SessionStatus, Skill } from '@hermes-mobile/protocol';
import { integer, object, string } from './gateway.js';
import type { Turn } from './spool.js';
import { boundedText } from './wire.js';

export const queryTimeout = 8_000;

export class QueryUnavailable extends Error {}

export function skillList(value: unknown): Skill[] {
  if (!Array.isArray(value)) throw new Error('Invalid Hermes skill list');
  return value.map((raw) => {
    const item = object(raw);
    const name = string(item?.name);
    if (!name?.trim() || name.includes('\0') || Buffer.byteLength(name) > 1024 || Buffer.from(name).toString() !== name) {
      throw new Error('Invalid Hermes skill name');
    }
    const description = string(item?.description);
    const category = string(item?.category);
    return {
      name,
      ...(description && { description: boundedText(description, 8192) }),
      ...(category && { category: boundedText(category, 1024) }),
    };
  });
}

export function sessionStatus(value: unknown, turns: Turn[]): SessionStatus {
  const item = object(value);
  if (!item) throw new Error('Invalid Hermes session status');
  const model = boundedText(string(item.model) ?? '', 512).trim();
  const count = integer(item.message_count);
  const activity = turns.some(({ status }) => status === 'streaming') ? 'running'
    : turns.some(({ status }) => status === 'queued') ? 'queued'
    : turns.length ? 'unknown' : 'idle';
  return {
    activity,
    ...(model && { model }),
    ...(count !== undefined && { message_count: count }),
  };
}
