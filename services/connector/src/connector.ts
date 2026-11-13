import {
  canonicalInteger, encodeControlResponse, normalizeCanonicalEvent, normalizeTurnOutcome,
  parseAdmissionReceipt, parseCanonicalEvent, parseControlReceipt, parseServerRequest, parseSessionSnapshot,
} from '@hermes-mobile/hermes-adapter';
import type { CanonicalAdmission, CanonicalPrompt, ServerRequest, SessionSnapshot } from '@hermes-mobile/hermes-adapter';
import type { Command, CommandResult, ConnectorEvent, Control, TopicQuery, TopicQueryData } from '@hermes-mobile/protocol';
import { MAX_CLARIFY_CHOICE_BYTES } from '@hermes-mobile/protocol';
import { Gateway, GatewayRefusal, object } from './gateway.js';
import type { JsonObject } from './gateway.js';
import { hasModel, modelCatalog } from './models.js';
import { Spool } from './spool.js';
import type { Binding, Cursor, Turn } from './spool.js';
import { QueryUnavailable, queryTimeout, runtimeVersion, sessionStatus, skillList } from './topic-query.js';
import { boundedText, commandDigest, result, stableId, text } from './wire.js';

type Target =
  | { type: 'prompt'; prompt: CanonicalPrompt }
  | { type: 'server'; request: ServerRequest; questionId: string };

type BufferState = { frames: JsonObject[]; bytes: number };

type Session = {
  binding: Binding;
  gateway: Gateway;
  buffer?: BufferState;
  cursor?: Cursor;
  targets: Map<string, Target>;
};

type Profile = {
  gateway: Promise<Gateway>;
  creating?: BufferState;
};

function outcomeStatus(outcome: ReturnType<typeof normalizeTurnOutcome>): Turn['status'] {
  return outcome === 'completed' ? 'final' : outcome;
}

function receiptStatus(receipt: CanonicalAdmission): Turn['status'] {
  if (receipt.status === 'terminal') return outcomeStatus(normalizeTurnOutcome(receipt.outcome));
  if (receipt.status === 'started') return 'streaming';
  return receipt.status;
}

function knownRefusal(error: unknown): error is GatewayRefusal {
  return error instanceof GatewayRefusal && [4000, 4001, 4030, 4404, -32601, -32602].includes(error.code)
    && !['storage_unavailable', 'outcome_unknown', 'execution_unknown'].includes(error.reason ?? '');
}

export class CanonicalConnector {
  readonly #profiles = new Map<string, Profile>();
  readonly #sessions = new Map<string, Session>();
  readonly #bindings = new Map<string, Binding>();
  readonly #attaching = new Map<string, Promise<Session>>();
  #closed = false;

  constructor(
    readonly binary: string,
    readonly spool: Spool,
    readonly onReconnect: () => void,
  ) {
    for (const binding of spool.bindings()) this.#bindings.set(binding.topicId, binding);
  }

  close(): void {
    this.#closed = true;
    for (const profile of this.#profiles.values()) {
      void profile.gateway.then((gateway) => gateway.close(), () => {});
    }
    this.#profiles.clear();
    this.#sessions.clear();
    this.#attaching.clear();
  }

