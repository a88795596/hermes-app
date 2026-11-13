import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Command, Control, Message, Topic } from "@hermes-mobile/protocol";
import type { PoolClient } from "pg";
import { profileId, topicData, topicRow } from "./projections.js";
import { ApiError, conflict, missing } from "./validation.js";

type CommandRow = { payload: Command; receipt: unknown };

async function prior<T>(db: PoolClient, id: string, kind: Command["kind"], target: string, body: object) {
  const { rows } = await db.query<CommandRow>("SELECT payload, receipt FROM commands WHERE id = $1", [id]);
  const existing = rows[0];
  if (!existing) return;
  const payload = existing.payload;
  const { title, control_id } = existing.receipt as { title?: string; control_id?: string };
  const existingBody = payload.kind === "create" ? { ...payload.body, title }
    : payload.body;
  const existingTarget = payload.kind === "create" ? payload.profile_ref
    : payload.kind === "respond" ? control_id : payload.topic_id;
  if (payload.kind !== kind || existingTarget !== target || !isDeepStrictEqual(existingBody, body)) {
    conflict("This request ID is already used for another operation");
  }
  return existing.receipt as T;
}

async function enqueue(db: PoolClient, payload: Command, receipt: object) {
  await db.query("INSERT INTO commands (id, topic_id, payload, receipt) VALUES ($1, $2, $3, $4)",
    [payload.command_id, payload.topic_id, payload, receipt]);
}

export async function createTopic(db: PoolClient, requestId: string, profile: string, title: string) {
  const saved = await prior<Topic>(db, requestId, "create", profile, { request_id: requestId, title });
  if (saved) return saved;
  const row = await db.query<Parameters<typeof topicData>[0]>(
    "INSERT INTO topics (id, profile_ref, title) VALUES ($1, $2, $3) RETURNING *", [requestId, profile, title],
  );
  const topic = topicData(row.rows[0]);
  await enqueue(db, { type: "command", command_id: requestId, topic_id: topic.topic_id,
    profile_ref: profile, kind: "create", body: { request_id: requestId } }, topic);
  return topic;
}

function requireReady(row: Awaited<ReturnType<typeof topicRow>>) {
  if (row.status !== "ready" || !row.session_id) throw new ApiError(409, "TOPIC_NOT_READY", "Topic is not ready");
  return row.session_id;
}

export async function submit(db: PoolClient, refs: Set<string>, topicId: string, submissionId: string, text: string) {
  const row = await topicRow(db, topicId, refs);
  const body = { submission_id: submissionId, text };
  const saved = await prior<Message>(db, submissionId, "submit", topicId, body);
  if (saved) return saved;
  const sessionId = requireReady(row);
  const message: Message = { message_id: randomUUID(), role: "user", text, status: "accepted", submission_id: submissionId };
  await db.query("INSERT INTO messages (id, topic_id, data) VALUES ($1, $2, $3)", [message.message_id, topicId, message]);
  await db.query("INSERT INTO submissions (id, topic_id, message_id, data) VALUES ($1, $2, $3, $4)",
    [submissionId, topicId, message.message_id, { status: "accepted" }]);
  await enqueue(db, { type: "command", command_id: submissionId, topic_id: topicId, profile_ref: row.profile_ref,
    session_id: sessionId, kind: "submit", body }, message);
  return message;
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
  if (!rowCount) throw new ApiError(409, "NO_ACTIVE_SUBMISSION", "The selected submission is no longer running");
  await enqueue(db, { type: "command", command_id: requestId, topic_id: topicId, profile_ref: row.profile_ref,
    session_id: sessionId, kind: "interrupt", body }, receipt);
  return receipt;
}

export async function respond(db: PoolClient, refs: Set<string>, controlId: string, responseId: string, answer: string) {
  const { rows } = await db.query<{ topic_id: string; data: Control }>("SELECT topic_id, data FROM controls WHERE id = $1", [controlId]);
  const control = rows[0];
  if (!control) missing("Control");
  const row = await topicRow(db, control.topic_id, refs);
  const body = { control_id: controlId, response_id: responseId, answer };
  const saved = await prior<{ status: "responding" }>(db, responseId, "respond", controlId, body);
  if (saved) return { topicId: row.id, result: { status: saved.status } };
  const sessionId = requireReady(row);
  if (control.data.status !== "pending") throw new ApiError(409, "CONTROL_ALREADY_HANDLED", "Control is no longer pending");
  if (control.data.kind === "approval" && !control.data.choices.includes(answer)) {
    throw new ApiError(422, "VALIDATION_FAILED", "Answer must match an approval option");
  }
  const result = { status: "responding" as const };
  await db.query("UPDATE controls SET data = $2 WHERE id = $1", [controlId, { ...control.data, ...result }]);
  await enqueue(db, { type: "command", command_id: responseId, topic_id: row.id, profile_ref: row.profile_ref,
    session_id: sessionId, kind: "respond", body }, { ...result, control_id: controlId });
  return { topicId: row.id, result };
}

export function findProfile(refs: Set<string>, id: string) {
  const ref = [...refs].find((ref) => profileId(ref) === id);
  if (!ref) missing("Profile");
  return ref;
}
