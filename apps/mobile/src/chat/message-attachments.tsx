import { useEffect, useState } from "react";
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
import { attachmentKind, type AttachmentContent } from "./attachment-content";
import { HtmlPreview } from "./html-preview";
import { loadAttachment } from "./load-attachment";
import { MediaPlayer } from "./media-player";

function ReceivedFile({ item: { attachment_id, name, mime, size }, session, tint, onOpenLink }: {
  item: Attachment; session: Session; tint: string; onOpenLink: (url: string) => void;
}) {
  const { colors, dark, styles } = useTheme();
  const { height, width } = useWindowDimensions();
  const reduced = useReduceMotion();
  const kind = attachmentKind({ name, mime });
  const [requested, setRequested] = useState(kind === "image");
  const [attempt, setAttempt] = useState(0);
  const [content, setContent] = useState<AttachmentContent>();
  const [document, setDocument] = useState<string>();
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [dimensions, setDimensions] = useState({ width: 4, height: 3 });

  useEffect(() => {
    if (!requested) return;
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
      if (kind === "image") Image.getSize(result.uri, (width, height) => {
        if (!controller.signal.aborted && width && height) setDimensions({ width, height });
      }, () => {});
      setDocument(text);
      setContent(result);
    }).catch((failure: unknown) => {
      resource?.dispose();
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "无法读取附件，请重试。");
    });
    return () => { controller.abort(); resource?.dispose(); };
  }, [requested, attempt, session, attachment_id, name, mime, size, kind]);

  const retry = () => { setError(undefined); setAttempt((value) => value + 1); setRequested(true); };
  const busy = requested && !content && !error;
  const label = kind === "audio" ? "打开音频" : kind === "video" ? "打开视频"
    : kind === "file" ? "查看文件" : "打开预览";
  const show = () => {
    haptic(kind === "file" ? "warning" : "light");
    if (kind === "file") { setError("暂不支持预览此文件类型。"); return; }
    setRequested(true);
    if (kind === "image" || kind === "markdown" || kind === "html") setOpen(true);
  };
  const loading = busy && <View style={layout.loading}><ActivityIndicator color={colors.accent} /><Text style={styles.caption}>正在加载…</Text></View>;
  const failure = error && <View style={layout.error}><Notice>{error}</Notice>{kind !== "file" && <Action title="重试" onPress={retry} />}</View>;
  const aspectRatio = Math.max(0.5, Math.min(2, dimensions.width / dimensions.height));

  return <View style={layout.file}>
    {kind === "image" && content ? (
      <Pressable accessibilityRole="button" accessibilityLabel={`查看图片：${name}`} onPress={show}
        style={({ pressed }) => pressed && styles.faded}>
        <Image source={{ uri: content.uri }} accessibilityLabel={name} resizeMode="contain"
          onError={() => setError("无法显示图片，请重试。")}
          style={[layout.image, { aspectRatio, minWidth: Math.min(180, width / 2), backgroundColor: colors.field }]} />
      </Pressable>
    ) : (kind === "audio" || kind === "video") && content ? (
      <MediaPlayer uri={content.uri} kind={kind} name={name} />
    ) : (
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}：${name}`} onPress={show}
        style={({ pressed }) => [layout.row, { borderBottomColor: colors.edge }, pressed && styles.faded]}>
        <View style={[layout.fileIcon, { backgroundColor: colors.tint }]}>
          <Icon name={kind === "image" ? "photo" : "attachment"} size={18} color={colors.accent} />
        </View>
        <View style={layout.name}>
          <Text numberOfLines={2} style={[styles.heading, layout.fileName, { color: tint }]}>{name}</Text>
          <Text style={[styles.caption, { color: tint === colors.foreground ? colors.muted : tint }]}>{size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`}</Text>
        </View>
        <Icon name="chevron" size={15} color={tint === colors.foreground ? colors.accent : tint} />
      </Pressable>
    )}
    {!open && loading}
    {!open && failure}
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
              trailing={<CloseButton accessibilityLabel="关闭文件预览" onPress={() => setOpen(false)} />} />
          </View>
          {loading}{failure}
          {open && content && kind === "image" && <View style={layout.imagePreview}>
            <Image source={{ uri: content.uri }} accessibilityLabel={name} resizeMode="contain" style={layout.fullImage} />
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

export function MessageAttachments({ items, session, tint, onOpenLink }: {
  items: Attachment[]; session?: Session; tint: string; onOpenLink: (url: string) => void;
}) {
  const { colors, styles } = useTheme();
  return <View style={layout.files}>{items.map((item, index) => item.attachment_id && session ? (
    <ReceivedFile key={item.attachment_id} item={item} session={session} tint={tint} onOpenLink={onOpenLink} />
  ) : (
    <View key={index} style={layout.row}>
      <View style={[layout.fileIcon, { backgroundColor: colors.tint }]}>
        <Icon name={item.mime.startsWith("image/") ? "photo" : "attachment"} size={18} color={colors.accent} />
      </View>
      <Text numberOfLines={2} style={[styles.heading, layout.fileName, layout.name, { color: tint }]}>{item.name}</Text>
    </View>
  ))}</View>;
}

const layout = StyleSheet.create({
  files: { gap: 2, minWidth: 0 },
  file: { gap: 6, minWidth: 0, width: "100%", paddingBottom: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 56, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "transparent" },
  fileIcon: { width: 36, height: 36, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  fileName: { fontSize: 16, lineHeight: 22 },
  name: { flex: 1, minWidth: 0 },
  image: { width: "100%", maxHeight: 360, borderRadius: 16 },
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