  async #profile(ref: string): Promise<Profile> {
    const existing = this.#profiles.get(ref);
    if (existing) {
      const gateway = await existing.gateway;
      if (gateway.connected) return existing;
      this.#profiles.delete(ref);
    }
    const profile: Profile = {
      gateway: Gateway.connect({ binary: this.binary, profile: ref },
        (frame, bytes) => this.#route(ref, frame, bytes),
        () => {
          if (this.#profiles.get(ref) !== profile) return;
          this.#profiles.delete(ref);
          for (const [topicId, session] of this.#sessions) {
            if (session.binding.profileRef === ref) this.#sessions.delete(topicId);
          }
          if (!this.#closed) this.onReconnect();
        }),
    };
    this.#profiles.set(ref, profile);
    try {
      await profile.gateway;
      return profile;
    } catch (error) {
      if (this.#profiles.get(ref) === profile) this.#profiles.delete(ref);
      throw error;
    }
  }

  async query({ kind, topic_id, profile_ref, session_id }: TopicQuery): Promise<TopicQueryData> {
    const binding = this.#bindings.get(topic_id);
    if (!binding || binding.profileRef !== profile_ref || binding.sessionId !== session_id) {
      throw new Error('Hermes session binding could not be verified');
    }
    const { gateway } = await this.#attach(binding);
    try {
      const info = await gateway.rpc('session.info', { session_id }, undefined, queryTimeout);
      if (info.profile_id !== binding.profileId) throw new Error('Unexpected Hermes profile');
      if (kind === 'version') return { kind, version: runtimeVersion(info.version) };
      if (kind === 'skills') {
        const categories = object(info.skills);
        if (!categories) throw new QueryUnavailable();
        const skills = Object.entries(categories).flatMap(([category, names]) => {
          if (!Array.isArray(names)) throw new Error('Invalid Hermes skill category');
          return names.map((name: unknown) => ({ name, category }));
        });
        return { kind, skills: skillList(skills) };
      }
      return { kind, status: sessionStatus(info, this.spool.activeTurns(topic_id)) };
    } catch (error) {
      if (error instanceof GatewayRefusal && error.code === -32601) throw new QueryUnavailable();
      throw error;
    }
  }

  async command(command: Command, current: () => boolean): Promise<void> {
    const { command_id: id, topic_id: topicId, profile_ref: ref } = command;
    const binding = this.#bindings.get(topicId);
    if (command.kind === 'watch') {
      if (binding?.sessionId === command.session_id && binding?.profileRef === ref) {
        try {
          await this.#attach(binding);
        } catch (error) {
          if (!knownRefusal(error)) throw error;
        }
      }
      return;
    }
    const digest = commandDigest(command);
    const existing = this.spool.command(id);
    if (existing) {
      if (existing.digest !== digest) throw new Error('BFF reused a command ID');
      return;
    }

    const finish = (status: CommandResult['status'], fields?: Partial<CommandResult>) => {
      if (this.spool.begin(id, digest)) this.spool.finish(id, { ...result(id, status, fields) });
    };
    if (command.kind === 'create') {
      if (binding) {
        finish('error', { error: 'Topic already has a Hermes session' });
        return;
      }
      const profile = await this.#profile(ref);
      const gateway = await profile.gateway;
      if (!current() || !gateway.connected) return;
      if (!this.spool.begin(id, digest)) return;
      const buffer: BufferState = { frames: [], bytes: 0 };
      profile.creating = buffer;
      try {
        const snapshot = parseSessionSnapshot(await gateway.rpc('session.create', {
          source: 'tool', request_id: command.body.request_id,
        }, id));
        if (snapshot.authorityEpoch !== gateway.identity.authorityEpoch || Buffer.byteLength(snapshot.sessionId) > 512) {
          throw new Error('Unexpected created Hermes session identity');
        }
        const created = { topicId, sessionId: snapshot.sessionId, profileId: gateway.identity.profileId, profileRef: ref };
        this.spool.finish(id, { ...result(id, 'ok', { session_id: created.sessionId }) }, created);
        this.#bindings.set(topicId, created);
        const session: Session = { binding: created, gateway, targets: new Map() };
        if (gateway.connected) {
          this.#sessions.set(topicId, session);
          session.buffer = {
            ...buffer, frames: buffer.frames.filter((frame) => object(frame.params)?.session_id === created.sessionId),
          };
          this.#restoreSnapshot(session, snapshot);
        }
      } catch (error) {
        this.#failedWrite(id, error);
      } finally {
        delete profile.creating;
      }
      return;
    }

    if (!binding || binding.profileRef !== ref || binding.sessionId !== command.session_id) {
      finish('error', { error: 'Hermes session binding could not be verified' });
      return;
    }
    let session: Session;
    try {
      session = await this.#attach(binding);
    } catch (error) {
      if (!knownRefusal(error)) throw error;
      finish('error', { error: 'Hermes session is unavailable for this profile' });
      return;
    }
    if (!current() || !session.gateway.connected) return;
    if (command.kind === 'model_options' || command.kind === 'select_model') {
      if (!this.spool.begin(id, digest)) return;
      try {
        const catalog = modelCatalog(await session.gateway.rpc('model.options', { session_id: binding.sessionId }));
        let receipt = result(id, 'ok', { model_result: { type: 'catalog', catalog } });
        if (command.kind === 'select_model') {
          const { provider, model } = command.body;
          receipt = result(id, 'error', { error: 'This model is no longer available. Open /model again.' });
          if (hasModel(catalog, { provider, model })) {
            const snapshot = parseSessionSnapshot(await session.gateway.rpc('session.resume', {
              session_id: binding.sessionId, omit_messages: true,
            }));
            this.#checkSnapshot(session, snapshot);
            // Keep model confirmation tied to the idle revision that issued it.
            if (snapshot.running || snapshot.pending.length) {
              receipt = result(id, 'error', { error: 'Wait for the current response before switching models.' });
            } else if (current() && session.gateway.connected) {
              const reply = await session.gateway.rpc('session.mutate', {
                session_id: binding.sessionId, request_id: id, operation: 'model', payload: command.body,
                expected_revision: canonicalInteger(snapshot.revision),
                expected_generation: canonicalInteger(snapshot.executionGeneration),
              }, id);
              receipt = result(id, 'unknown', { error: 'Hermes could not confirm the model selection' });
              if (reply.session_id === binding.sessionId && reply.operation === 'model') {
                if (reply.status === 'confirmation_required' && typeof reply.confirm === 'string' &&
                  /^[a-f0-9]{64}$/.test(reply.confirm) && text(reply.confirm_message, 16 * 1024)) {
                  receipt = result(id, 'ok', { model_result: { type: 'confirmation', confirm: reply.confirm, message: reply.confirm_message } });
                } else if (reply.status === 'deferred') {
                  receipt = result(id, 'ok', { model_result: { type: 'deferred', selection: { provider, model } } });
                } else if (text(reply.model, 512) && text(reply.provider, 256)) {
                  receipt = result(id, 'ok', { model_result: { type: 'selected', selection: { provider: reply.provider, model: reply.model } } });
                }
              }
            }
          }
        }
        this.spool.finish(id, { ...receipt });
      } catch (error) {
        if (error instanceof GatewayRefusal && error.code === -32601) {
          this.spool.finish(id, { ...result(id, 'error', { error: 'This Hermes Gateway version does not support model selection' }) });
        } else {
          this.#failedWrite(id, error);
        }
      }
      return;
    }
    if (command.kind === 'interrupt') {
      const turn = this.spool.activeTurns(topicId).find((item) => item.submissionId === command.body.submission_id);
      if (!turn) {
        finish('error', { error: 'The requested submission is no longer running' });
        return;
      }
      const raw = await session.gateway.rpc('session.resume', {
        session_id: binding.sessionId, omit_messages: true,
      });
      const snapshot = parseSessionSnapshot(raw);
      this.#checkSnapshot(session, snapshot);
      const pending = Array.isArray(raw.pending) ? raw.pending.map(object) : [];
      const receipt = snapshot.pending.find((item) => item.admissionId === turn.admissionId
        && item.submissionId === command.body.submission_id);
      const claim = pending.find((item) => item?.admission_id === turn.admissionId);
      if (claim?.steering !== false || !snapshot.running || receipt?.status !== 'started' || !receipt.executionGeneration
        || receipt.executionGeneration !== snapshot.executionGeneration
        || receipt.authorityEpoch !== session.gateway.identity.authorityEpoch) {
        finish('error', { error: 'The requested submission is no longer running' });
        return;
      }
      if (!current() || !session.gateway.connected || !this.spool.begin(id, digest)) return;
      try {
        await session.gateway.rpc('session.interrupt', {
          session_id: binding.sessionId, execution_generation: canonicalInteger(receipt.executionGeneration),
        }, id);
        this.spool.finish(id, { ...result(id, 'ok') });
      } catch (error) {
        this.#failedWrite(id, error);
      }
      return;
    }
    if (command.kind === 'respond') {
      const target = session.targets.get(command.body.control_id);
      if (!target) {
        finish('error', { control_status: 'closed', error: 'This request has expired or was already answered.' });
        return;
      }
      let call: { method: string; params: JsonObject };
      try {
        call = target.type === 'prompt'
          ? encodeControlResponse(binding.sessionId, target.prompt,
            target.prompt.kind === 'clarify' && command.body.answer === '' ? '\u0000skipped' : command.body.answer)
          : { method: 'clarify.lock', params: {
            request_id: target.request.requestId, question_id: target.questionId, answer: command.body.answer || null,
          } };
      } catch {
        finish('error', { error: 'The answer is not available for this control' });
        return;
      }
      if (!this.spool.begin(id, digest)) return;
      try {
        const reply = await session.gateway.rpc(call.method, call.params, id);
        const resolved = target.type === 'prompt'
          ? parseControlReceipt(reply, target.prompt.promptId) === 'resolved'
          : reply.status === 'ok';
        if (resolved) {
          this.spool.finish(id, { ...result(id, 'ok', { control_status: 'closed' }) });
          this.#closeControls(session, [command.body.control_id], 'closed', [id, 'respond']);
        } else if (target.type === 'prompt' || reply.status === 'expired') {
          this.spool.finish(id, { ...result(id, 'error', {
            control_status: 'closed', error: 'This request has expired or was already answered.',
          }) });
        } else {
          this.spool.finish(id, { ...result(id, 'unknown', { error: 'Hermes could not confirm the response' }) });
        }
      } catch (error) {
        if (error instanceof GatewayRefusal && ['stale_generation', 'approval_not_pending'].includes(error.reason ?? '')) {
          this.spool.finish(id, { ...result(id, 'error', {
            control_status: 'closed', error: 'This request has expired or was already answered.',
          }) });
        } else {
          this.#failedWrite(id, error);
        }
      }
      return;
    }

    if (!this.spool.begin(id, digest, { topicId, submissionId: command.body.submission_id })) return;
    session.buffer = { frames: [], bytes: 0 };
    try {
      const receipt = parseAdmissionReceipt(await session.gateway.rpc('prompt.submit', {
        session_id: binding.sessionId, submission_id: command.body.submission_id, text: command.body.text,
        ...(session.gateway.clarifyBatch ? { clarify_batch: true } : {}),
      }, id));
      if (receipt.kind === 'voice_stopped') {
        this.spool.finish(id, { ...result(id, 'error', { error: 'Hermes consumed this input as a voice stop' }) });
      } else {
        this.#checkReceipt(session, receipt);
        this.spool.finish(id, { ...result(id, 'ok', { admission_id: receipt.admissionId }) }, undefined, {
          topicId, admissionId: receipt.admissionId, submissionId: command.body.submission_id, text: '', status: 'queued',
        });
        this.#applyReceipt(session, receipt, command.body.submission_id);
      }
    } catch (error) {
      this.#failedWrite(id, error);
      if (!knownRefusal(error)) session.gateway.close();
    } finally {
      this.#drain(session);
    }
  }

  #failedWrite(id: string, error: unknown): void {
    const refused = knownRefusal(error);
    const reason = refused && error.reason && /^[a-z0-9_]{1,64}$/u.test(error.reason) ? error.reason : undefined;
    this.spool.finish(id, { ...result(id, refused ? 'error' : 'unknown', {
      error: refused ? `Hermes refused the request${reason ? ` (${reason})` : ''}`
        : 'Hermes could not confirm the outcome',
    }) });
  }

  async #attach(binding: Binding): Promise<Session> {
    const inflight = this.#attaching.get(binding.topicId);
    if (inflight) return inflight;
    const previous = this.#sessions.get(binding.topicId);
    if (previous?.gateway.connected) return previous;
    const attach = this.#resume(binding);
    this.#attaching.set(binding.topicId, attach);
    try {
      return await attach;
    } finally {
      this.#attaching.delete(binding.topicId);
    }
  }

