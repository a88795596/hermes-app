import { getDocumentAsync } from "expo-document-picker";
import { File } from "expo-file-system";
import { launchImageLibraryAsync, UIImagePickerPreferredAssetRepresentationMode } from "expo-image-picker";
import { Platform } from "react-native";
import {
  isAttachmentMime, isAttachmentName, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_TOTAL_BYTES, type AttachmentUpload,
} from "@hermes-mobile/protocol";

export async function pickAttachments(kind: "image" | "file", current: AttachmentUpload[]): Promise<AttachmentUpload[]> {
  const remaining = MAX_ATTACHMENTS - current.length;
  if (remaining < 1) throw new Error(`每条消息最多可添加 ${MAX_ATTACHMENTS} 个附件。`);
  const native = Platform.OS !== "web";
  const images = kind === "image" ? await launchImageLibraryAsync({
    mediaTypes: ["images"], allowsMultipleSelection: remaining > 1, selectionLimit: remaining,
    preferredAssetRepresentationMode: UIImagePickerPreferredAssetRepresentationMode.Compatible, quality: 0.82, base64: native,
  }) : undefined;
  const documents = kind === "file" ? await getDocumentAsync({ multiple: remaining > 1, copyToCacheDirectory: true, base64: false }) : undefined;
  const assets = images?.assets?.map((asset) => ({ ...asset, name: asset.fileName ?? "图片" })) ??
    documents?.assets?.map((asset) => ({ ...asset, base64: undefined })) ?? [];

  const next: AttachmentUpload[] = [];
  let total = current.reduce((sum, item) => sum + item.size, 0);
  try {
    if (assets.length > remaining) throw new Error(`每条消息最多可添加 ${MAX_ATTACHMENTS} 个附件。`);
    for (const asset of assets) {
      const jpeg = kind === "image" && native;
      const name = jpeg ? `${asset.name.trim().replace(/\.[^.]+$/u, "") || "图片"}.jpg` : asset.name.trim();
      const mime = jpeg ? "image/jpeg" : asset.mimeType?.toLowerCase() ?? "";
      const file = native && !jpeg ? new File(asset.uri) : undefined;
      const encoded = asset.base64;
      const size = jpeg && encoded ? (encoded.length * 3 / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0)
        : file?.size ?? asset.file?.size ?? 0;
      if (!isAttachmentName(name) || new TextEncoder().encode(name).byteLength > 200) throw new Error("附件名称无效或过长。");
      if (size === 0) throw new Error(`无法读取「${name}」或文件为空。`);
      if (size > MAX_ATTACHMENT_BYTES) throw new Error(`「${name}」超过单个附件 5 MB 的限制。`);
      total += size;
      if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error("同一条消息的附件合计最多 6 MB。");
      const supportedImage = /^image\/(?:png|jpeg|gif|webp)$/u.test(mime);
      if (kind === "image" && !supportedImage) throw new Error("请选择 JPEG、PNG、GIF 或 WebP 图片。");
      // 文件选择器返回的其他图片格式仍可按原始文件交给 Hermes。
      const type = mime.startsWith("image/") && !supportedImage ? "application/octet-stream" : mime;
      const content_base64 = encoded ?? (file ? await file.base64() : asset.file ? await readBase64(asset.file) : undefined);
      if (!content_base64 || content_base64.length !== 4 * Math.ceil(size / 3)) throw new Error(`无法读取「${name}」。`);
      next.push({ name, mime: isAttachmentMime(type) ? type : "application/octet-stream", size, content_base64 });
    }
  } finally {
    for (const { uri } of assets) {
      if (native) {
        try { new File(uri).delete(); } catch { /* 系统可清理选择器的临时缓存。 */ }
      } else URL.revokeObjectURL(uri);
    }
  }
  return next;
}

function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(new Error("无法读取所选附件。"));
    reader.readAsDataURL(file);
  });
}
