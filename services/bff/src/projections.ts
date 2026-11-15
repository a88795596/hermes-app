import { createHash } from "node:crypto";
import type { Command, CommandResult, Control, Message, ModelRequest, Profile, ReasoningEffort, ReasoningRequest, Topic } from "@hermes-mobile/protocol";
import type { Store } from "./store.js";
import { missing } from "./validation.js";

interface TopicRow {
  id: string;
  profile_ref: string;
  title: string;
  auto_title: boolean;
  status: Topic["status"];
  created_at: Date;
  updated_at: Date;
  archived: boolean;
  error: string | null;
  session_id: string | null;
  reasoning_effort: ReasoningEffort | null;
  reasoning_status: Topic["reasoning_status"] | null;
}

export function profileId(ref: string) {
  const id = createHash("sha256").update(`hermes-mobile/profile/${ref}`).digest("hex");
  const variant = ((Number.parseInt(id[16], 16) & 3) | 8).toString(16);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-8${id.slice(13, 16)}-${variant}${id.slice(17, 20)}-${id.slice(20, 32)}`;
}

export async function profiles(db: Pick<Store, "query">, refs: Set<string>): Promise<Profile[]> {
  const { rows } = await db.query<{ profile_ref: string; alias: string | null; avatar_sha256: string | null; is_default: boolean }>(
    "SELECT profile_ref, alias, avatar_sha256, is_default FROM profile_preferences WHERE profile_ref = ANY($1)", [[...refs]],
  );
  const preferences = new Map(rows.map((row) => [row.profile_ref, row]));
  return [...refs].map((ref) => {
    const id = profileId(ref);
    const saved = preferences.get(ref);
    return { profile_id: id, label: ref,
      ...(saved?.alias ? { alias: saved.alias } : {}),
      ...(saved?.avatar_sha256 ? { avatar_url: `/mobile/v1/profiles/${id}/avatar?v=${saved.avatar_sha256}` } : {}),
      ...(saved?.is_default ? { is_default: true } : {}),
    };
  });
}

export function topicData(row: TopicRow): Topic {
  return {
    topic_id: row.id,
    profile_id: profileId(row.profile_ref),
    title: row.title,
    status: row.status,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    archived: row.archived,
    ...(row.error ? { error: row.error } : {}),
    ...(row.reasoning_effort && !row.reasoning_status ? { reasoning_effort: row.reasoning_effort } : {}),
    ...(row.reasoning_status ? { reasoning_status: row.reasoning_status } : {}),
  };
}

export async function topicRow(db: Pick<Store, "query">, id: string, refs: Set<string>) {
  const { rows } = await db.query<TopicRow>("SELECT * FROM topics WHERE id = $1", [id]);
  if (!rows[0] || !refs.has(rows[0].profile_ref)) missing("话题");
  return rows[0];
}

export async function topics(store: Store, refs: Set<string>, includeArchived: boolean) {
  const { rows } = await store.query<TopicRow>(
    "SELECT * FROM topics WHERE profile_ref = ANY($1) AND ($2 OR NOT archived) ORDER BY updated_at DESC, id",
    [[...refs], includeArchived],
  );
  return rows.map(topicData);
}

async function requestRow(store: Store, refs: Set<string>, topicId: string, requestId: string) {
  await topicRow(store, topicId, refs);
  const { rows } = await store.query<{ payload: Command; result: CommandResult | null }>(
    "SELECT payload, result FROM commands WHERE id = $1 AND topic_id = $2", [requestId, topicId],
  );
  return rows[0];
}

export async function modelRequest(store: Store, refs: Set<string>, topicId: string, requestId: string): Promise<ModelRequest> {
  const row = await requestRow(store, refs, topicId, requestId);
  if (!row || (row.payload.kind !== "model_options" && row.payload.kind !== "select_model")) missing("模型请求");
  if (!row.result) return { status: "pending" };
  if (row.result.status === "ok" && row.result.model_result) return { status: "ok", model_result: row.result.model_result };
  return { status: row.result.status === "error" ? "error" : "unknown",
    error: row.result.error ?? "Hermes 无法确认模型请求的结果。" };
}

export async function reasoningRequest(store: Store, refs: Set<string>, topicId: string, requestId: string): Promise<ReasoningRequest> {
  const row = await requestRow(store, refs, topicId, requestId);
  if (!row || row.payload.kind !== "select_reasoning") missing("思考强度请求");
  if (!row.result) return { status: "pending" };
  const { status, error } = row.result;
  return status === "ok" ? { status } : { status, error: error ?? "Hermes 无法确认思考强度是否已切换。" };
}

export function detail(store: Store, id: string, refs: Set<string>) {
  return store.transaction(async (db) => {
    const row = await topicRow(db, id, refs);
    // shortcut: 个人话题返回完整历史。需要支持长期会话时，改用游标分页。
    const messages = await db.query<{ data: Message }>("SELECT data FROM messages WHERE topic_id = $1 ORDER BY position", [id]);
    const controls = await db.query<{ data: Control }>("SELECT data FROM controls WHERE topic_id = $1 ORDER BY position", [id]);
    return { topic: topicData(row), messages: messages.rows.map(({ data }) => data), controls: controls.rows.map(({ data }) => data) };
  });
}
