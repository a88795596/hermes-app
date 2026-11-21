import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Message } from "@hermes-mobile/protocol";
import type { PoolClient } from "pg";
import { connectorFrame } from "../src/connector-frame.js";
import { applyEvent } from "../src/ingress.js";

test("最终回复兼容旧消息帧并保留已收到的回复过程", async () => {
  const topicId = randomUUID();
  const messageId = randomUUID();
  const sessionId = "hermes-session";
  let stored: Message | undefined;
  const db = {
    async query(sql: string, args: unknown[]) {
      if (sql.startsWith("SELECT * FROM topics")) {
        return { rows: [{ id: topicId, profile_ref: "default", status: "ready", session_id: sessionId }] };
      }
      if (sql.startsWith("INSERT INTO connector_ingest")) return { rowCount: 1 };
      if (sql.startsWith("SELECT topic_id, data FROM messages")) {
        return { rows: stored ? [{ topic_id: topicId, data: stored }] : [] };
      }
      if (sql.startsWith("INSERT INTO messages")) {
        stored = args[2] as Message;
        return { rowCount: 1 };
      }
      if (sql.startsWith("UPDATE topics SET updated_at")) return { rowCount: 1 };
      throw new Error(`未预期的查询：${sql}`);
    },
  } as unknown as PoolClient;
  const process = [{ kind: "reasoning", text: "先核对信息。" }];
  async function ingest(fields: Record<string, unknown>) {
    const frame = connectorFrame({ type: "message", topic_id: topicId, event_id: randomUUID(),
      message_id: messageId, ...fields });
    assert.equal(frame.type, "message");
    await applyEvent(db, frame, new Set(["default"]), new Map([[topicId, sessionId]]));
  }

  const warning = "上下文压缩暂不可用。";
  await ingest({ text: "", status: "streaming", process, reply_status: { warning, progress: "第 6 轮迭代" } });
  assert.deepEqual(stored?.reply_status, { warning, progress: "第 6 轮迭代" });
  await ingest({ text: "最终答案", status: "final" });
  await ingest({ text: "迟到的增量", status: "streaming", reply_status: { progress: "第 7 轮迭代" } });
  assert.deepEqual(stored, { role: "assistant", message_id: messageId, text: "最终答案", status: "final", process,
    reply_status: { warning } });
});

test("拒绝包含工具原始参数的过程帧", () => {
  assert.throws(() => connectorFrame({
    type: "message", topic_id: randomUUID(), event_id: randomUUID(), message_id: randomUUID(),
    text: "", status: "streaming", process: [{ kind: "tool", id: "call-1", name: "terminal", status: "running", args: {} }],
  }), { statusCode: 422 });
});
