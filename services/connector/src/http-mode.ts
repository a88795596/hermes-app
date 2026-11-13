import { setTimeout as delay } from 'node:timers/promises';
import type { Command, Control, ModelSelection } from '@hermes-mobile/protocol';
import { MAX_CLARIFY_CHOICE_BYTES } from '@hermes-mobile/protocol';
import { integer, object, string } from './gateway.js';
import type { JsonObject } from './gateway.js';
import { hasModel, modelCatalog } from './models.js';
import type { Binding, Spool, Turn } from './spool.js';
import { boundedText, commandDigest, result, stableId, text } from './wire.js';

const unknown = 'Hermes could not confirm the outcome';
const runId = /^run_[a-f0-9]{32}$/;
const profileName = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

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
    // shortcut: incomplete approval details allow denial until the full request can be reviewed.
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

type Options = { url: string; token: string; send: (frame: JsonObject) => void; spool: Spool };

export function createHttpConnector({ url, token, send, spool }: Options) {
  const endpoint = URL.parse(url);
  if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol) ||
      !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password ||
      endpoint.pathname !== '/' || endpoint.search || endpoint.hash || !token.trim() || /[\r\n]/.test(token)) {
    throw new Error('Hermes HTTP mode requires a loopback origin and API key');
  }
  const origin = endpoint.origin;
  const shutdown = new AbortController();
  const watchers = new Map<string, AbortController>();
  const commands = new Set<string>();

  function request(profile: string, path: string, options: RequestInit = {}): Promise<Response> {
    return fetch(new URL(`/p/${encodeURIComponent(profile)}${path}`, origin), {
      ...options,
      redirect: 'error',
      headers: { authorization: `Bearer ${token}`, ...options.headers },
      signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(15_000), ...(options.signal ? [options.signal] : [])]),
    });
  }

  async function json(profile: string, path: string, body?: JsonObject, idempotencyKey?: string) {
    const response = await request(profile, path, body && {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: JSON.stringify(body),
    });
    return { response, data: object(await response.json().catch(() => undefined)) };
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

  function message(turn: Turn, status: 'streaming' | 'final', text: string) {
    return { type: 'message', message_id: httpId(turn.topicId, turn.admissionId, 'message'),
      submission_id: turn.submissionId, status, text };
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
          // shortcut: the Runs stream keeps a bounded replay buffer, so recover truncated text from the terminal output.
          gap ||= next !== sequence + 1;
          sequence = next;
          const turn = spool.turn(binding.topicId, id);
          if (!turn || !['queued', 'streaming', 'unknown'].includes(turn.status)) return;
          if (event.event !== 'message.delta' || typeof event.delta !== 'string' || gap) {
            record(turn, [], sequence, gap);
            continue;
          }
          const state = JSON.parse(turn.text) as RunState;
          const text = boundedText(state.text + event.delta, 256 * 1024);
          const frames = text !== state.text ? [message(turn, 'streaming', text)] : [];
          record({ ...turn, text: JSON.stringify({ ...state, text }) }, frames, sequence);
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
    void (async () => {
      while (!signal.aborted) {
        await stream(binding, id, signal).catch(() => undefined);
        await delay(1000, undefined, { signal });
      }
    })().catch(() => undefined);
    void (async () => {
      while (!signal.aborted) {
        const result = await json(binding.profileRef, `/v1/runs/${id}`).catch(() => undefined);
        if (signal.aborted) return;
        const turn = spool.turn(binding.topicId, id);
        if (!turn || !turn.submissionId) return;
        const data = result?.data;
        const missingRun = result?.response.status === 404 && object(data?.error)?.code === 'run_not_found';
        if (data?.run_id === id || missingRun) {
          const status = data?.status;
          const frames: JsonObject[] = [];
          const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
          const next = terminal ? [] : pendingPrompts(id, data ?? {});
          const state: Turn['status'] | undefined = status === 'completed' ? 'final'
            : status === 'failed' ? 'failed'
            : status === 'cancelled' ? 'cancelled'
            : status === 'queued' ? turn.status === 'streaming' ? 'streaming' : 'queued'
            : status === 'running' || status === 'waiting_for_approval' || status === 'stopping' ? 'streaming'
            : missingRun || status === 'interrupted' || status === 'unknown' ? 'unknown' : undefined;
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
            const finalText = terminal ? (state === 'final' && typeof data?.output === 'string'
              ? boundedText(data.output, 256 * 1024) : saved.text) : undefined;
            const updated = { ...turn, status: state, text: JSON.stringify({ text: finalText ?? saved.text, prompts: next }) };
            if (state !== turn.status) {
              const error = state === 'unknown' ? unknown : state === 'failed' ? 'Hermes reported that the run failed' : undefined;
              frames.push({ type: 'submission', submission_id: turn.submissionId, status: state, ...(error ? { error } : {}) });
            }
            if (finalText) frames.push(message(updated, 'final', finalText));
            if (frames.length) record(updated, frames);
            if (terminal || missingRun || status === 'interrupted') return;
          }
        }
        await delay(1500, undefined, { signal });
      }
    })().catch(() => undefined).finally(() => {
      controller.abort();
      watchers.delete(id);
    });
  }

  async function command(command: Command, current: () => boolean): Promise<void> {
    if (!current() || shutdown.signal.aborted) return;
    const { command_id, topic_id, profile_ref } = command;
    const existing = spool.bindings().find(({ topicId }) => topicId === topic_id);
    const bound = existing?.profileRef === profile_ref && existing.sessionId === command.session_id &&
      existing.sessionId.startsWith('mobile_') ? existing : undefined;
    if (command.kind === 'watch') {
      if (bound) for (const turn of spool.activeTurns(topic_id)) watch(bound, turn);
      return;
    }
    const digest = commandDigest(command);
    const saved = spool.command(command_id);
    if (saved && saved.digest !== digest) throw new Error('BFF reused a command ID');
    if (saved?.result) {
      send(JSON.parse(saved.result) as JsonObject);
      return;
    }
    if (commands.has(command_id)) return;
    if (!spool.begin(command_id, digest)) {
      const uncertain = result(command_id, 'unknown', { error: unknown });
      spool.finish(command_id, { ...uncertain });
      send({ ...uncertain });
      return;
    }

    commands.add(command_id);
    let receipt = result(command_id, 'unknown', { error: unknown });
    let binding: Binding | undefined;
    let turn: Turn | undefined;
    let selection: (ModelSelection & { topicId: string }) | undefined;
    try {
      if (!profileName.test(profile_ref)) {
        receipt = result(command_id, 'error', { error: 'Invalid Hermes profile' });
      } else if (command.kind === 'create') {
        if (existing) {
          receipt = result(command_id, 'error', { error: 'This topic already has a Hermes binding' });
        } else {
          const sessionId = `mobile_${httpId(profile_ref, topic_id, command_id)}`;
          const { response, data } = await json(profile_ref, '/api/sessions', { id: sessionId });
          if (response.status === 201 && object(data?.session)?.id === sessionId) {
            binding = { topicId: topic_id, sessionId, profileRef: profile_ref, profileId: profile_ref };
            receipt = result(command_id, 'ok', { session_id: sessionId });
          } else if (response.status >= 400 && response.status < 500 && response.status !== 408) {
            receipt = result(command_id, 'error', { error: 'Hermes rejected session creation' });
          }
        }
      } else if (!bound) {
        receipt = result(command_id, 'error', { error: 'Hermes topic binding does not match' });
      } else if (command.kind === 'model_options' || command.kind === 'select_model') {
        receipt = result(command_id, 'error', { error: 'Hermes could not load the model catalog' });
        const { response, data } = await json(profile_ref, '/api/model/options?include_unconfigured=false');
        if (!response.ok) {
          receipt = result(command_id, 'error', {
            error: response.status === 404 ? 'This Hermes API version does not support model options' : 'Hermes could not load the model catalog',
          });
        } else {
          const catalog = modelCatalog(data, spool.modelSelection(topic_id));
          if (command.kind === 'model_options') {
            receipt = result(command_id, 'ok', { model_result: { type: 'catalog', catalog } });
          } else {
            const { provider, model, confirm } = command.body;
            if (confirm || !hasModel(catalog, { provider, model })) {
              receipt = result(command_id, 'error', { error: 'This model is no longer available. Open /model again.' });
            } else if (current() && !shutdown.signal.aborted) {
              selection = { topicId: topic_id, provider, model };
              receipt = result(command_id, 'ok', { model_result: { type: 'selected', selection: { provider, model } } });
            }
          }
        }
      } else if (command.kind === 'submit') {
        const { response, data } = await json(profile_ref, '/v1/runs', {
          session_id: bound.sessionId, input: command.body.text, ...spool.modelSelection(topic_id),
        }, command_id);
        const id = string(data?.run_id);
        if (response.status === 202 && id && runId.test(id)) {
          turn = { topicId: topic_id, admissionId: id, submissionId: command.body.submission_id, text: emptyRun, status: 'queued' };
          receipt = result(command_id, 'ok', { admission_id: id });
        } else if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          receipt = result(command_id, 'error', { error: 'Hermes rejected the run' });
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
          control_status: 'closed', error: 'This request has expired or was already answered.',
        });
        const active = spool.activeTurns(topic_id).find((turn) => runId.test(turn.admissionId) &&
          (JSON.parse(turn.text) as RunState).prompts.some(({ control }) => control.control_id === command.body.control_id));
        if (active) {
          receipt = result(command_id, 'unknown', { error: 'Hermes could not confirm the response' });
          const path = `/v1/runs/${active.admissionId}`;
          const { response: snapshot, data } = await json(profile_ref, path);
          const prompt = data?.run_id === active.admissionId
            ? pendingPrompts(active.admissionId, data).find(({ control }) => control.control_id === command.body.control_id)
            : undefined;
          if (!prompt && (data?.run_id === active.admissionId ||
            (snapshot.status === 404 && object(data?.error)?.code === 'run_not_found'))) {
            receipt = result(command_id, 'error', { control_status: 'closed', error: 'This request has expired or was already answered.' });
          } else if (prompt && current() && !shutdown.signal.aborted) {
            const { kind, choices } = prompt.control;
            if (kind === 'approval' && !choices.includes(command.body.answer)) {
              receipt = result(command_id, 'error', { error: 'The answer is not available for this control' });
            } else {
              const { response, data: reply } = await json(profile_ref, `${path}/${kind}`, {
                request_id: prompt.id,
                ...(prompt.generation === undefined ? {} : { execution_generation: prompt.generation }),
                // The gateway uses a sentinel to distinguish a deliberate skip from an unanswered wait.
                [kind === 'approval' ? 'choice' : 'answer']: kind === 'clarify' && command.body.answer === ''
                  ? '\u0000skipped' : command.body.answer,
              });
              if (response.ok && reply?.run_id === active.admissionId &&
                  ((reply.prompt_id === prompt.id && reply.status === 'resolved') ||
                    (reply.request_id === prompt.id && (integer(reply.resolved) ?? 0) > 0))) {
                receipt = result(command_id, 'ok', { control_status: 'closed' });
              } else if ((reply?.prompt_id === prompt.id && reply.status === 'already_resolved') ||
                (response.status === 409 && ['stale_generation', 'approval_not_pending'].includes(String(object(reply?.error)?.code)))) {
                receipt = result(command_id, 'error', { control_status: 'closed', error: 'This request has expired or was already answered.' });
              }
            }
          }
        }
      }
    } catch {
      // The request may have reached Hermes before the connection failed.
    } finally {
      commands.delete(command_id);
    }
    if (shutdown.signal.aborted) return;
    spool.finish(command_id, { ...receipt }, binding, turn, selection);
    send({ ...receipt });
    if (turn && bound) watch(bound, turn);
  }

  return {
    command,
    close() {
      shutdown.abort();
      for (const controller of watchers.values()) controller.abort();
    },
  };
}
