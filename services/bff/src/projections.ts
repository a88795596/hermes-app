import { createHash } from "node:crypto";
import type { Control, Message, Profile, Topic } from "@hermes-mobile/protocol";
import type { Store } from "./store.js";
import { missing } from "./validation.js";

interface TopicRow {
  id: string;
  profile_ref: string;
  title: string;
  status: Topic["status"];
  error: string | null;
  session_id: string | null;
}

export function profileId(ref: string) {
  const id = createHash("sha256").update(`hermes-mobile/profile/${ref}`).digest("hex");
  const variant = ((Number.parseInt(id[16], 16) & 3) | 8).toString(16);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-8${id.slice(13, 16)}-${variant}${id.slice(17, 20)}-${id.slice(20, 32)}`;
}

export function profiles(refs: Set<string>): Profile[] {
  return [...refs].map((ref) => ({ profile_id: profileId(ref), label: ref }));
}

export function topicData(row: TopicRow): Topic {
  return {
    topic_id: row.id,
    profile_id: profileId(row.profile_ref),
    title: row.title,
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
  };
}

export async function topicRow(db: Pick<Store, "query">, id: string, refs: Set<string>) {
  const { rows } = await db.query<TopicRow>("SELECT * FROM topics WHERE id = $1", [id]);
  if (!rows[0] || !refs.has(rows[0].profile_ref)) missing("Topic");
  return rows[0];
}

export async function topics(store: Store, refs: Set<string>) {
  const { rows } = await store.query<TopicRow>(
    "SELECT * FROM topics WHERE profile_ref = ANY($1) ORDER BY created_at DESC, id", [[...refs]],
  );
  return rows.map(topicData);
}

export function detail(store: Store, id: string, refs: Set<string>) {
  return store.transaction(async (db) => {
    const row = await topicRow(db, id, refs);
    // shortcut: return full history for personal topics, add cursor pagination for long-lived sessions.
    const messages = await db.query<{ data: Message }>("SELECT data FROM messages WHERE topic_id = $1 ORDER BY position", [id]);
    const controls = await db.query<{ data: Control }>("SELECT data FROM controls WHERE topic_id = $1 ORDER BY id", [id]);
    return { topic: topicData(row), messages: messages.rows.map(({ data }) => data), controls: controls.rows.map(({ data }) => data) };
  });
}
