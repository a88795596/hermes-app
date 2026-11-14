import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DEFAULT_TOPIC_TITLE, topicTitlePreview } from "@hermes-mobile/protocol";
import type { AttachmentReference, Command, Control, Message, ModelSelection, ReasoningEffort, Topic } from "@hermes-mobile/protocol";
import type { PoolClient } from "pg";
import { profileId, topicData, topicRow } from "./projections.js";
import { ApiError, conflict, missing } from "./validation.js";

type CommandRow = { payload: Command; receipt: unknown };

async function prior<T>(db: PoolClient, id: string, kind: Command["kind"], target: string, body: object) {
  const { rows } = await db.query<CommandRow>("SELECT payload, receipt FROM commands WHERE id = $1", [id]);
  const existing = rows[0];
  if (!existing) return;
  const payload = existing.payload;
  const { title, auto_title, control_id } = existing.receipt as { title?: string; auto_title?: boolean; control_id?: string };
  const existingBody = payload.kind === "create" ? { ...payload.body, title: auto_title ? undefined : title }
    : payload.body;
  const existingTarget = payload.kind === "create" ? payload.profile_ref
    : payload.kind === "respond" ? control_id : payload.topic_id;
  if (payload.kind !== kind || existingTarget !== target || !isDeepStrictEqual(existingBody, body)) {
    conflict("此请求 ID 已用于另一项操作。");
  }
  return existing.receipt as T;
}

async function enqueue(db: PoolClient, payload: Command, receipt: object) {
  await db.query("INSERT INTO commands (id, topic_id, payload, receipt) VALUES ($1, $2, $3, $4)",
    [payload.command_id, payload.topic_id, payload, receipt]);
}

export async function createTopic(db: PoolClient, requestId: string, profile: string, title?: string) {
  const saved = await prior<Topic>(db, requestId, "create", profile, { request_id: requestId, title });
  if (saved) return topicData(await topicRow(db, requestId, new Set([profile])));
  const autoTitle = title === undefined;
  const row = await db.query<Parameters<typeof topicData>[0]>(
    "INSERT INTO topics (id, profile_ref, title, auto_title) VALUES ($1, $2, $3, $4) RETURNING *",
    [requestId, profile, title ?? DEFAULT_TOPIC_TITLE, autoTitle],
  );
  const topic = topicData(row.rows[0]);
  await enqueue(db, { type: "command", command_id: requestId, topic_id: topic.topic_id,
    profile_ref: profile, kind: "create", body: { request_id: requestId } }, { ...topic, auto_title: autoTitle });
  return topic;
}

function requireReady(row: Awaited<ReturnType<typeof topicRow>>) {
  if (row.status !== "ready" || !row.session_id) throw new ApiError(409, "TOPIC_NOT_READY", "话题尚未就绪。");
  return row.session_id;
}

async function requireIdle(db: PoolClient, topicId: string, message: string) {
  const { rowCount } = await db.query(`SELECT 1 FROM submissions WHERE topic_id = $1
    AND data->>'status' IN ('accepted', 'queued', 'streaming') LIMIT 1`, [topicId]);
  if (rowCount) throw new ApiError(409, "TOPIC_BUSY", message);
}

