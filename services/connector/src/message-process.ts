import { MAX_MESSAGE_PROCESS_STEPS, MAX_MESSAGE_PROCESS_TEXT_BYTES } from '@hermes-mobile/protocol';
import type { MessageProcessStep } from '@hermes-mobile/protocol';
import { boundedText, text } from './wire.js';

export function addProcessText(steps: MessageProcessStep[] | undefined, kind: 'reasoning' | 'commentary',
  value: unknown, delta = false): MessageProcessStep[] | undefined {
  if (typeof value !== 'string' || !value) return steps;
  const entries = steps ?? [];
  const last = entries.at(-1);
  if (delta && last?.kind === kind) {
    const text = boundedText(last.text + value, MAX_MESSAGE_PROCESS_TEXT_BYTES);
    return text === last.text ? steps : [...entries.slice(0, -1), { kind, text }];
  }
  // shortcut: 每条回复只保留前 64 个过程块，长流程需要更多历史时改为分页。
  if (entries.length === MAX_MESSAGE_PROCESS_STEPS) return steps;
  const text = boundedText(delta ? value : value.trim(), MAX_MESSAGE_PROCESS_TEXT_BYTES);
  if (!text || (!delta && last?.kind === kind && (last.text === text || last.text.startsWith(text)))) return steps;
  return [...entries, { kind, text }];
}

export function updateProcessTool(steps: MessageProcessStep[] | undefined, id: unknown, name: unknown,
  status: Extract<MessageProcessStep, { kind: 'tool' }>['status']): MessageProcessStep[] | undefined {
  if (!text(id, 512) || !text(name, 256)) return steps;
  const entries = steps ?? [];
  const index = entries.findIndex((step) => step.kind === 'tool' && step.id === id);
  const step = { kind: 'tool', id, name, status } as const;
  if (index === -1) return entries.length === MAX_MESSAGE_PROCESS_STEPS ? steps : [...entries, step];
  const previous = entries[index];
  if (previous.kind !== 'tool' || previous.status === status || status === 'running') return steps;
  return entries.map((entry, position) => position === index ? step : entry);
}

export function removeStreamedCommentary(answer: string, commentary: string): string {
  const suffix = commentary.trim();
  const streamed = answer.trimEnd();
  return suffix && streamed.endsWith(suffix) ? streamed.slice(0, -suffix.length).trimEnd() : answer;
}
