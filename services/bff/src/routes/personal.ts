import { randomBytes } from "node:crypto";
import type { InboxDelivery, InboxItem, MobileNotice, TopicQuery } from "@hermes-mobile/protocol";
import { inboxTitle, isManagementOperation, isReasoningEffort, MAX_ATTACHMENT_TOTAL_BYTES, MAX_CONTROL_ANSWER_BYTES, MAX_INBOX_TEXT_BYTES, MAX_INBOX_TITLE_BYTES, MAX_TOPIC_TITLE_BYTES } from "@hermes-mobile/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { submissionAttachments } from "../attachments.js";
import { deviceAuth, matchesToken, readBearer } from "../auth.js";
import { registerBridge } from "../bridge.js";
import { applyInboxDelivery } from "../ingress.js";
import { createTopic, findProfile, interrupt, requestModel, requestReasoning, respond, setTopicArchived, submit } from "../mutations.js";
import { detail, modelRequest, profileId, profiles, reasoningRequest, topicRow, topics } from "../projections.js";
import { registerProfilePreferences } from "../profile-preferences.js";
import { registerPushRoutes } from "../push.js";
import { receivedAttachmentReferences, registerReceivedAttachments } from "../received-attachments.js";
import type { Store } from "../store.js";
import { ApiError, deliverySessionId, invalid, record, string, uuid } from "../validation.js";

interface Config {
  pairingToken: string;
  connectorToken: string;
  inboxDeliveryToken?: string;
  profileRefs: string[];
}

function success(request: FastifyRequest, data: unknown) {
  return { data, request_id: request.id, server_time: new Date().toISOString() };
}

function accepted(request: FastifyRequest, reply: FastifyReply, data: unknown) {
  return reply.code(202).send(success(request, data));
}

function pathId(request: FastifyRequest) {
  return uuid(record(request.params).id, "资源 ID");
}

