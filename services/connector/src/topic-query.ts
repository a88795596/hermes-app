import type { SessionStatus, Skill } from '@hermes-mobile/protocol';
import { integer, object, string, type WebappAccess } from './gateway.js';
import type { Turn } from './spool.js';
import { boundedText } from './wire.js';

export const queryTimeout = 8_000;

export class QueryUnavailable extends Error {}

export function runtimeVersion(value: unknown): string {
  const version = boundedText(string(value) ?? '', 128).trim();
  if (!version) throw new QueryUnavailable();
  return version;
}

export function skillList(value: unknown): Skill[] {
  if (!Array.isArray(value)) throw new Error('Hermes 技能列表无效');
  return value.map((raw) => {
    const item = object(raw);
    const name = string(item?.name);
    if (!name?.trim() || name.includes('\0') || Buffer.byteLength(name) > 1024 || Buffer.from(name).toString() !== name) {
      throw new Error('Hermes 技能名称无效');
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

export async function webappSkills({ origin, token }: WebappAccess, profile: string, shutdown?: AbortSignal) {
  const url = new URL('/api/skills', origin);
  url.searchParams.set('profile', profile);
  const timeout = AbortSignal.timeout(queryTimeout);
  const response = await fetch(url, {
    headers: { authorization: 'Bearer ' + token }, redirect: 'error',
    signal: shutdown ? AbortSignal.any([shutdown, timeout]) : timeout,
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404 || response.status === 501) throw new QueryUnavailable();
    throw new Error('Hermes 拒绝了技能查询');
  }
  const skills = await response.json();
  if (!Array.isArray(skills)) throw new Error('Hermes 技能列表无效');
  return skillList(skills.filter((item: unknown) => object(item)?.enabled !== false));
}

export function sessionStatus(value: unknown, turns: Turn[]): SessionStatus {
  const item = object(value);
  if (!item) throw new Error('Hermes 会话状态无效');
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