  async #resume(binding: Binding): Promise<Session> {
    const { gateway: pending } = await this.#profile(binding.profileRef);
    const gateway = await pending;
    if (gateway.identity.profileId !== binding.profileId) throw new GatewayRefusal(4001, 'profile_mismatch');
    const session: Session = {
      binding, gateway, cursor: this.spool.cursor(binding.topicId), buffer: { frames: [], bytes: 0 }, targets: new Map(),
    };
    this.#sessions.set(binding.topicId, session);
    try {
      // Calling since before resume also tells the owner to send the gap between replay and subscription.
      const replay = await gateway.rpc('session.events.since', {
        session_id: binding.sessionId,
        ...(session.cursor && { replay_epoch: session.cursor.epoch }),
        last_sequence: canonicalInteger(session.cursor?.sequence ?? '0'),
      });
      if (!Array.isArray(replay.events) || typeof replay.snapshot_required !== 'boolean') {
        throw new Error('Invalid Hermes replay reply');
      }
      if (!replay.snapshot_required) {
        for (const params of replay.events) this.#frame(session, { jsonrpc: '2.0', method: 'event', params });
      }
      const snapshot = parseSessionSnapshot(await gateway.rpc('session.resume', {
        session_id: binding.sessionId, omit_messages: true,
      }));
      this.#checkSnapshot(session, snapshot);
      this.#restoreSnapshot(session, snapshot);
      for (const turn of this.spool.activeTurns(binding.topicId)) {
        try {
          const receipt = await this.#receipt(session, turn.admissionId);
          this.#applyReceipt(session, receipt, turn.submissionId);
        } catch (error) {
          if (!knownRefusal(error)) throw error;
          if (turn.submissionId) this.#setTurn(session, { ...turn, status: 'unknown' }, [turn.admissionId, 'missing']);
        }
      }
      return session;
    } catch (error) {
      if (this.#sessions.get(binding.topicId) === session) this.#sessions.delete(binding.topicId);
      throw error;
    }
  }

