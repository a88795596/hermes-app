import { openBrowserAsync, WebBrowserPresentationStyle } from "expo-web-browser";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MarkdownIt } from "react-native-markdown-renderer";
import { inboxTitle, type InboxItem, type Profile } from "@hermes-mobile/protocol";
import { AnswerMarkdown } from "../chat/answer-markdown";
import { MessageAttachments } from "../chat/message-attachments";
import type { Session } from "../auth/session";
import { formatTopicTime, groupTopics } from "../chat/topic-groups";
import { haptic } from "../ui/haptics";
import { PageHeader } from "../ui/page-header";
import { formatDateTime, profileLabel } from "../ui/text";
import { Action, EmptyState, Icon, Notice, SectionLabel, useTheme } from "../ui/theme";

const previewMarkdown = MarkdownIt({ html: false });

function tokenText(token: ReturnType<typeof previewMarkdown.parse>[number]): string {
  switch (token.type) {
    case "inline":
    case "image":
      return token.children?.map(tokenText).join("") ?? token.content;
    case "text":
    case "code_inline":
    case "code_block":
    case "fence":
      return token.content;
    case "softbreak":
    case "hardbreak":
      return " ";
    default:
      return "";
  }
}

function itemProfile(item: InboxItem, profiles: Profile[]) {
  const profile = profiles.find((profile) => profile.profile_id === item.profile_id);
  return profile ? profileLabel(profile) : "未标注档案";
}

function InboxRow({ item, profile, now, onOpen }: {
  item: InboxItem; profile: string; now: Date; onOpen: (item: InboxItem) => void;
}) {
  const { colors, styles } = useTheme();
  const [focused, setFocused] = useState(false);
  const title = item.title ?? inboxTitle(item.text || item.attachments?.[0]?.name || "");
  const plainText = useMemo(() => previewMarkdown.parse(item.text, {}).map(tokenText).join(" ").replace(/\s+/gu, " ").trim(), [item.text]);
  const preview = plainText || item.attachments?.map(({ name }) => name).join("、") || "";
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}，${profile}，${formatDateTime(item.created_at)}，${Array.from(preview).slice(0, 160).join("")}`}
      accessibilityHint="查看消息全文" onPress={() => { haptic("light"); onOpen(item); }}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={({ pressed }) => [layout.row, { borderColor: colors.edge }, focused && styles.focused, pressed && styles.faded]}>
      <View style={[layout.icon, { backgroundColor: colors.tint }]}>
        <Icon name={item.attachments?.length ? "attachment" : "chat"} size={21} color={colors.accent} />
      </View>
      <View style={layout.rowContent}>
        <Text numberOfLines={2} ellipsizeMode="tail" style={styles.heading}>{title}</Text>
        {!!preview && <Text numberOfLines={2} ellipsizeMode="tail" style={styles.muted}>{preview}</Text>}
        <View style={layout.metadata}>
          <Text numberOfLines={1} style={[styles.caption, layout.profile]}>{profile}</Text>
          <Text style={styles.caption}>{formatTopicTime(item.created_at, now)}</Text>
          <Icon name="chevron" size={11} color={colors.muted} />
        </View>
      </View>
    </Pressable>
  );
}

export function InboxList({ items, profiles, profileId, ready, onProfile, onOpen }: {
  items: InboxItem[];
  profiles: Profile[];
  profileId?: string;
  ready: boolean;
  onProfile: (id: string | undefined) => void;
  onOpen: (item: InboxItem) => void;
}) {
  const now = new Date();
  const filtered = profileId ? items.filter((item) => item.profile_id === profileId) : items;
  return <>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={layout.filterBar} contentContainerStyle={layout.filters}>
      <Action title="全部" selected={!profileId} toggled={!profileId} feedback={profileId ? "selection" : false} onPress={() => onProfile(undefined)} />
      {profiles.map((profile) => (
        <Action key={profile.profile_id} title={profileLabel(profile)} selected={profileId === profile.profile_id} toggled={profileId === profile.profile_id}
          feedback={profileId === profile.profile_id ? false : "selection"}
          onPress={() => onProfile(profile.profile_id)} />
      ))}
    </ScrollView>
    {groupTopics(filtered, now).map(({ title, rows }) => (
      <View key={title ?? "undated"}>
        {title && <SectionLabel>{title}</SectionLabel>}
        {rows.map((item) => <InboxRow key={item.inbox_id} item={item} profile={itemProfile(item, profiles)} now={now} onOpen={onOpen} />)}
      </View>
    ))}
    {ready && !filtered.length && <EmptyState icon="inbox" title={profileId ? "此档案暂无消息" : "暂无消息"} />}
  </>;
}

export function InboxDetail({ item, profiles, session, onBack }: { item: InboxItem; profiles: Profile[]; session: Session; onBack: () => void }) {
  const { colors, styles } = useTheme();
  const [error, setError] = useState<string>();
  const openLink = useCallback((url: string) => {
    haptic("light");
    setError(undefined);
    void openBrowserAsync(url, {
      dismissButtonStyle: "close",
      presentationStyle: WebBrowserPresentationStyle.PAGE_SHEET,
      createTask: false,
      toolbarColor: colors.surface,
      controlsColor: colors.foreground,
      windowFeatures: { noopener: true, noreferrer: true },
    }).catch(() => { haptic("error"); setError("无法打开链接，请稍后重试。"); });
  }, [colors.foreground, colors.surface]);
  return (
    <View style={styles.frame}>
      <PageHeader title={item.title ?? inboxTitle(item.text || item.attachments?.[0]?.name || "")}
        leading={<Pressable accessibilityRole="button" accessibilityLabel="返回收件箱" onPress={() => { haptic("light"); onBack(); }}
          style={({ pressed }) => [layout.back, pressed && styles.faded]}>
          <Icon name="back" size={18} color={colors.accent} />
        </Pressable>} />
      <ScrollView contentContainerStyle={[styles.content, layout.detail]}>
        <View style={[layout.detailMetadata, { borderBottomColor: colors.edge }]}>
          <Text selectable style={[styles.label, { color: colors.accent }]}>{itemProfile(item, profiles)}</Text>
          <Text selectable style={styles.caption}>{formatDateTime(item.created_at)}</Text>
        </View>
        {error && <Notice>{error}</Notice>}
        {!!item.attachments?.length && <MessageAttachments items={item.attachments} session={session} tint={colors.foreground} onOpenLink={openLink} />}
        <AnswerMarkdown text={item.text} onOpenLink={openLink} />
      </ScrollView>
    </View>
  );
}

const layout = StyleSheet.create({
  filterBar: { flexGrow: 0 },
  filters: { gap: 8, paddingVertical: 1, alignItems: "center" },
  row: { flexDirection: "row", gap: 14, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  icon: { width: 40, height: 40, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  rowContent: { flex: 1, minWidth: 0, gap: 4 },
  metadata: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  profile: { flex: 1, minWidth: 0 },
  back: { width: 48, minHeight: 48, alignItems: "center", justifyContent: "center" },
  detail: { width: "100%", maxWidth: 680, alignSelf: "center", paddingTop: 8, paddingBottom: 32, gap: 20 },
  detailMetadata: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 6,
    paddingBottom: 18, borderBottomWidth: StyleSheet.hairlineWidth },
});
