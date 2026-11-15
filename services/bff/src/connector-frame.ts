import type { ConnectorFrame, MessageProcessStep, ModelResult } from "@hermes-mobile/protocol";
import { MAX_CLARIFY_CHOICE_BYTES, MAX_INBOX_TITLE_BYTES, MAX_MESSAGE_PROCESS_STEPS, MAX_MESSAGE_PROCESS_TEXT_BYTES, MAX_TOPIC_TITLE_BYTES } from "@hermes-mobile/protocol";
import { deliverySessionId, invalid, record, string, uuid } from "./validation.js";
import { receivedAttachmentReferences } from "./received-attachments.js";

const controlStatuses = ["pending", "responding", "closed", "unknown"] as const;

function option<const T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid("连接器的枚举值无效。");
  return value as T;
}

function messageProcess(value: unknown): MessageProcessStep[] {
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_PROCESS_STEPS) invalid("回复过程无效。");
  return value.map((entry) => {
    const kind = option(record(entry).kind, ["reasoning", "commentary", "tool"]);
    if (kind === "tool") {
      const tool = record(entry, ["kind", "id", "name", "status"]);
      return { kind, id: string(tool.id, "工具调用 ID", 512), name: string(tool.name, "工具名称", 256),
        status: option(tool.status, ["running", "succeeded", "failed", "unknown"]) };
    }
    const step = record(entry, ["kind", "text"]);
    return { kind, text: string(step.text, "过程文本", MAX_MESSAGE_PROCESS_TEXT_BYTES, true) };
  });
}

function modelResult(value: unknown): ModelResult {
  const body = record(value);
  if (body.type === "catalog") {
    const catalog = record(body.catalog, ["provider", "model", "providers"]);
    if (!Array.isArray(catalog.providers)) invalid("模型提供商列表无效。");
    return { type: "catalog", catalog: {
      provider: string(catalog.provider, "模型提供商", 256, true),
      model: string(catalog.model, "模型", 512, true),
      providers: catalog.providers.map((value: unknown) => {
        const row = record(value, ["id", "name", "models"]);
        if (!Array.isArray(row.models)) invalid("提供商的模型列表无效。");
        return { id: string(row.id, "提供商 ID", 256), name: string(row.name, "提供商名称", 256),
          models: row.models.map((model: unknown) => string(model, "模型 ID", 512)) };
      }),
    } };
  }
  if (body.type === "selected" || body.type === "deferred") {
    const selection = record(body.selection, ["provider", "model"]);
    return { type: body.type, selection: {
      provider: string(selection.provider, "模型提供商", 256), model: string(selection.model, "模型", 512),
    } };
  }
  if (body.type === "confirmation") {
    const confirm = string(body.confirm, "模型确认凭证", 64);
    if (!/^[a-f0-9]{64}$/.test(confirm)) invalid("模型确认凭证无效。");
    return { type: "confirmation", confirm, message: string(body.message, "确认提示", 16 * 1024) };
  }
  invalid("模型结果无效。");
}

