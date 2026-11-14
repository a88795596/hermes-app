import { randomUUID } from "expo-crypto";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Keyboard, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { DEFAULT_TOPIC_TITLE, topicTitlePreview, type AttachmentUpload, type InboxItem } from "@hermes-mobile/protocol";
import { Pairing } from "../auth/pairing";
import { loadSession, saveSession, type Session } from "../auth/session";
import { Conversation } from "../chat/conversation";
import { TopicList, type TopicListRow } from "../chat/topic-list";
import { InboxDetail, InboxList } from "../inbox/inbox";
import { ManagementMenu, ManagementScreen, type ManagementPage } from "../manage";
import { Group, Row } from "../manage/shared";
import { enablePushNotifications, pushAvailable } from "../notifications";
import { pairDevice } from "../sync/api";
import { useWorkspace, type Pending } from "../sync/use-workspace";
import { motion, useReduceMotion } from "../ui/motion";
import { profileLabel } from "../ui/text";
import { Action, Card, EmptyState, Icon, Notice, useTheme, type IconName } from "../ui/theme";

const sections = {
  topics: { title: "话题", icon: "topics" },
  inbox: { title: "收件箱", icon: "inbox" },
  settings: { title: "设置", icon: "settings" },
} as const;
type Section = keyof typeof sections;
type Page = Section | "manage" | "connection" | "archive" | ManagementPage;
type PageMotion = "fade" | "push" | "pop";
type Navigation = { page: Page; transition: PageMotion; fromTopics?: boolean };
const tabs = Object.keys(sections) as Section[];
const backLabels = { topics: "话题", settings: "设置", manage: "管理" } as const;

function ConnectionRow({ icon, label, value, online }: { icon: IconName; label: string; value: string; online: boolean }) {
  const { colors, styles } = useTheme();
  const reduced = useReduceMotion();
  return (
    <View style={styles.listItem}>
      <Icon name={icon} size={17} color={colors.muted} />
      <Text style={[styles.text, layout.grow]}>{label}</Text>
      <Animated.Text style={[styles.muted, layout.value, online && { color: colors.success }, !reduced && motion.status]}>{value}</Animated.Text>
    </View>
  );
}

