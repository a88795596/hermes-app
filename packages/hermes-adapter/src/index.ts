export type CanonicalRecord = Record<string, unknown>;

const MAX_INT64 = 9_223_372_036_854_775_807n;
const decimalPattern = /^(0|[1-9][0-9]*)$/u;
const json = JSON as JSON & { rawJSON(source: string): object };

export function parseCanonicalJson(source: string): unknown {
  return JSON.parse(source, (_key, value: unknown, context?: { source?: string }) => {
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)
      && context?.source && /^-?[0-9]+$/u.test(context.source)) {
      return BigInt(context.source);
    }
    return value;
  });
}

export function canonicalInteger(value: string): number | object {
  if (!decimalPattern.test(value) || value.length > 19 || BigInt(value) > MAX_INT64) {
    throw new Error("Hermes 整数值无效");
  }
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : json.rawJSON(value);
}

function invalid(field: string): never {
  throw new Error(`Hermes ${field}无效`);
}

function isRecord(value: unknown): value is CanonicalRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, field: string): CanonicalRecord {
  return isRecord(value) ? value : invalid(field);
}

function string(value: unknown, field: string): string {
  return typeof value === "string" ? value : invalid(field);
}

function id(value: unknown, field: string): string {
  return string(value, field) || invalid(field);
}

function integer(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "bigint" && value >= 0n && value <= MAX_INT64) return value.toString();
  return invalid(field);
}

function list(value: unknown, field: string): unknown[] {
  return Array.isArray(value) ? value : invalid(field);
}

function boolean(value: unknown, field: string): boolean {
  return typeof value === "boolean" ? value : invalid(field);
}

export interface CanonicalEvent {
  sessionId: string;
  type: string;
  replayEpoch: string;
  sequence: string;
  authorityEpoch?: string;
  admissionId?: string;
  executionGeneration?: string;
  payload: CanonicalRecord;
}

export function parseCanonicalEvent(frame: unknown): CanonicalEvent | undefined {
  if (!isRecord(frame) || frame.method !== "event") return;
  if (frame.jsonrpc !== "2.0" || "id" in frame) invalid("事件报文");
  const params = record(frame.params, "事件参数");
  const type = id(params.type, "事件类型");
  if (params.session_id == null || params.session_id === "") return;
  const payload = record(params.payload, "事件内容");
  const gap = type === "session.replay_gap";
  return {
    sessionId: id(params.session_id, "session_id"),
    type,
    replayEpoch: id(gap ? payload.replay_epoch : params.replay_epoch, "replay_epoch"),
    sequence: integer(gap ? payload.latest_seq : params.seq, "事件序号"),
    authorityEpoch: params.authority_epoch == null ? undefined : integer(params.authority_epoch, "authority_epoch"),
    admissionId: params.admission_id == null ? undefined : id(params.admission_id, "admission_id"),
    executionGeneration: params.execution_generation == null
      ? undefined
      : integer(params.execution_generation, "execution_generation"),
    payload,
  };
}

export type AdmissionReceipt = { kind: "voice_stopped" } | CanonicalAdmission;

export interface CanonicalAdmission {
  kind: "admission";
  admissionId: string;
  sessionId: string;
  profileId: string;
  sequence: string;
  status: "queued" | "started" | "unknown" | "terminal";
  outcome: string | null;
  authorityEpoch: string;
  executionGeneration: string | null;
  finalText?: string;
  responseReused?: true;
}

function parseAdmission(value: CanonicalRecord): CanonicalAdmission {
  const ref = record(value.ref, "受理记录引用");
  const status = value.status;
  if (status !== "queued" && status !== "started" && status !== "unknown" && status !== "terminal") {
    invalid("受理记录状态");
  }
  const result = isRecord(value.result) ? value.result : undefined;
  return {
    kind: "admission",
    admissionId: id(value.admission_id, "admission_id"),
    sessionId: id(ref.session_id, "session_id"),
    profileId: id(ref.profile_id, "profile_id"),
    sequence: integer(value.sequence, "受理记录序号"),
    status,
    outcome: value.outcome === null ? null : id(value.outcome, "受理记录结果"),
    authorityEpoch: integer(value.authority_epoch, "authority_epoch"),
    executionGeneration: value.execution_generation === null
      ? null
      : integer(value.execution_generation, "execution_generation"),
    finalText: typeof result?.final_response === "string" ? result.final_response : undefined,
    ...(result?.response_reused === true ? { responseReused: true } : {}),
  };
}