export function connectorFrame(value: unknown): ConnectorFrame {
  const { type } = record(value);
  switch (type) {
    case "management_result": {
      const { request_id, ok, data, status, message } = record(value, ["type", "request_id", "ok", "data", "status", "message"]);
      const id = uuid(request_id, "请求 ID");
      if (ok === true && data !== undefined) return { type, request_id: id, ok, data };
      if (ok === false && typeof status === "number" && [400, 404, 409, 422, 429, 502, 503, 504].includes(status)) {
        return { type, request_id: id, ok, status, message: string(message, "错误提示", 2048) };
      }
      invalid("管理操作结果无效。");
    }
    case "command_result": {
      const body = record(value, ["type", "command_id", "status", "session_id", "admission_id", "error", "control_status", "model_result", "title", "steering"]);
      if (body.steering !== undefined && body.steering !== true) invalid("连接器的插话结果标记无效。");
      return { type, command_id: uuid(body.command_id, "命令 ID"), status: option(body.status, ["ok", "error", "unknown"]),
        ...(body.steering === true ? { steering: true } : {}),
        ...(body.session_id === undefined ? {} : { session_id: string(body.session_id, "会话 ID", 512) }),
        ...(body.admission_id === undefined ? {} : { admission_id: string(body.admission_id, "受理 ID", 512) }),
        ...(body.error === undefined ? {} : { error: string(body.error, "错误提示", 1024) }),
        ...(body.control_status === undefined ? {} : { control_status: option(body.control_status, controlStatuses) }),
        ...(body.model_result === undefined ? {} : { model_result: modelResult(body.model_result) }),
        ...(body.title === undefined ? {} : { title: string(body.title, "话题标题", MAX_TOPIC_TITLE_BYTES) }) };
    }
    case "topic_query_result": {
      const body = record(value, ["type", "request_id", "data", "error"]);
      const request_id = uuid(body.request_id, "请求 ID");
      if (body.error !== undefined) {
        if (body.data !== undefined) invalid("查询失败时不能包含结果数据。");
        return { type, request_id, error: option(body.error, ["unavailable", "failed", "too_large"]) };
      }
      const data = record(body.data);
      if (data.kind === "skills" && Array.isArray(data.skills)) {
        const skills = data.skills.map((raw) => {
          const skill = record(raw, ["name", "description", "category"]);
          return {
            name: string(skill.name, "技能名称", 1024),
            ...(skill.description === undefined ? {} : { description: string(skill.description, "技能描述", 8192, true) }),
            ...(skill.category === undefined ? {} : { category: string(skill.category, "技能分类", 1024, true) }),
          };
        });
        return { type, request_id, data: { kind: "skills", skills } };
      }
      if (data.kind === "version") {
        return { type, request_id, data: { kind: "version", version: string(data.version, "Hermes 版本", 128) } };
      }
      if (data.kind !== "status") invalid("查询结果无效。");
      const status = record(data.status, ["activity", "model", "message_count"]);
      const count = status.message_count;
      if (count !== undefined && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) {
        invalid("消息数量无效。");
      }
      return { type, request_id, data: { kind: "status", status: {
        activity: option(status.activity, ["idle", "running", "queued", "unknown"]),
        ...(status.model === undefined ? {} : { model: string(status.model, "模型", 512) }),
        ...(count === undefined ? {} : { message_count: count }),
      } } };
    }
    case "delivery": {
      const body = record(value, ["type", "event_id", "delivery_id", "profile_ref", "session_id", "title", "text", "attachments"]);
      const attachments = body.attachments === undefined ? undefined : receivedAttachmentReferences(body.attachments);
      return { type, event_id: uuid(body.event_id, "事件 ID"), delivery_id: uuid(body.delivery_id, "投递 ID"),
        ...(body.session_id === undefined ? {} : { session_id: deliverySessionId(body.session_id) }),
        ...(body.title === undefined ? {} : { title: string(body.title, "消息标题", MAX_INBOX_TITLE_BYTES) }),
        ...(attachments?.length ? { attachments } : {}),
        profile_ref: string(body.profile_ref, "配置档案名称", 256), text: string(body.text, "消息正文", 256 * 1024, !!attachments?.length) };
    }
    case "topic_title": {
      const body = record(value, ["type", "event_id", "topic_id", "session_id", "title"]);
      return { type, event_id: uuid(body.event_id, "事件 ID"), topic_id: uuid(body.topic_id, "话题 ID"),
        session_id: string(body.session_id, "会话 ID", 512), title: string(body.title, "话题标题", MAX_TOPIC_TITLE_BYTES) };
    }
    case "message": {
      const body = record(value, ["type", "event_id", "topic_id", "message_id", "submission_id", "text", "status", "process", "attachments"]);
      return { type, event_id: uuid(body.event_id, "事件 ID"), topic_id: uuid(body.topic_id, "话题 ID"),
        message_id: uuid(body.message_id, "消息 ID"), text: string(body.text, "消息正文", 256 * 1024, true),
        status: option(body.status, ["streaming", "final"]),
        ...(body.process === undefined ? {} : { process: messageProcess(body.process) }),
        ...(body.attachments === undefined ? {} : { attachments: receivedAttachmentReferences(body.attachments) }),
        ...(body.submission_id === undefined ? {} : { submission_id: uuid(body.submission_id, "提交 ID") }) };
    }
    case "submission": {
      const body = record(value, ["type", "event_id", "topic_id", "submission_id", "status", "error"]);
      return { type, event_id: uuid(body.event_id, "事件 ID"), topic_id: uuid(body.topic_id, "话题 ID"),
        submission_id: uuid(body.submission_id, "提交 ID"),
        status: option(body.status, ["queued", "streaming", "final", "failed", "cancelled", "unknown"]),
        ...(body.error === undefined ? {} : { error: string(body.error, "错误提示", 1024) }) };
    }
    case "control": {
      const body = record(value, ["type", "event_id", "topic_id", "control_id", "kind", "prompt", "choices", "status",
        "multi_select", "submission_id"]);
      if (!Array.isArray(body.choices) || body.choices.length > 30) invalid("交互请求的选项无效。");
      if (body.multi_select !== undefined && (body.kind !== "clarify" || typeof body.multi_select !== "boolean")) {
        invalid("交互请求的多选标记无效。");
      }
      return { type, event_id: uuid(body.event_id, "事件 ID"), topic_id: uuid(body.topic_id, "话题 ID"),
        control_id: uuid(body.control_id, "交互请求 ID"), kind: option(body.kind, ["approval", "clarify"]),
        prompt: string(body.prompt, "交互请求提示", 64 * 1024),
        choices: body.choices.map((choice) => string(choice, "交互请求选项", body.kind === "clarify" ? MAX_CLARIFY_CHOICE_BYTES : 1024)),
        status: option(body.status, controlStatuses),
        ...(body.multi_select === undefined ? {} : { multi_select: body.multi_select }),
        ...(body.submission_id === undefined ? {} : { submission_id: uuid(body.submission_id, "提交 ID") }) };
    }
    default: invalid("不支持此类连接器消息帧。");
  }
}
