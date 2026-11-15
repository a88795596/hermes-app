import { createHash } from 'node:crypto';
import type { AttachmentReference, BridgeFrame, Command, CommandResult } from '@hermes-mobile/protocol';
import { isAttachmentMime, isAttachmentName, isManagementOperation, isReasoningEffort, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES, MAX_CONTROL_ANSWER_BYTES } from '@hermes-mobile/protocol';
import { object } from './gateway.js';

export function stableId(parts: string[]): string {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function commandDigest(command: Command): string {
  return createHash('sha256').update(JSON.stringify([
    command.topic_id, command.profile_ref, command.session_id, command.kind,
    Object.entries(command.body).filter(([key]) => command.kind !== 'submit' || key !== 'steer_if_running')
      .sort(([a], [b]) => a.localeCompare(b)),
  ])).digest('hex');
}

export function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
}

export function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === 'string' && (empty || !!value.trim()) && !value.includes('\u0000')
    && Buffer.byteLength(value) <= max && Buffer.from(value).toString() === value;
}

function attachmentReferences(value: unknown): AttachmentReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.length || value.length > MAX_ATTACHMENTS) throw new Error('BFF 附件清单无效');
  let total = 0;
  return value.map((raw: unknown) => {
    const item = object(raw);
    const { name, mime, size, sha256 } = item ?? {};
    if (!item || Object.keys(item).length !== 4 || !text(name, 200) || !isAttachmentName(name) || typeof mime !== 'string'
      || !isAttachmentMime(mime) || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1
      || size > MAX_ATTACHMENT_BYTES || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new Error('BFF 附件清单无效');
    }
    total += size;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error('BFF 附件总大小超出限制');
    return { name, mime, size, sha256 };
  });
}

export function bridgeFrame(source: string): BridgeFrame {
  const frame = object(JSON.parse(source));
  if (frame?.type === 'ack' && uuid(frame.id)) return { type: 'ack', id: frame.id };
  if (frame?.type === 'topic_query' && uuid(frame.request_id) && uuid(frame.topic_id)
    && typeof frame.profile_ref === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(frame.profile_ref)
    && text(frame.session_id, 512) && (frame.kind === 'skills' || frame.kind === 'status' || frame.kind === 'version')) {
    const { type, request_id, topic_id, profile_ref, session_id, kind } = frame;
    return { type, request_id, topic_id, profile_ref, session_id, kind };
  }
  if (frame?.type === 'management_request') {
    const { type, request_id, profile_ref, operation } = frame;
    const input = object(frame.input);
    if (!uuid(request_id) || typeof profile_ref !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(profile_ref)
      || profile_ref === 'all' || profile_ref === 'current' || !isManagementOperation(operation) || !input) {
      throw new Error('BFF 管理请求无效');
    }
    return { type, request_id, profile_ref, operation, input };
  }
  if (frame?.type !== 'command' || !uuid(frame.command_id) || !uuid(frame.topic_id)
    || typeof frame.profile_ref !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(frame.profile_ref)) {
    throw new Error('BFF 命令报文无效');
  }
  const { command_id, topic_id, profile_ref } = frame;
  const base = { type: 'command' as const, command_id, topic_id, profile_ref };
  const body = object(frame.body);
  if (frame.kind === 'create' && topic_id === command_id && body?.request_id === command_id && frame.session_id === undefined) {
    return { ...base, kind: 'create', body: { request_id: command_id } };
  }
  if (!body || !text(frame.session_id, 512)) throw new Error('BFF 命令的会话信息无效');
  const session_id = frame.session_id;
  switch (frame.kind) {
    case 'watch':
      return { ...base, session_id, kind: 'watch', body: {} };
    case 'model_options':
      if (!Object.keys(body).length) return { ...base, session_id, kind: 'model_options', body: {} };
      break;
    case 'select_model':
      if (text(body.provider, 256) && text(body.model, 512) &&
        (body.global === undefined || typeof body.global === 'boolean') &&
        (body.confirm === undefined || (typeof body.confirm === 'string' && /^[a-f0-9]{64}$/.test(body.confirm)))) {
        return { ...base, session_id, kind: 'select_model', body: {
          provider: body.provider, model: body.model, ...(body.confirm === undefined ? {} : { confirm: body.confirm }),
          ...(body.global === undefined ? {} : { global: body.global }),
        } };
      }
      break;
    case 'select_reasoning':
      if (body.effort === null || isReasoningEffort(body.effort)) {
        return { ...base, session_id, kind: 'select_reasoning', body: { effort: body.effort } };
      }
      break;
    case 'submit': {
      const attachments = attachmentReferences(body.attachments);
      if (body.submission_id === command_id && text(body.text, 256 * 1024, attachments.length > 0)
        && (body.steer_if_running === undefined || body.steer_if_running === true)) {
        return { ...base, session_id, kind: 'submit', body: {
          submission_id: command_id, text: body.text, ...(attachments.length && { attachments }),
          ...(body.steer_if_running === true && { steer_if_running: true }),
        } };
      }
      break;
    }
    case 'interrupt':
      if (uuid(body.submission_id)) {
        return { ...base, session_id, kind: 'interrupt', body: { submission_id: body.submission_id } };
      }
      break;
    case 'respond':
      if (body.response_id === command_id && uuid(body.control_id) && text(body.answer, MAX_CONTROL_ANSWER_BYTES, true)) {
        return { ...base, session_id, kind: 'respond', body: {
          control_id: body.control_id, response_id: command_id, answer: body.answer,
        } };
      }
      break;
  }
  throw new Error('BFF 命令内容无效');
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
