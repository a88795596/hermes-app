import { isDeepStrictEqual } from "node:util";
import { isAttachmentMime, isAttachmentName, MAX_ATTACHMENTS, MAX_RECEIVED_ATTACHMENT_BYTES, type Attachment } from "@hermes-mobile/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { attachmentUpload } from "./attachments.js";
import { matchesToken, readBearer } from "./auth.js";
import type { Store } from "./store.js";
import { ApiError, conflict, invalid, missing, record, string, uuid } from "./validation.js";

export function receivedAttachmentReferences(value: unknown): Attachment[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) invalid(`每条消息最多可添加 ${MAX_ATTACHMENTS} 个附件。`);
  return value.map((raw) => {
    const item = record(raw, ["attachment_id", "name", "mime", "size"]);
    const attachment_id = uuid(item.attachment_id, "附件 ID");
    const name = string(item.name, "附件名称", 200).trim();
    const mime = string(item.mime, "附件类型", 127).toLowerCase();
    const size = item.size;
    if (!isAttachmentName(name) || !isAttachmentMime(mime) || typeof size !== "number" ||
      !Number.isSafeInteger(size) || size < 1 || size > MAX_RECEIVED_ATTACHMENT_BYTES) invalid("附件信息无效。");
    return { attachment_id, name, mime, size };
  });
}

export async function validateReceivedAttachments(db: PoolClient, attachments: Attachment[] | undefined, profileRef: string) {
  if (!attachments?.length) return;
  const { rows } = await db.query<{ id: string; metadata: Attachment }>(
    "SELECT id, metadata FROM received_attachments WHERE id = ANY($1::uuid[]) AND profile_ref = $2",
    [attachments.map((attachment) => attachment.attachment_id), profileRef],
  );
  for (const attachment of attachments) {
    const stored = rows.find(({ id }) => id === attachment.attachment_id);
    if (!stored) missing("附件");
    if (!isDeepStrictEqual(stored.metadata, attachment)) invalid("附件信息与已上传的文件不一致。");
  }
}

export function registerReceivedAttachments(api: FastifyInstance, store: Store, refs: Set<string>,
  config: { connectorToken: string; inboxDeliveryToken?: string }, authenticate: (request: FastifyRequest) => Promise<string>) {
  api.put("/internal/attachments/v1/:id", {
    bodyLimit: 4 * Math.ceil(MAX_RECEIVED_ATTACHMENT_BYTES / 3) + 16 * 1024,
    onRequest: async (request) => {
      const token = readBearer(request);
      if (!matchesToken(token, config.connectorToken) && !(config.inboxDeliveryToken && matchesToken(token, config.inboxDeliveryToken))) {
        throw new ApiError(401, "UNAUTHORIZED", "附件上传凭证无效。");
      }
    },
  }, async (request) => {
    const id = uuid(record(request.params).id, "附件 ID");
    const { profile_ref, ...upload } = record(request.body, ["profile_ref", "name", "mime", "size", "content_base64"]);
    const profile = string(profile_ref, "配置档案名称", 64);
    if (!refs.has(profile)) missing("配置档案");
    const { reference: { sha256, ...file }, content } = attachmentUpload(upload, MAX_RECEIVED_ATTACHMENT_BYTES);
    const metadata: Attachment = { attachment_id: id, ...file };
    // shortcut: 附件持久保存在 PostgreSQL；媒体量增大时迁移对象存储并增加未引用文件的回收。
    await store.transaction(async (db) => {
      const inserted = await db.query(`INSERT INTO received_attachments (id, profile_ref, metadata, content, sha256)
        VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [id, profile, metadata, content, sha256]);
      if (inserted.rowCount) return;
      const { rows: [old] } = await db.query<{ profile_ref: string; metadata: Attachment; sha256: string }>(
        "SELECT profile_ref, metadata, sha256 FROM received_attachments WHERE id = $1", [id]);
      if (!old || old.profile_ref !== profile || old.sha256 !== sha256 || !isDeepStrictEqual(old.metadata, metadata)) {
        conflict("同一个附件 ID 对应不同的文件。");
      }
    });
    return { data: metadata, request_id: request.id, server_time: new Date().toISOString() };
  });

  api.get("/mobile/v1/attachments/:id", { onRequest: async (request) => { await authenticate(request); } }, async (request, reply) => {
    const id = uuid(record(request.params).id, "附件 ID");
    const { rows: [attachment] } = await store.query<{ metadata: Attachment; content: Buffer }>(`
      SELECT a.metadata, a.content FROM received_attachments a
      WHERE a.id = $1 AND a.profile_ref = ANY($2) AND (
        EXISTS (SELECT 1 FROM inbox i WHERE i.profile_ref = a.profile_ref AND i.data->'attachments' @> $3::jsonb)
        OR EXISTS (SELECT 1 FROM messages m JOIN topics t ON t.id = m.topic_id
          WHERE t.profile_ref = a.profile_ref AND m.data->'attachments' @> $3::jsonb)
      )`, [id, [...refs], JSON.stringify([{ attachment_id: id }])]);
    if (!attachment) missing("附件");
    const { metadata, content } = attachment;
    const filename = encodeURIComponent(metadata.name).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    reply.type(metadata.mime).header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", `attachment; filename="attachment"; filename*=UTF-8''${filename}`)
      .header("Content-Security-Policy", "sandbox; default-src 'none'")
      .header("Accept-Ranges", "bytes");
    const range = request.method === "HEAD" || request.headers["if-range"] ? undefined : request.headers.range;
    if (range !== undefined) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
      let start = 0;
      let end = content.length - 1;
      if (match?.[1]) {
        start = Number(match[1]);
        if (match[2]) end = Number(match[2]);
      } else if (match?.[2]) {
        start = Math.max(0, content.length - Number(match[2]));
      }
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        (match[2] && !Number.isSafeInteger(Number(match[2]))) || start >= content.length || start > end) {
        return reply.code(416).header("Content-Range", `bytes */${content.length}`).send();
      }
      end = Math.min(end, content.length - 1);
      return reply.code(206).header("Content-Range", `bytes ${start}-${end}/${content.length}`)
        .header("Content-Length", end - start + 1).send(content.subarray(start, end + 1));
    }
    return reply.header("Content-Length", content.length).send(content);
  });
}
