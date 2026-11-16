import { isDeepStrictEqual } from "node:util";
import type { Command, CommandResult, ConnectorEvent, Control, DeliveryFrame, InboxDelivery, InboxItem, Message } from "@hermes-mobile/protocol";
import { inboxTitle } from "@hermes-mobile/protocol";
import type { PoolClient } from "pg";
import { touchTopic } from "./mutations.js";
import { profileId, topicRow } from "./projections.js";
import { queueInboxPush, queueTurnPush } from "./push.js";
import { validateReceivedAttachments } from "./received-attachments.js";
import { ApiError, conflict, invalid, missing } from "./validation.js";

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
  return status === "final";
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
  if (payload.profile_ref !== topic.profile_ref) invalid("命令绑定已不匹配。");
  if (payload.kind === "summarize_title") return topic;
  if (result) {
    // 压缩成功后绑定已旋转；相同的持久回执重发仍然需要确认。
    if (isDeepStrictEqual(result, frame)) return topic;
    if (payload.kind !== "native_command" || result.status !== "unknown" || frame.status === "unknown") {
      conflict("命令结果与已保存的结果冲突。");
    }
  }
  // 旧会话的后台报告可以补齐原请求；任何会话变更仍须匹配当前绑定。
  const historicalOutput = result?.status === "unknown" && payload.kind === "native_command"
    && !/^\/(?:compress|compact|undo|new|reset)(?:[ \t]|$)/iu.test(payload.body.command)
    && ((frame.status === "ok" && frame.native_result !== undefined && Object.keys(frame.native_result).length === 1
      && Object.hasOwn(frame.native_result, "output")) || (frame.status === "error" && frame.native_result === undefined));
  if (payload.session_id && payload.session_id !== topic.session_id && !historicalOutput) invalid("命令绑定已不匹配。");
  const isModel = payload.kind === "model_options" || payload.kind === "select_model";
  const isNative = payload.kind === "native_command";
  if ((frame.native_result !== undefined && (!isNative || frame.status !== "ok")) ||
      (isNative && frame.status === "ok" && !frame.native_result)) invalid("命令的原生结果无效。");
  if (isNative && (frame.session_id !== undefined || frame.admission_id !== undefined || frame.control_status !== undefined)) {
    invalid("原生命令回执包含无关结果。");
  }
  const reset = frame.native_result?.reset === true;
  if (frame.native_result?.confirmation !== undefined && (!isNative || !/^\/(?:new|reset|undo)(?:[ \t]|$)/iu.test(payload.body.command)
    || frame.native_result.session_id !== undefined || frame.native_result.reset !== undefined
    || frame.native_result.rewound_turns !== undefined || frame.native_result.title !== undefined)) {
    invalid("原生命令确认回执不能包含执行结果。");
  }
  if (reset && (!isNative || !/^\/(?:new|reset)(?:[ \t]|$)/iu.test(payload.body.command) || !frame.native_result?.session_id)) {
    invalid("原生命令不能重置会话。");
  }
  if (frame.native_result?.title !== undefined && (!isNative || (!reset && !/^\/title(?:[ \t]|$)/iu.test(payload.body.command)))) {
    invalid("原生命令不能修改话题标题。");
  }
  if (frame.native_result?.session_id !== undefined && (!isNative || (!reset && !/^\/(?:compress|compact)(?:[ \t]|$)/iu.test(payload.body.command))
    || !payload.session_id || frame.native_result.session_id === payload.session_id)) invalid("原生命令不能旋转会话绑定。");
  if (frame.native_result?.rewound_turns !== undefined && (!isNative || !/^\/undo(?:[ \t]|$)/iu.test(payload.body.command))) {
    invalid("原生命令不能撤回上下文。");
  }
  if ((frame.model_result !== undefined && (!isModel || frame.status !== "ok" ||
      (frame.model_result.type === "catalog") !== (payload.kind === "model_options"))) ||
      (isModel && frame.status === "ok" && !frame.model_result)) invalid("命令的模型结果无效。");
  if (frame.title !== undefined) invalid("命令的标题结果无效。");
  if (frame.steering !== undefined && (frame.steering !== true || payload.kind !== "submit"
    || payload.body.steer_if_running !== true || payload.body.attachments !== undefined
    || frame.admission_id !== undefined || frame.session_id !== undefined
    || frame.control_status !== undefined || frame.model_result !== undefined || frame.native_result !== undefined)) invalid("命令的插话结果无效。");
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
    if (frame.status === "ok" && !frame.steering && !frame.admission_id) invalid("提交结果缺少受理 ID。");
    const status = frame.status === "ok" ? (frame.steering ? "final" : "queued") : frame.status === "error" ? "failed" : "unknown";
    await applySubmission(db, topic.id, payload.body.submission_id, status, frame.error, frame.admission_id);
    if (payload.body.attachments) await db.query("DELETE FROM submission_attachments WHERE submission_id = $1", [frame.command_id]);
  } else if (isNative) {
    if (frame.native_result?.session_id !== undefined) {
      const updated = await db.query(`UPDATE topics SET session_id = $2, updated_at = clock_timestamp()
        WHERE id = $1 AND profile_ref = $3 AND session_id = $4`,
      [topic.id, frame.native_result.session_id, payload.profile_ref, payload.session_id]);
      if (updated.rowCount !== 1) conflict("原生命令执行期间会话绑定已变更。");
      topic.session_id = frame.native_result.session_id;
    }
    if (reset) {
      await db.query("UPDATE topics SET reasoning_effort = NULL, reasoning_status = NULL WHERE id = $1", [topic.id]);
      await db.query("UPDATE controls SET data = data || '{\"status\":\"closed\"}'::jsonb WHERE topic_id = $1 AND data->>'status' <> 'closed'", [topic.id]);
    }
    if (frame.native_result?.title !== undefined) {
      await db.query("UPDATE topics SET title = $2, auto_title = false, updated_at = clock_timestamp() WHERE id = $1",
        [topic.id, frame.native_result.title]);
    }
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
  if (!isDeepStrictEqual(rows[0]?.payload, payload)) {
    conflict(kind === "delivery" ? "同一个投递 ID 对应不同的数据。" : "不同的事件数据使用了同一个连接器事件 ID。");
  }
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
    if (await applySubmission(db, topic.id, frame.submission_id, frame.status, frame.error)) {
      await queueTurnPush(db, frame.submission_id);
    }
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
    const attachments = frame.attachments ?? existing?.data.attachments;
    await validateReceivedAttachments(db, attachments, topic.profile_ref);
    const message: Message = { message_id: frame.message_id, role: "assistant", text: frame.text, status: frame.status,
      ...(process?.length ? { process } : {}),
      ...(attachments?.length ? { attachments } : {}),
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
  const applied = await applyInboxDelivery(db, frame, refs);
  await recordEvent(db, "event", frame.event_id, frame);
  return applied;
}

export async function applyInboxDelivery(db: PoolClient, { delivery_id, profile_ref, session_id, title, text, attachments }: InboxDelivery, refs: Set<string>) {
  if (!refs.has(profile_ref)) missing("配置档案");
  await validateReceivedAttachments(db, attachments, profile_ref);
  if (!await recordEvent(db, "delivery", delivery_id, { profile_ref, text, ...(title === undefined ? {} : { title }),
    ...(session_id === undefined ? {} : { session_id }),
    ...(attachments?.length ? { attachments } : {}) })) return false;
  if (session_id !== undefined) {
    const { rows: [topic] } = await db.query<{ id: string; status: string }>(
      "SELECT id, status FROM topics WHERE profile_ref = $1 AND session_id = $2", [profile_ref, session_id]);
    if (!topic) throw new ApiError(404, "DELIVERY_TARGET_NOT_FOUND", "找不到投递目标会话。");
    if (topic.status !== "ready") throw new ApiError(409, "DELIVERY_TARGET_NOT_READY", "投递目标会话尚未就绪。");
    const message: Message = { message_id: delivery_id, role: "assistant", text, status: "final",
      ...(attachments?.length ? { attachments } : {}) };
    const inserted = await db.query("INSERT INTO messages (id, topic_id, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
      [delivery_id, topic.id, message]);
    if (!inserted.rowCount) conflict("该消息 ID 已用于其他记录。");
    await touchTopic(db, topic.id);
    return true;
  }
  const item: InboxItem = { inbox_id: delivery_id, profile_id: profileId(profile_ref), title: title ?? inboxTitle(text.trim() || attachments?.[0]?.name || ""),
    text, ...(attachments?.length ? { attachments } : {}), created_at: new Date().toISOString() };
  await db.query("INSERT INTO inbox (id, profile_ref, data) VALUES ($1, $2, $3)", [item.inbox_id, profile_ref, item]);
  await queueInboxPush(db, item.inbox_id);
  return true;
}
