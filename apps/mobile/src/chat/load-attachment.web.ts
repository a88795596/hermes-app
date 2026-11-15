import type { Attachment } from "@hermes-mobile/protocol";
import type { Session } from "../auth/session";
import { attachmentUrl, readAttachment, type AttachmentContent } from "./attachment-content";

export async function loadAttachment(session: Session, item: Attachment, signal: AbortSignal): Promise<AttachmentContent> {
  const response = await fetch(attachmentUrl(session, item), { headers: { Authorization: `Bearer ${session.token}` },
    redirect: "error", credentials: "omit", signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
  const chunks: BlobPart[] = [];
  await readAttachment(response, item.size, async (chunk) => { chunks.push(Uint8Array.from(chunk)); });
  const blob = new Blob(chunks, { type: item.mime });
  const uri = URL.createObjectURL(blob);
  return { uri, text: () => blob.text(), dispose: () => URL.revokeObjectURL(uri) };
}
