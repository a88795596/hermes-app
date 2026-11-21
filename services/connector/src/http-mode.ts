import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import type { Command, ConnectorEvent, Control, ModelSelection, NativeCommandResult, ReasoningEffort, TopicQuery, TopicQueryData } from '@hermes-mobile/protocol';
import { MAX_CLARIFY_CHOICE_BYTES, MAX_TOPIC_TITLE_BYTES } from '@hermes-mobile/protocol';
import { attachmentBytes, attachmentFilename, type DownloadAttachment, type ReceiveAttachments } from './attachments.js';
import { deliveryInstructions } from './delivery-context.js';
import { integer, object, string } from './gateway.js';
import type { JsonObject, WebappAccess } from './gateway.js';
import { addProcessText, removeStreamedCommentary, updateProcessTool } from './message-process.js';
import { hasModel, modelCatalog } from './models.js';
import { createNativeCommands, enableNativeCommands, NativeCommandFailure, nativeStatusOutput, nativeTitle, resolveNativeCommand, type NativeCommands } from './native-commands.js';
import type { createDashboardManagement } from './management.js';
import type { Binding, NativePending, Spool, Turn } from './spool.js';
import { QueryUnavailable, queryTimeout, runtimeVersion, sessionStatus, skillList, webappSkills } from './topic-query.js';
import { topicTitleEvent } from './topic-title.js';
import { boundedText, commandDigest, result, stableId, text } from './wire.js';

const unknown = 'Hermes 无法确认执行结果';
const runId = /^run_[a-f0-9]{32}$/;
const profileName = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function terminalStatus(status: unknown): 'final' | 'failed' | 'cancelled' | 'unknown' | undefined {
  switch (status) {
    case 'completed': return 'final';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'interrupted': return 'unknown';
  }
}

function httpId(...identity: unknown[]): string {
  return stableId(['hermes-http-runs', JSON.stringify(identity)]);
}

type Prompt = {
  id: string;
  generation?: number;
  control: Pick<Control, 'control_id' | 'kind' | 'prompt' | 'choices' | 'multi_select'>;
};

type RunState = { text: string; prompts: Prompt[] };
const emptyRun = JSON.stringify({ text: '', prompts: [] });

function pendingPrompts(id: string, run: JsonObject): Prompt[] {
  const canonical = Array.isArray(run.pending_controls);
  const records: unknown[] = canonical ? run.pending_controls as unknown[] : [run.approval];
  return records.flatMap((raw) => {
    const item = object(raw);
    if (!item) return [];
    const kind = canonical ? item.kind : 'approval';
    const requestId = string(canonical ? item.prompt_id : item.request_id);
    const generation = integer(item.execution_generation);
    if ((kind !== 'approval' && kind !== 'clarify') || !requestId || (canonical && generation === undefined)) return [];
    const prompt = kind === 'clarify' ? string(item.question) ?? '' : [string(item.description), string(item.command)].filter(Boolean).join('\n');
    const display = boundedText(prompt, 64 * 1024);
    if (!display.trim() || !Array.isArray(item.choices)) return [];
    // shortcut: 审批详情不完整时仅可拒绝，等能查看完整请求后再开放其他选项。
    const denyOnly = kind === 'approval' && (Object.hasOwn(item, 'edit') || display !== prompt);
    const maxChoice = kind === 'clarify' ? MAX_CLARIFY_CHOICE_BYTES : 1024;
    const choices = [...new Set(item.choices.filter((choice) => text(choice, maxChoice) && (!denyOnly || choice === 'deny')))].slice(0, 30);
    if (kind === 'approval' && !choices.length) return [];
    return [{ id: requestId, generation, control: {
      control_id: httpId(id, 'control', kind, requestId, generation), kind,
      prompt: display, choices, ...(kind === 'clarify' && item.multi_select === true ? { multi_select: true } : {}),
    } }];
  });
}

type Options = {
  url: string;
  token: string;
  send: (frame: JsonObject) => void;
  spool: Spool;
  downloadAttachment: DownloadAttachment;
  receiveAttachments?: ReceiveAttachments;
  webapp?: WebappAccess;
  manage?: ReturnType<typeof createDashboardManagement>;
  nativeCommands?: NativeCommands;
};

