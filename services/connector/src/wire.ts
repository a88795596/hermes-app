import { createHash } from 'node:crypto';
import type { BridgeFrame, Command, CommandResult } from '@hermes-mobile/protocol';
import { object } from './gateway.js';

export function stableId(parts: string[]): string {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function commandDigest(command: Command): string {
  return createHash('sha256').update(JSON.stringify([
    command.topic_id, command.profile_ref, command.session_id, command.kind,
    Object.entries(command.body).sort(([a], [b]) => a.localeCompare(b)),
  ])).digest('hex');
}

export function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
}

function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === 'string' && (empty || !!value.trim()) && !value.includes('\u0000')
    && Buffer.byteLength(value) <= max && Buffer.from(value).toString() === value;
}

export function bridgeFrame(source: string): BridgeFrame {
  const frame = object(JSON.parse(source));
  if (frame?.type === 'ack' && uuid(frame.id)) return { type: 'ack', id: frame.id };
  if (frame?.type !== 'command' || !uuid(frame.command_id) || !uuid(frame.topic_id)
    || typeof frame.profile_ref !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(frame.profile_ref)) {
    throw new Error('Invalid BFF command envelope');
  }
  const { command_id, topic_id, profile_ref } = frame;
  const base = { type: 'command' as const, command_id, topic_id, profile_ref };
  const body = object(frame.body);
  if (frame.kind === 'create' && topic_id === command_id && body?.request_id === command_id && frame.session_id === undefined) {
    return { ...base, kind: 'create', body: { request_id: command_id } };
  }
  if (!body || !text(frame.session_id, 512)) throw new Error('Invalid BFF command session');
  const session_id = frame.session_id;
  switch (frame.kind) {
    case 'watch':
      return { ...base, session_id, kind: 'watch', body: {} };
    case 'submit':
      if (body.submission_id === command_id && text(body.text, 256 * 1024)) {
        return { ...base, session_id, kind: 'submit', body: { submission_id: command_id, text: body.text } };
      }
      break;
    case 'interrupt':
      if (uuid(body.submission_id)) {
        return { ...base, session_id, kind: 'interrupt', body: { submission_id: body.submission_id } };
      }
      break;
    case 'respond':
      if (body.response_id === command_id && uuid(body.control_id) && text(body.answer, 256 * 1024, true)) {
        return { ...base, session_id, kind: 'respond', body: {
          control_id: body.control_id, response_id: command_id, answer: body.answer,
        } };
      }
      break;
  }
  throw new Error('Invalid BFF command body');
}

export function result(id: string, status: CommandResult['status'], fields: Partial<CommandResult> = {}): CommandResult {
  return { ...fields, type: 'command_result', command_id: id, status };
}

export function boundedText(value: string, max: number): string {
  const bytes = Buffer.from(value.replaceAll('\u0000', ''));
  if (bytes.length <= max) return bytes.toString();
  let end = max;
  while ((bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString();
}
