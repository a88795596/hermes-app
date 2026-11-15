import { deliveryInstructions } from './delivery-context.js';
import {
  canonicalInteger, encodeControlResponse, normalizeCanonicalEvent, normalizeTurnOutcome,
  parseAdmissionReceipt, parseCanonicalEvent, parseControlReceipt, parseServerRequest, parseSessionSnapshot,
} from '@hermes-mobile/hermes-adapter';
import type { CanonicalAdmission, CanonicalPrompt, ServerRequest, SessionSnapshot } from '@hermes-mobile/hermes-adapter';
import type { Command, CommandResult, ConnectorEvent, Control, TopicQuery, TopicQueryData } from '@hermes-mobile/protocol';
import { MAX_CLARIFY_CHOICE_BYTES, MAX_MESSAGE_PROCESS_TEXT_BYTES } from '@hermes-mobile/protocol';
import { attachmentBytes, attachmentFilename, hasReceivedAttachments, type DownloadAttachment, type ReceiveAttachments } from './attachments.js';
import { Gateway, GatewayRefusal, integer, object } from './gateway.js';
import type { JsonObject, WebappAccess } from './gateway.js';
import { addProcessText, redactProcessText, removeStreamedCommentary, updateProcessTool } from './message-process.js';
import { hasModel, modelCatalog } from './models.js';
import { Spool } from './spool.js';
import type { Binding, Cursor, Turn } from './spool.js';
import { QueryUnavailable, queryTimeout, runtimeVersion, sessionStatus, skillList, webappSkills } from './topic-query.js';
import { topicTitleEvent } from './topic-title.js';
import { boundedText, commandDigest, result, stableId, text } from './wire.js';

type Target =
  | { type: 'prompt'; prompt: CanonicalPrompt }
  | { type: 'server'; request: ServerRequest; questionId: string };

type BufferState = { frames: JsonObject[]; bytes: number };

const maxReasoningBytes = 2 * MAX_MESSAGE_PROCESS_TEXT_BYTES;