export function parseAdmissionReceipt(value: unknown): AdmissionReceipt {
  const receipt = record(value, "受理回执");
  if (receipt.voice_stopped === true && Object.keys(receipt).length === 1) return { kind: "voice_stopped" };
  return parseAdmission(receipt);
}

export function parseControlReceipt(value: unknown, expectedPromptId: string): "resolved" | "already_resolved" {
  const receipt = record(value, "交互请求回执");
  if (receipt.prompt_id !== expectedPromptId || (receipt.status !== "resolved" && receipt.status !== "already_resolved")) {
    invalid("交互请求回执");
  }
  return receipt.status;
}

function strings(value: unknown, field: string): string[] {
  return list(value, field).map((item) => string(item, field));
}

export interface CanonicalPrompt {
  kind: "approval" | "clarify";
  promptId: string;
  executionGeneration: string;
  prompt: string;
  choices: string[];
  multiSelect: boolean;
}

function parsePrompt(payload: CanonicalRecord): CanonicalPrompt {
  const kind = payload.kind;
  if (kind !== "approval" && kind !== "clarify") invalid("提示类型");
  const command = kind === "approval" ? string(payload.command, "待审批命令") : undefined;
  const description = payload.description == null ? "" : string(payload.description, "审批说明");
  const choices = strings(payload.choices, "提示选项");
  return {
    kind,
    promptId: id(payload.prompt_id, "prompt_id"),
    executionGeneration: integer(payload.execution_generation, "execution_generation"),
    prompt: kind === "approval" ? [command, description].filter(Boolean).join("\n") : id(payload.question, "问题"),
    // 审批文件编辑前需查看差异，此纯文本客户端仅提供拒绝选项。
    choices: kind === "approval" && payload.edit != null ? choices.filter((choice) => choice === "deny") : choices,
    multiSelect: payload.multi_select == null ? false : boolean(payload.multi_select, "multi_select"),
  };
}

export function encodeControlResponse(sessionId: string, prompt: CanonicalPrompt, answer: string) {
  const params = {
    session_id: sessionId,
    execution_generation: canonicalInteger(prompt.executionGeneration),
    prompt_id: prompt.promptId,
  };
  if (prompt.kind === "approval") {
    if (!prompt.choices.includes(answer)) invalid("审批选项");
    return { method: "approval.respond", params: { ...params, choice: answer } };
  }
  return { method: "clarify.respond", params: { ...params, answer } };
}

export interface ServerRequest {
  requestId: string;
  sessionId: string;
  questions: { questionId: string; prompt: string; choices: string[]; multiSelect: boolean }[];
  answeredQuestionIds: string[];
}

export function parseServerRequest(frame: unknown): ServerRequest | undefined {
  if (!isRecord(frame) || frame.method !== "clarify" || !("id" in frame)) return;
  if (frame.jsonrpc !== "2.0") invalid("服务端请求报文");
  const params = record(frame.params, "服务端请求参数");
  const questions = list(params.questions, "澄清问题列表").map((value) => {
    const question = record(value, "澄清问题");
    return {
      questionId: id(question.qid, "问题标识 qid"),
      prompt: id(question.question, "问题"),
      choices: question.choices == null ? [] : strings(question.choices, "问题选项"),
      multiSelect: question.multi_select == null ? false : boolean(question.multi_select, "multi_select"),
    };
  });
  const questionIds = new Set(questions.map((question) => question.questionId));
  if (questions.length < 1 || questions.length > 5 || questions.length !== questionIds.size) {
    invalid("澄清问题列表");
  }
  const answers = params.answers == null ? {} : record(params.answers, "澄清回答");
  const answeredQuestionIds = Object.keys(answers);
  if (answeredQuestionIds.some((qid) => !questionIds.has(qid) || (answers[qid] !== null && typeof answers[qid] !== "string"))) {
    invalid("澄清回答");
  }
  return {
    requestId: id(frame.id, "服务端请求 ID"),
    sessionId: id(params.session_id, "session_id"),
    questions,
    answeredQuestionIds,
  };
}

export function encodeServerResponse(request: ServerRequest, answers: Record<string, string | null>) {
  const questionIds = new Set(request.questions.map((question) => question.questionId));
  if (Object.entries(answers).some(([qid, answer]) => !questionIds.has(qid) || (answer !== null && typeof answer !== "string"))) {
    invalid("澄清回答");
  }
  if (request.questions.some(({ questionId }) => !Object.hasOwn(answers, questionId)
    && !request.answeredQuestionIds.includes(questionId))) throw new Error("Hermes 澄清回答不完整");
  return { jsonrpc: "2.0", id: request.requestId, result: { answers, outcome: "submitted" } };
}

