import pg from "pg";
import type { PoolClient } from "pg";

export function openStore(connectionString: string) {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 5_000 });

  return {
    query: pool.query.bind(pool),
    onError: (handle: (error: Error) => void) => pool.on("error", handle),
    close: () => pool.end(),
    async migrate() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS devices (
          id uuid PRIMARY KEY,
          token_hash bytea NOT NULL UNIQUE,
          name text NOT NULL
        );
        CREATE TABLE IF NOT EXISTS topics (
          id uuid PRIMARY KEY,
          profile_ref text NOT NULL,
          title text NOT NULL,
          status text NOT NULL DEFAULT 'creating',
          error text,
          session_id text,
          UNIQUE (profile_ref, session_id),
          created_at timestamptz NOT NULL DEFAULT now()
        );
        ALTER TABLE topics ADD COLUMN IF NOT EXISTS reasoning_effort text;
        ALTER TABLE topics ADD COLUMN IF NOT EXISTS reasoning_status text;
        ALTER TABLE topics ADD COLUMN IF NOT EXISTS auto_title boolean NOT NULL DEFAULT false;
        ALTER TABLE topics ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
        ALTER TABLE topics ADD COLUMN IF NOT EXISTS updated_at timestamptz;
        CREATE TABLE IF NOT EXISTS messages (
          id uuid PRIMARY KEY,
          topic_id uuid NOT NULL REFERENCES topics(id),
          position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
          data jsonb NOT NULL
        );
        CREATE INDEX IF NOT EXISTS messages_topic_position_idx ON messages (topic_id, position);
        CREATE TABLE IF NOT EXISTS submissions (
          id uuid PRIMARY KEY,
          topic_id uuid NOT NULL REFERENCES topics(id),
          message_id uuid NOT NULL REFERENCES messages(id),
          data jsonb NOT NULL
        );
        CREATE TABLE IF NOT EXISTS submission_attachments (
          submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
          position smallint NOT NULL,
          content bytea NOT NULL,
          PRIMARY KEY (submission_id, position)
        );
        CREATE TABLE IF NOT EXISTS controls (
          id uuid PRIMARY KEY,
          topic_id uuid NOT NULL REFERENCES topics(id),
          data jsonb NOT NULL
        );
        ALTER TABLE controls ADD COLUMN IF NOT EXISTS position bigint GENERATED ALWAYS AS IDENTITY;
        CREATE TABLE IF NOT EXISTS commands (
          id uuid PRIMARY KEY,
          topic_id uuid NOT NULL REFERENCES topics(id),
          payload jsonb NOT NULL,
          result jsonb,
          dispatched boolean NOT NULL DEFAULT false,
          receipt jsonb NOT NULL,
          position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS commands_pending_idx ON commands (position) WHERE result IS NULL;
        UPDATE commands SET result = jsonb_build_object(
          'type', 'command_result', 'command_id', id, 'status', 'error'
        ) WHERE result IS NULL AND payload->>'kind' = 'summarize_title';
        -- shortcut: 旧消息没有时间戳，按最近命令推算历史活动，有消息时间戳时再从消息回填。
        UPDATE topics AS t SET updated_at = GREATEST(t.created_at, activity.last_command_at)
        FROM (
          SELECT old.id, max(c.created_at) AS last_command_at
          FROM topics AS old LEFT JOIN commands AS c ON c.topic_id = old.id
            AND c.payload->>'kind' IN ('submit', 'respond', 'select_model', 'select_reasoning', 'summarize_title')
          WHERE old.updated_at IS NULL
          GROUP BY old.id
        ) AS activity WHERE t.id = activity.id AND t.updated_at IS NULL;
        ALTER TABLE topics ALTER COLUMN updated_at SET DEFAULT now(), ALTER COLUMN updated_at SET NOT NULL;
        CREATE TABLE IF NOT EXISTS inbox (
          id uuid PRIMARY KEY,
          profile_ref text NOT NULL,
          data jsonb NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS connector_ingest (
          kind text NOT NULL,
          id uuid NOT NULL,
          payload jsonb NOT NULL,
          PRIMARY KEY (kind, id)
        );
      `);
    },
    async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // shortcut: 单账户的写入共用一把锁。部署多租户时，按账户加锁。
        await client.query("SELECT pg_advisory_xact_lock(41831011)");
        const result = await run(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export type Store = ReturnType<typeof openStore>;
