import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { File, FileMode, Paths } from "expo-file-system";
import { fetch } from "expo/fetch";
import type { Attachment } from "@hermes-mobile/protocol";
import type { Session } from "../auth/session";
import { attachmentUrl, readAttachment, type AttachmentContent } from "./attachment-content";

const downloads = new Map<string, Promise<void>>();

export async function loadAttachment(session: Session, item: Attachment, signal: AbortSignal): Promise<AttachmentContent> {
  const url = attachmentUrl(session, item);
  signal.throwIfAborted();
  const key = await digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify([url, session.token, item.size]));
  signal.throwIfAborted();
  const extension = item.name.match(/\.[a-z0-9]{1,10}$/iu)?.[0] ?? "";
  const file = new File(Paths.cache, `received-${key}${extension}`);
  if (!file.exists || file.size !== item.size) {
    let pending = downloads.get(file.uri);
    if (!pending) {
      pending = downloadAttachment(session, item, url, file).finally(() => downloads.delete(file.uri));
      downloads.set(file.uri, pending);
    }
    await pending;
  }
  signal.throwIfAborted();
  // 完整文件保留在系统缓存目录，关闭预览只释放使用者。
  return { uri: file.uri, text: () => file.text(), dispose: () => {} };
}

async function downloadAttachment(session: Session, item: Attachment, url: string, destination: File): Promise<void> {
  // 共享下载不受单个预览卸载影响，完成后可供后续打开复用。
  const response = await fetch(url, { headers: { Authorization: `Bearer ${session.token}` }, redirect: "error",
    signal: AbortSignal.timeout(120_000) });
  const file = new File(Paths.cache, `received-${randomUUID()}.part`);
  try {
    file.create();
    const handle = file.open(FileMode.WriteOnly);
    try {
      await readAttachment(response, item.size, (chunk) => handle.writeBytes(chunk));
    } finally {
      handle.close();
    }
    await file.move(destination, { overwrite: true });
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    try { file.delete(); } catch { /* 系统可能已清理临时文件。 */ }
    throw error;
  }
}
