export interface PairingResult {
  token: string;
  device_id: string;
}

export interface Profile {
  profile_id: string;
  label: string;
}

export interface Topic {
  topic_id: string;
  profile_id: string;
  title: string;
  status: "creating" | "ready" | "error";
  error?: string;
  reasoning_effort?: ReasoningEffort;
  reasoning_status?: "pending" | "unknown";
}

export const DEFAULT_TOPIC_TITLE = "新会话";
export const MAX_TOPIC_TITLE_BYTES = 256;
export const MAX_TITLE_INPUT_BYTES = 32 * 1024;

export function topicTitlePreview(text: string): string {
  const characters = Array.from(text.replace(/[\s\p{Cc}]+/gu, " ").trim());
  return characters.length > 64 ? characters.slice(0, 63).join("").trimEnd() + "…"
    : characters.join("") || DEFAULT_TOPIC_TITLE;
}

export type MessageStatus = "accepted" | "queued" | "streaming" | "final" | "failed" | "unknown" | "cancelled";

export const MAX_MESSAGE_PROCESS_STEPS = 64;
export const MAX_MESSAGE_PROCESS_TEXT_BYTES = 4096;

export type MessageProcessStep =
  | { kind: "reasoning" | "commentary"; text: string }
  | { kind: "tool"; id: string; name: string; status: "running" | "succeeded" | "failed" | "unknown" };

export interface Message {
  message_id: string;
  role: "user" | "assistant";
  text: string;
  status: MessageStatus;
  submission_id?: string;
  error?: string;
  process?: MessageProcessStep[];
}

export interface Control {
  control_id: string;
  kind: "approval" | "clarify";
  prompt: string;
  choices: string[];
  multi_select?: boolean;
  submission_id?: string;
  status: "pending" | "responding" | "closed" | "unknown";
  answer?: string;
  error?: string;
}

export interface ModelSelection {
  provider: string;
  model: string;
}

export interface ModelCatalog extends ModelSelection {
  providers: { id: string; name: string; models: string[] }[];
}

export const MAX_CLARIFY_CHOICE_BYTES = 32 * 1024;
export const MAX_CONTROL_ANSWER_BYTES = 192 * 1024;

export type ModelResult =
  | { type: "catalog"; catalog: ModelCatalog }
  | { type: "selected" | "deferred"; selection: ModelSelection }
  | { type: "confirmation"; confirm: string; message: string };

export type ModelRequest =
  | { status: "pending" }
  | { status: "ok"; model_result: ModelResult }
  | { status: "error" | "unknown"; error: string };

export const reasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = (typeof reasoningEfforts)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return reasoningEfforts.some((effort) => effort === value);
}

export type ReasoningRequest =
  | { status: "pending" }
  | { status: "ok" }
  | { status: "error" | "unknown"; error: string };

export interface TopicDetail {
  topic: Topic;
  messages: Message[];
  controls: Control[];
}

export interface Skill {
  name: string;
  description?: string;
  category?: string;
}

export interface SessionStatus {
  activity: "idle" | "running" | "queued" | "unknown";
  model?: string;
  message_count?: number;
}

export type TopicQueryData =
  | { kind: "skills"; skills: Skill[] }
  | { kind: "status"; status: SessionStatus }
  | { kind: "version"; version: string };

export interface TopicQuery {
  type: "topic_query";
  request_id: string;
  topic_id: string;
  profile_ref: string;
  session_id: string;
  kind: TopicQueryData["kind"];
}

export type TopicQueryResult = { type: "topic_query_result"; request_id: string } & (
  | { data: TopicQueryData }
  | { error: "unavailable" | "failed" | "too_large" }
);

export interface InboxItem {
  inbox_id: string;
  text: string;
  created_at: string;
}

export interface MobileNotice {
  type: "changed";
  topic_id?: string;
}

interface CommandEnvelope {
  type: "command";
  command_id: string;
  topic_id: string;
  profile_ref: string;
  session_id?: string;
}

export type Command = CommandEnvelope & (
  | { kind: "create"; body: { request_id: string } }
  | { kind: "submit"; body: { submission_id: string; text: string } }
  | { kind: "interrupt"; body: { submission_id: string } }
  | { kind: "respond"; body: { control_id: string; response_id: string; answer: string } }
  | { kind: "model_options"; body: Record<string, never> }
  | { kind: "select_model"; body: ModelSelection & { confirm?: string } }
  | { kind: "select_reasoning"; body: { effort: ReasoningEffort | null } }
  | { kind: "summarize_title"; body: { input: string } }
  | { kind: "watch"; body: Record<string, never> }
);

export interface CommandResult {
  type: "command_result";
  command_id: string;
  status: "ok" | "error" | "unknown";
  session_id?: string;
  admission_id?: string;
  error?: string;
  control_status?: Control["status"];
  model_result?: ModelResult;
  title?: string;
}

interface EventEnvelope {
  event_id: string;
  topic_id: string;
}

export interface DeliveryFrame {
  type: "delivery";
  event_id: string;
  delivery_id: string;
  profile_ref: string;
  text: string;
}

export type ConnectorEvent =
  | (EventEnvelope & Pick<Message, "message_id" | "submission_id" | "text" | "process"> & { type: "message"; status: "streaming" | "final" })
  | (EventEnvelope & { type: "submission"; submission_id: string; status: Exclude<MessageStatus, "accepted">; error?: string })
  | (EventEnvelope & Omit<Control, "answer" | "error"> & { type: "control" });

export type ConnectorFrame = CommandResult | ConnectorEvent | DeliveryFrame | TopicQueryResult | ManagementResult;
export type BridgeFrame = Command | { type: "ack"; id: string } | TopicQuery | ManagementRequest;

export const managementOperations = {
  "cron.list": "read", "cron.runs": "read", "cron.create": "write", "cron.edit": "write",
  "cron.pause": "write", "cron.resume": "write", "cron.trigger": "write", "cron.remove": "write",
  "model.list": "read", "model.options": "read", "model.set": "write",
  "model.keys": "read", "model.key": "write", "model.key.remove": "write",
  "logs.read": "read", "logs.level": "write",
  "skill.list": "read", "skill.read": "read", "skill.create": "write", "skill.edit": "write",
  "skill.toggle": "write", "skill.install": "write",
  "mcp.list": "read", "mcp.add": "write", "mcp.edit": "write", "mcp.token": "write", "mcp.toggle": "write", "mcp.test": "read",
  "mcp.remove": "write", "mcp.catalog": "read", "mcp.install": "write", "action.status": "read",
} as const;

export type ManagementOperation = keyof typeof managementOperations;

export function isManagementOperation(value: unknown): value is ManagementOperation {
  return typeof value === "string" && Object.hasOwn(managementOperations, value);
}

export function managementTimeout(operation: ManagementOperation): number {
  return operation === "mcp.test" ? 45_000 : 28_000;
}

export interface ManagementRequest {
  type: "management_request";
  request_id: string;
  profile_ref: string;
  operation: ManagementOperation;
  input: Record<string, unknown>;
}

export type ManagementResult = { type: "management_result"; request_id: string } & (
  | { ok: true; data: unknown }
  | { ok: false; status: number; message: string }
);

export interface ApiSuccess<T> {
  data: T;
  request_id: string;
  server_time: string;
}

export interface ApiFailure {
  error: { code: string; message: string; retryable: boolean };
  request_id: string;
}
