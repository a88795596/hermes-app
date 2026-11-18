import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  isAttachmentMime, isAttachmentName, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL_BYTES,
  type Attachment, type AttachmentReference,
} from "@hermes-mobile/protocol";
import type { PoolClient } from "pg";
import { conflict, invalid, record, string } from "./validation.js";

export type ValidatedUpload = { reference: AttachmentReference; content: Buffer };

export async function storeAttachment(db: PoolClient, id: string, profile: string, { reference, content }: ValidatedUpload) {
  const { name, mime, size, sha256 } = reference;
  const metadata = { attachment_id: id, name, mime, size };
  const inserted = await db.query(`INSERT INTO received_attachments (id, profile_ref, metadata, content, sha256)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [id, profile, metadata, content, sha256]);
  if (!inserted.rowCount) {
    const { rows: [old] } = await db.query<{ profile_ref: string; metadata: Attachment; sha256: string }>(
      "SELECT profile_ref, metadata, sha256 FROM received_attachments WHERE id = $1", [id]);
    if (!old || old.profile_ref !== profile || old.sha256 !== sha256 || !isDeepStrictEqual(old.metadata, metadata)) {
      conflict("同一个附件 ID 对应不同的文件。");
    }
  }
  return metadata;
}

export function submissionAttachments(value: unknown): ValidatedUpload[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) invalid(`每条消息最多可添加 ${MAX_ATTACHMENTS} 个附件。`);
  let total = 0;
  return value.map((raw: unknown) => {
    const attachment = attachmentUpload(raw, MAX_ATTACHMENT_BYTES);
    total += attachment.reference.size;
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) invalid("同一条消息的附件合计最多 6 MB。");
    return attachment;
  });
}

export function attachmentUpload(value: unknown, maxBytes: number): ValidatedUpload {
  const item = record(value, ["name", "mime", "size", "content_base64"]);
  const name = string(item.name, "附件名称", 200).trim();
  const declared = string(item.mime, "附件类型", 127).toLowerCase();
  const size = item.size;
  if (!isAttachmentName(name) || !isAttachmentMime(declared)) invalid("附件名称或类型无效。");
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > maxBytes) {
    invalid(`附件必须有内容，单个附件最多 ${maxBytes / 1024 / 1024} MB。`);
  }
  const encoded = item.content_base64;
  if (typeof encoded !== "string" || encoded.length !== 4 * Math.ceil(size / 3)) invalid("附件内容无效。");
  const content = Buffer.from(encoded, "base64");
  if (content.length !== size || content.toString("base64") !== encoded) invalid("附件内容无效。");
  const image = imageMime(content);
  if (declared.startsWith("image/") && !image) invalid("图片须为有效的 JPEG、PNG、GIF 或 WebP 文件。");
  return { reference: { name, mime: image ?? declared, size, sha256: createHash("sha256").update(content).digest("hex") }, content };
}

function imageMime(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.toString("latin1", 0, 6))) return "image/gif";
  if (data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return "image/webp";
}
