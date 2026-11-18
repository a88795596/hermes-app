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
        CREATE TABLE IF NOT EXISTS profile_preferences (
          profile_ref text PRIMARY KEY,
          alias text,
          avatar_mime text,
          avatar_content bytea,
          avatar_sha256 text,
          is_default boolean NOT NULL DEFAULT false
        );
        CREATE UNIQUE INDEX IF NOT EXISTS profile_preferences_default_idx
          ON profile_preferences (is_default) WHERE is_default;
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
        CREATE TABLE IF NOT EXISTS received_attachments (
          id uuid PRIMARY KEY,
          profile_ref text NOT NULL,
          metadata jsonb NOT NULL,
          content bytea NOT NULL,
          sha256 text NOT NULL
        );
        -- 旧版只在连接器回执前暂存原件。仅为仍有字节的附件补齐消息和重试回执中的同一个 ID。
        DO $upgrade$
        DECLARE
          file record;
          file_id uuid;
          id_path text[];
        BEGIN
          FOR file IN
            SELECT a.*, s.message_id, t.profile_ref, c.payload->'body'->'attachments'->(a.position - 1) AS ref
            FROM submission_attachments a JOIN submissions s ON s.id = a.submission_id
            JOIN commands c ON c.id = s.id JOIN topics t ON t.id = s.topic_id
            WHERE c.receipt->'attachments'->(a.position - 1)->>'attachment_id' IS NULL
          LOOP
            file_id := gen_random_uuid();
            id_path := ARRAY['attachments', (file.position - 1)::text, 'attachment_id'];
            INSERT INTO received_attachments (id, profile_ref, metadata, content, sha256)
              VALUES (file_id, file.profile_ref, (file.ref - 'sha256') || jsonb_build_object('attachment_id', file_id),
                file.content, file.ref->>'sha256');
            UPDATE messages SET data = jsonb_set(data, id_path, to_jsonb(file_id)) WHERE id = file.message_id;
            UPDATE commands SET receipt = jsonb_set(receipt, id_path, to_jsonb(file_id)) WHERE id = file.submission_id;
          END LOOP;
        END;
        $upgrade$;
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
