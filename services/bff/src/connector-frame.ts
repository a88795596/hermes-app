import type { ConnectorFrame, ModelResult } from "@hermes-mobile/protocol";
import { MAX_CLARIFY_CHOICE_BYTES } from "@hermes-mobile/protocol";
import { invalid, record, string, uuid } from "./validation.js";

const controlStatuses = ["pending", "responding", "closed", "unknown"] as const;

function option<const T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid("Invalid Connector enum");
  return value as T;
}

function modelResult(value: unknown): ModelResult {
  const body = record(value);
  if (body.type === "catalog") {
    const catalog = record(body.catalog, ["provider", "model", "providers"]);
    if (!Array.isArray(catalog.providers)) invalid("Invalid model providers");
    return { type: "catalog", catalog: {
      provider: string(catalog.provider, "provider", 256, true),
      model: string(catalog.model, "model", 512, true),
      providers: catalog.providers.map((value: unknown) => {
        const row = record(value, ["id", "name", "models"]);
        if (!Array.isArray(row.models)) invalid("Invalid provider models");
        return { id: string(row.id, "provider ID", 256), name: string(row.name, "provider name", 256),
          models: row.models.map((model: unknown) => string(model, "model ID", 512)) };
      }),
    } };
  }
  if (body.type === "selected" || body.type === "deferred") {
    const selection = record(body.selection, ["provider", "model"]);
    return { type: body.type, selection: {
      provider: string(selection.provider, "provider", 256), model: string(selection.model, "model", 512),
    } };
  }
  if (body.type === "confirmation") {
    const confirm = string(body.confirm, "model confirmation", 64);
    if (!/^[a-f0-9]{64}$/.test(confirm)) invalid("Invalid model confirmation");
    return { type: "confirmation", confirm, message: string(body.message, "confirmation message", 16 * 1024) };
  }
  invalid("Invalid model result");
}

export function connectorFrame(value: unknown): ConnectorFrame {
  const { type } = record(value);
  switch (type) {
    case "management_result": {
      const { request_id, ok, data, status, message } = record(value, ["type", "request_id", "ok", "data", "status", "message"]);
      const id = uuid(request_id, "request_id");
      if (ok === true && data !== undefined) return { type, request_id: id, ok, data };
      if (ok === false && typeof status === "number" && [400, 404, 409, 422, 429, 502, 503, 504].includes(status)) {
        return { type, request_id: id, ok, status, message: string(message, "message", 2048) };
      }
      invalid("Invalid management result");
    }
    case "command_result": {
      const body = record(value, ["type", "command_id", "status", "session_id", "admission_id", "error", "control_status", "model_result"]);
      return { type, command_id: uuid(body.command_id, "command_id"), status: option(body.status, ["ok", "error", "unknown"]),
        ...(body.session_id === undefined ? {} : { session_id: string(body.session_id, "session_id", 512) }),
        ...(body.admission_id === undefined ? {} : { admission_id: string(body.admission_id, "admission_id", 512) }),
        ...(body.error === undefined ? {} : { error: string(body.error, "error", 1024) }),
        ...(body.control_status === undefined ? {} : { control_status: option(body.control_status, controlStatuses) }),
        ...(body.model_result === undefined ? {} : { model_result: modelResult(body.model_result) }) };
    }
    case "topic_query_result": {
      const body = record(value, ["type", "request_id", "data", "error"]);
      const request_id = uuid(body.request_id, "request_id");
      if (body.error !== undefined) {
        if (body.data !== undefined) invalid("Unexpected query data");
        return { type, request_id, error: option(body.error, ["unavailable", "failed", "too_large"]) };
      }
      const data = record(body.data);
      if (data.kind === "skills" && Array.isArray(data.skills)) {
        const skills = data.skills.map((raw) => {
          const skill = record(raw, ["name", "description", "category"]);
          return {
            name: string(skill.name, "skill name", 1024),
            ...(skill.description === undefined ? {} : { description: string(skill.description, "description", 8192, true) }),
            ...(skill.category === undefined ? {} : { category: string(skill.category, "category", 1024, true) }),
          };
        });
        return { type, request_id, data: { kind: "skills", skills } };
      }
      if (data.kind === "version") {
        return { type, request_id, data: { kind: "version", version: string(data.version, "Hermes version", 128) } };
      }
      if (data.kind !== "status") invalid("Invalid query result");
      const status = record(data.status, ["activity", "model", "message_count"]);
      const count = status.message_count;
      if (count !== undefined && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) {
        invalid("Invalid message count");
      }
      return { type, request_id, data: { kind: "status", status: {
        activity: option(status.activity, ["idle", "running", "queued", "unknown"]),
        ...(status.model === undefined ? {} : { model: string(status.model, "model", 512) }),
        ...(count === undefined ? {} : { message_count: count }),
      } } };
    }
    case "delivery": {
      const body = record(value, ["type", "event_id", "delivery_id", "profile_ref", "text"]);
      return { type, event_id: uuid(body.event_id, "event_id"), delivery_id: uuid(body.delivery_id, "delivery_id"),
        profile_ref: string(body.profile_ref, "profile_ref", 256), text: string(body.text, "text", 256 * 1024) };
    }
    case "message": {
      const body = record(value, ["type", "event_id", "topic_id", "message_id", "submission_id", "text", "status"]);
      return { type, event_id: uuid(body.event_id, "event_id"), topic_id: uuid(body.topic_id, "topic_id"),
        message_id: uuid(body.message_id, "message_id"), text: string(body.text, "text", 256 * 1024, true),
        status: option(body.status, ["streaming", "final"]),
        ...(body.submission_id === undefined ? {} : { submission_id: uuid(body.submission_id, "submission_id") }) };
    }
    case "submission": {
      const body = record(value, ["type", "event_id", "topic_id", "submission_id", "status", "error"]);
      return { type, event_id: uuid(body.event_id, "event_id"), topic_id: uuid(body.topic_id, "topic_id"),
        submission_id: uuid(body.submission_id, "submission_id"),
        status: option(body.status, ["queued", "streaming", "final", "failed", "cancelled", "unknown"]),
        ...(body.error === undefined ? {} : { error: string(body.error, "error", 1024) }) };
    }
    case "control": {
      const body = record(value, ["type", "event_id", "topic_id", "control_id", "kind", "prompt", "choices", "status",
        "multi_select", "submission_id"]);
      if (!Array.isArray(body.choices) || body.choices.length > 30) invalid("Invalid control choices");
      if (body.multi_select !== undefined && (body.kind !== "clarify" || typeof body.multi_select !== "boolean")) {
        invalid("Invalid control multi-select flag");
      }
      return { type, event_id: uuid(body.event_id, "event_id"), topic_id: uuid(body.topic_id, "topic_id"),
        control_id: uuid(body.control_id, "control_id"), kind: option(body.kind, ["approval", "clarify"]),
        prompt: string(body.prompt, "prompt", 64 * 1024),
        choices: body.choices.map((choice) => string(choice, "choice", body.kind === "clarify" ? MAX_CLARIFY_CHOICE_BYTES : 1024)),
        status: option(body.status, controlStatuses),
        ...(body.multi_select === undefined ? {} : { multi_select: body.multi_select }),
        ...(body.submission_id === undefined ? {} : { submission_id: uuid(body.submission_id, "submission_id") }) };
    }
    default: invalid("Unsupported Connector frame");
  }
}
