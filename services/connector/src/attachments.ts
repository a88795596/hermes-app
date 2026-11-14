import { createHash } from 'node:crypto';
import type { AttachmentReference } from '@hermes-mobile/protocol';

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
