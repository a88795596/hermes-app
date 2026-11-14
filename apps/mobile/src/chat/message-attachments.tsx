import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Attachment } from "@hermes-mobile/protocol";
import type { Session } from "../auth/session";
import { Action, CloseButton, Icon, Notice, useTheme } from "../ui/theme";
import { AnswerMarkdown } from "./answer-markdown";
import { attachmentKind, type AttachmentContent } from "./attachment-content";
import { HtmlPreview } from "./html-preview";
import { loadAttachment } from "./load-attachment";
import { MediaPlayer } from "./media-player";

function ReceivedFile({ item, session, tint, onOpenLink }: {
  item: Attachment; session: Session; tint: string; onOpenLink: (url: string) => void;
}) {
  const { colors, styles } = useTheme();
  const kind = attachmentKind(item);
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
    setContent(undefined);
    setDocument(undefined);
    setError(undefined);
    void loadAttachment(session, item, controller.signal).then(async (result) => {
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
  }, [requested, attempt, session, item.attachment_id, item.size, item.name, item.mime, kind]);

  const retry = () => { setError(undefined); setAttempt((value) => value + 1); setRequested(true); };
  const busy = requested && !content && !error;
  const label = kind === "audio" ? "打开音频" : kind === "video" ? "打开视频"
    : kind === "file" ? "查看文件" : "打开预览";
  const show = () => {
    if (kind === "file") { setError("暂不支持预览此文件类型。"); return; }
    setRequested(true);
    if (kind === "image" || kind === "markdown" || kind === "html") setOpen(true);
  };
  const loading = busy && <View style={layout.loading}><ActivityIndicator color={colors.accent} /><Text style={styles.caption}>正在加载…</Text></View>;
  const failure = error && <View style={layout.error}><Notice>{error}</Notice>{kind !== "file" && <Action title="重试" onPress={retry} />}</View>;

  return <View style={layout.file}>
    {kind === "image" && content ? (
      <Pressable accessibilityRole="button" accessibilityLabel={`查看图片：${item.name}`} onPress={show}>
        <Image source={{ uri: content.uri }} accessibilityLabel={item.name} resizeMode="contain"
          onError={() => setError("无法显示图片，请重试。")}
          style={[layout.image, { aspectRatio: Math.max(0.5, Math.min(2, dimensions.width / dimensions.height)), backgroundColor: colors.field }]} />
      </Pressable>
    ) : (kind === "audio" || kind === "video") && content ? (
      <MediaPlayer uri={content.uri} kind={kind} name={item.name} />
    ) : (
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}：${item.name}`} onPress={show}
        style={({ pressed }) => [layout.row, pressed && styles.faded]}>
        <Icon name={kind === "image" ? "photo" : "attachment"} size={20} color={tint} />
        <View style={layout.name}><Text numberOfLines={2} style={[styles.text, { color: tint }]}>{item.name}</Text>
          <Text style={[styles.caption, { color: tint }]}>{item.size < 1024 * 1024 ? `${Math.ceil(item.size / 1024)} KB` : `${(item.size / 1024 / 1024).toFixed(1)} MB`}</Text></View>
        <Icon name="chevron" size={12} color={tint} />
      </Pressable>
    )}
    {!open && loading}
    {!open && failure}
    <Modal visible={open} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setOpen(false)}>
      <SafeAreaView style={[layout.preview, { backgroundColor: colors.surface }]}>
        <View style={[layout.header, { borderBottomColor: colors.edge }]}>
          <Text numberOfLines={1} style={[styles.heading, layout.name]}>{item.name}</Text>
          <CloseButton accessibilityLabel="关闭文件预览" onPress={() => setOpen(false)} />
        </View>
        {loading}{failure}
        {open && content && kind === "image" && <Image source={{ uri: content.uri }} accessibilityLabel={item.name}
          resizeMode="contain" style={layout.fullImage} />}
        {open && document !== undefined && kind === "markdown" && <ScrollView contentContainerStyle={layout.markdown}>
          <AnswerMarkdown text={document} onOpenLink={onOpenLink} />
        </ScrollView>}
        {open && document !== undefined && kind === "html" && <HtmlPreview html={document} name={item.name} />}
      </SafeAreaView>
    </Modal>
  </View>;
}

export function MessageAttachments({ items, session, tint, onOpenLink }: {
  items: Attachment[]; session?: Session; tint: string; onOpenLink: (url: string) => void;
}) {
  const { styles } = useTheme();
  return <View style={layout.files}>{items.map((item, index) => item.attachment_id && session ? (
    <ReceivedFile key={item.attachment_id} item={item} session={session} tint={tint} onOpenLink={onOpenLink} />
  ) : (
    <View key={index} style={layout.row}>
      <Icon name={item.mime.startsWith("image/") ? "photo" : "attachment"} size={15} color={tint} />
      <Text numberOfLines={2} style={[styles.text, layout.name, { color: tint }]}>{item.name}</Text>
    </View>
  ))}</View>;
}

const layout = StyleSheet.create({
  files: { gap: 10, minWidth: 0 },
  file: { gap: 6, minWidth: 0, width: "100%" },
  row: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48 },
  name: { flex: 1, minWidth: 0 },
  image: { width: "100%", minWidth: 180, maxHeight: 360, borderRadius: 12 },
  loading: { padding: 16, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" },
  error: { padding: 8, gap: 8 },
  preview: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingStart: 16, paddingEnd: 4, borderBottomWidth: StyleSheet.hairlineWidth },
  fullImage: { flex: 1, width: "100%" },
  markdown: { padding: 20, maxWidth: 800, width: "100%", alignSelf: "center" },
});