type Session = {
  binding: Binding;
  gateway: Gateway;
  buffer?: BufferState;
  cursor?: Cursor;
  targets: Map<string, Target>;
  reasoning: Map<string, string>;
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

function isRevision(value: unknown): boolean {
  return typeof value === 'bigint' ? value >= 0n && value <= 9_223_372_036_854_775_807n : integer(value) !== undefined;
}

export class CanonicalConnector {
  readonly #profiles = new Map<string, Profile>();
  readonly #sessions = new Map<string, Session>();
  readonly #bindings = new Map<string, Binding>();
  readonly #attaching = new Map<string, Promise<Session>>();
  readonly #receiving = new Set<string>();
  #closed = false;

  constructor(
    readonly access: string | WebappAccess,
    readonly spool: Spool,
    readonly onReconnect: () => void,
    readonly downloadAttachment: DownloadAttachment,
    readonly receiveAttachments?: ReceiveAttachments,
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
      gateway: Gateway.connect({ ...(typeof this.access === 'string' ? { binary: this.access } : { webapp: this.access }), profile: ref },
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
      throw new Error('无法验证 Hermes 会话绑定');
    }
    const session = await this.#attach(binding);
    const { gateway } = session;
    try {
      if (kind === 'skills' && typeof this.access !== 'string') {
        return { kind, skills: await webappSkills(this.access, profile_ref) };
      }
      const deadline = Date.now() + queryTimeout;
      let subagents: unknown[] = [];
      let info: JsonObject;
      if (kind === 'status') {
        try {
          // 先查子任务再读父执行，覆盖后台结果唤醒下一轮的交接。
          const roster = await gateway.rpc('subagent.list', { session_id }, undefined, queryTimeout);
          if (!Array.isArray(roster.subagents)) throw new Error('Hermes 子任务状态无效');
          subagents = roster.subagents;
        } catch (error) {
          if (!(error instanceof GatewayRefusal && (error.code === -32601 || error.reason === 'unsupported_projection'))) throw error;
        }
        const raw = await gateway.rpc('session.resume', { session_id, omit_messages: true }, undefined, Math.max(1, deadline - Date.now()));
        const snapshot = parseSessionSnapshot(raw);
        this.#checkSnapshot(session, snapshot);
        info = { ...object(raw.info), running: snapshot.running, message_count: raw.message_count };
      } else {
        info = await gateway.rpc('session.info', { session_id }, undefined, Math.max(1, deadline - Date.now()));
      }
      if (info.profile_id !== binding.profileId) throw new Error('Hermes 返回了意外的配置档案');
      if (kind === 'version') return { kind, version: runtimeVersion(info.version) };
      if (kind === 'skills') {
        const categories = object(info.skills);
        if (!categories) throw new QueryUnavailable();
        const skills = Object.entries(categories).flatMap(([category, names]) => {
          if (!Array.isArray(names)) throw new Error('Hermes 技能分类无效');
          return names.map((name: unknown) => ({ name, category }));
        });
        return { kind, skills: skillList(skills) };
      }
      return { kind, status: sessionStatus(info, this.spool.activeTurns(topic_id), subagents) };
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
      if (existing.digest !== digest) throw new Error('BFF 重复使用了命令 ID');
      return;
    }

    const finish = (status: CommandResult['status'], fields?: Partial<CommandResult>) => {
      if (this.spool.begin(id, digest)) this.spool.finish(id, { ...result(id, status, fields) });
    };
    if (command.kind === 'create') {
      if (binding) {
        finish('error', { error: '此话题已绑定 Hermes 会话' });
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
          throw new Error('新建的 Hermes 会话标识与预期不符');
        }
        const created = { topicId, sessionId: snapshot.sessionId, profileId: gateway.identity.profileId, profileRef: ref };
        this.spool.finish(id, { ...result(id, 'ok', { session_id: created.sessionId }) }, created);
        this.#bindings.set(topicId, created);
        const session: Session = { binding: created, gateway, targets: new Map(), reasoning: new Map() };
        if (gateway.connected) {
          this.#sessions.set(topicId, session);
          session.buffer = {
            ...buffer, frames: buffer.frames.filter((frame) => object(frame.params)?.session_id === created.sessionId),
          };
          this.#restoreSnapshot(session, snapshot);
          await this.#enableReasoning(session);
        }
      } catch (error) {
        this.#failedWrite(id, error);
      } finally {
        delete profile.creating;
      }
      return;
    }

    if (!binding || binding.profileRef !== ref || binding.sessionId !== command.session_id) {
      finish('error', { error: '无法验证 Hermes 会话绑定' });
      return;
    }
    let session: Session;
    try {
      session = await this.#attach(binding);
    } catch (error) {
      if (!knownRefusal(error)) throw error;
      finish('error', { error: '此配置档案下的 Hermes 会话不可用' });
      return;
    }
    if (!current() || !session.gateway.connected) return;
    if (command.kind === 'select_reasoning') {
      if (!this.spool.begin(id, digest)) return;
      try {
        const snapshot = parseSessionSnapshot(await session.gateway.rpc('session.resume', {
          session_id: binding.sessionId, omit_messages: true,
        }));
        this.#checkSnapshot(session, snapshot);
        let receipt = result(id, 'unknown', { error: 'Hermes 无法确认思考强度是否已切换。' });
        if (snapshot.running || snapshot.pending.length) {
          receipt = result(id, 'error', { error: '请等待当前回复完成后再切换思考强度。' });
        } else if (current() && session.gateway.connected) {
          const reply = await session.gateway.rpc('session.mutate', {
            session_id: binding.sessionId, request_id: id, operation: 'reasoning', payload: command.body,
            expected_revision: canonicalInteger(snapshot.revision),
            expected_generation: canonicalInteger(snapshot.executionGeneration),
          }, id);
          if (reply.session_id === binding.sessionId && reply.operation === 'reasoning' && reply.effort === command.body.effort) {
            if (reply.status === 'deferred') {
              receipt = result(id, 'unknown', { error: 'Hermes 已安排稍后切换思考强度。请在回复结束后重新确认档位。' });
            } else if (reply.status === undefined && isRevision(reply.revision) && isRevision(reply.execution_generation)) {
              receipt = result(id, 'ok');
            }
          }
        }
        this.spool.finish(id, { ...receipt });
      } catch (error) {
        if (error instanceof GatewayRefusal && (error.code === -32601 || error.reason === 'invalid_params')) {
          this.spool.finish(id, { ...result(id, 'error', { error: '当前 Hermes 网关版本不支持切换思考强度。' }) });
        } else {
          this.#failedWrite(id, error);
        }
      }
      return;
    }
    if (command.kind === 'model_options' || command.kind === 'select_model') {
      if (!this.spool.begin(id, digest)) return;
      if (command.kind === 'select_model' && command.body.global === true) {
        this.spool.finish(id, { ...result(id, 'error', {
          error: '当前网关模式不支持保存默认模型，请使用 HTTP Runs 模式。',
        }) });
        return;
      }
      try {
        const catalog = modelCatalog(await session.gateway.rpc('model.options', { session_id: binding.sessionId }));
        let receipt = result(id, 'ok', { model_result: { type: 'catalog', catalog } });
        if (command.kind === 'select_model') {
          const { provider, model } = command.body;
          receipt = result(id, 'error', { error: '此模型已不可用，请重新打开 /model。' });
          if (hasModel(catalog, { provider, model })) {
            const snapshot = parseSessionSnapshot(await session.gateway.rpc('session.resume', {
              session_id: binding.sessionId, omit_messages: true,
            }));
            this.#checkSnapshot(session, snapshot);
            // 将模型切换确认绑定到发出确认时的空闲版本。
            if (snapshot.running || snapshot.pending.length) {
              receipt = result(id, 'error', { error: '请等待当前回复完成后再切换模型。' });
            } else if (current() && session.gateway.connected) {
              const reply = await session.gateway.rpc('session.mutate', {
                session_id: binding.sessionId, request_id: id, operation: 'model',
                payload: { provider, model, ...(command.body.confirm && { confirm: command.body.confirm }) },
                expected_revision: canonicalInteger(snapshot.revision),
                expected_generation: canonicalInteger(snapshot.executionGeneration),
              }, id);
              receipt = result(id, 'unknown', { error: 'Hermes 无法确认模型选择' });
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
          this.spool.finish(id, { ...result(id, 'error', { error: '当前 Hermes 网关版本不支持选择模型' }) });
        } else {
          this.#failedWrite(id, error);
        }
      }
      return;
    }
    if (command.kind === 'interrupt') {
      const turn = this.spool.activeTurns(topicId).find((item) => item.submissionId === command.body.submission_id);
      if (!turn) {
        finish('error', { error: '此消息已结束执行' });
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
        finish('error', { error: '此消息已结束执行' });
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
        finish('error', { control_status: 'closed', error: '此请求已过期或已回答。' });
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
        finish('error', { error: '无法为此请求提交该回答' });
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
            control_status: 'closed', error: '此请求已过期或已回答。',
          }) });
        } else {
          this.spool.finish(id, { ...result(id, 'unknown', { error: 'Hermes 无法确认回答' }) });
        }
      } catch (error) {
        if (error instanceof GatewayRefusal && ['stale_generation', 'approval_not_pending'].includes(error.reason ?? '')) {
          this.spool.finish(id, { ...result(id, 'error', {
            control_status: 'closed', error: '此请求已过期或已回答。',
          }) });
        } else {
          this.#failedWrite(id, error);
        }
      }
      return;
    }

    const files: string[] = [];
    const images: { path: string; mime: string }[] = [];
    try {
      for (const [index, attachment] of (command.body.attachments ?? []).entries()) {
        const content_base64 = (await attachmentBytes(this.downloadAttachment, id, index + 1, attachment)).toString('base64');
        const name = attachmentFilename(attachment.name);
        if (attachment.mime.startsWith('image/')) {
          const image = await session.gateway.rpc('image.attach_bytes', { session_id: binding.sessionId, filename: name, content_base64 });
          if (image.attached !== true || !text(image.path, 4096) || image.mime !== attachment.mime) throw new Error('无法暂存图片');
          images.push({ path: image.path, mime: attachment.mime });
        } else {
          const file = await session.gateway.rpc('file.attach', { session_id: binding.sessionId, name,
            data_url: `data:${attachment.mime};base64,${content_base64}` });
          if (file.attached !== true || !text(file.ref_text, 4096) || !file.ref_text.startsWith('@file:')) throw new Error('无法暂存文件');
          files.push(file.ref_text);
        }
      }
    } catch {
      if (current()) finish('error', { error: 'Hermes 无法读取附件，请重新发送。' });
      return;
    }
    let snapshot: SessionSnapshot | undefined;
    if (command.body.steer_if_running === true && !command.body.attachments?.length) {
      snapshot = parseSessionSnapshot(await session.gateway.rpc('session.resume', {
        session_id: binding.sessionId, omit_messages: true,
      }));
      this.#checkSnapshot(session, snapshot);
    }
    if (!current() || !session.gateway.connected || !this.spool.begin(id, digest,
      snapshot?.running ? undefined : { topicId, submissionId: command.body.submission_id })) return;
    if (snapshot?.running) {
      try {
        const reply = await session.gateway.rpc('session.steer', {
          session_id: binding.sessionId, text: command.body.text, execution_generation: canonicalInteger(snapshot.executionGeneration),
        }, id);
        const matches = reply.text === command.body.text && isRevision(reply.execution_generation)
          && String(reply.execution_generation) === snapshot.executionGeneration && isRevision(reply.authority_epoch)
          && String(reply.authority_epoch) === snapshot.authorityEpoch;
        // 原生 rejected 也可能已送达，只有 delivered:false 能安全转为普通消息。
        if (!(matches && reply.status === 'rejected' && reply.delivered === false)) {
          const accepted = matches && reply.status === 'queued' && reply.delivered === undefined;
          this.spool.finish(id, { ...result(id, accepted ? 'ok' : 'unknown', {
            steering: true, ...(!accepted && { error: '无法确认消息是否送达，请先查看回复。' }),
          }) });
          return;
        }
      } catch (error) {
        if (!(knownRefusal(error) && (error.code === -32601
          || ['stale_generation', 'unsupported_control'].includes(error.reason ?? '')))) {
          this.#failedWrite(id, error, true);
          if (!knownRefusal(error)) session.gateway.close();
          return;
        }
      }
    }
    session.buffer = { frames: [], bytes: 0 };
    try {
      if (snapshot?.running) this.spool.addIntent(topicId, command.body.submission_id);
      const text = [command.body.text, files.join('\n')].filter((part) => part.trim()).join('\n\n') || '请查看上传的图片。';
      const receipt = parseAdmissionReceipt(await session.gateway.rpc('prompt.submit', {
        session_id: binding.sessionId, submission_id: command.body.submission_id,
        text, api_text: `${text}\n\n${deliveryInstructions(binding.profileRef, binding.sessionId)}`,
        ...(images.length && { attachments: images }),
        ...(session.gateway.clarifyBatch ? { clarify_batch: true } : {}),
      }, id));
      if (receipt.kind === 'voice_stopped') {
        this.spool.finish(id, { ...result(id, 'error', { error: 'Hermes 已将此输入用作停止语音交互的指令' }) });
      } else {
        this.#checkReceipt(session, receipt);
        this.spool.finish(id, { ...result(id, 'ok', { admission_id: receipt.admissionId }) }, undefined, {
          topicId, admissionId: receipt.admissionId, submissionId: command.body.submission_id, text: '', status: 'queued',
        });
        // 先归并 RPC 等待期间收到的过程和回复，再用回执对账。
        this.#drain(session);
        this.#applyReceipt(session, receipt, command.body.submission_id);
      }
    } catch (error) {
      this.#failedWrite(id, error);
      if (!knownRefusal(error)) session.gateway.close();
    } finally {
      this.#drain(session);
    }
  }

  #failedWrite(id: string, error: unknown, steering = false): void {
    const refused = knownRefusal(error);
    const reason = refused && error.reason && /^[a-z0-9_]{1,64}$/u.test(error.reason) ? error.reason : undefined;
    this.spool.finish(id, { ...result(id, refused ? 'error' : 'unknown', {
      ...(steering && { steering: true }),
      error: refused ? `Hermes 拒绝了请求${reason ? `（${reason}）` : ''}`
        : 'Hermes 无法确认执行结果',
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
      binding, gateway, cursor: this.spool.cursor(binding.topicId), buffer: { frames: [], bytes: 0 },
      targets: new Map(), reasoning: new Map(),
    };
    this.#sessions.set(binding.topicId, session);
    try {
      // 先查询增量再恢复订阅，以便网关补发回放与订阅之间的事件。
      const replay = await gateway.rpc('session.events.since', {
        session_id: binding.sessionId,
        ...(session.cursor && { replay_epoch: session.cursor.epoch }),
        last_sequence: canonicalInteger(session.cursor?.sequence ?? '0'),
      });
      if (!Array.isArray(replay.events) || typeof replay.snapshot_required !== 'boolean') {
        throw new Error('Hermes 回放响应无效');
      }
      if (!replay.snapshot_required) {
        for (const params of replay.events) this.#frame(session, { jsonrpc: '2.0', method: 'event', params });
      }
      const snapshot = parseSessionSnapshot(await gateway.rpc('session.resume', {
        session_id: binding.sessionId, omit_messages: true,
      }));
      this.#checkSnapshot(session, snapshot);
      this.#restoreSnapshot(session, snapshot);
      await this.#enableReasoning(session);
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

  async #enableReasoning({ binding, gateway }: Session): Promise<void> {
    try {
      const params = { session_id: binding.sessionId, key: 'show_reasoning' };
      const current = await gateway.rpc('config.get', params, undefined, queryTimeout);
      if (current.value === '0') await gateway.rpc('config.set', { ...params, value: 'on' }, undefined, queryTimeout);
    } catch {
      // 旧网关可能不支持此会话显示选项，仍可投影它发送的过程事件。
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
    const cursor = { epoch: snapshot.replayEpoch, sequence: snapshot.lastSequence };
    if (session.cursor && session.cursor.epoch !== cursor.epoch) session.reasoning.clear();
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
    if (!session.cursor || session.cursor.epoch !== cursor.epoch || BigInt(session.cursor.sequence) <= BigInt(cursor.sequence)) {
      const title = topicTitleEvent(session.binding, snapshot.title, [cursor.epoch, cursor.sequence]);
      this.spool.record(session.binding.topicId, title ? [title] : [], cursor);
      session.cursor = cursor;
    }
  }

  #checkReceipt(session: Session, receipt: CanonicalAdmission): void {
    if (receipt.profileId !== session.binding.profileId || receipt.sessionId !== session.binding.sessionId) {
      throw new Error('Hermes 受理记录的作用域不符');
    }
  }

  async #receipt(session: Session, admissionId: string): Promise<CanonicalAdmission> {
    const receipt = parseAdmissionReceipt(await session.gateway.rpc('prompt.receipt', {
      session_id: session.binding.sessionId, admission_id: admissionId, include_result: true,
    }));
    if (receipt.kind !== 'admission' || receipt.admissionId !== admissionId) throw new Error('Hermes 受理记录 ID 无效');
    this.#checkReceipt(session, receipt);
    return receipt;
  }

  #applyReceipt(session: Session, receipt: CanonicalAdmission, submissionId: string | null): void {
    const previous = this.spool.turn(session.binding.topicId, receipt.admissionId);
    const status = receiptStatus(receipt);
    if (previous?.status === 'streaming' && status === 'queued') return;
    if (previous && ['final', 'failed', 'cancelled'].includes(previous.status) &&
      (previous.status !== status || previous.text || previous.attachments?.length || !receipt.finalText)) return;
    const text = receipt.finalText || previous?.text || '';
    if (previous?.status === status && previous.submissionId === submissionId && previous.text === text
      && status !== 'queued') return;
    const reasoning = session.reasoning.get(receipt.admissionId);
    const terminal = status === 'final' || status === 'cancelled' || status === 'failed';
    if (terminal) session.reasoning.delete(receipt.admissionId);
    this.#setTurn(session, {
      topicId: session.binding.topicId, admissionId: receipt.admissionId, submissionId, text, status,
      process: terminal && reasoning ? addProcessText(previous?.process, 'reasoning', redactProcessText(reasoning)) : previous?.process,
    }, [receipt.admissionId, 'receipt', status, receipt.authorityEpoch, receipt.executionGeneration ?? ''],
    terminal);
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
        throw new Error('Hermes 补发事件超出缓冲区容量');
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
    return gateway.send({ jsonrpc: '2.0', id, error: { code: -32601, message: '客户端不支持此请求' } });
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
    let title: ReturnType<typeof topicTitleEvent>;
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
      title = topicTitleEvent(binding, projection.title, key);
      for (const receipt of projection.pending ?? []) {
        if (this.spool.hasIntent(binding.topicId, receipt.submissionId)) {
          this.#checkReceipt(session, receipt);
          this.#applyReceipt(session, receipt, receipt.submissionId);
        }
      }
    } else if (projection && 'admissionId' in projection && projection.admissionId) {
      const admissionId = projection.admissionId;
      const existing = this.spool.turn(binding.topicId, admissionId);
      if (projection.type === 'reasoning.delta' && existing?.submissionId
        && !['final', 'failed', 'cancelled'].includes(existing.status)) {
        // 保留完整思考块以隐藏跨增量的凭据，重连从上一条已持久化事件补拉。
        const value = (session.reasoning.get(admissionId) ?? '') + projection.text;
        session.reasoning.set(admissionId, boundedText(value, maxReasoningBytes));
        return;
      }
      const previousText = existing?.text ?? '';
      let text = previousText;
      let process = existing?.process;
      let status: Turn['status'] = 'streaming';
      let publishMessage = false;
      let submissionId = existing?.submissionId ?? null;
      if (projection.type !== 'message.start' && projection.type !== 'reasoning.delta') {
        const reasoning = session.reasoning.get(admissionId);
        if (reasoning) {
          session.reasoning.delete(admissionId);
          process = addProcessText(process, 'reasoning', redactProcessText(reasoning));
          publishMessage = process !== existing?.process;
        }
      }
      if (projection.type === 'message.delta' && projection.text) {
        text = previousText + projection.text;
        publishMessage = true;
      } else if (projection.type === 'message.interim') {
        process = addProcessText(process, 'commentary', redactProcessText(projection.text));
        if (projection.alreadyStreamed) text = removeStreamedCommentary(text, projection.text);
        publishMessage = text !== previousText || process !== existing?.process;
      } else if (projection.type === 'reasoning.available') {
        process = addProcessText(process, 'reasoning', redactProcessText(projection.text));
        publishMessage = process !== existing?.process;
      } else if (projection.type === 'tool.start' || projection.type === 'tool.complete') {
        if (projection.type === 'tool.start' && text) {
          // 原版网关将已经流式发送的阶段说明放在工具启动前的文本增量里。
          process = addProcessText(process, 'commentary', redactProcessText(text));
          text = '';
        }
        process = updateProcessTool(process, projection.toolId, projection.name, projection.status);
        publishMessage = text !== previousText || process !== existing?.process;
      } else if (projection.type === 'message.complete') {
        const provided = projection.submissionId;
        if (!submissionId && provided && this.spool.hasIntent(binding.topicId, provided)) submissionId = provided;
        status = outcomeStatus(projection.outcome);
        text = projection.responseReused ? previousText || projection.text || ''
          : projection.text || previousText;
        if (!process?.some((step) => step.kind === 'reasoning')) {
          process = addProcessText(process, 'reasoning', projection.reasoning && redactProcessText(projection.reasoning));
        }
        publishMessage = true;
      }
      // 已结束的回复保留已确认的终态。
      if (projection.type !== 'reasoning.delta' && (!existing || !['final', 'failed', 'cancelled'].includes(existing.status))) {
        this.#setTurn(session, { topicId: binding.topicId, admissionId, submissionId, text, status, process },
          key, publishMessage, cursor);
        session.cursor = cursor;
        return;
      }
    }
    this.spool.record(binding.topicId, title ? [title] : [], cursor);
    session.cursor = cursor;
  }

  #setTurn(session: Session, turn: Turn, key: string[], publishMessage = false, cursor?: Cursor): void {
    const receivingKey = JSON.stringify([turn.topicId, turn.admissionId]);
    if (this.#receiving.has(receivingKey)) return;
    if (turn.status === 'final' && this.receiveAttachments && hasReceivedAttachments(turn.text)) {
      this.#receiving.add(receivingKey);
      // 先保留原文及未终结状态；传输中断后可按持久化回执重试。
      this.#recordTurn(session, { ...turn, status: 'streaming' }, [...key, 'attachments-pending'], false, cursor);
      void this.receiveAttachments(session.binding.profileRef, turn.topicId, turn.admissionId, turn.text).then((received) => {
        if (!this.#closed) this.#recordTurn(session, { ...turn, ...received }, key, true);
      }).catch(() => {
        if (!this.#closed) session.gateway.close();
      }).finally(() => { this.#receiving.delete(receivingKey); });
      return;
    }
    this.#recordTurn(session, turn, key, publishMessage, cursor);
  }

  #recordTurn(session: Session, turn: Turn, key: string[], publishMessage = false, cursor?: Cursor): void {
    const topicId = session.binding.topicId;
    const eventId = (kind: string) => stableId([topicId, kind, ...key]);
    const frames: ConnectorEvent[] = [];
    const text = turn.text.trim() ? boundedText(turn.text, 256 * 1024) : '';
    if (publishMessage && (text || turn.process?.length || turn.attachments?.length)) {
      frames.push({
        type: 'message', event_id: eventId('message'), topic_id: topicId,
        message_id: stableId([topicId, 'message', turn.admissionId]), text,
        status: turn.status === 'streaming' ? 'streaming' : 'final',
        ...(turn.process?.length ? { process: turn.process } : {}),
        ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
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
      // 回放可能复用同一个事件 ID，默认提示保持字节一致，由客户端翻译。
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