export async function submit(db: PoolClient, refs: Set<string>, topicId: string, submissionId: string, text: string,
  attachments: { reference: AttachmentReference; content: Buffer }[], attachmentsSupported: boolean) {
  const row = await topicRow(db, topicId, refs);
  const body = { submission_id: submissionId, text,
    ...(attachments.length && { attachments: attachments.map(({ reference }) => reference) }) };
  const saved = await prior<Message>(db, submissionId, "submit", topicId, body);
  if (saved) return saved;
  const sessionId = requireReady(row);
  if (attachments.length && !attachmentsSupported) {
    throw new ApiError(409, "ATTACHMENTS_UNAVAILABLE", "更新 Hermes 连接器后可发送附件。");
  }
  if (row.auto_title && row.title === DEFAULT_TOPIC_TITLE) {
    await db.query(`UPDATE topics SET title = $2 WHERE id = $1 AND NOT EXISTS
      (SELECT 1 FROM submissions WHERE topic_id = $1)`, [topicId, topicTitlePreview(text.trim() || attachments[0]?.reference.name || "")]);
  }
  const message: Message = { message_id: randomUUID(), role: "user", text, status: "accepted", submission_id: submissionId,
    ...(attachments.length && { attachments: attachments.map(({ reference: { name, mime, size } }) => ({ name, mime, size })) }) };
  await db.query("INSERT INTO messages (id, topic_id, data) VALUES ($1, $2, $3)", [message.message_id, topicId, message]);
  await db.query("INSERT INTO submissions (id, topic_id, message_id, data) VALUES ($1, $2, $3, $4)",
    [submissionId, topicId, message.message_id, { status: "accepted" }]);
  for (const [index, { content }] of attachments.entries()) {
    await db.query("INSERT INTO submission_attachments (submission_id, position, content) VALUES ($1, $2, $3)",
      [submissionId, index + 1, content]);
  }
  await enqueue(db, { type: "command", command_id: submissionId, topic_id: topicId, profile_ref: row.profile_ref,
    session_id: sessionId, kind: "submit", body }, message);
  return message;
}

export async function queueTopicTitle(db: PoolClient, topic: Awaited<ReturnType<typeof topicRow>>) {
  if (!topic.auto_title || !topic.session_id) return false;
  const { rows: [revision] } = await db.query<{ title_revision: string }>(
    "UPDATE topics SET title_revision = title_revision + 1 WHERE id = $1 RETURNING title_revision", [topic.id],
  );
  // shortcut: 用现有标题和最近四轮控制提示长度，长会话需要覆盖更早内容时再加入滚动摘要。
  const { rows } = await db.query<{ user: string; assistant: string | null }>(`
    SELECT left(COALESCE(NULLIF(btrim(u.data->>'text'), ''), u.data#>>'{attachments,0,name}', ''), 600) AS "user", (
      SELECT left(a.data->>'text', 600) FROM messages AS a
      WHERE a.topic_id = s.topic_id AND a.data->>'submission_id' = s.id::text
        AND a.data->>'role' = 'assistant' AND a.data->>'status' = 'final'
      ORDER BY a.position DESC LIMIT 1
    ) AS assistant
    FROM submissions AS s JOIN messages AS u ON u.id = s.message_id
    WHERE s.topic_id = $1 AND s.data->>'status' = 'final'
    ORDER BY u.position DESC LIMIT 4`, [topic.id]);
  const input = JSON.stringify({ title: topic.title, turns: rows.reverse() });
  await enqueue(db, { type: "command", command_id: randomUUID(), topic_id: topic.id, profile_ref: topic.profile_ref,
    session_id: topic.session_id, kind: "summarize_title", body: { input } }, revision);
  return true;
}

export async function interrupt(db: PoolClient, refs: Set<string>, topicId: string, requestId: string, submissionId: string) {
  const row = await topicRow(db, topicId, refs);
  const receipt = { status: "accepted" as const };
  const body = { submission_id: submissionId };
  const saved = await prior<typeof receipt>(db, requestId, "interrupt", topicId, body);
  if (saved) return saved;
  const sessionId = requireReady(row);
  const { rowCount } = await db.query(
    "SELECT id FROM submissions WHERE id = $1 AND topic_id = $2 AND data->>'status' = 'streaming'", [submissionId, topicId],
  );
  if (!rowCount) throw new ApiError(409, "NO_ACTIVE_SUBMISSION", "这条消息已不在处理中。");
  await enqueue(db, { type: "command", command_id: requestId, topic_id: topicId, profile_ref: row.profile_ref,
    session_id: sessionId, kind: "interrupt", body }, receipt);
  return receipt;
}

