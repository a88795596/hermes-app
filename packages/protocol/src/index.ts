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
}

export type MessageStatus = "accepted" | "queued" | "streaming" | "final" | "failed" | "unknown" | "cancelled";

export interface Message {
  message_id: string;
  role: "user" | "assistant";
  text: string;
  status: MessageStatus;
  submission_id?: string;
  error?: string;
}

export interface Control {
  control_id: string;
  kind: "approval" | "clarify";
  prompt: string;
  choices: string[];
  status: "pending" | "responding" | "closed" | "unknown";
}

export interface TopicDetail {
  topic: Topic;
  messages: Message[];
  controls: Control[];
}

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
  | (EventEnvelope & { type: "message"; message_id: string; submission_id?: string; text: string; status: "streaming" | "final" })
  | (EventEnvelope & { type: "submission"; submission_id: string; status: Exclude<MessageStatus, "accepted">; error?: string })
  | (EventEnvelope & Control & { type: "control" });

export type ConnectorFrame = CommandResult | ConnectorEvent | DeliveryFrame;
export type BridgeFrame = Command | { type: "ack"; id: string };

export interface ApiSuccess<T> {
  data: T;
  request_id: string;
  server_time: string;
}

export interface ApiFailure {
  error: { code: string; message: string; retryable: boolean };
  request_id: string;
}
