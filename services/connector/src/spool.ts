import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Attachment, Control, MessageProcessStep, ModelSelection, ReasoningEffort } from '@hermes-mobile/protocol';
import type { JsonObject } from './gateway.js';

type CommandRow = { digest: string; result: string | null };
export type Binding = { topicId: string; sessionId: string; profileId: string; profileRef: string };
export type NativePending = { commandId: string; name: string; binding: Binding; mutating?: boolean };
export type Cursor = { epoch: string; sequence: string };
export type Turn = {
  topicId: string;
  admissionId: string;
  submissionId: string | null;
  replyMessageId?: string;
  text: string;
  process?: MessageProcessStep[];
  attachments?: Attachment[];
  status: 'queued' | 'streaming' | 'final' | 'failed' | 'cancelled' | 'unknown';
};

type TurnRow = Omit<Turn, 'process' | 'attachments' | 'replyMessageId'> & {
  process: string | null; attachments: string | null; replyMessageId: string | null;
};

function readTurn({ process, attachments, replyMessageId, ...turn }: TurnRow): Turn {
  return { ...turn, ...(replyMessageId ? { replyMessageId } : {}),
    ...(process ? { process: JSON.parse(process) as MessageProcessStep[] } : {}),
    ...(attachments ? { attachments: JSON.parse(attachments) as Attachment[] } : {}) };
}