export async function requestModel(
  db: PoolClient, refs: Set<string>, topicId: string, requestId: string, selection?: ModelSelection & { confirm?: string },
) {
  const row = await topicRow(db, topicId, refs);
  const kind = selection ? "select_model" : "model_options";
  const receipt = { status: "pending" as const };
  const saved = await prior<typeof receipt>(db, requestId, kind, topicId, selection ?? {});
  if (saved) return saved;
  const envelope = { type: "command" as const, command_id: requestId, topic_id: row.id, profile_ref: row.profile_ref,
    session_id: requireReady(row) };
  if (selection) await requireIdle(db, topicId, "请等当前回复结束后再切换模型。");
  await enqueue(db, selection ? { ...envelope, kind: "select_model", body: selection }
    : { ...envelope, kind: "model_options", body: {} }, receipt);
  return receipt;
}

export async function requestReasoning(db: PoolClient, refs: Set<string>, topicId: string, requestId: string,
  effort: ReasoningEffort | null, connection: "ready" | "offline" | "legacy") {
  const row = await topicRow(db, topicId, refs);
  const body = { effort };
  const receipt = { status: "pending" as const, was_unconfirmed: row.reasoning_status === "unknown" };
  const saved = await prior<typeof receipt>(db, requestId, "select_reasoning", topicId, body);
  if (saved) return { status: saved.status };
  const session_id = requireReady(row);
  if (connection === "offline") throw new ApiError(503, "CONNECTOR_OFFLINE", "请连接 Hermes 后重试。");
  if (connection === "legacy") throw new ApiError(503, "REASONING_UNAVAILABLE", "请更新 Hermes 连接器以切换思考强度。");
  if (row.reasoning_status === "pending") throw new ApiError(409, "REASONING_PENDING", "Hermes 仍在处理上一次思考强度切换。");
  await requireIdle(db, topicId, "请等当前回复结束后再切换思考强度。");
  await enqueue(db, { type: "command", command_id: requestId, topic_id: row.id, profile_ref: row.profile_ref,
    session_id, kind: "select_reasoning", body }, receipt);
  await db.query("UPDATE topics SET reasoning_status = 'pending' WHERE id = $1", [topicId]);
  return { status: receipt.status };
}

export async function respond(db: PoolClient, refs: Set<string>, controlId: string, responseId: string, answer: string) {
  const { rows } = await db.query<{ topic_id: string; data: Control }>("SELECT topic_id, data FROM controls WHERE id = $1", [controlId]);
  const control = rows[0];
  if (!control) missing("交互请求");
  const row = await topicRow(db, control.topic_id, refs);
  const body = { control_id: controlId, response_id: responseId, answer };
  const saved = await prior<{ status: "responding" }>(db, responseId, "respond", controlId, body);
  if (saved) return { topicId: row.id, result: { status: saved.status } };
  const sessionId = requireReady(row);
  if (control.data.status !== "pending") throw new ApiError(409, "CONTROL_ALREADY_HANDLED", "此请求已不再等待答复。");
  if (control.data.kind === "approval" && !control.data.choices.includes(answer)) {
    throw new ApiError(422, "VALIDATION_FAILED", "请从给定的审批选项中选择。");
  }
  const result = { status: "responding" as const };
  await db.query("UPDATE controls SET data = $2 WHERE id = $1", [controlId, { ...control.data, ...result }]);
  await enqueue(db, { type: "command", command_id: responseId, topic_id: row.id, profile_ref: row.profile_ref,
    session_id: sessionId, kind: "respond", body }, { ...result, control_id: controlId });
  return { topicId: row.id, result };
}

export function findProfile(refs: Set<string>, id: string) {
  const ref = [...refs].find((ref) => profileId(ref) === id);
  if (!ref) missing("配置档案");
  return ref;
}
