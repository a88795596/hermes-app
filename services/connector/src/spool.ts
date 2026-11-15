import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Attachment, Control, MessageProcessStep, ModelSelection, ReasoningEffort } from '@hermes-mobile/protocol';
import type { JsonObject } from './gateway.js';

type CommandRow = { digest: string; result: string | null };
export type Binding = { topicId: string; sessionId: string; profileId: string; profileRef: string };
export type Cursor = { epoch: string; sequence: string };
export type Turn = {
  topicId: string;
  admissionId: string;
  submissionId: string | null;
  text: string;
  process?: MessageProcessStep[];
  attachments?: Attachment[];
  status: 'queued' | 'streaming' | 'final' | 'failed' | 'cancelled' | 'unknown';
};

type TurnRow = Omit<Turn, 'process' | 'attachments'> & { process: string | null; attachments: string | null };

function readTurn({ process, attachments, ...turn }: TurnRow): Turn {
  return { ...turn, ...(process ? { process: JSON.parse(process) as MessageProcessStep[] } : {}),
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
      if (!this.#db.prepare('PRAGMA table_info(turns)').all().some((column) => column.name === 'process')) {
        this.#db.exec('ALTER TABLE turns ADD COLUMN process TEXT');
      }
      if (!this.#db.prepare('PRAGMA table_info(turns)').all().some((column) => column.name === 'attachments')) {
        this.#db.exec('ALTER TABLE turns ADD COLUMN attachments TEXT');
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
      if (inserted && intent) {
        this.#db.prepare('INSERT OR IGNORE INTO intents (topic_id, submission_id) VALUES (?, ?)')
          .run(intent.topicId, intent.submissionId);
      }
    });
    return inserted;
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
      SELECT topic_id AS topicId, admission_id AS admissionId, submission_id AS submissionId, text, status, process, attachments
      FROM turns WHERE topic_id = ? AND admission_id = ?
    `).get(topicId, admissionId) as TurnRow | undefined;
    return row && readTurn(row);
  }

  activeTurns(topicId: string): Turn[] {
    const rows = this.#db.prepare(`
      SELECT topic_id AS topicId, admission_id AS admissionId, submission_id AS submissionId, text, status, process, attachments
      FROM turns WHERE topic_id = ? AND status IN ('queued', 'streaming', 'unknown')
    `).all(topicId) as TurnRow[];
    return rows.map(readTurn);
  }

  #storeTurn(turn: Turn): void {
    this.#db.prepare(`
      INSERT INTO turns (topic_id, admission_id, submission_id, text, status, process, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (topic_id, admission_id)
      DO UPDATE SET submission_id = COALESCE(excluded.submission_id, turns.submission_id),
        text = excluded.text, status = excluded.status, process = excluded.process, attachments = excluded.attachments
    `).run(turn.topicId, turn.admissionId, turn.submissionId, turn.text, turn.status,
      turn.process ? JSON.stringify(turn.process) : null, turn.attachments ? JSON.stringify(turn.attachments) : null);
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

  ack(id: string): void {
    this.#db.prepare('UPDATE commands SET acknowledged = 1 WHERE id = ?').run(id);
    this.#db.prepare('DELETE FROM events WHERE id = ?').run(id);
  }

  close(): void {
    this.#db.close();
  }
}
