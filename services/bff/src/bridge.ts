import { randomUUID } from "node:crypto";
import { managementOperations, managementTimeout, MAX_ATTACHMENTS } from "@hermes-mobile/protocol";
import type { BridgeFrame, Command, ManagementRequest, ManagementResult, TopicQuery, TopicQueryResult } from "@hermes-mobile/protocol";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { matchesToken, readBearer } from "./auth.js";
import { connectorFrame } from "./connector-frame.js";
import { applyDelivery, applyEvent, applyResult } from "./ingress.js";
import type { Store } from "./store.js";
import { ApiError, invalid, missing, record, uuid } from "./validation.js";

export function registerBridge(api: FastifyInstance, store: Store, refs: Set<string>, secret: string, changed: (topicId?: string) => void) {
  type ManagementCall = Omit<ManagementRequest, "type" | "request_id">;
  let active: {
    socket: WebSocket;
    reasoning: boolean;
    attachments: boolean;
    pump: () => void;
    query: (target: Omit<TopicQuery, "type" | "request_id">) => Promise<TopicQueryResult>;
    manage?: (call: ManagementCall) => Promise<unknown>;
  } | undefined;

  api.get("/internal/connector/v1/submissions/:id/attachments/:position", async (request, reply) => {
    if (!matchesToken(readBearer(request), secret)) throw new ApiError(401, "UNAUTHORIZED", "连接器凭证无效。");
    const params = record(request.params);
    const id = uuid(params.id, "提交 ID");
    const position = Number(params.position);
    if (!Number.isInteger(position) || position < 1 || position > MAX_ATTACHMENTS) missing("附件");
    const { rows: [attachment] } = await store.query<{ content: Buffer }>(`
      SELECT a.content FROM submission_attachments a
      JOIN commands c ON c.id = a.submission_id JOIN topics t ON t.id = c.topic_id
      WHERE a.submission_id = $1 AND a.position = $2 AND c.dispatched AND c.result IS NULL AND t.profile_ref = ANY($3)`,
    [id, position, [...refs]]);
    if (!attachment) missing("附件");
    return reply.type("application/octet-stream").header("X-Content-Type-Options", "nosniff").send(attachment.content);
  });

  api.get("/internal/connector/v1/events", {
    websocket: true,
    preValidation: async (request) => {
      if (!matchesToken(readBearer(request), secret)) throw new ApiError(401, "UNAUTHORIZED", "连接器凭证无效。");
    },
  }, (socket, request) => {
    if (active) {
      socket.close(1008, "已有连接器在线");
      return;
    }
    const sent = new Map<string, number>();
    const sessions = new Map<string, string>();
    const watches = new Set<string>();
    const reasoning = request.headers["x-hermes-mobile-reasoning"] === "1";
    const attachments = request.headers["x-hermes-mobile-attachments"] === "1";
    const queries = new Map<string, {
      kind: TopicQuery["kind"];
      finish: (result?: TopicQueryResult) => void;
    }>();
    const management = new Map<string, (result?: ManagementResult) => void>();
    let serial = Promise.resolve();
    let queuedFrames = 0;
    let pumping = false;
    let needsPump = false;
    let alive = true;
    const isCurrent = () => active?.socket === socket && socket.readyState === socket.OPEN;
    const send = (frame: BridgeFrame) => {
      if (!isCurrent()) return false;
      if (socket.bufferedAmount > 1024 * 1024) {
        socket.close(1013, "连接器接收过慢");
        return false;
      }
      socket.send(JSON.stringify(frame));
      return true;
    };
    const run = (task: () => Promise<void>) => {
      serial = serial.then(async () => {
        if (isCurrent()) await task();
      }).catch((error: unknown) => {
        const rejected = error instanceof SyntaxError || error instanceof ApiError;
        api.log.warn({ code: rejected && error instanceof ApiError ? error.code : "CONNECTOR_FRAME_FAILED" }, "处理连接器消息帧失败");
        socket.close(rejected ? 1008 : 1011, rejected ? "连接器消息帧无效" : "处理连接器消息失败");
      });
    };
    const pump = () => {
      needsPump = true;
      if (pumping) return;
      pumping = true;
      run(async () => {
        try {
          do {
            needsPump = false;
            const { rows } = await store.query<{ payload: Command; reasoning_required: boolean }>(
              `SELECT c.payload, (t.reasoning_effort IS NOT NULL OR t.reasoning_status IS NOT NULL) AS reasoning_required
               FROM commands c JOIN topics t ON t.id = c.topic_id
               WHERE c.result IS NULL AND t.profile_ref = ANY($1)
               ORDER BY c.position`, [[...refs]],
            );
            for (const { payload, reasoning_required } of rows) {
              if (sent.size >= 64 || !isCurrent()) break;
              if (sent.has(payload.command_id)) continue;
              if (!reasoning && (payload.kind === "select_reasoning" || (payload.kind === "submit" && reasoning_required))) continue;
              if (payload.session_id && sessions.get(payload.topic_id) !== payload.session_id) continue;
              if (!attachments && payload.kind === "submit" && payload.body.attachments) continue;
              await store.query("UPDATE commands SET dispatched = true WHERE id = $1 AND NOT dispatched", [payload.command_id]);
              if (send(payload)) sent.set(payload.command_id, Date.now());
            }
          } while (needsPump && isCurrent());
        } finally {
          pumping = false;
        }
      });
    };
    const query = (target: Omit<TopicQuery, "type" | "request_id">) => {
      if (request.headers["x-hermes-mobile-topic-query"] !== "1") {
        throw new ApiError(503, "TOPIC_QUERY_UNAVAILABLE", "请更新 Hermes 连接器以使用此功能。");
      }
      if (queries.size >= 8) {
        throw new ApiError(429, "TOPIC_QUERY_BUSY", "请求过多，请稍后重试。");
      }
      return new Promise<TopicQueryResult>((resolve, reject) => {
        const request_id = randomUUID();
        const timer = setTimeout(() => {
          queries.delete(request_id);
          reject(new ApiError(504, "TOPIC_QUERY_TIMEOUT", "等待 Hermes 响应超时，请重试。"));
        }, 9_000);
        const finish = (result?: TopicQueryResult) => {
          clearTimeout(timer);
          queries.delete(request_id);
          if (result) resolve(result);
          else reject(new ApiError(503, "CONNECTOR_OFFLINE", "Hermes 连接器已断开，请重试。"));
        };
        queries.set(request_id, { kind: target.kind, finish });
        if (!send({ ...target, type: "topic_query", request_id })) finish();
      });
    };
    const manage = (call: ManagementCall) => {
      if (!isCurrent()) throw new ApiError(503, "MANAGEMENT_UNAVAILABLE", "请连接 Hermes 连接器后再使用管理功能。");
      if (management.size >= 16) throw new ApiError(429, "MANAGEMENT_BUSY", "Hermes 正在处理其他管理请求。");
      const request_id = randomUUID();
      const write = managementOperations[call.operation] === "write";
      return new Promise<unknown>((resolve, reject) => {
        const finish = (result?: ManagementResult, timedOut = false) => {
          management.delete(request_id);
          clearTimeout(timeout);
          if (result?.ok) resolve(result.data);
          else if (result) reject(new ApiError(result.status, "HERMES_MANAGEMENT_ERROR", result.message));
          else reject(new ApiError(timedOut ? 504 : 503, write ? "MANAGEMENT_UNCONFIRMED" : "MANAGEMENT_UNAVAILABLE",
            write ? "Hermes 无法确认此次更改。请先刷新查看当前状态，再重试。"
              : "连接器未返回响应，请刷新后重试。"));
        };
        const timeout = setTimeout(() => finish(undefined, true), managementTimeout(call.operation) + 4_000);
        timeout.unref();
        management.set(request_id, finish);
        try {
          if (!send({ type: "management_request", request_id, ...call })) finish();
        } catch {
          finish();
        }
      });
    };
    active = { socket, reasoning, attachments, pump, query, manage: request.headers["x-hermes-mobile-management"] === "1" ? manage : undefined };
    socket.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive || [...sent.values()].some((sentAt) => Date.now() - sentAt > 90_000)) return socket.terminate();
      alive = false;
      if (isCurrent()) socket.ping();
    }, 25_000);
    heartbeat.unref();
    socket.once("close", () => {
      clearInterval(heartbeat);
      for (const query of queries.values()) query.finish();
      for (const finish of management.values()) finish();
      if (active?.socket === socket) {
        active = undefined;
        changed();
      }
    });
    socket.on("error", () => socket.terminate());
    socket.on("message", (raw, isBinary) => {
      if (isBinary || queuedFrames >= 128) {
        socket.close(1008, "连接器消息格式无效");
        return;
      }
      queuedFrames += 1;
      if (queuedFrames === 32) socket.pause();
      run(async () => {
        try {
          const frame = connectorFrame(JSON.parse(raw.toString()));
          if (frame.type === "topic_query_result") {
            const query = queries.get(frame.request_id);
            if (!query) return;
            if ("data" in frame && frame.data.kind !== query.kind) invalid("话题查询结果类型不匹配。");
            query.finish(frame);
          } else if (frame.type === "management_result") {
            management.get(frame.request_id)?.(frame);
          } else if (frame.type === "command_result") {
            if (watches.delete(frame.command_id)) return;
            if (!sent.has(frame.command_id)) {
              // 原连接丢失确认回执时，连接器可以重发结果。
              const { rowCount } = await store.query("SELECT id FROM commands WHERE id = $1 AND dispatched", [frame.command_id]);
              if (!rowCount) invalid("此命令未通过当前连接发送。");
            }
            const topic = await store.transaction((db) => applyResult(db, frame, refs));
            if (topic.session_id) sessions.set(topic.id, topic.session_id);
            sent.delete(frame.command_id);
            send({ type: "ack", id: frame.command_id });
            changed(topic.id);
            pump();
          } else if (frame.type === "delivery") {
            await store.transaction((db) => applyDelivery(db, frame, refs));
            send({ type: "ack", id: frame.event_id });
            changed();
          } else {
            await store.transaction((db) => applyEvent(db, frame, refs, sessions));
            send({ type: "ack", id: frame.event_id });
            changed(frame.topic_id);
          }
        } finally {
          queuedFrames -= 1;
          if (queuedFrames === 16 && isCurrent()) socket.resume();
        }
      });
    });
    run(async () => {
      const { rows } = await store.query<{ id: string; profile_ref: string; session_id: string }>(
        "SELECT id, profile_ref, session_id FROM topics WHERE status = 'ready' AND profile_ref = ANY($1) ORDER BY created_at", [[...refs]],
      );
      for (const { id, profile_ref, session_id } of rows) {
        const commandId = randomUUID();
        if (send({ type: "command", command_id: commandId, topic_id: id, profile_ref, session_id, kind: "watch", body: {} })) {
          sessions.set(id, session_id);
          watches.add(commandId);
        }
      }
      pump();
    });
    changed();
  });

  return {
    online: () => active !== undefined && active.socket.readyState === active.socket.OPEN,
    reasoningSupported: () => active?.reasoning === true && active.socket.readyState === active.socket.OPEN,
    attachmentsSupported: () => active?.attachments === true && active.socket.readyState === active.socket.OPEN,
    pump: () => active?.pump(),
    async query(target: Omit<TopicQuery, "type" | "request_id">) {
      if (!refs.has(target.profile_ref)) invalid("Hermes 配置档案无效。");
      if (!active || active.socket.readyState !== active.socket.OPEN) {
        throw new ApiError(503, "CONNECTOR_OFFLINE", "请连接 Hermes 后重试。");
      }
      const result = await active.query(target);
      if ("data" in result) return result.data;
      if (result.error === "too_large") {
        throw new ApiError(502, "TOPIC_QUERY_TOO_LARGE", "Hermes 技能列表超出连接器的响应大小限制。");
      }
      if (result.error === "unavailable") {
        throw new ApiError(503, "TOPIC_QUERY_UNAVAILABLE", "此 Hermes 服务器暂不支持该功能。");
      }
      throw new ApiError(502, "TOPIC_QUERY_FAILED", {
        skills: "无法获取此 Hermes 配置档案的技能列表，请重试。",
        status: "无法读取此 Hermes 会话的状态，请重试。",
        version: "无法获取 Hermes 版本，请重试。",
      }[target.kind]);
    },
    manage(call: ManagementCall) {
      if (!active?.manage) throw new ApiError(503, "MANAGEMENT_UNAVAILABLE",
        "请为 Hermes 连接器配置控制台地址和令牌，连接后即可使用管理功能。");
      return active.manage(call);
    },
  };
}