export function createHttpConnector({ url, token, send, spool, downloadAttachment, receiveAttachments, webapp, manage, nativeCommands }: Options) {
  const endpoint = URL.parse(url);
  if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol) ||
      !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password ||
      endpoint.pathname !== '/' || endpoint.search || endpoint.hash || !token.trim() || /[\r\n]/.test(token)) {
    throw new Error('Hermes HTTP 模式需要本机回环地址和 API 密钥');
  }
  const origin = endpoint.origin;
  const native = nativeCommands ?? createNativeCommands(origin, token);
  const shutdown = new AbortController();
  const watchers = new Map<string, AbortController>();
  const watcherTopics = new Map<string, string>();
  const nativeWatchers = new Set<string>();
  const topicQueues = new Map<string, Promise<void>>();
  const commands = new Set<string>();
  const modelConfirmations = new Map<string, { selection: string; expires: number }>();

  function request(profile: string, path: string, options: RequestInit = {}, timeoutMs = 15_000): Promise<Response> {
    return fetch(new URL(`/p/${encodeURIComponent(profile)}${path}`, origin), {
      ...options,
      redirect: 'error',
      headers: { authorization: `Bearer ${token}`, ...options.headers },
      signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])]),
    });
  }

  async function json(profile: string, path: string, body?: JsonObject, idempotencyKey?: string, timeoutMs?: number) {
    const response = await request(profile, path, body && {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: JSON.stringify(body),
    }, timeoutMs);
    return { response, data: object(await response.json().catch(() => undefined)) };
  }

  async function prepareInput(command: Extract<Command, { kind: 'submit' }>) {
    const { text: description, attachments } = command.body;
    const documents: string[] = [];
    const images: JsonObject[] = [];
    for (const [index, attachment] of (attachments ?? []).entries()) {
      const content = await attachmentBytes(downloadAttachment, command.command_id, index + 1, attachment);
      if (attachment.mime.startsWith('image/')) {
        images.push({ type: 'image_url', image_url: { url: `data:${attachment.mime};base64,${content.toString('base64')}` } });
      } else {
        if (!webapp) throw new QueryUnavailable();
        const form = new FormData();
        const bytes = Uint8Array.from(content);
        form.set('file', new Blob([bytes], { type: attachment.mime }), attachmentFilename(attachment.name));
        const url = new URL('/api/chat/file-upload', webapp.origin);
        url.searchParams.set('profile', command.profile_ref);
        const response = await fetch(url, { method: 'POST', body: form, redirect: 'error',
          headers: { authorization: 'Bearer ' + webapp.token },
          signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(20_000)]) });
        const data = object(await response.json().catch(() => undefined));
        const path = data?.path;
        if (!response.ok || data?.ok !== true || data.size !== attachment.size ||
          !text(path, 4096) || /[\p{Cc}]/u.test(path)) throw new Error('无法暂存文件');
        documents.push(`用户附上了文件 ${JSON.stringify(attachment.name)}，保存在 ${JSON.stringify(path)}。请使用文件工具读取或提取其内容。`);
      }
    }
    const prompt = [description, ...documents].filter((part) => part.trim()).join('\n\n') || '请查看上传的图片。';
    return images.length ? [{ role: 'user', content: [{ type: 'text', text: prompt }, ...images] }] : prompt;
  }

  async function query({ kind, topic_id, profile_ref, session_id, include_context, include_reasoning }: TopicQuery): Promise<TopicQueryData> {
    const binding = spool.binding(topic_id);
    if (!binding || binding.profileRef !== profile_ref || binding.sessionId !== session_id || spool.transport(topic_id) !== 'http') {
      throw new Error('无法验证 Hermes 会话绑定');
    }
    if (kind === 'commands') {
      return { kind, commands: enableNativeCommands(await native.catalog(profile_ref, shutdown.signal), ['status', 'title']) };
    }
    const path = kind === 'skills' ? '/v1/skills'
      : kind === 'version' ? '/v1/health'
      : `/api/sessions/${encodeURIComponent(session_id)}`;
    const response = await request(profile_ref, path, { signal: AbortSignal.timeout(queryTimeout) });
    if (!response.ok) {
      await response.body?.cancel();
      if (kind === 'skills' && webapp && [404, 500, 501].includes(response.status)) {
        return { kind, skills: await webappSkills(webapp, profile_ref, shutdown.signal) };
      }
      if (response.status === 404 || response.status === 501) throw new QueryUnavailable();
      throw new Error('Hermes 拒绝了查询');
    }
    const data = object(await response.json());
    if (kind === 'skills') return { kind, skills: skillList(data?.data) };
    if (kind === 'version') return { kind, version: runtimeVersion(data?.version) };
    const session = object(data?.session);
    if (session?.id !== session_id) throw new Error('Hermes 返回了意外的会话');
    const model = spool.modelSelection(topic_id)?.model ?? session.model;
    const status = sessionStatus({ ...session, model }, spool.activeTurns(topic_id), [], include_context);
    const effort = include_reasoning ? spool.reasoningEffort(topic_id) : undefined;
    if (effort) status.reasoning_effort = effort;
    return { kind, status };
  }

  async function syncTitle(binding: Binding) {
    const session = await json(binding.profileRef, `/api/sessions/${encodeURIComponent(binding.sessionId)}`)
      .then(({ response, data }) => response.ok ? object(data?.session) : undefined, () => undefined);
    if (session?.id !== binding.sessionId || shutdown.signal.aborted || spool.binding(binding.topicId)?.sessionId !== binding.sessionId) return;
    const event = topicTitleEvent(binding, session.title, [String(session.last_active ?? '')]);
    if (event) {
      spool.record(binding.topicId, [event]);
      send(event.body);
    }
  }

  function record(turn: Turn, bodies: JsonObject[], sequence?: number, gap = false) {
    const cursorKey = `http-run:${turn.admissionId}`;
    const frames = bodies.map((body) => {
      const id = httpId(turn.topicId, turn.admissionId, sequence, body);
      return { id, body: { ...body, event_id: id, topic_id: turn.topicId } };
    });
    spool.record(sequence === undefined ? turn.topicId : cursorKey, frames,
      sequence === undefined ? undefined : { epoch: gap ? 'gap' : 'http', sequence: String(sequence) }, turn);
    for (const frame of frames) send(frame.body);
  }

  function message(turn: Turn, status: 'streaming' | 'final', text: string): Omit<Extract<ConnectorEvent, { type: 'message' }>, 'topic_id' | 'event_id'> {
    return { type: 'message', message_id: httpId(turn.topicId, turn.admissionId, 'message'),
      ...(turn.submissionId ? { submission_id: turn.submissionId } : {}), status, text: text.trim() ? text : '',
      ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
      ...(turn.process?.length ? { process: turn.process } : {}) };
  }

  async function finishRun(binding: Binding, turn: Turn, state: NonNullable<ReturnType<typeof terminalStatus>>, output: unknown) {
    const saved = JSON.parse(turn.text) as RunState;
    const source = state === 'final' && typeof output === 'string' ? boundedText(output, 256 * 1024) : saved.text;
    const received = state === 'final' && receiveAttachments
      ? await receiveAttachments(binding.profileRef, turn.topicId, turn.admissionId, source) : { text: source };
    if (shutdown.signal.aborted) return;
    const { text, attachments } = received;
    const updated = { ...turn, status: state, attachments, text: JSON.stringify({ text, prompts: [] }) };
    const frames: JsonObject[] = saved.prompts.map(({ control }) => ({
      type: 'control', ...control, submission_id: turn.submissionId, status: state === 'unknown' ? 'unknown' : 'closed',
    }));
    if (text || saved.text || updated.process?.length || attachments?.length) frames.push(message(updated, 'final', text));
    const error = state === 'unknown' ? unknown : state === 'failed' ? 'Hermes 报告执行失败' : undefined;
    if (state !== turn.status || error) {
      frames.push({ type: 'submission', submission_id: turn.submissionId, status: state, ...(error ? { error } : {}) });
    }
    record(updated, frames);
  }

  async function stream(binding: Binding, id: string, signal: AbortSignal) {
    const path = `/v1/runs/${id}/events`;
    const cursor = spool.cursor(`http-run:${id}`);
    let sequence = cursor ? Number(cursor.sequence) : -1;
    let gap = cursor?.epoch === 'gap';
    const response = await request(binding.profileRef, path, {
      headers: { accept: 'text/event-stream', 'Last-Event-ID': String(sequence) }, signal,
    });
    if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
      await response.body?.cancel();
      return;
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || signal.aborted) return;
        buffer += value;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line.startsWith('data: ')) continue;
          const event = object(JSON.parse(line.slice(6)));
          if (event?.run_id !== id) continue;
          if (event.event === 'replay.truncated') gap = true;
          const next = integer(event.seq);
          if (next === undefined || next <= sequence) continue;
          // shortcut: Runs 流的回放缓冲区有容量限制，回放截断时从最终输出恢复文本。
          gap ||= next !== sequence + 1;
          sequence = next;
          const turn = spool.turn(binding.topicId, id);
          if (!turn || !['queued', 'streaming', 'unknown'].includes(turn.status)) return;
          if (typeof event.event === 'string' && event.event.startsWith('run.') && terminalStatus(event.event.slice(4))) {
            record(turn, [], sequence, gap);
            return;
          }
          const state = JSON.parse(turn.text) as RunState;
          let answer = state.text;
          let process = turn.process;
          if (event.event === 'message.delta' && typeof event.delta === 'string' && !gap) {
            answer = boundedText(answer + event.delta, 256 * 1024);
          } else if (event.event === 'message.interim' && typeof event.text === 'string') {
            process = addProcessText(process, 'commentary', event.text);
            if (event.already_streamed === true) answer = removeStreamedCommentary(answer, event.text);
          } else if (event.event === 'reasoning.available' || (event.event === 'reasoning.delta' && !gap)) {
            process = addProcessText(process, 'reasoning', event.text, event.event === 'reasoning.delta');
          } else if (event.event === 'tool.started' || event.event === 'tool.completed' || event.event === 'tool.failed') {
            const started = event.event === 'tool.started';
            let callId = string(event.tool_call_id);
            if (!callId) {
              // shortcut: 旧版 Runs 省略调用 ID 时按工具名匹配最早的待完成调用，升级后使用上游 ID。
              const pending = started ? undefined : process?.find((step) =>
                step.kind === 'tool' && step.name === event.tool && step.status === 'running');
              callId = pending?.kind === 'tool' ? pending.id : httpId(id, sequence, 'tool');
            }
            const status = started ? 'running' : event.event === 'tool.failed' || event.error === true ? 'failed'
              : event.error === false ? 'succeeded' : 'unknown';
            process = updateProcessTool(process, callId, event.tool, status);
          }
          const updated = { ...turn, process, text: JSON.stringify({ ...state, text: answer }) };
          const frames = answer !== state.text || process !== turn.process ? [message(updated, 'streaming', answer)] : [];
          record(updated, frames, sequence, gap);
        }
        if (buffer.length > 2 * 1024 * 1024) return;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  function watch(binding: Binding, initial: Turn) {
    const id = initial.admissionId;
    if (!runId.test(id) || watchers.has(id) || shutdown.signal.aborted) return;
    const controller = new AbortController();
    const { signal } = controller;
    watchers.set(id, controller);
    watcherTopics.set(id, binding.topicId);
    let reading: Promise<void> | undefined;
    let finishing = false;
    void (async () => {
      while (!signal.aborted && !finishing) {
        reading = stream(binding, id, signal).catch(() => undefined);
        await reading;
        reading = undefined;
        if (!finishing) await delay(1000, undefined, { signal });
      }
    })().catch(() => undefined);
    void (async () => {
      while (!signal.aborted) {
        const result = await json(binding.profileRef, `/v1/runs/${id}`).catch(() => undefined);
        if (signal.aborted) return;
        const turn = spool.turn(binding.topicId, id);
        if (!turn?.submissionId || ['final', 'failed', 'cancelled'].includes(turn.status)) return;
        const data = result?.data;
        const missingRun = result?.response.status === 404 && object(data?.error)?.code === 'run_not_found';
        if (data?.run_id === id || missingRun) {
          const status = data?.status;
          const frames: JsonObject[] = [];
          const finished = missingRun ? 'unknown' : terminalStatus(status);
          if (finished) {
            finishing = true;
            // GET 状态可能先于已排入 SSE 的过程事件到达。
            const drain = reading ?? (missingRun ? undefined : stream(binding, id, signal).catch(() => undefined));
            if (drain) await Promise.race([drain, delay(1500, undefined, { signal, ref: false })]);
            if (signal.aborted) return;
            const latest = spool.turn(binding.topicId, id);
            if (latest?.submissionId) await finishRun(binding, latest, finished, data?.output);
            if (finished === 'final') await syncTitle(binding);
            return;
          }
          const next = pendingPrompts(id, data ?? {});
          const state: Turn['status'] | undefined = status === 'queued' ? turn.status === 'streaming' ? 'streaming' : 'queued'
            : status === 'running' || status === 'waiting_for_approval' || status === 'stopping' ? 'streaming'
            : status === 'unknown' ? 'unknown' : undefined;
          if (state !== undefined) {
            const saved = JSON.parse(turn.text) as RunState;
            for (const prompt of saved.prompts) {
              if (!next.some(({ control }) => control.control_id === prompt.control.control_id)) {
                frames.push({ type: 'control', ...prompt.control, submission_id: turn.submissionId,
                  status: state === 'unknown' ? 'unknown' : 'closed' });
              }
            }
            for (const prompt of next) {
              if (saved.prompts.some(({ control }) => control.control_id === prompt.control.control_id)) continue;
              frames.push({ type: 'control', ...prompt.control, submission_id: turn.submissionId, status: 'pending' });
            }
            const updated = { ...turn, status: state, text: JSON.stringify({ ...saved, prompts: next }) };
            if (state !== turn.status) {
              const error = state === 'unknown' ? unknown : undefined;
              frames.push({ type: 'submission', submission_id: turn.submissionId, status: state, ...(error ? { error } : {}) });
            }
            if (frames.length) record(updated, frames);
          }
        }
        await delay(1500, undefined, { signal });
      }
    })().catch(() => undefined).finally(() => {
      controller.abort();
      watchers.delete(id);
      watcherTopics.delete(id);
    });
  }

  function validateNativeMutation(name: string, receipt: NativeCommandResult): void {
    const resetting = (name === 'new' || name === 'reset') && receipt.reset === true;
    if ((receipt.session_id !== undefined && name !== 'compress' && !resetting)
      || (receipt.rewound_turns !== undefined && name !== 'undo')
      || (receipt.title !== undefined && name !== 'title' && !resetting)
      || (receipt.reset !== undefined && !resetting)
      || (receipt.confirmation !== undefined && !['new', 'reset', 'undo'].includes(name))) {
      throw new NativeCommandFailure('Hermes 返回了与命令不匹配的会话变更回执。', 'unknown');
    }
  }

  async function stopForReset(binding: Binding): Promise<void> {
    const active = spool.activeTurns(binding.topicId);
    if (!active.length) return;
    for (const turn of active) {
      if (!runId.test(turn.admissionId)) throw new NativeCommandFailure('当前任务状态尚未确认，无法重置会话。');
      const { response, data } = await json(binding.profileRef, `/v1/runs/${turn.admissionId}/stop`, {});
      if (!response.ok || data?.run_id !== turn.admissionId) throw new NativeCommandFailure('无法确认当前回复已停止，尚未重置会话。');
    }
    const deadline = Date.now() + 15_000;
    while (spool.activeTurns(binding.topicId).length && Date.now() < deadline && !shutdown.signal.aborted) {
      for (const turn of spool.activeTurns(binding.topicId)) {
        const { response, data } = await json(binding.profileRef, `/v1/runs/${turn.admissionId}`);
        if (!response.ok || data?.run_id !== turn.admissionId) continue;
        const state = terminalStatus(data.status);
        if (state && state !== 'unknown') {
          watchers.get(turn.admissionId)?.abort();
          await finishRun(binding, turn, state, data.output);
        }
      }
      if (spool.activeTurns(binding.topicId).length) await delay(250, undefined, { signal: shutdown.signal });
    }
    if (spool.activeTurns(binding.topicId).length) throw new NativeCommandFailure('已请求停止回复，等待执行结束后才能重置会话。');
  }

  function finishNative(pending: NativePending, receipt: ReturnType<typeof result>): void {
    const sessionId = receipt.status === 'ok' ? receipt.native_result?.session_id : undefined;
    spool.finishNative(pending.commandId, { ...receipt }, sessionId);
    if (sessionId && sessionId !== pending.binding.sessionId) {
      for (const [id, topicId] of watcherTopics) if (topicId === pending.binding.topicId) watchers.get(id)?.abort();
    }
    const saved = spool.command(pending.commandId)?.result;
    if (saved) send(JSON.parse(saved) as JsonObject);
  }

  function watchNative(pending: NativePending): void {
    if (nativeWatchers.has(pending.commandId) || shutdown.signal.aborted) return;
    nativeWatchers.add(pending.commandId);
    void (async () => {
      while (!shutdown.signal.aborted && spool.nativeRequests(pending.binding.topicId)
        .some(({ commandId }) => commandId === pending.commandId)) {
        await delay(1500, undefined, { signal: shutdown.signal });
        try {
          const native_result = await native.result(pending.binding.profileRef, pending.binding.sessionId,
            pending.commandId, shutdown.signal);
          validateNativeMutation(pending.name, native_result);
          finishNative(pending, result(pending.commandId, 'ok', { native_result }));
          return;
        } catch (error) {
          if (error instanceof NativeCommandFailure && error.status === 'error') {
            finishNative(pending, result(pending.commandId, 'error', { error: error.message }));
            return;
          }
          // A missing, pending, or unverified receipt leaves the durable admission fence in place.
        }
      }
    })().catch(() => {}).finally(() => { nativeWatchers.delete(pending.commandId); });
  }

  function command(command: Command, current: () => boolean): Promise<void> {
    const previous = topicQueues.get(command.topic_id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => runCommand(command, current));
    topicQueues.set(command.topic_id, next);
    void next.finally(() => { if (topicQueues.get(command.topic_id) === next) topicQueues.delete(command.topic_id); }).catch(() => {});
    return next;
  }

  async function runCommand(command: Command, current: () => boolean): Promise<void> {
    if (!current() || shutdown.signal.aborted) return;
    const { command_id, topic_id, profile_ref } = command;
    const existing = spool.binding(topic_id);
    const bound = existing?.profileRef === profile_ref && existing.sessionId === command.session_id &&
      spool.transport(topic_id) === 'http' ? existing : undefined;
    if (command.kind === 'watch') {
      if (bound) {
        for (const turn of spool.activeTurns(topic_id)) watch(bound, turn);
        await syncTitle(bound);
      }
      return;
    }
    const digest = commandDigest(command);
    const saved = spool.command(command_id);
    if (saved && saved.digest !== digest) throw new Error('BFF 重复使用了命令 ID');
    if (saved?.result) {
      send(JSON.parse(saved.result) as JsonObject);
      return;
    }
    if (commands.has(command_id)) return;
    let input: Awaited<ReturnType<typeof prepareInput>> | undefined;
    if (command.kind === 'submit' && bound && command.body.attachments && !saved) {
      try {
        input = await prepareInput(command);
      } catch {
        if (current() && !shutdown.signal.aborted && spool.begin(command_id, digest)) {
          const receipt = result(command_id, 'error', { error: 'Hermes 无法读取附件，请重新发送。' });
          spool.finish(command_id, { ...receipt });
          send({ ...receipt });
        }
        return;
      }
      if (!current() || shutdown.signal.aborted) return;
    }
    if (!spool.begin(command_id, digest)) {
      const uncertain = result(command_id, 'unknown', { error: unknown });
      spool.finish(command_id, { ...uncertain });
      send({ ...uncertain });
      return;
    }

    commands.add(command_id);
    let receipt = result(command_id, 'unknown', { error: unknown });
    let turn: Turn | undefined;
    let selection: ((ModelSelection | { effort: ReasoningEffort | null }) & { topicId: string }) | undefined;
    let pendingNative: NativePending | undefined;
    try {
      if (!profileName.test(profile_ref)) {
        receipt = result(command_id, 'error', { error: 'Hermes 配置档案无效' });
      } else if (!bound) {
        receipt = result(command_id, 'error', { error: 'Hermes 会话与话题的绑定不匹配' });
      } else if (spool.nativePending(topic_id).length && command.kind !== 'native_command' && command.kind !== 'model_options') {
        receipt = result(command_id, 'error', { error: '上一条原生命令的会话变更尚未确认，请等待结果后继续。' });
      } else if (command.kind === 'native_command') {
        let dispatched = false;
        try {
          const originalCatalog = await native.catalog(profile_ref, shutdown.signal);
          const catalog = enableNativeCommands(originalCatalog, ['status', 'title']);
          const { entry, args } = resolveNativeCommand(command.body.command, catalog);
          if (!entry.supported) throw new NativeCommandFailure(entry.unavailable_reason || '当前会话通道未开放此原生命令。');
          if (spool.nativePending(topic_id).length && (args || !['help', 'commands', 'version', 'status', 'usage', 'context',
            'profile', 'bundles', 'title', 'restart'].includes(entry.name))) {
            throw new NativeCommandFailure('上一条原生命令的会话变更尚未确认，请等待结果后继续。');
          }
          if (!current() || shutdown.signal.aborted) throw new NativeCommandFailure('连接已中断，命令尚未执行。');
          if (entry.name === 'new' || entry.name === 'reset') await stopForReset(bound);
          if (['undo', 'compress', 'new', 'reset', 'fast'].includes(entry.name)) {
            pendingNative = { commandId: command_id, name: entry.name, binding: bound };
            try { spool.beginNative(pendingNative); }
            catch { pendingNative = undefined; throw new NativeCommandFailure('请等待当前会话任务结束并确认结果后再执行此命令。'); }
          }
          if ((entry.name === 'status' || entry.name === 'title') && !originalCatalog.find(({ name }) => name === entry.name)?.supported) {
            if (entry.name === 'status' && args) throw new NativeCommandFailure('/status 不接受参数。');
            const writing = entry.name === 'title' && !!args;
            const expectedTitle = writing ? nativeTitle(args) : undefined;
            dispatched = writing;
            const response = await request(profile_ref, `/api/sessions/${encodeURIComponent(bound.sessionId)}`, writing ? {
              method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: args }),
            } : {});
            const data = object(await response.json().catch(() => undefined));
            if (!response.ok) throw new NativeCommandFailure(`Hermes 拒绝了会话命令（${response.status}）。`,
              writing && response.status >= 500 ? 'unknown' : 'error');
            const snapshot = object(data?.session);
            if (snapshot?.id !== bound.sessionId || (writing
              && (!text(snapshot.title, MAX_TOPIC_TITLE_BYTES) || snapshot.title !== expectedTitle))) {
              throw new NativeCommandFailure('Hermes 返回了不匹配的会话命令回执。', writing ? 'unknown' : 'error');
            }
            const output = entry.name === 'status' ? nativeStatusOutput(sessionStatus(snapshot, spool.activeTurns(topic_id)))
              : `会话标题：${typeof snapshot.title === 'string' && snapshot.title ? snapshot.title : '未命名'}`;
            receipt = result(command_id, 'ok', { native_result: { output, ...(writing && { title: snapshot.title as string }) } });
          } else {
            if (!pendingNative) {
              const pending = { commandId: command_id, name: entry.name, binding: bound, mutating: false };
              spool.beginNative(pending);
              pendingNative = pending;
            }
            dispatched = true;
            const native_result = await native.execute(profile_ref, bound.sessionId, command_id, command.body.command,
              shutdown.signal, command.body.approval, entry.name === 'fast' ? spool.modelSelection(topic_id)?.model : undefined);
            validateNativeMutation(entry.name, native_result);
            receipt = result(command_id, 'ok', { native_result });
          }
        } catch (error) {
          receipt = result(command_id, error instanceof NativeCommandFailure ? error.status : dispatched ? 'unknown' : 'error', {
            error: error instanceof NativeCommandFailure ? error.message
              : error instanceof QueryUnavailable ? '请更新并启用 Hermes 移动端命令插件。' : 'Hermes 无法确认原生命令的结果。',
          });
        }
      } else if (command.kind === 'model_options' || command.kind === 'select_model') {
        receipt = result(command_id, 'error', { error: 'Hermes 无法加载模型目录' });
        const { response, data } = await json(profile_ref, '/api/model/options?include_unconfigured=false');
        if (!response.ok) {
          receipt = result(command_id, 'error', {
            error: response.status === 404 ? '当前 Hermes API 版本不支持查询模型选项' : 'Hermes 无法加载模型目录',
          });
        } else {
          const catalog = modelCatalog(data, spool.modelSelection(topic_id));
          if (command.kind === 'model_options') {
            receipt = result(command_id, 'ok', { model_result: { type: 'catalog', catalog } });
          } else {
            const { provider, model, confirm, global } = command.body;
            if (!hasModel(catalog, { provider, model }) || (confirm && !global)) {
              receipt = result(command_id, 'error', { error: '此模型已不可用，请重新打开 /model。' });
            } else if (global && (!manage || ['all', 'current'].includes(profile_ref))) {
              receipt = result(command_id, 'error', { error: '无法保存默认模型，请检查当前 profile 的 Hermes 控制台连接。' });
            } else if (current() && !shutdown.signal.aborted) {
              let savedDefault = !global;
              if (global && manage) {
                const identity = JSON.stringify([topic_id, profile_ref, bound.sessionId, provider, model]);
                for (const [token, pending] of modelConfirmations) {
                  if (pending.expires <= Date.now()) modelConfirmations.delete(token);
                }
                if (confirm && modelConfirmations.get(confirm)?.selection !== identity) {
                  receipt = result(command_id, 'error', { error: '模型确认已失效，请重新选择模型。' });
                } else {
                  if (confirm) modelConfirmations.delete(confirm);
                  receipt = result(command_id, 'unknown', { error: 'Hermes 无法确认默认模型是否已保存，请检查配置后重试。' });
                  const response = await manage({ type: 'management_request', request_id: command_id, profile_ref,
                    operation: 'model.set', input: { scope: 'main', provider, model,
                      ...(confirm && { confirm_expensive_model: true }) } });
                  if (!response.ok) {
                    receipt = result(command_id, response.status >= 500 ? 'unknown' : 'error', { error: response.message });
                  } else {
                    const data = object(response.data);
                    if (data?.confirm_required === true) {
                      const token = randomBytes(32).toString('hex');
                      if (modelConfirmations.size >= 64) modelConfirmations.delete(modelConfirmations.keys().next().value!);
                      modelConfirmations.set(token, { selection: identity, expires: Date.now() + 5 * 60_000 });
                      receipt = result(command_id, 'ok', { model_result: { type: 'confirmation', confirm: token,
                        message: string(data.confirm_message) ?? 'Hermes 要求确认此模型变更，是否继续？' } });
                    } else savedDefault = data?.ok === true;
                  }
                }
              }
              if (savedDefault) {
                selection = { topicId: topic_id, provider, model };
                receipt = result(command_id, 'ok', { model_result: { type: 'selected', selection: { provider, model },
                  ...(global && { global: true }) } });
              }
            }
          }
        }
      } else if (command.kind === 'select_reasoning') {
        receipt = result(command_id, 'error', { error: '无法访问 Hermes 会话，请检查连接后重试。' });
        const { response, data } = await json(profile_ref, `/api/sessions/${encodeURIComponent(bound.sessionId)}`);
        if (response.ok && object(data?.session)?.id === bound.sessionId && current() && !shutdown.signal.aborted) {
          selection = { topicId: topic_id, effort: command.body.effort };
          receipt = result(command_id, 'ok');
        }
      } else if (command.kind === 'submit') {
        let runtime: Awaited<ReturnType<NativeCommands['runtime']>>;
        try {
          runtime = await native.runtime(profile_ref, bound.sessionId, shutdown.signal);
          spool.markNativeRuntimeSupported(profile_ref);
        } catch (error) {
          if (error instanceof QueryUnavailable && !spool.nativeRuntimeSupported(profile_ref)) runtime = { system_prompt: '' };
          else {
            receipt = result(command_id, 'error', { error: '无法读取 Hermes 当前会话运行配置，请检查原生命令插件连接后重试。' });
            throw new Error('Native runtime configuration unavailable before admission');
          }
        }
        const effort = spool.reasoningEffort(topic_id);
        const { response, data } = await json(profile_ref, '/v1/runs', {
          session_id: bound.sessionId, input: input ?? command.body.text, ...spool.modelSelection(topic_id),
          instructions: [runtime.system_prompt, deliveryInstructions(bound.profileRef, bound.sessionId)].filter(Boolean).join('\n\n'),
          ...((effort || runtime.service_tier !== undefined) && { model_options: {
            ...(effort && { reasoning_effort: effort }),
            ...(runtime.service_tier !== undefined && { service_tier: runtime.service_tier }),
          } }),
        }, command_id);
        const id = string(data?.run_id);
        if (response.status === 202 && id && runId.test(id)) {
          turn = { topicId: topic_id, admissionId: id, submissionId: command.body.submission_id, text: emptyRun, status: 'queued' };
          receipt = result(command_id, 'ok', { admission_id: id });
        } else if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          receipt = result(command_id, 'error', { error: 'Hermes 拒绝执行' });
        }
      } else if (command.kind === 'interrupt') {
        const submissionId = command.body.submission_id;
        const active = spool.activeTurns(topic_id).find((item) => item.submissionId === submissionId);
        if (active && runId.test(active.admissionId)) {
          const { response, data } = await json(profile_ref, `/v1/runs/${active.admissionId}/stop`, {});
          if (response.ok && data?.run_id === active.admissionId && (data.status === 'stopping' || data.status === 'cancelled')) {
            receipt = result(command_id, 'ok');
          }
        }
      } else if (command.kind === 'respond') {
        receipt = result(command_id, 'error', {
          control_status: 'closed', error: '此请求已过期或已回答。',
        });
        const active = spool.activeTurns(topic_id).find((turn) => runId.test(turn.admissionId) &&
          (JSON.parse(turn.text) as RunState).prompts.some(({ control }) => control.control_id === command.body.control_id));
        if (active) {
          receipt = result(command_id, 'unknown', { error: 'Hermes 无法确认回答' });
          const path = `/v1/runs/${active.admissionId}`;
          const { response: snapshot, data } = await json(profile_ref, path);
          const prompt = data?.run_id === active.admissionId
            ? pendingPrompts(active.admissionId, data).find(({ control }) => control.control_id === command.body.control_id)
            : undefined;
          if (!prompt && (data?.run_id === active.admissionId ||
            (snapshot.status === 404 && object(data?.error)?.code === 'run_not_found'))) {
            receipt = result(command_id, 'error', { control_status: 'closed', error: '此请求已过期或已回答。' });
          } else if (prompt && current() && !shutdown.signal.aborted) {
            const { kind, choices } = prompt.control;
            if (kind === 'approval' && !choices.includes(command.body.answer)) {
              receipt = result(command_id, 'error', { error: '无法为此请求提交该回答' });
            } else {
              const { response, data: reply } = await json(profile_ref, `${path}/${kind}`, {
                request_id: prompt.id,
                ...(prompt.generation === undefined ? {} : { execution_generation: prompt.generation }),
                // 网关用特殊值区分主动跳过和等待回答。
                [kind === 'approval' ? 'choice' : 'answer']: kind === 'clarify' && command.body.answer === ''
                  ? '\u0000skipped' : command.body.answer,
              });
              if (response.ok && reply?.run_id === active.admissionId &&
                  ((reply.prompt_id === prompt.id && reply.status === 'resolved') ||
                    (reply.request_id === prompt.id && (integer(reply.resolved) ?? 0) > 0))) {
                receipt = result(command_id, 'ok', { control_status: 'closed' });
              } else if ((reply?.prompt_id === prompt.id && reply.status === 'already_resolved') ||
                (response.status === 409 && ['stale_generation', 'approval_not_pending'].includes(String(object(reply?.error)?.code)))) {
                receipt = result(command_id, 'error', { control_status: 'closed', error: '此请求已过期或已回答。' });
              }
            }
          }
        }
      }
    } catch {
      // 连接中断之前，请求可能已送达 Hermes。
    } finally {
      commands.delete(command_id);
    }
    if (pendingNative) {
      try { finishNative(pendingNative, receipt); }
      catch { finishNative(pendingNative, result(command_id, 'unknown', { error: '原生命令的会话变更尚未确认，请等待原生回执。' })); }
      if (spool.nativeRequests(topic_id).some(({ commandId }) => commandId === command_id)) watchNative(pendingNative);
    } else {
      if (shutdown.signal.aborted) return;
      spool.finish(command_id, { ...receipt }, undefined, turn, selection);
      send({ ...receipt });
    }
    if (turn && bound) watch(bound, turn);
  }

  for (const pending of spool.nativeRequests()) if (spool.transport(pending.binding.topicId) === 'http') watchNative(pending);

  return {
    command,
    query,
    close() {
      shutdown.abort();
      for (const controller of watchers.values()) controller.abort();
    },
  };
}