export function registerPersonalRoutes(api: FastifyInstance, store: Store, config: Config) {
  const refs = new Set(config.profileRefs.map((ref) => string(ref.trim(), "配置档案名称", 256)));
  if (!refs.size || [...refs].some((ref) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(ref))) {
    throw new Error("HERMES_PROFILES 必须包含有效的 Hermes 配置档案名称。");
  }
  const auth = deviceAuth(store);
  const tickets = new Map<string, { deviceId: string; expiresAt: number }>();
  const mobiles = new Map<WebSocket, string>();
  const prefix = "/mobile/v1";
  api.addHook("onRequest", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
  const authenticate = async (request: FastifyRequest) => {
    const deviceId = await auth.authenticate(request);
    if (!deviceId) throw new ApiError(401, "UNAUTHORIZED", "设备凭证无效。");
    return deviceId;
  };
  const verifyDevice = async (request: FastifyRequest) => { await authenticate(request); };
  const requireDevice = { preValidation: verifyDevice };
  const changed = (topicId?: string) => {
    const notice: MobileNotice = { type: "changed", ...(topicId ? { topic_id: topicId } : {}) };
    const raw = JSON.stringify(notice);
    for (const socket of mobiles.keys()) {
      if (socket.readyState !== socket.OPEN) continue;
      if (socket.bufferedAmount > 256 * 1024) socket.close(1013, "请重新连接并刷新");
      else socket.send(raw);
    }
  };
  const bridge = registerBridge(api, store, refs, config.connectorToken, changed);
  registerPushRoutes(api, store, authenticate);
  registerReceivedAttachments(api, store, refs, config, authenticate);
  registerProfilePreferences(api, store, refs, config, authenticate, changed);

  api.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message,
        retryable: error.code === "DELIVERY_TARGET_NOT_READY" }, request_id: request.id });
    }
    const status = error instanceof Error && "statusCode" in error ? Number(error.statusCode) : 500;
    if (status === 413) return reply.code(413).send({ error: {
      code: "BODY_TOO_LARGE", message: "发送内容超出服务器大小限制。", retryable: false,
    }, request_id: request.id });
    const rejected = status >= 400 && status < 500;
    if (!rejected) api.log.error({ request_id: request.id }, "处理请求失败");
    return reply.code(rejected ? status : 500).send({ error: {
      code: rejected ? "BAD_REQUEST" : "INTERNAL_ERROR",
      message: rejected ? "请求无效。" : "无法完成请求。",
      retryable: !rejected,
    }, request_id: request.id });
  });

  api.post(`${prefix}/pairings/redeem`, async (request) => {
    const body = record(request.body, ["pairing_token", "device_name"]);
    if (!matchesToken(body.pairing_token, config.pairingToken)) throw new ApiError(401, "UNAUTHORIZED", "配对令牌无效。");
    const name = string(body.device_name, "设备名称", 160);
    return success(request, await auth.issue(name));
  });

  api.delete(`${prefix}/auth/session`, async (request, reply) => {
    const deviceId = await authenticate(request);
    await auth.revoke(deviceId);
    for (const [key, ticket] of tickets) if (ticket.deviceId === deviceId) tickets.delete(key);
    for (const [socket, owner] of mobiles) if (owner === deviceId) socket.close(1008, "设备会话已撤销");
    return reply.code(204).send();
  });

  api.get(`${prefix}/profiles`, requireDevice, async (request) => success(request, await profiles(store, refs)));
  api.post(`${prefix}/profiles/:id/manage/:operation`, requireDevice, async (request) => {
    const params = record(request.params);
    const profile_ref = findProfile(refs, pathId(request));
    const operation = params.operation;
    if (!isManagementOperation(operation)) throw new ApiError(404, "NOT_FOUND", "找不到该管理操作。");
    if (profile_ref === "all" || profile_ref === "current") invalid("请选择具体的 Hermes 配置档案。");
    const { input } = record(request.body ?? {}, ["input"]);
    return success(request, await bridge.manage({ profile_ref, operation, input: input === undefined ? {} : record(input) }));
  });
  api.get(`${prefix}/status`, requireDevice, (request) => success(request, {
    connector_online: bridge.online(), reasoning_supported: bridge.reasoningSupported(), attachments_supported: bridge.attachmentsSupported(),
  }));
  api.get(`${prefix}/topics`, requireDevice, async (request) => {
    const { include_archived } = record(request.query);
    if (include_archived !== undefined && include_archived !== "true" && include_archived !== "false") {
      invalid("include_archived 必须为 true 或 false。");
    }
    return success(request, await topics(store, refs, include_archived === "true"));
  });
  api.get(`${prefix}/topics/:id`, requireDevice, async (request) => success(request, await detail(store, pathId(request), refs)));
  api.put(`${prefix}/topics/:id/archive`, requireDevice, async (request) => {
    const id = pathId(request);
    const { archived } = record(request.body, ["archived"]);
    if (typeof archived !== "boolean") invalid("必须指定是否归档。");
    const topic = await store.transaction((db) => setTopicArchived(db, refs, id, archived));
    changed();
    return success(request, topic);
  });
  for (const kind of ["skills", "status", "version"] satisfies TopicQuery["kind"][]) {
    api.get(`${prefix}/topics/:id/${kind}`, requireDevice, async (request) => {
      const topic = await topicRow(store, pathId(request), refs);
      if (topic.status !== "ready" || !topic.session_id) {
        throw new ApiError(409, "TOPIC_NOT_READY", "话题尚未就绪。");
      }
      const result = await bridge.query({
        kind, topic_id: topic.id, profile_ref: topic.profile_ref, session_id: topic.session_id,
      });
      switch (result.kind) {
        case "skills": return success(request, result.skills);
        case "status": return success(request, result.status);
        case "version": return success(request, result.version);
      }
    });
  }
  api.get(`${prefix}/inbox`, requireDevice, async (request) => {
    const { rows } = await store.query<{ profile_ref: string; data: InboxItem }>("SELECT profile_ref, data FROM inbox WHERE profile_ref = ANY($1) ORDER BY created_at DESC, id", [[...refs]]);
    return success(request, rows.map(({ profile_ref, data }) => ({ ...data,
      profile_id: profileId(profile_ref), title: data.title ?? inboxTitle(data.text) })));
  });
  const deliveryToken = config.inboxDeliveryToken;
  if (deliveryToken) {
    if (!/^[\x21-\x7e]+$/.test(deliveryToken) || [config.pairingToken, config.connectorToken].includes(deliveryToken)) {
      throw new Error("INBOX_DELIVERY_TOKEN 必须是与配对和连接器令牌不同的凭证，且不能包含空白字符。");
    }
    api.post("/internal/inbox/v1/deliveries", {
      // JSON 转义后单个正文字符最多占 6 字节。
      bodyLimit: 6 * (MAX_INBOX_TEXT_BYTES + MAX_INBOX_TITLE_BYTES) + 16 * 1024,
      onRequest: async (request) => {
        if (!matchesToken(readBearer(request), deliveryToken)) throw new ApiError(401, "UNAUTHORIZED", "收件箱投递凭证无效。");
      },
    }, async (request, reply) => {
      const body = record(request.body, ["delivery_id", "profile_ref", "session_id", "title", "text", "attachments"]);
      const attachments = body.attachments === undefined ? undefined : receivedAttachmentReferences(body.attachments);
      const delivery: InboxDelivery = {
        delivery_id: uuid(body.delivery_id, "投递 ID"),
        profile_ref: string(body.profile_ref, "配置档案名称", 64),
        ...(body.session_id === undefined ? {} : { session_id: deliverySessionId(body.session_id) }),
        ...(body.title === undefined ? {} : { title: string(body.title, "消息标题", MAX_INBOX_TITLE_BYTES) }),
        text: string(body.text, "消息正文", MAX_INBOX_TEXT_BYTES, !!attachments?.length),
        ...(attachments?.length ? { attachments } : {}),
      };
      const applied = await store.transaction((db) => applyInboxDelivery(db, delivery, refs));
      if (applied) changed();
      return reply.code(204).send();
    });
  }

  api.post(`${prefix}/topics`, requireDevice, async (request, reply) => {
    const body = record(request.body, ["request_id", "profile_id", "title"]);
    const id = uuid(body.request_id, "请求 ID");
    const profile = findProfile(refs, uuid(body.profile_id, "配置档案 ID"));
    const title = body.title === undefined ? undefined : string(body.title, "话题标题", MAX_TOPIC_TITLE_BYTES);
    const topic = await store.transaction((db) => createTopic(db, id, profile, title));
    changed(topic.topic_id);
    bridge.pump();
    return accepted(request, reply, topic);
  });

  api.post(`${prefix}/topics/:id/submissions`, {
    onRequest: verifyDevice, bodyLimit: Math.ceil(MAX_ATTACHMENT_TOTAL_BYTES / 3) * 4 + 512 * 1024,
  }, async (request, reply) => {
    const topicId = pathId(request);
    const body = record(request.body, ["submission_id", "text", "attachments"]);
    const id = uuid(body.submission_id, "提交 ID");
    const attachments = submissionAttachments(body.attachments);
    const text = string(body.text, "消息正文", 64 * 1024, attachments.length > 0);
    const supported = !bridge.online() || bridge.attachmentsSupported();
    const message = await store.transaction((db) => submit(db, refs, topicId, id, text, attachments, supported));
    changed(topicId);
    bridge.pump();
    return accepted(request, reply, message);
  });

  api.post(`${prefix}/topics/:id/interrupt`, requireDevice, async (request, reply) => {
    const topicId = pathId(request);
    const body = record(request.body, ["request_id", "submission_id"]);
    const id = uuid(body.request_id, "请求 ID");
    const submissionId = uuid(body.submission_id, "提交 ID");
    const result = await store.transaction((db) => interrupt(db, refs, topicId, id, submissionId));
    bridge.pump();
    return accepted(request, reply, result);
  });

  api.post(`${prefix}/topics/:id/model-requests`, requireDevice, async (request, reply) => {
    const topicId = pathId(request);
    const body = record(request.body, ["request_id", "provider", "model", "global", "confirm"]);
    const id = uuid(body.request_id, "请求 ID");
    const confirm = body.confirm === undefined ? undefined : string(body.confirm, "模型确认凭证", 64);
    if (confirm !== undefined && !/^[a-f0-9]{64}$/.test(confirm)) invalid("模型确认凭证无效。");
    if (body.global !== undefined && typeof body.global !== "boolean") invalid("模型默认设置必须采用布尔值。");
    const selection = body.provider === undefined && body.model === undefined && body.global === undefined && confirm === undefined ? undefined : {
      provider: string(body.provider, "模型服务商", 256), model: string(body.model, "模型", 512),
      ...(body.global === undefined ? {} : { global: body.global }),
      ...(confirm === undefined ? {} : { confirm }),
    };
    const result = await store.transaction((db) => requestModel(db, refs, topicId, id, selection));
    bridge.pump();
    return accepted(request, reply, result);
  });

  api.get(`${prefix}/topics/:id/model-requests/:requestId`, requireDevice, async (request) => {
    const requestId = uuid(record(request.params).requestId, "请求 ID");
    return success(request, await modelRequest(store, refs, pathId(request), requestId));
  });

  api.post(`${prefix}/topics/:id/reasoning-requests`, requireDevice, async (request, reply) => {
    const topicId = pathId(request);
    const { request_id, effort } = record(request.body, ["request_id", "effort"]);
    const id = uuid(request_id, "请求 ID");
    if (effort !== null && !isReasoningEffort(effort)) invalid("思考强度无效。");
    const result = await store.transaction((db) => requestReasoning(db, refs, topicId, id, effort,
      !bridge.online() ? "offline" : bridge.reasoningSupported() ? "ready" : "legacy"));
    changed(topicId);
    bridge.pump();
    return accepted(request, reply, result);
  });

  api.get(`${prefix}/topics/:id/reasoning-requests/:requestId`, requireDevice, async (request) => {
    const requestId = uuid(record(request.params).requestId, "请求 ID");
    return success(request, await reasoningRequest(store, refs, pathId(request), requestId));
  });

  api.post(`${prefix}/controls/:id/responses`, requireDevice, async (request, reply) => {
    const controlId = pathId(request);
    const body = record(request.body, ["response_id", "answer"]);
    const id = uuid(body.response_id, "答复 ID");
    const answer = string(body.answer, "答复内容", MAX_CONTROL_ANSWER_BYTES, true);
    const { topicId, result } = await store.transaction((db) => respond(db, refs, controlId, id, answer));
    changed(topicId);
    bridge.pump();
    return accepted(request, reply, result);
  });

  api.post(`${prefix}/ws-tickets`, async (request) => {
    const deviceId = await authenticate(request);
    const now = Date.now();
    for (const [key, ticket] of tickets) if (ticket.expiresAt <= now) tickets.delete(key);
    if (tickets.size >= 1024) throw new ApiError(429, "TOO_MANY_TICKETS", "请稍后重试。");
    const ticket = randomBytes(32).toString("base64url");
    tickets.set(ticket, { deviceId, expiresAt: now + 30_000 });
    return success(request, { ticket });
  });

  const readTicket = (request: FastifyRequest) => string(record(request.query, ["ticket"]).ticket, "WebSocket 票据", 43);
  api.get(`${prefix}/events`, { websocket: true, preValidation: async (request) => {
    const ticket = tickets.get(readTicket(request));
    if (!ticket || ticket.expiresAt <= Date.now()) throw new ApiError(401, "UNAUTHORIZED", "WebSocket 票据无效。");
  } }, (socket, request) => {
    const key = readTicket(request);
    const ticket = tickets.get(key);
    tickets.delete(key);
    if (!ticket || ticket.expiresAt <= Date.now()) return socket.close(1008, "WebSocket 票据无效");
    mobiles.set(socket, ticket.deviceId);
    let alive = true;
    socket.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      if (socket.readyState === socket.OPEN) socket.ping();
    }, 25_000);
    heartbeat.unref();
    socket.once("close", () => {
      clearInterval(heartbeat);
      mobiles.delete(socket);
    });
    socket.on("error", () => socket.terminate());
    socket.on("message", () => socket.close(1008, "此连接仅用于接收通知"));
    socket.send(JSON.stringify({ type: "changed" } satisfies MobileNotice));
  });
}