export interface PendingAdmission extends CanonicalAdmission {
  submissionId: string;
}

function parsePending(value: unknown): PendingAdmission[] {
  return list(value, "待处理的受理记录列表").map((item) => {
    const admission = record(item, "待处理的受理记录");
    return { ...parseAdmission(admission), submissionId: id(admission.input_id, "input_id") };
  });
}

export interface SessionSnapshot {
  sessionId: string;
  storedSessionId: string;
  authorityEpoch: string;
  replayEpoch: string;
  lastSequence: string;
  subscriptionId: string;
  executionGeneration: string;
  revision: string;
  running: boolean;
  title?: string;
  messages: { role: "user" | "assistant"; text: string; rowId?: string }[];
  prompts: CanonicalPrompt[];
  pending: PendingAdmission[];
  openRequests: ServerRequest[];
}

function textWithoutMedia(text: string): string {
  return text
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/giu, "[图片]")
    .replace(/^@image:.*$/gmu, "[图片]")
    .replace(/\[Image attached at: [^\n\]]+\]/gu, "[图片]");
}

export function parseSessionSnapshot(value: unknown): SessionSnapshot {
  const snapshot = record(value, "会话快照");
  const sessionId = id(snapshot.session_id, "session_id");
  const info = isRecord(snapshot.info) ? snapshot.info : undefined;
  const messages: SessionSnapshot["messages"] = [];
  // 网关提供的界面消息已滤除仅供模型读取的记录及技能和系统辅助内容。
  for (const row of list(snapshot.display_messages ?? [], "界面消息列表")) {
    const message = record(row, "界面消息");
    if ((message.role !== "user" && message.role !== "assistant") || message.text == null || message.text === "") continue;
    messages.push({
      role: message.role,
      text: textWithoutMedia(string(message.text, "消息文本")),
      rowId: message.row_id == null ? undefined : integer(message.row_id, "row_id"),
    });
  }
  return {
    sessionId,
    storedSessionId: id(snapshot.stored_session_id, "stored_session_id"),
    authorityEpoch: integer(snapshot.authority_epoch, "authority_epoch"),
    replayEpoch: id(snapshot.replay_epoch, "replay_epoch"),
    lastSequence: integer(snapshot.last_sequence, "last_sequence"),
    subscriptionId: id(snapshot.subscription_id, "subscription_id"),
    executionGeneration: integer(snapshot.execution_generation, "execution_generation"),
    revision: integer(snapshot.revision, "revision"),
    running: boolean(snapshot.running, "会话运行标志"),
    title: typeof info?.title === "string" ? info.title : undefined,
    messages,
    prompts: list(snapshot.prompts, "待处理提示列表").map((item) => parsePrompt(record(item, "提示"))),
    pending: parsePending(snapshot.pending),
    openRequests: list(snapshot.open_requests ?? [], "待响应请求列表").flatMap((item) => {
      const request = parseServerRequest({ ...record(item, "待响应请求"), jsonrpc: "2.0" });
      if (!request) return [];
      if (request.sessionId !== sessionId) invalid("待响应请求的 session_id");
      return [request];
    }),
  };
}

export type TurnOutcome = "completed" | "failed" | "cancelled" | "unknown";

export function normalizeTurnOutcome(outcome: unknown, status?: unknown): TurnOutcome {
  switch (outcome) {
    case "completed": return "completed";
    case "failed": return "failed";
    case "interrupted":
    case "cancelled": return "cancelled";
    case null:
    case undefined:
      switch (status) {
        case "complete": return "completed";
        case "error": return "failed";
        case "interrupted": return "cancelled";
      }
  }
  return "unknown";
}

type TurnIdentity = { admissionId?: string; turnId?: string };
type SegmentIdentity = TurnIdentity & { segment?: number };

export type CanonicalProjection =
  | ({ type: "message.start" } & TurnIdentity)
  | { type: "steering.applied"; admissionId: string }
  | ({ type: "message.delta"; text: string | null; offset?: number } & SegmentIdentity)
  | ({ type: "message.interim"; text: string; alreadyStreamed: boolean } & SegmentIdentity)
  | ({ type: "message.complete"; text?: string; reasoning?: string; outcome: TurnOutcome; submissionId?: string; rowId?: string;
       responseReused: boolean } & TurnIdentity)
  | ({ type: "reasoning.delta" | "reasoning.available"; text: string } & TurnIdentity)
  | { type: "tool.start" | "tool.complete"; admissionId?: string; toolId: string; name: string;
      status: "running" | "succeeded" | "failed" | "unknown" }
  | ({ type: "approval.request" | "clarify.request" } & CanonicalPrompt)
  | { type: "approval.settled" | "clarify.settled"; promptId: string; executionGeneration: string }
  | { type: "request.cancel"; requestId: string; reason: string }
  | { type: "session.info"; pending?: PendingAdmission[]; running?: boolean; executionGeneration?: string; title?: string }
  | { type: "session.replay_gap" };

