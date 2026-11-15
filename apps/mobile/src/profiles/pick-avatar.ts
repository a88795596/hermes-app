import { File } from "expo-file-system";
import { launchImageLibraryAsync, UIImagePickerPreferredAssetRepresentationMode } from "expo-image-picker";
import { Platform } from "react-native";
import { MAX_PROFILE_AVATAR_BYTES, type AttachmentUpload } from "@hermes-mobile/protocol";

export async function pickProfileAvatar(): Promise<AttachmentUpload | undefined> {
  const native = Platform.OS !== "web";
  const result = await launchImageLibraryAsync({
    mediaTypes: ["images"], allowsMultipleSelection: false, allowsEditing: true, aspect: [1, 1],
    preferredAssetRepresentationMode: UIImagePickerPreferredAssetRepresentationMode.Compatible, quality: 0.8, base64: native,
  });
  const asset = result.assets?.[0];
  if (!asset) return;
  try {
    const mime = native ? "image/jpeg" : asset.mimeType?.toLowerCase() ?? asset.file?.type ?? "";
    if (!/^image\/(?:jpeg|png|gif|webp)$/u.test(mime)) throw new Error("请选择 JPEG、PNG、GIF 或 WebP 图片。");
    if (!native && (asset.file?.size ?? 0) > MAX_PROFILE_AVATAR_BYTES) throw new Error("头像图片不能超过 2 MB。");
    const content_base64 = asset.base64 ?? (asset.file ? await readBase64(asset.file) : undefined);
    if (content_base64 && content_base64.length > 4 * Math.ceil(MAX_PROFILE_AVATAR_BYTES / 3)) throw new Error("头像图片不能超过 2 MB。");
    if (!content_base64 || content_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(content_base64)) {
      throw new Error("无法读取所选图片。");
    }
    const size = content_base64.length * 3 / 4 - (content_base64.endsWith("==") ? 2 : content_base64.endsWith("=") ? 1 : 0);
    if (size > MAX_PROFILE_AVATAR_BYTES) throw new Error("头像图片不能超过 2 MB。");
    return { name: `头像.${mime === "image/jpeg" ? "jpg" : mime.slice(6)}`, mime, size, content_base64 };
  } finally {
    if (native) {
      try { new File(asset.uri).delete(); } catch { /* 系统可清理选择器的临时缓存。 */ }
    } else URL.revokeObjectURL(asset.uri);
  }
}

function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(new Error("无法读取所选图片。"));
    reader.readAsDataURL(file);
  });
}
