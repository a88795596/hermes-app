import { randomUUID } from "expo-crypto";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, BackHandler, Keyboard, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { DEFAULT_TOPIC_TITLE, topicTitlePreview } from "@hermes-mobile/protocol";
import { Conversation } from "./chat/conversation";
import { TopicList, type TopicListRow } from "./chat/topic-list";
import { InboxDetail, InboxList } from "./inbox/inbox";
import { ManagementMenu, ManagementScreen, type ManagementPage } from "./manage";
import { Group, Row } from "./manage/shared";
import { enablePushNotifications, pushAvailable } from "./notifications";
import type { Pending } from "./sync/use-workspace";
import { motion, useReduceMotion } from "./ui/motion";
import { formatDateTime, profileLabel } from "./ui/text";
import { Action, Card, EmptyState, Icon, Notice, useTheme, type IconName } from "./ui/theme";
import { checkUpdateManually, currentUpdate } from "./updates";
import { useWorkspaceContext, type Section } from "./workspace-context";

const sections = {
  topics: { title: "话题", icon: "topics" },
  inbox: { title: "收件箱", icon: "inbox" },
  settings: { title: "设置", icon: "settings" },
} as const;
type Page = Section | "manage" | "connection" | "archive" | ManagementPage;
const tabs = Object.keys(sections) as Section[];

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