function turnIdentity(event: CanonicalEvent): TurnIdentity {
  const turnId = event.payload.turn_id;
  return { admissionId: event.admissionId, turnId: turnId == null ? undefined : id(turnId, "turn_id") };
}

function offset(value: unknown, field: string): number | undefined {
  if (value == null) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(field);
  return value;
}

export function normalizeCanonicalEvent(event: CanonicalEvent): CanonicalProjection | undefined {
  const { type, payload } = event;
  switch (type) {
    case "message.start":
      return { type, ...turnIdentity(event) };
    case "plugin.hermes-mobile-delivery.steering.applied":
      if (event.admissionId && event.authorityEpoch !== undefined && event.executionGeneration !== undefined
        && typeof payload.api_request_id === "string" && payload.api_request_id.length > 0
        && payload.api_request_id.length <= 512) return { type: "steering.applied", admissionId: event.admissionId };
      return;
    case "message.delta":
      return { type, ...turnIdentity(event), segment: offset(payload.segment, "消息分段"),
        text: payload.text === null ? null : string(payload.text, "增量文本"), offset: offset(payload.offset, "增量偏移量") };
    case "message.interim":
      return { type, ...turnIdentity(event), segment: offset(payload.segment, "消息分段"),
        text: string(payload.text, "中间文本"), alreadyStreamed: boolean(payload.already_streamed, "already_streamed") };
    case "reasoning.delta":
    case "reasoning.available":
      if (typeof payload.text !== "string") return;
      return { type, admissionId: event.admissionId, text: payload.text };
    case "message.complete": {
      const identity = turnIdentity(event);
      const admissionId = payload.admission_id == null ? identity.admissionId : id(payload.admission_id, "admission_id");
      if (identity.admissionId && identity.admissionId !== admissionId) invalid("完成事件的 admission_id");
      const text = typeof payload.text === "string" ? payload.text
        : typeof payload.content === "string" ? payload.content : undefined;
      const persisted = payload.persisted_turn == null ? {} : record(payload.persisted_turn, "已持久化的对话轮次");
      return {
        type, ...identity, admissionId, text, outcome: normalizeTurnOutcome(payload.outcome, payload.status),
        reasoning: typeof payload.reasoning === "string" ? payload.reasoning : undefined,
        submissionId: persisted.submission_id == null ? undefined : id(persisted.submission_id, "submission_id"),
        rowId: persisted.final_assistant_row_id == null
          ? undefined
          : integer(persisted.final_assistant_row_id, "final_assistant_row_id"),
        responseReused: payload.response_reused === true,
      };
    }
    case "tool.start":
    case "tool.complete":
      return {
        type,
        admissionId: event.admissionId,
        toolId: string(payload.tool_id, "tool_id"),
        name: id(payload.name, "工具名称"),
        status: type === "tool.start" ? "running" : payload.is_error === true ? "failed"
          : payload.is_error === false ? "succeeded" : "unknown",
      };
    case "approval.request":
    case "clarify.request": {
      const kind = type === "approval.request" ? "approval" : "clarify";
      if (payload.kind != null && payload.kind !== kind) invalid("事件提示类型");
      return { type, ...parsePrompt({ ...payload, kind }) };
    }
    case "approval.settled":
    case "clarify.settled":
      return {
        type,
        promptId: id(payload.prompt_id, "prompt_id"),
        executionGeneration: integer(payload.execution_generation, "execution_generation"),
      };
    case "request.cancel":
      if (payload.method !== "clarify") return;
      return { type, requestId: id(payload.id, "服务端请求 ID"), reason: id(payload.reason, "取消原因") };
    case "session.info":
      return {
        type,
        pending: payload.pending == null ? undefined : parsePending(payload.pending),
        running: payload.running == null ? undefined : boolean(payload.running, "会话运行标志"),
        title: typeof payload.title === "string" ? payload.title : undefined,
        executionGeneration: payload.execution_generation == null
          ? undefined
          : integer(payload.execution_generation, "execution_generation"),
      };
    case "session.replay_gap":
      return { type };
  }
}