export class Spool {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, 'a', 0o600));
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT, acknowledged INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS bindings (
        topic_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, profile_id TEXT NOT NULL,
        profile_ref TEXT NOT NULL, UNIQUE(profile_ref, session_id)
      );
      CREATE TABLE IF NOT EXISTS native_pending (
        command_id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, body TEXT NOT NULL, mutating INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS native_runtime_capabilities (profile_ref TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS model_selections (
        topic_id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reasoning_selections (
        topic_id TEXT PRIMARY KEY, effort TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cursors (
        topic_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, sequence TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        topic_id TEXT NOT NULL, admission_id TEXT NOT NULL, submission_id TEXT,
        text TEXT NOT NULL, status TEXT NOT NULL, process TEXT, PRIMARY KEY(topic_id, admission_id)
      );
      CREATE TABLE IF NOT EXISTS intents (
        topic_id TEXT NOT NULL, submission_id TEXT NOT NULL, PRIMARY KEY(topic_id, submission_id)
      );
      CREATE TABLE IF NOT EXISTS controls (
        topic_id TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(topic_id, id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, body TEXT NOT NULL
      );
    `);
    this.#transaction(() => {
      if (!this.#db.prepare('PRAGMA table_info(native_pending)').all().some((column) => column.name === 'mutating')) {
        this.#db.exec(`ALTER TABLE native_pending RENAME TO native_pending_previous;
          CREATE TABLE native_pending (
            command_id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, body TEXT NOT NULL, mutating INTEGER NOT NULL DEFAULT 1
          );
          INSERT INTO native_pending (command_id, topic_id, body) SELECT command_id, topic_id, body FROM native_pending_previous;
          DROP TABLE native_pending_previous;`);
      }
      this.#db.exec('CREATE UNIQUE INDEX IF NOT EXISTS native_mutation_topic ON native_pending (topic_id) WHERE mutating = 1');
      if (!this.#db.prepare('PRAGMA table_info(bindings)').all().some((column) => column.name === 'transport')) {
        this.#db.exec('ALTER TABLE bindings ADD COLUMN transport TEXT');
      }
      if (!this.#db.prepare('PRAGMA table_info(turns)').all().some((column) => column.name === 'process')) {
        this.#db.exec('ALTER TABLE turns ADD COLUMN process TEXT');
      }
      if (!this.#db.prepare('PRAGMA table_info(turns)').all().some((column) => column.name === 'attachments')) {
        this.#db.exec('ALTER TABLE turns ADD COLUMN attachments TEXT');
      }
      if (!this.#db.prepare('PRAGMA table_info(turns)').all().some((column) => column.name === 'reply_message_id')) {
        this.#db.exec('ALTER TABLE turns ADD COLUMN reply_message_id TEXT');
      }
    });
  }

  #transaction(write: () => void): void {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      write();
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  command(id: string): CommandRow | undefined {
    return this.#db.prepare('SELECT digest, result FROM commands WHERE id = ?').get(id) as CommandRow | undefined;
  }

  begin(id: string, digest: string, intent?: { topicId: string; submissionId: string }): boolean {
    let inserted = false;
    this.#transaction(() => {
      inserted = this.#db.prepare('INSERT OR IGNORE INTO commands (id, digest) VALUES (?, ?)').run(id, digest).changes === 1;
      if (inserted && intent) this.addIntent(intent.topicId, intent.submissionId);
    });
    return inserted;
  }

  addIntent(topicId: string, submissionId: string): void {
    this.#db.prepare('INSERT OR IGNORE INTO intents (topic_id, submission_id) VALUES (?, ?)').run(topicId, submissionId);
  }

  hasIntent(topicId: string, submissionId: string): boolean {
    return this.#db.prepare('SELECT 1 FROM intents WHERE topic_id = ? AND submission_id = ?')
      .get(topicId, submissionId) !== undefined;
  }

  controls(topicId: string): Control[] {
    return this.#db.prepare('SELECT body FROM controls WHERE topic_id = ?')
      .all(topicId).map((row) => JSON.parse(row.body as string) as Control);
  }

  modelSelection(topicId: string): ModelSelection | undefined {
    return this.#db.prepare('SELECT provider, model FROM model_selections WHERE topic_id = ?')
      .get(topicId) as ModelSelection | undefined;
  }

  reasoningEffort(topicId: string): ReasoningEffort | undefined {
    return this.#db.prepare('SELECT effort FROM reasoning_selections WHERE topic_id = ?')
      .get(topicId)?.effort as ReasoningEffort | undefined;
  }

  finish(id: string, result: JsonObject, binding?: Binding, turn?: Turn,
    selection?: (ModelSelection | { effort: ReasoningEffort | null }) & { topicId: string }): void {
    this.#transaction(() => {
      if (this.command(id)?.result !== null) return;
      if (binding) {
        this.#db.prepare(`
          INSERT INTO bindings (topic_id, session_id, profile_id, profile_ref) VALUES (?, ?, ?, ?)
        `).run(binding.topicId, binding.sessionId, binding.profileId, binding.profileRef);
      }
      if (turn) this.#storeTurn(turn);
      if (selection && 'effort' in selection) {
        if (selection.effort === null) {
          this.#db.prepare('DELETE FROM reasoning_selections WHERE topic_id = ?').run(selection.topicId);
        } else {
          this.#db.prepare(`INSERT INTO reasoning_selections (topic_id, effort) VALUES (?, ?)
            ON CONFLICT (topic_id) DO UPDATE SET effort = excluded.effort`).run(selection.topicId, selection.effort);
        }
      } else if (selection) {
        this.#db.prepare(`
          INSERT INTO model_selections (topic_id, provider, model) VALUES (?, ?, ?)
          ON CONFLICT (topic_id) DO UPDATE SET provider = excluded.provider, model = excluded.model
        `).run(selection.topicId, selection.provider, selection.model);
      }
      this.#db.prepare('UPDATE commands SET result = ? WHERE id = ? AND result IS NULL')
        .run(JSON.stringify(result), id);
    });
  }

  transport(topicId: string): 'http' | 'canonical' | undefined {
    const binding = this.#db.prepare('SELECT session_id, transport FROM bindings WHERE topic_id = ?').get(topicId);
    if (!binding) return;
    return binding.transport === 'http' || (binding.transport === null && String(binding.session_id).startsWith('mobile_'))
      ? 'http' : 'canonical';
  }

  nativeRuntimeSupported(profileRef: string): boolean {
    return this.#db.prepare('SELECT 1 FROM native_runtime_capabilities WHERE profile_ref = ?').get(profileRef) !== undefined;
  }

  markNativeRuntimeSupported(profileRef: string): void {
    this.#db.prepare('INSERT OR IGNORE INTO native_runtime_capabilities (profile_ref) VALUES (?)').run(profileRef);
  }

  nativePending(topicId?: string): NativePending[] {
    const rows = topicId === undefined ? this.#db.prepare('SELECT body FROM native_pending WHERE mutating = 1').all()
      : this.#db.prepare('SELECT body FROM native_pending WHERE topic_id = ? AND mutating = 1').all(topicId);
    return rows.map((row) => JSON.parse(row.body as string) as NativePending);
  }

  nativeRequests(topicId?: string): NativePending[] {
    const rows = topicId === undefined ? this.#db.prepare('SELECT body FROM native_pending').all()
      : this.#db.prepare('SELECT body FROM native_pending WHERE topic_id = ?').all(topicId);
    return rows.map((row) => JSON.parse(row.body as string) as NativePending);
  }

  beginNative(pending: NativePending): void {
    this.#transaction(() => {
      const { binding, commandId } = pending;
      const current = this.binding(binding.topicId);
      if (this.command(commandId)?.result !== null || current?.sessionId !== binding.sessionId
        || current.profileRef !== binding.profileRef || current.profileId !== binding.profileId
        || (pending.mutating !== false && (this.activeTurns(binding.topicId).length || this.nativePending(binding.topicId).length))) {
        throw new Error('请等待当前会话任务结束并确认结果后再执行此命令。');
      }
      this.#db.prepare('INSERT INTO native_pending (command_id, topic_id, body, mutating) VALUES (?, ?, ?, ?)')
        .run(commandId, binding.topicId, JSON.stringify(pending), pending.mutating === false ? 0 : 1);
    });
  }

  /** Publish a native receipt and any authorized session continuation as one durable change. */
  finishNative(id: string, result: JsonObject, sessionId?: string): void {
    this.#transaction(() => {
      const raw = this.#db.prepare('SELECT body FROM native_pending WHERE command_id = ?').get(id);
      if (!raw) return; // A replayed final receipt must not restore an older binding.
      const { binding, name, mutating } = JSON.parse(raw.body as string) as NativePending;
      if (mutating === false && sessionId !== undefined) throw new Error('此原生命令不能替换会话绑定。');
      if (mutating === false && name === 'title' && result.status === 'ok'
        && this.binding(binding.topicId)?.sessionId !== binding.sessionId && result.native_result) {
        const { title: _title, ...historical } = result.native_result as JsonObject;
        result = { ...result, native_result: historical };
      }
      if (result.status === 'ok' && mutating !== false) {
        const current = this.binding(binding.topicId);
        if (current?.sessionId !== binding.sessionId || current.profileRef !== binding.profileRef
          || current.profileId !== binding.profileId || this.activeTurns(binding.topicId).length) {
          throw new Error('原生命令执行后的会话绑定已改变，结果需要确认。');
        }
        if (sessionId && sessionId !== binding.sessionId) {
          const transport = this.transport(binding.topicId);
          const updated = this.#db.prepare(`UPDATE bindings SET session_id = ?, transport = ?
            WHERE topic_id = ? AND session_id = ? AND profile_ref = ? AND profile_id = ?`)
            .run(sessionId, transport!, binding.topicId, binding.sessionId, binding.profileRef, binding.profileId);
          if (updated.changes !== 1) throw new Error('原生命令的会话续接未确认。');
          this.#db.prepare('DELETE FROM cursors WHERE topic_id = ?').run(binding.topicId);
          this.#db.prepare('DELETE FROM controls WHERE topic_id = ?').run(binding.topicId);
        }
        if ((name === 'new' || name === 'reset') && (result.native_result as JsonObject | undefined)?.reset === true) {
          this.#db.prepare('DELETE FROM controls WHERE topic_id = ?').run(binding.topicId);
          this.#db.prepare('DELETE FROM model_selections WHERE topic_id = ?').run(binding.topicId);
          this.#db.prepare('DELETE FROM reasoning_selections WHERE topic_id = ?').run(binding.topicId);
        }
      }
      this.#db.prepare('UPDATE commands SET result = ?, acknowledged = 0 WHERE id = ?')
        .run(JSON.stringify(result), id);
      if (result.status !== 'unknown') this.#db.prepare('DELETE FROM native_pending WHERE command_id = ?').run(id);
    });
  }

  unfinished(): string[] {
    return this.#db.prepare('SELECT id FROM commands WHERE result IS NULL').all()
      .map((row) => row.id as string);
  }

  results(sent: Set<string>, limit: number): { id: string; body: JsonObject }[] {
    return this.#db.prepare(`
      SELECT id, result FROM commands WHERE result IS NOT NULL AND acknowledged = 0
        AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY rowid LIMIT ?
    `).all(JSON.stringify([...sent]), limit).map((row) => ({ id: row.id as string, body: JSON.parse(row.result as string) as JsonObject }));
  }

  binding(topicId: string): Binding | undefined {
    return this.#db.prepare(`
      SELECT topic_id AS topicId, session_id AS sessionId, profile_id AS profileId, profile_ref AS profileRef
      FROM bindings WHERE topic_id = ?
    `).get(topicId) as Binding | undefined;
  }

  bindings(): Binding[] {
    return this.#db.prepare(`
      SELECT topic_id AS topicId, session_id AS sessionId, profile_id AS profileId, profile_ref AS profileRef FROM bindings
    `).all() as Binding[];
  }

  cursor(topicId: string): Cursor | undefined {
    return this.#db.prepare('SELECT epoch, sequence FROM cursors WHERE topic_id = ?').get(topicId) as Cursor | undefined;
  }

  turn(topicId: string, admissionId: string): Turn | undefined {
    const row = this.#db.prepare(`
      SELECT topic_id AS topicId, admission_id AS admissionId, submission_id AS submissionId,
        text, status, process, attachments, reply_message_id AS replyMessageId
      FROM turns WHERE topic_id = ? AND admission_id = ?
    `).get(topicId, admissionId) as TurnRow | undefined;
    return row && readTurn(row);
  }

  activeTurns(topicId: string): Turn[] {
    const rows = this.#db.prepare(`
      SELECT topic_id AS topicId, admission_id AS admissionId, submission_id AS submissionId,
        text, status, process, attachments, reply_message_id AS replyMessageId
      FROM turns WHERE topic_id = ? AND status IN ('queued', 'streaming', 'unknown')
    `).all(topicId) as TurnRow[];
    return rows.map(readTurn);
  }

  #storeTurn(turn: Turn): void {
    this.#db.prepare(`
      INSERT INTO turns (topic_id, admission_id, submission_id, text, status, process, attachments, reply_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (topic_id, admission_id)
      DO UPDATE SET submission_id = COALESCE(excluded.submission_id, turns.submission_id),
        text = excluded.text, status = excluded.status, process = excluded.process, attachments = excluded.attachments,
        reply_message_id = excluded.reply_message_id
    `).run(turn.topicId, turn.admissionId, turn.submissionId, turn.text, turn.status,
      turn.process ? JSON.stringify(turn.process) : null, turn.attachments ? JSON.stringify(turn.attachments) : null,
      turn.replyMessageId ?? null);
  }

  record(topicId: string, frames: { id: string; body: JsonObject }[], cursor?: Cursor, turn?: Turn, controls: Control[] = []): void {
    this.#transaction(() => {
      if (turn) this.#storeTurn(turn);
      const insert = this.#db.prepare('INSERT OR IGNORE INTO events (id, body) VALUES (?, ?)');
      for (const frame of frames) insert.run(frame.id, JSON.stringify(frame.body));
      for (const control of controls) {
        if (control.status === 'closed') {
          this.#db.prepare('DELETE FROM controls WHERE topic_id = ? AND id = ?').run(topicId, control.control_id);
        } else {
          this.#db.prepare(`
            INSERT INTO controls (topic_id, id, body) VALUES (?, ?, ?)
            ON CONFLICT (topic_id, id) DO UPDATE SET body = excluded.body
          `).run(topicId, control.control_id, JSON.stringify(control));
        }
      }
      if (cursor) {
        this.#db.prepare(`
          INSERT INTO cursors (topic_id, epoch, sequence) VALUES (?, ?, ?)
          ON CONFLICT (topic_id) DO UPDATE SET epoch = excluded.epoch, sequence = excluded.sequence
        `).run(topicId, cursor.epoch, cursor.sequence);
      }
    });
  }

  events(topics: Set<string>, sent: Set<string>, limit: number): { id: string; body: JsonObject }[] {
    return this.#db.prepare(`
      SELECT id, body FROM events WHERE json_extract(body, '$.topic_id') IN (SELECT value FROM json_each(?))
        AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY rowid LIMIT ?
    `).all(JSON.stringify([...topics]), JSON.stringify([...sent]), limit).map((row) => ({ id: row.id as string, body: JSON.parse(row.body as string) as JsonObject }));
  }

  ack(id: string, expectedResult?: string): void {
    if (expectedResult === undefined) this.#db.prepare('UPDATE commands SET acknowledged = 1 WHERE id = ?').run(id);
    else this.#db.prepare('UPDATE commands SET acknowledged = 1 WHERE id = ? AND result = ?').run(id, expectedResult);
    this.#db.prepare('DELETE FROM events WHERE id = ?').run(id);
  }

  close(): void {
    this.#db.close();
  }
}
