import { isDeepStrictEqual } from "node:util";
import type { Command, CommandResult, ConnectorEvent, Control, DeliveryFrame, InboxItem, Message } from "@hermes-mobile/protocol";
import type { PoolClient } from "pg";
import { touchTopic } from "./mutations.js";
import { topicRow } from "./projections.js";
import { queueInboxPush } from "./push.js";
import { conflict, invalid, missing } from "./validation.js";

const terminal = new Set<Message["status"]>(["final", "failed", "cancelled"]);

async function applySubmission(db: PoolClient, topicId: string, id: string, status: Message["status"], error?: string, admissionId?: string) {
  const { rows } = await db.query<{ message_id: string; data: { status: Message["status"]; admission_id?: string } }>(
    "SELECT message_id, data FROM submissions WHERE id = $1 AND topic_id = $2", [id, topicId],
  );
  const submission = rows[0];
  if (!submission) missing("消息提交记录");
  const old = submission.data.status;
  if (terminal.has(old) || (old === "streaming" && status === "queued")) status = old;
  await db.query("UPDATE submissions SET data = $2 WHERE id = $1", [id, {
    ...submission.data, status, ...(admissionId ? { admission_id: admissionId } : {}),
  }]);
  if (status === old && (terminal.has(old) || !error)) return;
  await db.query("UPDATE messages SET data = (data - 'error') || $2::jsonb WHERE id = $1", [submission.message_id, {
    status, ...(error ? { error } : {}),
  }]);
  await touchTopic(db, topicId);
}

export async function applyResult(db: PoolClient, frame: CommandResult, refs: Set<string>) {
  type RetiredTitleCommand = Pick<Command, "topic_id" | "profile_ref" | "session_id"> & { kind: "summarize_title" };
  const { rows } = await db.query<{ payload: Command | RetiredTitleCommand; result: CommandResult | null; receipt: { was_unconfirmed?: boolean } }>(
    "SELECT payload, result, receipt FROM commands WHERE id = $1", [frame.command_id],
  );
  const command = rows[0];
  if (!command) missing("命令");
  const { payload, result } = command;
  const topic = await topicRow(db, payload.topic_id, refs);
  if (payload.profile_ref !== topic.profile_ref || (payload.session_id && payload.session_id !== topic.session_id)) {
    invalid("命令绑定已不匹配。");
  }
  if (payload.kind === "summarize_title") return topic;
  if (result) {
    if (!isDeepStrictEqual(result, frame)) conflict("命令结果与已保存的结果冲突。");
    return topic;
  }
  const isModel = payload.kind === "model_options" || payload.kind === "select_model";
  if ((frame.model_result !== undefined && (!isModel || frame.status !== "ok" ||
      (frame.model_result.type === "catalog") !== (payload.kind === "model_options"))) ||
      (isModel && frame.status === "ok" && !frame.model_result)) invalid("命令的模型结果无效。");
  if (frame.title !== undefined) invalid("命令的标题结果无效。");
  if (payload.kind === "create") {
    if (frame.status === "ok" && !frame.session_id) invalid("创建结果缺少会话 ID。");
    const success = frame.status === "ok";
    await db.query("UPDATE topics SET session_id = $2, status = $3, error = $4, updated_at = clock_timestamp() WHERE id = $1", [
      topic.id, success ? frame.session_id : null, success ? "ready" : "error",
      success ? null : (frame.error ?? "Hermes 无法确认会话是否创建成功。"),
    ]);
    topic.session_id = success ? frame.session_id! : null;
    topic.status = success ? "ready" : "error";
  } else if (payload.kind === "submit") {
    if (frame.status === "ok" && !frame.admission_id) invalid("提交结果缺少受理 ID。");
    const status = frame.status === "ok" ? "queued" : frame.status === "error" ? "failed" : "unknown";
    await applySubmission(db, topic.id, payload.body.submission_id, status, frame.error, frame.admission_id);
    if (payload.body.attachments) await db.query("DELETE FROM submission_attachments WHERE submission_id = $1", [frame.command_id]);
  } else if (payload.kind === "select_reasoning") {
    await db.query("UPDATE topics SET reasoning_effort = $2, reasoning_status = $3, updated_at = clock_timestamp() WHERE id = $1", [topic.id,
      frame.status === "ok" ? payload.body.effort : topic.reasoning_effort,
      frame.status === "unknown" || (frame.status === "error" && command.receipt.was_unconfirmed) ? "unknown" : null]);
  } else if (frame.model_result?.type === "selected" || frame.model_result?.type === "deferred") {
    await touchTopic(db, topic.id);
  } else if (payload.kind === "respond") {
    const closed = frame.control_status === "closed";
    const answer = closed && frame.status === "ok" ? payload.body.answer : undefined;
    const result = await db.query(`UPDATE controls SET data = data || $3::jsonb ||
      jsonb_build_object('status', CASE WHEN data->>'status' = 'closed' THEN 'closed' ELSE $4::text END)
      WHERE id = $1 AND topic_id = $2 AND data->>'status' <> 'pending'`,
      [payload.body.control_id, topic.id,
        { ...(answer === undefined ? {} : { answer }), ...(frame.error ? { error: frame.error } : {}) },
        closed ? "closed" : "unknown"]);
    if (result.rowCount) await touchTopic(db, topic.id);
  }
  await db.query("UPDATE commands SET result = $2 WHERE id = $1", [frame.command_id, frame]);
  return topic;
}