function Workspace() {
  const { colors, styles } = useTheme();
  const reduced = useReduceMotion();
  const router = useRouter();
  const updateInFlight = useRef(false);
  const [updateStatus, setUpdateStatus] = useState<string>();
  const updateDisabled = Platform.OS === "web" || !!updateStatus;
  const params = useLocalSearchParams<{ page?: Page | "conversation" | "inbox-item"; topicId?: string; newProfileId?: string; archived?: string }>();
  const { session, onSignOut, workspace, section: rootSection, setSection,
    profileId, setProfileId, inboxProfileId, setInboxProfileId, inboxItem: selectedInboxItem, setInboxItem,
    drafts, setDrafts, draftAttachments, setDraftAttachments, showProcess, setShowProcess,
    signingOut, setSigningOut, push, setPush, error, setError, archiveInFlight, archiving, setArchiving } = useWorkspaceContext();
  const page = params.page && params.page !== "conversation" && params.page !== "inbox-item" ? params.page : rootSection;
  const chat = params.page === "conversation" && typeof params.topicId === "string"
    ? { id: params.topicId, newProfileId: typeof params.newProfileId === "string" ? params.newProfileId : undefined } : undefined;
  const inboxItem = params.page === "inbox-item" ? selectedInboxItem : undefined;
  const topicId = chat?.id ?? null;
  const profile = workspace.profiles.find((item) => item.profile_id === profileId) ?? workspace.profiles[0];
  const topic = workspace.detail?.topic.topic_id === topicId
    ? workspace.detail.topic : workspace.topics.find((item) => item.topic_id === topicId);
  const pendingTopics = new Map<string, Pending>();
  for (const item of workspace.pending) {
    if (item.profile_id && (pendingTopics.get(item.topic_id)?.created_at ?? Infinity) > item.created_at) {
      pendingTopics.set(item.topic_id, item);
    }
  }
  const archived = page === "archive" || params.archived === "1";
  const topicListPage = page === "topics" || archived;
  const section = page === "topics" || page === "inbox" ? page : "settings";
  const settingsPage = page === "topics" || page === "inbox" || page === "settings" ? undefined : page;
  const managementPage = settingsPage === "manage" || settingsPage === "connection" || settingsPage === "archive" ? undefined : settingsPage;
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

  const showPage = useCallback((next: Page) => {
    Keyboard.dismiss();
    if (next === "topics" || next === "inbox" || next === "settings") {
      setSection(next);
      if (router.canDismiss()) router.dismissAll();
    } else {
      router.push({ pathname: "/[page]", params: { page: next } });
    }
    setError(undefined);
  }, [router, setError, setSection]);

  const closeTopic = useCallback(() => {
    Keyboard.dismiss();
    router.back();
  }, [router]);

  useFocusEffect(useCallback(() => {
    if (Platform.OS !== "android" || params.page) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (page !== "topics") {
        showPage("topics");
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [page, params.page, showPage]));

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

  async function checkUpdate() {
    if (updateInFlight.current) return;
    updateInFlight.current = true;
    setUpdateStatus("检查中…");
    try {
      const message = await checkUpdateManually((update) => new Promise<boolean>((resolve) => {
        setUpdateStatus("等待确认…");
        Alert.alert("发现热更新", [update.message?.trim(),
          `时间：${update.publishedAt === undefined ? "未知" : formatDateTime(update.publishedAt)}`,
          `ID：${update.id}`,
        ].filter(Boolean).join("\n\n"), [
          { text: "取消", style: "cancel", onPress: () => resolve(false) },
          { text: "下载", onPress: () => { setUpdateStatus("下载中…"); resolve(true); } },
        ], { cancelable: true, onDismiss: () => resolve(false) });
      }));
      if (message) Alert.alert("热更新", message);
    } catch (failure) {
      Alert.alert("热更新失败", failure instanceof Error ? failure.message : "请稍后重试。");
    } finally {
      updateInFlight.current = false;
      setUpdateStatus(undefined);
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
    router.push({ pathname: "/[page]", params: { page: "conversation", topicId: randomUUID(), newProfileId } });
  }

  if (chat) {
    const { id, newProfileId } = chat;
    const processVisible = showProcess[id] ?? false;
    return (
      <View style={styles.frame}>
        <View style={[styles.header, layout.chatHeader, { borderBottomColor: colors.edge, backgroundColor: colors.background }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={archived ? "返回已归档会话" : "返回话题列表"} hitSlop={6} onPress={closeTopic}
            style={({ pressed }) => [layout.chatBack, layout.chatHeaderSide, pressed && styles.faded]}>
            <Icon name="back" size={17} color={colors.accent} />
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
          session={session}
          draft={drafts[id] ?? ""}
          onDraftChange={(value) => setDrafts((current) => ({ ...current, [id]: value }))}
          attachments={draftAttachments[id] ?? []}
          onAttachmentsChange={(value) => setDraftAttachments((current) => ({ ...current, [id]: value }))}
          onNewTopic={() => {
            const profileId = topic?.profile_id ?? newProfileId;
            if (profileId) startConversation(profileId);
          }}
        />
      </View>
    );
  }

  if (inboxItem) {
    return (
      <View style={styles.frame}>
        <InboxDetail item={inboxItem} profiles={workspace.profiles} session={session} />
      </View>
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
          <Pressable accessibilityRole="button" accessibilityLabel={connection + "。打开连接设置"} onPress={() => showPage("connection")}
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
            onOpen={({ id, newProfileId }) => router.push({ pathname: "/[page]", params: {
              page: "conversation", topicId: id, newProfileId, archived: archived ? "1" : undefined,
            } })} onArchive={(row) => void changeArchive(row)} />
        ) : workspace.ready ? (
          <EmptyState icon={archived ? "archive" : "topics"} title={archived ? "暂无已归档会话" : "暂无话题"}
            description={archived ? undefined : "点击新建按钮开始对话。"} />
        ) : null)}
        {page === "inbox" && <InboxList items={workspace.inbox} profiles={workspace.profiles} profileId={inboxProfileId}
          ready={workspace.ready} onProfile={setInboxProfileId} onOpen={(item) => {
            setInboxItem(item);
            router.push({ pathname: "/[page]", params: { page: "inbox-item" } });
          }} />}
        {page === "settings" && (
          <>
            <Group>
              <Row title="管理" subtitle="定时任务、模型、日志、技能和 MCP" icon="manage" onPress={() => showPage("manage")} />
              <Row divided title="连接" subtitle={connection} icon="link" onPress={() => showPage("connection")} />
              <Row divided title="已归档会话" icon="archive" onPress={() => showPage("archive")} />
            </Group>
            <Group>
              <Pressable accessibilityRole="button" accessibilityLabel={`热更新版本，${currentUpdate.id}，检查更新`}
                accessibilityState={{ busy: !!updateStatus, disabled: updateDisabled }} disabled={updateDisabled}
                onPress={() => void checkUpdate()} style={({ pressed }) => [styles.listItem, pressed && styles.faded]}>
                <Text style={styles.text}>{updateStatus ?? "热更新版本"}</Text>
                <Text style={[styles.caption, layout.updateValue]}>{currentUpdate.id}</Text>
                {Platform.OS !== "web" && <Icon name="chevron" size={13} color={colors.muted} />}
              </Pressable>
              <View style={[styles.listItem, layout.divided, { borderColor: colors.edge }]}>
                <Text style={styles.text}>构建时间</Text>
                <Text selectable style={[styles.caption, layout.updateValue]}>
                  {currentUpdate.builtAt === undefined ? "—" : formatDateTime(currentUpdate.builtAt)}
                </Text>
              </View>
            </Group>
          </>
        )}
        {(page === "manage" || managementPage) && (
          <ManagementMenu profiles={workspace.profiles} profile={profile} onProfile={setProfileId} onOpen={showPage} />
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
      <View style={styles.frame}>
        {content}
      </View>
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

export default function WorkspaceScreen() {
  const { styles } = useTheme();
  return <SafeAreaView style={[styles.frame, layout.clip]}><Workspace /></SafeAreaView>;
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
  updateValue: { flex: 1, minWidth: 0, textAlign: "right" },
  chatHeader: { borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 48, paddingHorizontal: 12, paddingVertical: 2 },
  chatBack: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  chatHeaderSide: { width: 44 },
  chatTitle: { textAlign: "center" },
  tabs: { width: "87%", maxWidth: 400, alignSelf: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: 25, marginTop: 4, marginBottom: 5, padding: 3 },
  tabStrip: { flexDirection: "row" },
  tabIndicator: { position: "absolute", left: 0, top: 0, bottom: 0, width: `${100 / tabs.length}%`, borderRadius: 22, pointerEvents: "none" },
  tab: { flex: 1, minHeight: 44, borderRadius: 22, justifyContent: "center", alignItems: "center", gap: 2, paddingVertical: 3, paddingHorizontal: 2 },
  tabLabel: { fontSize: 11, fontWeight: "600", textAlign: "center" },
});