function Workspace({
  session, onSignOut,
}: {
  session: Session;
  onSignOut: () => Promise<void>;
}) {
  const { colors, styles } = useTheme();
  const reduced = useReduceMotion();
  const [{ page, transition, fromTopics }, setNavigation] = useState<Navigation>({ page: "topics", transition: "fade" });
  const [chat, setChat] = useState<Pick<TopicListRow, "id" | "newProfileId">>();
  const [profileId, setProfileId] = useState<string>();
  const [inboxProfileId, setInboxProfileId] = useState<string>();
  const [inboxItem, setInboxItem] = useState<InboxItem>();
  const [signingOut, setSigningOut] = useState(false);
  const [push, setPush] = useState<"idle" | "enabling" | "enabled">("idle");
  const [error, setError] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftAttachments, setDraftAttachments] = useState<Record<string, AttachmentUpload[]>>({});
  const [showProcess, setShowProcess] = useState<Record<string, boolean>>({});
  const archiveInFlight = useRef(false);
  const [archiving, setArchiving] = useState(false);
  const topicId = chat?.id ?? null;
  const workspace = useWorkspace(session, topicId, chat?.newProfileId !== undefined);
  const profile = workspace.profiles.find((item) => item.profile_id === profileId) ?? workspace.profiles[0];
  const topic = workspace.detail?.topic ?? workspace.topics.find((item) => item.topic_id === topicId);
  const pendingTopics = new Map<string, Pending>();
  for (const item of workspace.pending) {
    if (item.profile_id && (pendingTopics.get(item.topic_id)?.created_at ?? Infinity) > item.created_at) {
      pendingTopics.set(item.topic_id, item);
    }
  }
  const archived = page === "archive";
  const topicListPage = page === "topics" || archived;
  const section = page === "topics" || page === "inbox" ? page : "settings";
  const settingsPage = page === "topics" || page === "inbox" || page === "settings" ? undefined : page;
  const managementPage = settingsPage === "manage" || settingsPage === "connection" || settingsPage === "archive" ? undefined : settingsPage;
  const settingsParent = managementPage && profile ? "manage" : fromTopics ? "topics" : "settings";
  const backLabel = backLabels[settingsParent];
  const pageTitle = archived ? "已归档会话" : settingsPage === "connection" ? "连接" : settingsPage ? "管理" : sections[section].title;
  const rows: TopicListRow[] = topicListPage ? workspace.topics
    .filter((item) => Boolean(item.archived) === archived && (archived || !profile || item.profile_id === profile.profile_id))
    .map((item) => ({
      id: item.topic_id, newProfileId: pendingTopics.get(item.topic_id)?.profile_id, title: item.title,
      status: item.status === "creating" ? "创建中…" : item.status === "error" ? "创建失败" : "",
      created_at: item.created_at, updated_at: item.updated_at,
      profileLabel: archived && workspace.profiles.length > 1
        ? profileLabel(workspace.profiles.find((profile) => profile.profile_id === item.profile_id)?.label ?? "") : undefined,
    })) : [];
  if (page === "topics") {
    const remoteIds = new Set(workspace.topics.map((topic) => topic.topic_id));
    for (const item of pendingTopics.values()) {
      if (item.profile_id !== profile?.profile_id || remoteIds.has(item.topic_id)) continue;
      rows.push({ id: item.topic_id, newProfileId: item.profile_id, title: topicTitlePreview(item.text || item.attachments?.[0]?.name || ""),
        status: item.error ? "发送失败" : "等待发送", created_at: item.created_at, updated_at: item.created_at });
    }
  }
  const pendingFirst = chat && pendingTopics.get(chat.id);
  const chatTitle = pendingFirst && (!topic || (topic.title === DEFAULT_TOPIC_TITLE
    && !workspace.detail?.messages.some((message) => message.role === "user")))
    ? topicTitlePreview(pendingFirst.text || pendingFirst.attachments?.[0]?.name || "") : topic?.title ?? (chat?.newProfileId ? DEFAULT_TOPIC_TITLE : "话题");
  const connected = workspace.network === "online" && workspace.connector_online === true;
  const connection = workspace.network === "offline" ? "离线"
    : workspace.network === "connecting" ? "连接中…"
    : connected ? "Hermes 已连接" : "连接器离线";

  const showPage = useCallback((next: Page, transition: PageMotion = "fade") => {
    Keyboard.dismiss();
    setNavigation((current) => current.page === next ? current : {
      page: next, transition, fromTopics: next === "connection" && current.page === "topics",
    });
    setError(undefined);
  }, []);

  const closeTopic = useCallback(() => {
    Keyboard.dismiss();
    setNavigation((current) => ({ ...current, transition: "pop" }));
    setChat(undefined);
  }, []);

  const closeInboxItem = useCallback(() => {
    setNavigation((current) => ({ ...current, transition: "pop" }));
    setInboxItem(undefined);
  }, []);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (topicId) {
        closeTopic();
        return true;
      }
      if (inboxItem) {
        closeInboxItem();
        return true;
      }
      if (settingsPage) {
        showPage(settingsParent, "pop");
        return true;
      }
      if (page !== "topics") {
        showPage("topics");
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [closeInboxItem, closeTopic, inboxItem, page, settingsPage, settingsParent, showPage, topicId]);

  async function enablePush() {
    setPush("enabling");
    setError(undefined);
    try {
      await enablePushNotifications(session);
      setPush("enabled");
    } catch (failure) {
      setPush("idle");
      setError(failure instanceof Error ? failure.message : "无法启用通知。");
    }
  }

  async function disconnect(discardIds?: readonly string[]) {
    if (signingOut) return;
    setSigningOut(true);
    setError(undefined);
    try {
      await workspace.finishSession(onSignOut, discardIds);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "退出登录失败。");
    } finally {
      setSigningOut(false);
    }
  }

  async function changeArchive(row: TopicListRow) {
    if (archiveInFlight.current) return;
    archiveInFlight.current = true;
    setArchiving(true);
    setError(undefined);
    try {
      await workspace.setTopicArchived(row.id, !archived, row.newProfileId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : archived ? "无法恢复会话。" : "无法归档会话。");
    } finally {
      archiveInFlight.current = false;
      setArchiving(false);
    }
  }

  if (workspace.sessionEnded) {
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>设备会话已结束</Text>
        {workspace.pending.length > 0 && (
          <>
            <Text style={styles.muted}>请先复制下方待发送的内容，再重新配对。这些消息的送达状态尚未确认。</Text>
            {workspace.pending.map((item) => (
              <Card key={item.submission_id}><Text selectable style={styles.text}>{item.text}</Text></Card>
            ))}
          </>
        )}
        {error && <Notice>{error}</Notice>}
        {workspace.storageError && <Notice>{workspace.storageError}</Notice>}
        <Action
          title={workspace.pending.length ? "丢弃待发送内容并重新配对" : "重新配对"}
          disabled={signingOut}
          onPress={() => void disconnect(workspace.pending.map((item) => item.submission_id))}
        />
      </ScrollView>
    );
  }

  function startConversation(newProfileId: string) {
    showPage("topics");
    setProfileId(newProfileId);
    setChat({ id: randomUUID(), newProfileId });
  }

  if (chat) {
    const { id, newProfileId } = chat;
    const processVisible = showProcess[id] ?? false;
    return (
      <Animated.View key={id} style={[styles.frame, !reduced && motion.push]}>
        <View style={[styles.header, layout.chatHeader, { borderBottomColor: colors.edge, backgroundColor: colors.surface }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={archived ? "返回已归档会话" : "返回话题列表"} hitSlop={6} onPress={closeTopic}
            style={({ pressed }) => [layout.back, layout.chatHeaderSide, pressed && styles.faded]}>
            <Icon name="back" size={17} color={colors.accent} />
            <Text style={[styles.text, { color: colors.accent }]}>{archived ? "归档" : sections.topics.title}</Text>
          </Pressable>
          <Text accessibilityRole="header" numberOfLines={1} ellipsizeMode="tail" style={[styles.heading, layout.grow, layout.chatTitle]}>{chatTitle}</Text>
          <View style={layout.chatHeaderSide} />
        </View>
        <Conversation
          id={id}
          topic={topic}
          newProfileId={newProfileId}
          showProcess={processVisible}
          onToggleProcess={() => setShowProcess((current) => ({ ...current, [id]: !current[id] }))}
          workspace={workspace}
          draft={drafts[id] ?? ""}
          onDraftChange={(value) => setDrafts((current) => ({ ...current, [id]: value }))}
          attachments={draftAttachments[id] ?? []}
          onAttachmentsChange={(value) => setDraftAttachments((current) => ({ ...current, [id]: value }))}
          onNewTopic={() => {
            const profileId = topic?.profile_id ?? newProfileId;
            if (profileId) startConversation(profileId);
          }}
        />
      </Animated.View>
    );
  }

  if (inboxItem) {
    return (
      <Animated.View key={inboxItem.inbox_id} style={[styles.frame, !reduced && motion.push]}>
        <InboxDetail item={inboxItem} profiles={workspace.profiles} onBack={closeInboxItem} />
      </Animated.View>
    );
  }

  const content = managementPage && profile ? (
    <ManagementScreen key={`${profile.profile_id}:${managementPage}`} page={managementPage} profile={profile} request={workspace.call} />
  ) : (
      <ScrollView
        contentContainerStyle={[styles.content, layout.page]}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={workspace.refreshing} onRefresh={() => void workspace.refresh()} tintColor={colors.accent} colors={[colors.accent]} />}
      >
        <View style={layout.pageHeader}>
          <Text accessibilityRole="header" style={[styles.title, layout.grow]}>{pageTitle}</Text>
          {page === "topics" && profile && (
            <Pressable accessibilityRole="button" accessibilityLabel="新建会话"
              onPress={() => startConversation(profile.profile_id)}
              style={({ pressed }) => [layout.compose, { backgroundColor: colors.tint }, pressed && styles.faded]}>
              <Icon name="compose" color={colors.accent} size={19} />
            </Pressable>
          )}
        </View>
        {page === "topics" && (
          <Pressable accessibilityRole="button" accessibilityLabel={connection + "。打开连接设置"} onPress={() => showPage("connection", "push")}
            style={({ pressed }) => [layout.connectionSummary, pressed && styles.faded]}>
            <View style={[layout.dot, { backgroundColor: connected ? colors.success : colors.muted }]} />
            <Text style={styles.muted}>{connection}</Text>
          </Pressable>
        )}
        {error && <Notice>{error}</Notice>}
        {workspace.error && <Notice>{workspace.error}</Notice>}
        {workspace.storageError && <Notice>{workspace.storageError}</Notice>}
        {page === "topics" && workspace.profiles.length > 1 && (
          <View style={styles.row}>
            {workspace.profiles.map((item) => (
              <Action key={item.profile_id} title={profileLabel(item.label)} selected={profile?.profile_id === item.profile_id} onPress={() => setProfileId(item.profile_id)} />
            ))}
          </View>
        )}
        {topicListPage && (rows.length > 0 ? (
          <TopicList rows={rows} archived={archived} busy={archiving}
            onOpen={({ id, newProfileId }) => setChat({ id, newProfileId })} onArchive={(row) => void changeArchive(row)} />
        ) : workspace.ready ? (
          <EmptyState icon={archived ? "archive" : "topics"} title={archived ? "暂无已归档会话" : "暂无话题"}
            description={archived ? undefined : "点击新建按钮开始对话。"} />
        ) : null)}
        {page === "inbox" && <InboxList items={workspace.inbox} profiles={workspace.profiles} profileId={inboxProfileId}
          ready={workspace.ready} onProfile={setInboxProfileId} onOpen={setInboxItem} />}
        {page === "settings" && (
          <Group>
            <Row title="管理" subtitle="定时任务、模型、日志、技能和 MCP" icon="manage" onPress={() => showPage("manage", "push")} />
            <Row divided title="连接" subtitle={connection} icon="link" onPress={() => showPage("connection", "push")} />
            <Row divided title="已归档会话" icon="archive" onPress={() => showPage("archive", "push")} />
          </Group>
        )}
        {(page === "manage" || managementPage) && (
          <ManagementMenu profiles={workspace.profiles} profile={profile} onProfile={setProfileId} onOpen={(next) => showPage(next, "push")} />
        )}
        {page === "connection" && (
          <>
            <View>
              <Text accessibilityRole="header" style={styles.sectionLabel}>服务器</Text>
              <View style={[layout.group, { backgroundColor: colors.surface }]}>
                <View style={styles.listItem}>
                  <View style={[layout.rowIcon, { backgroundColor: colors.tint }]}><Icon name="server" size={17} color={colors.accent} /></View>
                  <Text selectable style={[styles.text, layout.grow]}>{session.origin}</Text>
                </View>
              </View>
            </View>
            <View>
              <Text accessibilityRole="header" style={styles.sectionLabel}>状态</Text>
              <View style={[layout.group, { backgroundColor: colors.surface }]}>
                <ConnectionRow icon="link" label="应用连接" value={{ online: "在线", offline: "离线", connecting: "连接中…" }[workspace.network]} online={workspace.network === "online"} />
                <View style={[layout.divided, { borderColor: colors.edge }]} />
                <ConnectionRow icon="activity" label="实时更新" value={workspace.live ? "已连接" : "重新连接中…"} online={workspace.live} />
                <View style={[layout.divided, { borderColor: colors.edge }]} />
                <ConnectionRow icon="server" label="Hermes 连接器" value={workspace.connector_online === undefined ? "未知" : workspace.connector_online ? "在线" : "离线"} online={workspace.connector_online === true} />
              </View>
            </View>
            <View style={styles.row}>
              <Action icon="refresh" title="刷新" disabled={workspace.refreshing} onPress={() => void workspace.refresh()} />
              {pushAvailable && (
                <Action icon="bell" title={push === "enabled" ? "通知已启用" : push === "enabling" ? "启用中…" : "启用通知"}
                  disabled={push !== "idle" || workspace.network !== "online"} onPress={() => void enablePush()} />
              )}
            </View>
            {workspace.pending.length > 0 && (
              <Text style={styles.muted}>请先在对应的话题中处理待发送的消息，再退出登录。</Text>
            )}
            <Action icon="logout" destructive title={signingOut ? "正在退出…" : "退出此设备"}
              disabled={signingOut || !workspace.ready || workspace.pending.length > 0} onPress={() => void disconnect()} />
          </>
        )}
      </ScrollView>
  );

  return (
    <>
      <Animated.View key={page} style={[styles.frame, !reduced && motion[transition]]}>
        {settingsPage && (
          <View style={[layout.backBar, { backgroundColor: colors.surface, borderColor: colors.edge }]}>
            <Pressable accessibilityRole="button" accessibilityLabel={`返回${backLabel}`}
              onPress={() => showPage(settingsParent, "pop")} style={({ pressed }) => [layout.back, pressed && styles.faded]}>
              <Icon name="back" size={16} color={colors.accent} />
              <Text style={[styles.text, { color: colors.accent }]}>{backLabel}</Text>
            </Pressable>
          </View>
        )}
        {content}
      </Animated.View>
      <View accessibilityRole="tablist" style={[layout.tabs, { borderColor: colors.edge, backgroundColor: colors.surface }]}>
        <View style={layout.tabStrip}>
          <Animated.View style={[layout.tabIndicator, {
            backgroundColor: colors.tint,
            transform: [{ translateX: `${tabs.indexOf(section) * 100}%` }],
          }, !reduced && motion.indicator]} />
          {tabs.map((id) => {
            const { title, icon } = sections[id];
            const active = section === id;
            const color = active ? colors.accent : colors.muted;
            return (
              <Pressable key={id} accessibilityRole="tab" accessibilityLabel={title} aria-selected={active} onPress={() => showPage(id)}
                style={({ pressed }) => [layout.tab, pressed && styles.faded]}>
                <Icon name={icon} size={19} color={color} />
                <Text style={[layout.tabLabel, { color }]}>{title}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </>
  );
}

export default function HomeScreen() {
  const { colors, dark, styles } = useTheme();
  const [session, setSession] = useState<Session | null>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    void loadSession().then(setSession).catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : "无法恢复设备会话，请重新配对。");
      setSession(null);
    });
  }, []);

  async function pair(origin: string, token: string) {
    const next = await pairDevice(origin, token);
    await saveSession(next);
    setError(undefined);
    setSession(next);
  }

  async function signOut() {
    await saveSession(null);
    setSession(null);
  }

  return (
    <SafeAreaView style={[styles.frame, layout.clip]}>
      <StatusBar style={dark ? "light" : "dark"} />
      {session === undefined ? (
        <View style={styles.pairContent}>
          <ActivityIndicator accessibilityLabel="正在恢复设备会话" color={colors.accent} />
        </View>
      ) : session ? (
        <Workspace session={session} onSignOut={signOut} />
      ) : (
        <Pairing onPair={pair} initialError={error} />
      )}
    </SafeAreaView>
  );
}

