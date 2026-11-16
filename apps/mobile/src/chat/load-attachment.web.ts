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

export async function saveAttachment(session: Session, item: Attachment): Promise<"downloaded"> {
  const content = await loadAttachment(session, item, new AbortController().signal);
  let started = false;
  try {
    const link = document.createElement("a");
    link.href = content.uri;
    link.download = item.name;
    link.style.display = "none";
    document.body.appendChild(link);
    try {
      link.click();
      started = true;
    } finally {
      link.remove();
    }
    return "downloaded";
  } finally {
    // Safari can start reading a blob after click() returns.
    if (started) setTimeout(() => content.dispose(), 60_000);
    else content.dispose();
  }
}
