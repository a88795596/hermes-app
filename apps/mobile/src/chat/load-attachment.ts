import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from "expo-crypto";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { Asset, requestPermissionsAsync } from "expo-media-library";
import { fetch } from "expo/fetch";
import type { Attachment } from "@hermes-mobile/protocol";
import type { Session } from "../auth/session";
import { attachmentKind, attachmentUrl, readAttachment, type AttachmentContent } from "./attachment-content";

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

export type SaveAttachmentResult = "album" | "files" | "downloaded" | "cancelled";

export async function saveAttachment(session: Session, item: Attachment): Promise<SaveAttachmentResult> {
  attachmentUrl(session, item);
  const kind = attachmentKind(item);
  const name = safeFilename(item.name);
  let content: AttachmentContent | undefined;
  async function source() {
    content ??= await loadAttachment(session, item, new AbortController().signal);
    return new File(content.uri);
  }

  try {
    if (kind === "image" || kind === "video") {
      let granted = false;
      try {
        granted = (await requestPermissionsAsync(true, [kind === "image" ? "photo" : "video"])).granted;
      } catch { /* 相册不可用时仍可保存到文件。 */ }
      if (granted) {
        const cached = await source();
        const temporary = new Directory(Paths.cache, `export-${randomUUID()}`);
        try {
          temporary.create();
          const media = new File(temporary, mediaFilename(name, item.mime));
          await cached.copy(media);
          await Asset.create(media.uri);
          return "album";
        } catch { /* 系统相册不支持此格式时交给文件选择器。 */ }
        finally { try { temporary.delete(); } catch { /* 系统可清理临时文件。 */ } }
      }
    }

    let directory: Directory;
    try {
      directory = await Directory.pickDirectoryAsync();
    } catch (error) {
      if (error instanceof Error && /(?:picker|picking) was cancelled by the user/iu.test(error.message)) return "cancelled";
      throw error;
    }
    const cached = await source();
    const taken = new Set(directory.list().map((entry) => entry.name));
    const filename = uniqueFilename(name, taken);
    const destination = directory.createFile(filename, item.mime);
    try {
      const reader = cached.open(FileMode.ReadOnly);
      try {
        const writer = destination.open(FileMode.WriteOnly);
        try {
          let written = 0;
          while (written < item.size) {
            const chunk = await reader.readBytes(Math.min(64 * 1024, item.size - written));
            if (chunk.byteLength === 0) throw new Error("附件缓存不完整，请重试。");
            await writer.writeBytes(chunk);
            written += chunk.byteLength;
          }
        } finally {
          writer.close();
        }
      } finally {
        reader.close();
      }
    } catch (error) {
      try { destination.delete(); } catch { /* 目标目录可能已经失效。 */ }
      throw error;
    }
    return "files";
  } finally {
    content?.dispose();
  }
}

function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\p{Cc}]/gu, "_").replace(/^[ .]+|[ .]+$/gu, "") || "附件";
}

function mediaFilename(name: string, mime: string): string {
  if (/\.[a-z0-9]{1,10}$/iu.test(name)) return name;
  const extension: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
    "image/heic": "heic", "image/avif": "avif", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
  };
  return extension[mime] ? `${name}.${extension[mime]}` : name;
}

function uniqueFilename(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let number = 1; number < 10000; number += 1) {
    const candidate = `${stem} (${number})${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("目标文件夹中有过多同名文件，请选择其他位置。");
}