  #checkSnapshot(session: Session, snapshot: SessionSnapshot): void {
    if (snapshot.sessionId !== session.binding.sessionId ||
      snapshot.authorityEpoch !== session.gateway.identity.authorityEpoch) {
      throw new GatewayRefusal(4001, 'session_identity_mismatch');
    }
  }

  #restoreSnapshot(session: Session, snapshot: SessionSnapshot): void {
    const later: JsonObject[] = [];
    for (const frame of session.buffer?.frames ?? []) {
      const event = parseCanonicalEvent(frame);
      if (event && event.type !== 'session.replay_gap' && event.replayEpoch === snapshot.replayEpoch &&
        BigInt(event.sequence) <= BigInt(snapshot.lastSequence)) {
        this.#frame(session, frame);
      } else {
        later.push(frame);
      }
    }
    this.#snapshot(session, snapshot);
    session.buffer = { frames: later, bytes: 0 };
    this.#drain(session);
  }

  #snapshot(session: Session, snapshot: SessionSnapshot): void {
    const open = new Set<string>();
    const running = snapshot.pending.filter((receipt) => receipt.status === 'started');
    const submissionId = running.length === 1 && this.spool.hasIntent(session.binding.topicId, running[0].submissionId)
      ? running[0].submissionId : undefined;
    for (const prompt of snapshot.prompts) {
      open.add(this.#prompt(session, prompt, [snapshot.replayEpoch, snapshot.lastSequence, 'snapshot'], submissionId));
    }
    for (const request of snapshot.openRequests) {
      for (const id of this.#request(session, request, submissionId)) open.add(id);
    }
    const closed = this.spool.controls(session.binding.topicId)
      .filter((control) => !open.has(control.control_id)).map((control) => control.control_id);
    this.#closeControls(session, closed, 'unknown', [snapshot.replayEpoch, snapshot.lastSequence, 'snapshot']);
    for (const receipt of snapshot.pending) {
      if (this.spool.hasIntent(session.binding.topicId, receipt.submissionId)) {
        this.#checkReceipt(session, receipt);
        this.#applyReceipt(session, receipt, receipt.submissionId);
      }
    }
    const cursor = { epoch: snapshot.replayEpoch, sequence: snapshot.lastSequence };
    if (!session.cursor || session.cursor.epoch !== cursor.epoch || BigInt(session.cursor.sequence) < BigInt(cursor.sequence)) {
      this.spool.record(session.binding.topicId, [], cursor);
      session.cursor = cursor;
    }
  }

  #checkReceipt(session: Session, receipt: CanonicalAdmission): void {
    if (receipt.profileId !== session.binding.profileId || receipt.sessionId !== session.binding.sessionId) {
      throw new Error('Hermes admission belongs to a different scope');
    }
  }

  async #receipt(session: Session, admissionId: string): Promise<CanonicalAdmission> {
    const receipt = parseAdmissionReceipt(await session.gateway.rpc('prompt.receipt', {
      session_id: session.binding.sessionId, admission_id: admissionId, include_result: true,
    }));
    if (receipt.kind !== 'admission' || receipt.admissionId !== admissionId) throw new Error('Invalid Hermes admission ID');
    this.#checkReceipt(session, receipt);
    return receipt;
  }

  #applyReceipt(session: Session, receipt: CanonicalAdmission, submissionId: string | null): void {
    const previous = this.spool.turn(session.binding.topicId, receipt.admissionId);
    const status = receiptStatus(receipt);
    if (previous && (['final', 'failed', 'cancelled'].includes(previous.status)
      || (previous.status === 'streaming' && status === 'queued'))) return;
    const text = receipt.finalText || previous?.text || '';
    if (previous?.status === status && previous.submissionId === submissionId && previous.text === text
      && status !== 'queued') return;
    this.#setTurn(session, {
      topicId: session.binding.topicId, admissionId: receipt.admissionId, submissionId, text, status,
    }, [receipt.admissionId, 'receipt', status, receipt.authorityEpoch, receipt.executionGeneration ?? ''],
    status === 'final' || status === 'cancelled');
  }

  #route(profileRef: string, frame: JsonObject, bytes: number): void {
    const profile = this.#profiles.get(profileRef);
    if (!profile || this.#closed) return;
    const sessionId = object(frame.params)?.session_id;
    const session = [...this.#sessions.values()].find(({ binding }) =>
      binding.profileRef === profileRef && binding.sessionId === sessionId);
    const buffer = session ? session.buffer : typeof sessionId === 'string' ? profile.creating : undefined;
    if (buffer) {
      if (buffer.frames.length >= 8_192 || buffer.bytes + bytes > 8 * 1024 * 1024) {
        throw new Error('Hermes catch-up buffer overflowed');
      }
      buffer.bytes += bytes;
      buffer.frames.push(frame);
      return;
    }
    if (session) {
      this.#frame(session, frame);
    } else if (frame.method !== 'event' && typeof frame.id === 'string') {
      void profile.gateway.then((gateway) => this.#rejectRequest(gateway, frame.id as string)).catch(() => {});
    }
  }

  #rejectRequest(gateway: Gateway, id: string): Promise<void> {
    return gateway.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unsupported client request' } });
  }

  #drain(session: Session): void {
    const frames = session.buffer?.frames ?? [];
    delete session.buffer;
    for (const frame of frames) this.#frame(session, frame);
  }

  #frame(session: Session, frame: JsonObject): void {
    const { binding } = session;
    if (frame.method !== 'event') {
      const request = parseServerRequest(frame);
      if (request?.sessionId === binding.sessionId) {
        const running = this.spool.activeTurns(binding.topicId).filter((turn) => turn.status === 'streaming');
        this.#request(session, request, running.length === 1 ? running[0].submissionId : undefined);
      } else if (typeof frame.id === 'string') {
        void this.#rejectRequest(session.gateway, frame.id).catch(() => {});
      }
      return;
    }
    const event = parseCanonicalEvent(frame);
    if (!event || event.sessionId !== binding.sessionId) return;
    if (event.type === 'session.replay_gap') {
      session.gateway.close();
      return;
    }
    if (session.cursor?.epoch === event.replayEpoch && BigInt(event.sequence) <= BigInt(session.cursor.sequence)) return;
    const cursor = { epoch: event.replayEpoch, sequence: event.sequence };
    const key = [event.replayEpoch, event.sequence];
    if (session.cursor && session.cursor.epoch !== event.replayEpoch && !session.buffer) {
      session.gateway.close();
      return;
    }
    const projection = normalizeCanonicalEvent(event);
    if (projection?.type === 'approval.request' || projection?.type === 'clarify.request') {
      this.#prompt(session, projection, key, event.admissionId ? this.spool.turn(binding.topicId, event.admissionId)?.submissionId : undefined);
    } else if (projection?.type === 'approval.settled' || projection?.type === 'clarify.settled') {
      this.#closeControls(session, [stableId([binding.topicId, 'prompt', projection.promptId, projection.executionGeneration])],
        'closed', key);
    } else if (projection?.type === 'request.cancel') {
      const ids = [...session.targets].filter(([, target]) => target.type === 'server'
        && target.request.requestId === projection.requestId).map(([id]) => id);
      this.#closeControls(session, ids, 'closed', key);
    } else if (projection?.type === 'session.info') {
      for (const receipt of projection.pending ?? []) {
        if (this.spool.hasIntent(binding.topicId, receipt.submissionId)) {
          this.#checkReceipt(session, receipt);
          this.#applyReceipt(session, receipt, receipt.submissionId);
        }
      }
    } else if (projection && 'admissionId' in projection && projection.admissionId &&
      ['message.start', 'message.delta', 'message.interim', 'message.complete'].includes(projection.type)) {
      const admissionId = projection.admissionId;
      const existing = this.spool.turn(binding.topicId, admissionId);
      const previousText = existing?.text ?? '';
      let text = previousText;
      let status: Turn['status'] = 'streaming';
      let publishMessage = false;
      let submissionId = existing?.submissionId ?? null;
      if (projection.type === 'message.delta' && projection.text) {
        text = previousText + projection.text;
        publishMessage = true;
      } else if (projection.type === 'message.interim' && !projection.alreadyStreamed && projection.text) {
        text = previousText ? `${previousText}\n${projection.text}` : projection.text;
        publishMessage = true;
      } else if (projection.type === 'message.complete') {
        const provided = projection.submissionId;
        if (!submissionId && provided && this.spool.hasIntent(binding.topicId, provided)) submissionId = provided;
        status = outcomeStatus(projection.outcome);
        text = projection.responseReused ? previousText || projection.text || ''
          : projection.text || previousText;
        publishMessage = !!text;
      }
      // A receipt may settle before buffered stream frames are drained.
      if (!existing || !['final', 'failed', 'cancelled'].includes(existing.status)) {
        this.#setTurn(session, { topicId: binding.topicId, admissionId, submissionId, text, status },
          key, publishMessage, cursor);
        session.cursor = cursor;
        return;
      }
    }
    this.spool.record(binding.topicId, [], cursor);
    session.cursor = cursor;
  }

  #setTurn(session: Session, turn: Turn, key: string[], publishMessage = false, cursor?: Cursor): void {
    const topicId = session.binding.topicId;
    const eventId = (kind: string) => stableId([topicId, kind, ...key]);
    const frames: ConnectorEvent[] = [];
    const text = boundedText(turn.text, 256 * 1024);
    if (publishMessage && text) {
      frames.push({
        type: 'message', event_id: eventId('message'), topic_id: topicId,
        message_id: stableId([topicId, 'message', turn.admissionId]), text,
        status: turn.status === 'streaming' ? 'streaming' : 'final',
        ...(turn.submissionId ? { submission_id: turn.submissionId } : {}),
      });
    }
    if (turn.submissionId) {
      frames.push({
        type: 'submission', event_id: eventId(`submission-${turn.admissionId}`), topic_id: topicId,
        submission_id: turn.submissionId, status: turn.status,
      });
    }
    this.spool.record(topicId, frames.map((body) => ({ id: body.event_id, body: { ...body } })), cursor, { ...turn, text });
  }

  #prompt(session: Session, prompt: CanonicalPrompt, key: string[], submissionId?: string | null): string {
    const topicId = session.binding.topicId;
    const id = stableId([topicId, 'prompt', prompt.promptId, prompt.executionGeneration]);
    const visible = boundedText(prompt.prompt, 64 * 1024);
    const choices = prompt.choices.filter((choice) => text(choice, prompt.kind === 'clarify' ? MAX_CLARIFY_CHOICE_BYTES : 1024));
    const safeChoices = prompt.kind === 'approval' && visible !== prompt.prompt
      ? choices.filter((choice) => choice === 'deny')
      : choices;
    session.targets.set(id, { type: 'prompt', prompt: { ...prompt, choices: safeChoices.slice(0, 30) } });
    this.#saveControl(session, {
      control_id: id, kind: prompt.kind, prompt: visible,
      choices: safeChoices, status: 'pending',
      ...(prompt.kind === 'clarify' && prompt.multiSelect ? { multi_select: true } : {}),
      ...(submissionId ? { submission_id: submissionId } : {}),
    }, key);
    return id;
  }

  #request(session: Session, request: ServerRequest, submissionId?: string | null): string[] {
    const topicId = session.binding.topicId;
    const open: string[] = [];
    for (const question of request.questions) {
      const id = stableId([topicId, 'server-request', request.requestId, question.questionId]);
      if (request.answeredQuestionIds.includes(question.questionId)) {
        this.#closeControls(session, [id], 'closed', [request.requestId, 'locked']);
      } else {
        session.targets.set(id, { type: 'server', request, questionId: question.questionId });
        this.#saveControl(session, {
          control_id: id, kind: 'clarify', prompt: question.prompt,
          choices: question.choices, status: 'pending',
          ...(question.multiSelect ? { multi_select: true } : {}),
          ...(submissionId ? { submission_id: submissionId } : {}),
        }, [request.requestId, 'open']);
        open.push(id);
      }
    }
    return open;
  }

  #saveControl(session: Session, control: Control, key: string[]): void {
    const topicId = session.binding.topicId;
    const clean = {
      ...control,
      prompt: boundedText(control.prompt, 64 * 1024).trim() || 'Hermes requires an answer',
      choices: [...new Set(control.choices.filter((choice) => text(choice, control.kind === 'clarify' ? MAX_CLARIFY_CHOICE_BYTES : 1024)))].slice(0, 30),
    };
    const id = stableId([topicId, 'control', control.control_id, ...key, clean.submission_id ?? '', String(clean.multi_select ?? false)]);
    this.spool.record(topicId, [{ id, body: { ...clean, type: 'control', event_id: id, topic_id: topicId } }],
      undefined, undefined, [clean]);
  }

  #closeControls(session: Session, ids: string[], status: 'closed' | 'unknown', key: string[]): void {
    const topicId = session.binding.topicId;
    for (const id of ids) session.targets.delete(id);
    for (const control of this.spool.controls(topicId)) {
      if (ids.includes(control.control_id)) this.#saveControl(session, { ...control, status }, key);
    }
  }
}