const layout = StyleSheet.create({
  clip: { overflow: "hidden" },
  page: { width: "100%", maxWidth: 680, alignSelf: "center", paddingTop: 16 },
  pageHeader: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  compose: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  connectionSummary: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 44, alignSelf: "flex-start", marginTop: -16, marginBottom: -12 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  group: { borderRadius: 13, overflow: "hidden" },
  divided: { borderTopWidth: StyleSheet.hairlineWidth },
  rowIcon: { width: 29, height: 29, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  value: { flexShrink: 1, maxWidth: "46%", textAlign: "right" },
  chatHeader: { borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 48, paddingHorizontal: 12, paddingVertical: 2 },
  backBar: { alignItems: "flex-start", borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12 },
  back: { flexDirection: "row", gap: 2, minHeight: 44, minWidth: 65, alignItems: "center" },
  chatHeaderSide: { minWidth: 80 },
  chatTitle: { textAlign: "center" },
  tabs: { width: "87%", maxWidth: 400, alignSelf: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: 25, marginTop: 4, marginBottom: 5, padding: 3 },
  tabStrip: { flexDirection: "row" },
  tabIndicator: { position: "absolute", left: 0, top: 0, bottom: 0, width: `${100 / tabs.length}%`, borderRadius: 22, pointerEvents: "none" },
  tab: { flex: 1, minHeight: 44, borderRadius: 22, justifyContent: "center", alignItems: "center", gap: 2, paddingVertical: 3, paddingHorizontal: 2 },
  tabLabel: { fontSize: 11, fontWeight: "600", textAlign: "center" },
});
