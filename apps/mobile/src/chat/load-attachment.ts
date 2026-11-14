import { randomUUID } from "expo-crypto";
import { File, FileMode, Paths } from "expo-file-system";
import { fetch } from "expo/fetch";
import type { Attachment } from "@hermes-mobile/protocol";
import type { Session } from "../auth/session";
import { attachmentUrl, readAttachment, type AttachmentContent } from "./attachment-content";

export async function loadAttachment(session: Session, item: Attachment, signal: AbortSignal): Promise<AttachmentContent> {
  const url = attachmentUrl(session, item);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${session.token}` }, redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
  const extension = item.name.match(/\.[a-z0-9]{1,10}$/iu)?.[0] ?? "";
  const file = new File(Paths.cache, `received-${randomUUID()}${extension}`);
  const dispose = () => { try { file.delete(); } catch { /* 系统可能已清理临时文件。 */ } };
  try {
    file.create();
    const handle = file.open(FileMode.WriteOnly);
    try {
      await readAttachment(response, item.size, (chunk) => handle.writeBytes(chunk));
    } finally {
      handle.close();
    }
    return { uri: file.uri, text: () => file.text(), dispose };
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    dispose();
    throw error;
  }
}
