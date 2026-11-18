import { MAX_RECEIVED_ATTACHMENT_BYTES, type Attachment } from "@hermes-mobile/protocol";
import type { Session } from "../auth/session";

export const sentImageSize = 200;

export function uploadImageUri(item: Attachment & { content_base64?: string }) {
  if (item.mime.startsWith("image/") && item.content_base64) return `data:${item.mime};base64,${item.content_base64}`;
}

export function attachmentKind({ name, mime }: Pick<Attachment, "name" | "mime">) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/") || /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/iu.test(name)) return "audio";
  if (mime.startsWith("video/") || /\.(mp4|m4v|mov|webm)$/iu.test(name)) return "video";
  if (mime === "text/markdown" || /\.(md|markdown)$/iu.test(name)) return "markdown";
  if (mime === "text/html" || mime === "application/xhtml+xml" || /\.html?$/iu.test(name)) return "html";
  return "file";
}

export function attachmentUrl(session: Session, item: Pick<Attachment, "attachment_id" | "size">) {
  if (!item.attachment_id || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(item.attachment_id)
    || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_RECEIVED_ATTACHMENT_BYTES) {
    throw new Error("附件信息无效，请刷新消息后重试。");
  }
  return `${session.origin}/mobile/v1/attachments/${item.attachment_id}`;
}

export async function readAttachment(response: Response, size: number, write: (chunk: Uint8Array) => Promise<void>) {
  const length = response.headers.get("content-length");
  if (!response.ok || !response.body || (length !== null && Number(length) !== size)) {
    await response.body?.cancel();
    throw new Error(response.status === 401 ? "设备凭证已失效，请重新配对。" : "无法下载附件，请刷新消息后重试。");
  }
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > size) throw new Error("附件内容与记录不符。");
      await write(value);
    }
    if (received !== size) throw new Error("附件未下载完整，请重试。");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export interface AttachmentContent {
  uri: string;
  text: () => Promise<string>;
  dispose: () => void;
}