async function recordEvent(db: PoolClient, kind: string, id: string, payload: object) {
  const inserted = await db.query(
    "INSERT INTO connector_ingest (kind, id, payload) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [kind, id, payload],
  );
  if (inserted.rowCount) return true;
  const { rows } = await db.query("SELECT payload FROM connector_ingest WHERE kind = $1 AND id = $2", [kind, id]);
  if (!isDeepStrictEqual(rows[0]?.payload, payload)) conflict("不同的事件数据使用了同一个连接器事件 ID。");
  return false;
}

export async function applyEvent(db: PoolClient, frame: ConnectorEvent, refs: Set<string>, sessions: Map<string, string>) {
  const topic = await topicRow(db, frame.topic_id, refs);
  if (topic.status !== "ready" || sessions.get(topic.id) !== topic.session_id) invalid("连接器未绑定此话题对应的会话。");
  if (frame.type === "topic_title" && frame.session_id !== topic.session_id) invalid("标题事件的 Hermes 会话不匹配。");
  if (!await recordEvent(db, "event", frame.event_id, frame)) return;

  if (frame.type === "topic_title") {
    await db.query("UPDATE topics SET title = $2 WHERE id = $1 AND auto_title AND title IS DISTINCT FROM $2",
      [topic.id, frame.title]);
    return;
  }
  if (frame.type === "submission") {
    await applySubmission(db, topic.id, frame.submission_id, frame.status, frame.error);
    return;
  }
  if (frame.type === "message") {
    if (frame.submission_id) {
      const { rowCount } = await db.query("SELECT id FROM submissions WHERE id = $1 AND topic_id = $2", [frame.submission_id, topic.id]);
      if (!rowCount) missing("消息提交记录");
    }
    const { rows } = await db.query<{ topic_id: string; data: Message }>("SELECT topic_id, data FROM messages WHERE id = $1", [frame.message_id]);
    const existing = rows[0];
    if (existing && (existing.topic_id !== topic.id || existing.data.role !== "assistant" ||
      (frame.submission_id && existing.data.submission_id && frame.submission_id !== existing.data.submission_id))) {
      conflict("该消息 ID 已用于其他记录。");
    }
    if (existing?.data.status === "final" && frame.status === "streaming") return;
    const submissionId = frame.submission_id ?? existing?.data.submission_id;
    const process = frame.process ?? existing?.data.process;
    const message: Message = { message_id: frame.message_id, role: "assistant", text: frame.text, status: frame.status,
      ...(process?.length ? { process } : {}),
      ...(submissionId ? { submission_id: submissionId } : {}) };
    await db.query("INSERT INTO messages (id, topic_id, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
      [message.message_id, topic.id, message]);
  } else {
    const { rows } = await db.query<{ topic_id: string; data: Control }>("SELECT topic_id, data FROM controls WHERE id = $1", [frame.control_id]);
    const existing = rows[0];
    if (existing && (existing.topic_id !== topic.id || existing.data.kind !== frame.kind)) conflict("该交互请求 ID 已用于其他记录。");
    if (existing?.data.status === "closed" || (existing && existing.data.status !== "pending" && frame.status === "pending")) return;
    const submissionId = existing?.data.submission_id ?? frame.submission_id;
    if (submissionId && !existing?.data.submission_id) {
      const { rowCount } = await db.query("SELECT id FROM submissions WHERE id = $1 AND topic_id = $2", [submissionId, topic.id]);
      if (!rowCount) invalid("交互请求关联的消息提交记录无效。");
    }
    const control: Control = { ...existing?.data, control_id: frame.control_id, kind: frame.kind,
      prompt: frame.prompt, choices: frame.choices, status: frame.status,
      ...(frame.multi_select === undefined ? {} : { multi_select: frame.multi_select }),
      ...(submissionId ? { submission_id: submissionId } : {}) };
    await db.query("INSERT INTO controls (id, topic_id, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
      [control.control_id, topic.id, control]);
  }
  await touchTopic(db, topic.id);
}

export async function applyDelivery(db: PoolClient, frame: DeliveryFrame, refs: Set<string>) {
  if (!refs.has(frame.profile_ref)) missing("配置档案");
  await recordEvent(db, "event", frame.event_id, frame);
  const { delivery_id, profile_ref, text } = frame;
  if (!await recordEvent(db, "delivery", delivery_id, { profile_ref, text })) return;
  const item: InboxItem = { inbox_id: delivery_id, text, created_at: new Date().toISOString() };
  await db.query("INSERT INTO inbox (id, profile_ref, data) VALUES ($1, $2, $3)", [item.inbox_id, profile_ref, item]);
  await queueInboxPush(db, item.inbox_id);
}
