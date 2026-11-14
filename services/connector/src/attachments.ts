import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Attachment, AttachmentReference } from '@hermes-mobile/protocol';
import { isAttachmentMime, MAX_ATTACHMENTS, MAX_RECEIVED_ATTACHMENT_BYTES } from '@hermes-mobile/protocol';
import { object, type WebappAccess } from './gateway.js';
import { boundedText, stableId } from './wire.js';

export type DownloadAttachment = (id: string, position: number, size: number) => Promise<Buffer>;

export function attachmentDownloader(url: URL, token: string, signal: AbortSignal): DownloadAttachment {
  const origin = url.origin.replace(/^ws/u, 'http');
  return async (id, position, size) => {
    const response = await fetch(`${origin}/internal/connector/v1/submissions/${id}/attachments/${position}`, {
      headers: { authorization: `Bearer ${token}` }, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok || response.headers.get('content-type') !== 'application/octet-stream' || !response.body) {
      await response.body?.cancel();
      throw new Error('无法下载附件');
    }
    const content = Buffer.alloc(size);
    let offset = 0;
    for await (const chunk of response.body) {
      if (offset + chunk.byteLength > size) throw new Error('附件大小与提交记录不符');
      content.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== size) throw new Error('附件大小与提交记录不符');
    return content;
  };
}

export async function attachmentBytes(download: DownloadAttachment, id: string, position: number, attachment: AttachmentReference) {
  const content = await download(id, position, attachment.size);
  if (content.length !== attachment.size || createHash('sha256').update(content).digest('hex') !== attachment.sha256) {
    throw new Error('附件内容与提交记录不符');
  }
  return content;
}

export function attachmentFilename(name: string) {
  return name.replace(/[^\p{L}\p{N} ._-]/gu, '_').replace(/^[ .]+|[ .]+$/gu, '') || 'attachment';
}

export type ReceivedAttachments = { text: string; attachments?: Attachment[] };
export type ReceiveAttachments = (profile: string, topicId: string, messageId: string, text: string) => Promise<ReceivedAttachments>;

const mimeByExtension: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.heic': 'image/heic', '.avif': 'image/avif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.opus': 'audio/ogg', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.html': 'text/html', '.htm': 'text/html',
  '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.pdf': 'application/pdf',
};

function localReferences(text: string): { start: number; end: number; path: string }[] {
  const references: { start: number; end: number; path: string }[] = [];
  // 保留原始偏移量，避免删掉代码示例中恰好相同的文件标记。
  const mask = (value: string) => value.replace(/[^\r\n]/g, ' ');
  let scan = text.replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[ \t]*$|$(?![\s\S]))|^[ \t]*>.*$/gmu, mask);
  scan = scan.replace(/(`+)[^\r\n]*?\1/gu, (value: string, _ticks: string, start: number) =>
    /MEDIA:[ \t]*$/u.test(scan.slice(0, start)) ? value : mask(value));
  const pattern = /MEDIA:\s*(?:`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s`<>]+))|!?\[[^\]\r\n]*\]\((?:<([^>\r\n]+)>|([^\s)]+))(?:\s+"[^"\r\n]*")?\)/gu;
  for (const match of scan.matchAll(pattern)) {
    const raw = match.slice(1).find((value) => value !== undefined)!;
    let path = raw;
    try {
      if (path.startsWith('file:')) path = fileURLToPath(path);
      else if (path.startsWith('/')) path = decodeURIComponent(path);
    } catch { continue; }
    if (!path.startsWith('/') || path.startsWith('//') || /[\p{Cc}]/u.test(path) || Buffer.byteLength(path) > 4096) continue;
    references.push({ start: match.index, end: match.index + match[0].length, path });
  }
  return references;
}

export function hasReceivedAttachments(text: string): boolean {
  return localReferences(text).length > 0;
}

async function responseBytes(response: Response, max: number): Promise<Buffer> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > max) {
    await response.body?.cancel();
    throw new Error('无法读取附件');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > max) throw new Error('附件超出大小限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

export function attachmentReceiver(url: URL, token: string, webapp: WebappAccess | undefined,
  signal: AbortSignal): ReceiveAttachments {
  const origin = url.origin.replace(/^ws/u, 'http');
  return async (profile, topicId, messageId, source) => {
    const references = localReferences(source);
    if (!references.length) return { text: source };
    const attachments: Attachment[] = [];
    const delivered = new Set<string>();
    const paths = [...new Set(references.map(({ path }) => path))];
    for (const path of paths.slice(0, MAX_ATTACHMENTS)) {
      if (!webapp) break;
      let content: { bytes: Buffer; mime: string } | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const download = new URL('/api/files/download', webapp.origin);
          download.searchParams.set('path', path);
          download.searchParams.set('profile', profile);
          const response = await fetch(download, { headers: { authorization: `Bearer ${webapp.token}` }, redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
          const bytes = await responseBytes(response, MAX_RECEIVED_ATTACHMENT_BYTES);
          if (!bytes.length) throw new Error('附件为空');
          const reported = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
          content = { bytes, mime: mimeByExtension[extname(path).toLowerCase()]
            ?? (isAttachmentMime(reported) ? reported : 'application/octet-stream') };
          break;
        } catch {
          if (signal.aborted) throw new Error('附件交付已停止');
        }
      }
      if (!content) continue;
      const { bytes, mime } = content;
      const name = attachmentFilename(boundedText(basename(path), 200));
      const id = stableId([profile, topicId, messageId, path, createHash('sha256').update(bytes).digest('hex')]);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const uploaded = await fetch(`${origin}/internal/attachments/v1/${id}`, {
            method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, redirect: 'error',
            body: JSON.stringify({ profile_ref: profile, name, mime, size: bytes.length, content_base64: bytes.toString('base64') }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          });
          const data = object(object(JSON.parse((await responseBytes(uploaded, 16 * 1024)).toString()))?.data);
          if (data?.attachment_id !== id || data.name !== name || typeof data.mime !== 'string'
            || !isAttachmentMime(data.mime) || data.size !== bytes.length) {
            throw new Error('附件上传回执无效');
          }
          attachments.push({ attachment_id: id, name, mime: data.mime, size: bytes.length });
          delivered.add(path);
          break;
        } catch {
          if (signal.aborted) throw new Error('附件交付已停止');
        }
      }
    }
    let text = source;
    for (const { start, end, path } of references.reverse()) if (delivered.has(path)) text = text.slice(0, start) + text.slice(end);
    text = text.trim();
    if (delivered.size < paths.length) {
      const error = '\n\n附件交付失败：部分文件未能传送，请让 Hermes 重新发送。';
      text = boundedText(text, 256 * 1024 - Buffer.byteLength(error)) + error;
    }
    return { text, ...(attachments.length ? { attachments } : {}) };
  };
}
