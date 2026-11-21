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

export function contextUsage(value: unknown, model?: string, window?: unknown): SessionStatus['context_usage'] {
  const usage = object(value);
  const usageModel = string(usage?.model)?.trim();
  if (!usage || (model && usageModel && model !== usageModel)) return;
  const reportedMax = integer(usage.context_max);
  const max = reportedMax || integer(window) || undefined;
  const reportedUsed = integer(usage.context_used);
  // Agentless context breakdowns can have zeroed header fields and a real transcript estimate.
  const estimate = !reportedMax && !reportedUsed ? integer(usage.estimated_total) : undefined;
  const used = estimate || reportedUsed;
  if (used === undefined || (!used && !max) || (max !== undefined && used > max)) return;
  return { used, ...(max && { max }), ...((estimate || usage.context_estimated === true) && { estimated: true }) };
}

export function sessionStatus(value: unknown, turns: Turn[], subagents: unknown[] = [], includeContext = false): SessionStatus {
  const item = object(value);
  if (!item || (item.running !== undefined && typeof item.running !== 'boolean')) throw new Error('Hermes 会话状态无效');
  const model = boundedText(string(item.model)?.trim() || string(object(item.usage)?.model)?.trim() || '', 512);
  const count = integer(item.message_count);
  const context = includeContext ? contextUsage(item.usage, model, item.context_length) : undefined;
  const children = subagents.map((value) => {
    const status = string(object(value)?.status);
    if (!status || !['queued', 'running', 'completed', 'failed', 'error', 'timeout', 'interrupted'].includes(status)) {
      throw new Error('Hermes 子任务状态无效');
    }
    return status;
  });
  const activity = item.running === true || children.some((status) => status === 'running' || status === 'queued') ? 'running'
    : item.running !== false && turns.some(({ status }) => status === 'streaming') ? 'running'
    : turns.some(({ status }) => status === 'queued') ? 'queued'
    : item.running === false || !turns.length ? 'idle' : 'unknown';
  return {
    activity,
    ...(model && { model }),
    ...(count !== undefined && { message_count: count }),
    ...(context && { context_usage: context }),
  };
}
