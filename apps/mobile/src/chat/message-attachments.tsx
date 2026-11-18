import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Attachment } from "@hermes-mobile/protocol";
import type { Session } from "../auth/session";
import { haptic } from "../ui/haptics";
import { useReduceMotion } from "../ui/motion";
import { OverlayModal } from "../ui/overlay";
import { PageHeader } from "../ui/page-header";
import { Action, CloseButton, Icon, Notice, useTheme } from "../ui/theme";
import { AnswerMarkdown } from "./answer-markdown";
import { attachmentKind, sentImageSize, uploadImageUri, type AttachmentContent } from "./attachment-content";
import { HtmlPreview } from "./html-preview";
import { loadAttachment, saveAttachment } from "./load-attachment";
import { MediaPlayer } from "./media-player";

const saveErrorMessages = new Set([
  "附件信息无效，请刷新消息后重试。",
  "设备凭证已失效，请重新配对。",
  "无法下载附件，请刷新消息后重试。",
  "附件内容与记录不符。",
  "附件未下载完整，请重试。",
  "附件缓存不完整，请重试。",
  "目标文件夹中有过多同名文件，请选择其他位置。",
]);

function MessageFile({ item: { attachment_id, name, mime, size }, session, outgoing, localUri, tint, onOpenLink }: {
  item: Attachment; session?: Session; outgoing: boolean; localUri?: string; tint: string; onOpenLink: (url: string) => void;
}) {
  const { colors, dark, styles } = useTheme();
  const { height, width } = useWindowDimensions();
  const reduced = useReduceMotion();
  const kind = attachmentKind({ name, mime });
  const sentImage = outgoing && kind === "image";
  const [requested, setRequested] = useState(kind === "image");
  const [attempt, setAttempt] = useState(0);
  const [content, setContent] = useState<AttachmentContent>();
  const [document, setDocument] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string>();
  const [saveMessage, setSaveMessage] = useState<string>();
  const [open, setOpen] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 4, height: 3 });

  useEffect(() => {
    if (!requested || !session || localUri) return;
    const controller = new AbortController();
    let resource: AttachmentContent | undefined;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Invalidate the revoked file URI before waiting for its replacement.
    setContent(undefined);
    setDocument(undefined);
    setError(undefined);
    void loadAttachment(session, { attachment_id, name, mime, size }, controller.signal).then(async (result) => {
      resource = result;
      if (controller.signal.aborted) return result.dispose();
      const text = kind === "html" || kind === "markdown" ? await result.text() : undefined;
      if (controller.signal.aborted) return result.dispose();
      if (kind === "image" && !sentImage) Image.getSize(result.uri, (width, height) => {
        if (!controller.signal.aborted && width && height) setDimensions({ width, height });
      }, () => {});
      setDocument(text);
      setContent(result);
    }).catch((failure: unknown) => {
      resource?.dispose();
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "无法读取附件，请重试。");
    });
    return () => { controller.abort(); resource?.dispose(); };
  }, [requested, attempt, session, attachment_id, name, mime, size, kind, sentImage, localUri]);

  const retry = () => { setError(undefined); setAttempt((value) => value + 1); setRequested(true); };
  const imageUri = localUri ?? content?.uri;
  const busy = requested && !content && !localUri && !error;
  const label = kind === "audio" ? "打开音频" : kind === "video" ? "打开视频"
    : kind === "file" ? "查看文件" : "打开预览";
  const show = () => {
    haptic(kind === "file" ? "warning" : "light");
    if (kind === "file") { setError("暂不支持预览此文件类型。"); return; }
    setRequested(true);
    if (kind === "image" || kind === "markdown" || kind === "html") setOpen(true);
  };
  async function save() {
    if (!session || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(undefined);
    setSaveMessage(undefined);
    try {
      const result = await saveAttachment(session, { attachment_id, name, mime, size });
      if (result !== "cancelled") {
        haptic("success");
        setSaveMessage(result === "album" ? "已保存到相册" : result === "downloaded" ? "已开始下载" : "已保存到文件");
      }
    } catch (failure) {
      haptic("error");
      setSaveError(failure instanceof Error && saveErrorMessages.has(failure.message)
        ? failure.message : "无法保存文件，请检查存储空间或系统权限后重试。");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  const saveButton = () => <Action compact icon="download" title={saving ? "保存中…" : "保存"}
    accessibilityLabel={`保存${name}`} disabled={saving} onPress={() => void save()} />;
  const saveFeedback = <>
    {saveError && <Notice>{saveError}</Notice>}
    {saveMessage && <Text accessibilityLiveRegion="polite" style={[styles.caption, { color: colors.success }]}>{saveMessage}</Text>}
  </>;
  const loading = busy && <View style={layout.loading}><ActivityIndicator color={colors.accent} /><Text style={styles.caption}>正在加载…</Text></View>;
  const failure = error && <View style={layout.error}><Notice>{error}</Notice>{kind !== "file" && <Action title="重试" onPress={retry} />}</View>;
  const aspectRatio = Math.max(0.5, Math.min(2, dimensions.width / dimensions.height));

  return <View style={layout.file}>
    {sentImage ? (
      <Pressable accessibilityRole="button" accessibilityLabel={`查看图片：${name}`} onPress={show}
        style={({ pressed }) => [layout.sentThumbnail, { backgroundColor: colors.field }, pressed && styles.faded]}>
        {error ? <Icon name="photo" size={24} color={colors.muted} />
          : imageUri ? <Image source={{ uri: imageUri }} resizeMode="cover" style={layout.thumbnailImage}
            onError={() => setError("无法显示图片，请重试。")} />
          : <ActivityIndicator color={colors.accent} />}
      </Pressable>
    ) : content && (kind === "image" || kind === "video") ? (
      <View style={layout.media}>
        {kind === "image" ? (
          <Pressable accessibilityRole="button" accessibilityLabel={`查看图片：${name}`} onPress={show}
            style={({ pressed }) => pressed && styles.faded}>
            <Image source={{ uri: content.uri }} accessibilityLabel={name} resizeMode="contain"
              onError={() => setError("无法显示图片，请重试。")}
              style={[layout.image, { aspectRatio, minWidth: Math.min(180, width / 2), backgroundColor: colors.field }]} />
          </Pressable>
        ) : <MediaPlayer uri={content.uri} kind={kind} name={name} />}
        <Pressable accessibilityRole="button" accessibilityLabel={`保存${name}`}
          accessibilityState={{ disabled: saving, busy: saving }} disabled={saving} hitSlop={6}
          onPress={() => { haptic("light"); void save(); }}
          style={({ pressed }) => [layout.mediaSave, pressed && layout.mediaSavePressed]}>
          {saving ? <ActivityIndicator size="small" color={colors.onAccent} />
            : <Icon name="download" size={18} color={colors.onAccent} />}
        </Pressable>
      </View>
    ) : kind === "audio" && content ? (
      <><MediaPlayer uri={content.uri} kind={kind} name={name} /><View style={layout.mediaActions}>{saveButton()}</View></>
    ) : (
      <View style={[layout.receivedRow, { borderBottomColor: colors.edge }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${label}：${name}`} onPress={show}
          style={({ pressed }) => [layout.row, layout.openRow, pressed && styles.faded]}>
          <View style={[layout.fileIcon, { backgroundColor: colors.tint }]}>
            <Icon name={kind === "image" ? "photo" : "attachment"} size={18} color={colors.accent} />
          </View>
          <View style={layout.name}>
            <Text numberOfLines={2} style={[styles.heading, layout.fileName, { color: tint }]}>{name}</Text>
            <Text style={[styles.caption, { color: tint === colors.foreground ? colors.muted : tint }]}>{size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`}</Text>
          </View>
          <Icon name="chevron" size={15} color={tint === colors.foreground ? colors.accent : tint} />
        </Pressable>
        {saveButton()}
      </View>
    )}
    {!open && !sentImage && <>{loading}{failure}{saveFeedback}</>}
    <OverlayModal visible={open} animationType={reduced ? "none" : "slide"} onRequestClose={() => setOpen(false)}
      supportedOrientations={["portrait", "landscape-left", "landscape-right"]}>
      <SafeAreaView style={layout.previewWindow} edges={["top"]}>
        <SafeAreaView accessibilityViewIsModal importantForAccessibility="yes" edges={["bottom", "left", "right"]}
          style={[layout.preview, {
            backgroundColor: colors.surface,
            borderTopColor: colors.edge,
            marginTop: kind === "markdown" ? Math.min(106, height * 0.18) : Math.min(60, height * 0.12),
          }]}>
          <View style={[layout.header, { borderBottomColor: colors.edge }]}>
            <PageHeader title={name}
              leading={kind === "html" && <View style={[layout.fileIcon, { backgroundColor: colors.tint }]}>
                <Icon name="logs" size={18} color={colors.accent} />
              </View>}
              trailing={<View style={layout.headerActions}>
                {kind === "image" && session && saveButton()}
                <CloseButton accessibilityLabel="关闭文件预览" onPress={() => setOpen(false)} />
              </View>} />
          </View>
          {loading}{failure}{saveFeedback}
          {open && imageUri && kind === "image" && <View style={layout.imagePreview}>
            <Image source={{ uri: imageUri }} accessibilityLabel={name} resizeMode="contain" style={layout.fullImage} />
          </View>}
          {open && document !== undefined && kind === "markdown" && <ScrollView contentContainerStyle={layout.markdown}>
            <AnswerMarkdown text={document} onOpenLink={onOpenLink} />
          </ScrollView>}
          {open && document !== undefined && kind === "html" && <View style={layout.html}>
            <HtmlPreview html={document} name={name} backgroundColor={dark ? "#ffffff" : colors.background} />
          </View>}
        </SafeAreaView>
      </SafeAreaView>
    </OverlayModal>
  </View>;
}

export function MessageAttachments({ items, session, outgoing = false, tint, onOpenLink }: {
  items: Attachment[]; session?: Session; outgoing?: boolean; tint: string; onOpenLink: (url: string) => void;
}) {
  const { colors, styles } = useTheme();
  return <View style={layout.files}>{items.map((item, index) => {
    const localUri = outgoing && !item.attachment_id ? uploadImageUri(item) : undefined;
    if ((item.attachment_id && session) || localUri) {
      return <MessageFile key={item.attachment_id ?? index} item={item} session={session} outgoing={outgoing}
        localUri={localUri} tint={tint} onOpenLink={onOpenLink} />;
    }
    return (
      <View key={index} style={layout.row}>
        <View style={[layout.fileIcon, { backgroundColor: colors.tint }]}>
          <Icon name={item.mime.startsWith("image/") ? "photo" : "attachment"} size={18} color={colors.accent} />
        </View>
        <View style={layout.name}>
          <Text numberOfLines={2} style={[styles.heading, layout.fileName, { color: tint }]}>{item.name}</Text>
          {!!session && <Text style={styles.caption}>暂无可用预览</Text>}
        </View>
      </View>
    );
  })}</View>;
}

const layout = StyleSheet.create({
  files: { gap: 2, minWidth: 0 },
  file: { gap: 6, minWidth: 0, width: "100%", paddingBottom: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 56, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "transparent" },
  receivedRow: { flexDirection: "row", alignItems: "center", gap: 4, minWidth: 0, borderBottomWidth: StyleSheet.hairlineWidth },
  openRow: { flex: 1, minWidth: 0, borderBottomWidth: 0 },
  media: { position: "relative" },
  mediaSave: {
    position: "absolute", top: 8, right: 8, zIndex: 1, width: 36, height: 36, borderRadius: 18,
    alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0, 0, 0, 0.72)",
  },
  mediaSavePressed: { backgroundColor: "rgba(0, 0, 0, 0.9)" },
  mediaActions: { alignSelf: "flex-end" },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  fileIcon: { width: 36, height: 36, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  fileName: { fontSize: 16, lineHeight: 22 },
  name: { flex: 1, minWidth: 0 },
  image: { width: "100%", maxHeight: 360, borderRadius: 16 },
  sentThumbnail: { width: sentImageSize, maxWidth: "100%", aspectRatio: 1, alignItems: "center", justifyContent: "center", borderRadius: 14, overflow: "hidden" },
  thumbnailImage: { width: "100%", height: "100%" },
  loading: { padding: 16, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" },
  error: { padding: 12, gap: 8 },
  previewWindow: { flex: 1 },
  preview: { flex: 1, minHeight: 0, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderTopWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  header: { borderBottomWidth: StyleSheet.hairlineWidth },
  imagePreview: { flex: 1, paddingHorizontal: 16, paddingVertical: 24, paddingTop: 12 },
  fullImage: { flex: 1, width: "100%", maxWidth: 800, alignSelf: "center", borderRadius: 16 },
  markdown: { padding: 24, paddingTop: 12, maxWidth: 800, width: "100%", alignSelf: "center" },
  html: { flex: 1, minHeight: 0, margin: 16, marginTop: 8 },
});
