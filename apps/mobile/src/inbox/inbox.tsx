import { openBrowserAsync, WebBrowserPresentationStyle } from "expo-web-browser";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { inboxTitle, type InboxItem, type Profile } from "@hermes-mobile/protocol";
import { AnswerMarkdown } from "../chat/answer-markdown";
import { formatTopicTime, groupTopics } from "../chat/topic-groups";
import { formatDateTime, profileLabel } from "../ui/text";
import { Action, EmptyState, Icon, Notice, useTheme } from "../ui/theme";

function itemProfile(item: InboxItem, profiles: Profile[]) {
  const profile = profiles.find((profile) => profile.profile_id === item.profile_id);
  return profile ? profileLabel(profile.label) : "未标注档案";
}

function InboxCard({ item, profile, now, onOpen }: {
  item: InboxItem; profile: string; now: Date; onOpen: (item: InboxItem) => void;
}) {
  const { colors, styles } = useTheme();
  const [focused, setFocused] = useState(false);
  const title = item.title ?? inboxTitle(item.text);
  const preview = item.text.replace(/\s+/gu, " ").trim();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}，${profile}，${formatDateTime(item.created_at)}，${Array.from(preview).slice(0, 160).join("")}`}
      accessibilityHint="查看消息全文" onPress={() => onOpen(item)}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={({ pressed }) => [styles.card, layout.card, focused && styles.focused, pressed && { backgroundColor: colors.secondary }]}>
      <Text numberOfLines={2} ellipsizeMode="tail" style={styles.heading}>{title}</Text>
      <Text numberOfLines={2} ellipsizeMode="tail" style={[styles.text, { color: colors.muted }]}>
        {preview}
      </Text>
      <View style={layout.metadata}>
        <Text numberOfLines={1} style={[styles.caption, layout.profile]}>{profile}</Text>
        <Text style={styles.caption}>{formatTopicTime(item.created_at, now)}</Text>
        <Icon name="chevron" size={11} color={colors.muted} />
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
  const { styles } = useTheme();
  const now = new Date();
  const filtered = profileId ? items.filter((item) => item.profile_id === profileId) : items;
  return <>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={layout.filterBar} contentContainerStyle={layout.filters}>
      <Action title="全部" selected={!profileId} toggled={!profileId} onPress={() => onProfile(undefined)} />
      {profiles.map((profile) => (
        <Action key={profile.profile_id} title={profileLabel(profile.label)} selected={profileId === profile.profile_id} toggled={profileId === profile.profile_id}
          onPress={() => onProfile(profile.profile_id)} />
      ))}
    </ScrollView>
    {groupTopics(filtered, now).map(({ title, rows }) => (
      <View key={title ?? "undated"}>
        {title && <Text accessibilityRole="header" style={styles.sectionLabel}>{title}</Text>}
        <View style={layout.cards}>
          {rows.map((item) => <InboxCard key={item.inbox_id} item={item} profile={itemProfile(item, profiles)} now={now} onOpen={onOpen} />)}
        </View>
      </View>
    ))}
    {ready && !filtered.length && <EmptyState icon="inbox" title={profileId ? "此档案暂无消息" : "暂无消息"} />}
  </>;
}

export function InboxDetail({ item, profiles, onBack }: { item: InboxItem; profiles: Profile[]; onBack: () => void }) {
  const { colors, styles } = useTheme();
  const [error, setError] = useState<string>();
  const openLink = useCallback((url: string) => {
    setError(undefined);
    void openBrowserAsync(url, {
      dismissButtonStyle: "close",
      presentationStyle: WebBrowserPresentationStyle.PAGE_SHEET,
      createTask: false,
      toolbarColor: colors.surface,
      controlsColor: colors.foreground,
      windowFeatures: { noopener: true, noreferrer: true },
    }).catch(() => setError("无法打开链接，请稍后重试。"));
  }, [colors.foreground, colors.surface]);
  return (
    <View style={[styles.frame, { backgroundColor: colors.surface }]}>
      <View style={[styles.header, layout.header, { borderBottomColor: colors.edge }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="返回收件箱" onPress={onBack}
          style={({ pressed }) => [layout.back, pressed && styles.faded]}>
          <Icon name="back" size={17} color={colors.accent} />
          <Text style={[styles.text, { color: colors.accent }]}>收件箱</Text>
        </Pressable>
        <Text style={[styles.heading, layout.headerTitle]}>消息详情</Text>
        <View style={layout.headerSide} />
      </View>
      <ScrollView contentContainerStyle={[styles.content, layout.detail]}>
        <Text selectable accessibilityRole="header" style={[styles.title, layout.detailTitle]}>{item.title ?? inboxTitle(item.text)}</Text>
        <View style={[layout.detailMetadata, { borderBottomColor: colors.edge }]}>
          <Text selectable style={[styles.label, { color: colors.accent }]}>{itemProfile(item, profiles)}</Text>
          <Text selectable style={styles.caption}>{formatDateTime(item.created_at)}</Text>
        </View>
        {error && <Notice>{error}</Notice>}
        <AnswerMarkdown text={item.text} onOpenLink={openLink} />
      </ScrollView>
    </View>
  );
}

const layout = StyleSheet.create({
  filterBar: { flexGrow: 0 },
  filters: { gap: 6, paddingVertical: 1, alignItems: "center" },
  cards: { gap: 10 },
  card: { padding: 16, gap: 8, borderWidth: 1, borderColor: "transparent" },
  metadata: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  profile: { flex: 1, minWidth: 0 },
  header: { borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 48, paddingHorizontal: 12, paddingVertical: 2 },
  back: { flexDirection: "row", gap: 2, minHeight: 44, minWidth: 80, alignItems: "center" },
  headerTitle: { flex: 1, textAlign: "center" },
  headerSide: { minWidth: 80 },
  detail: { width: "100%", maxWidth: 680, alignSelf: "center", paddingTop: 24, paddingBottom: 32, gap: 18 },
  detailTitle: { fontSize: 24, lineHeight: 32, letterSpacing: -0.4 },
  detailMetadata: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 12, rowGap: 6,
    paddingBottom: 18, borderBottomWidth: StyleSheet.hairlineWidth },
});
