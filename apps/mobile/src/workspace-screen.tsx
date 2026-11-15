import { randomUUID } from "expo-crypto";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, BackHandler, Keyboard, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { DEFAULT_TOPIC_TITLE, topicTitlePreview } from "@hermes-mobile/protocol";
import { Conversation } from "./chat/conversation";
import { ComposerSheet, PickerRow } from "./chat/composer-menu";
import { TopicList, type TopicListRow } from "./chat/topic-list";
import { InboxDetail, InboxList } from "./inbox/inbox";
import { ManagementMenu, ManagementScreen, type ManagementPage } from "./manage";
import { Group, Row } from "./manage/shared";
import { enablePushNotifications, pushAvailable } from "./notifications";
import type { Pending } from "./sync/use-workspace";
import { motion, useReduceMotion } from "./ui/motion";
import { PageHeader } from "./ui/page-header";
import { haptic } from "./ui/haptics";
import { formatDateTime, profileLabel } from "./ui/text";
import { Action, Card, EmptyState, Icon, Notice, SectionLabel, useTheme, type IconName } from "./ui/theme";
import { checkUpdateManually, currentUpdate } from "./updates";
import { useWorkspaceContext, type Section } from "./workspace-context";

const sections = {
  topics: { title: "话题", icon: "chat", activeIcon: "chatActive" },
  inbox: { title: "收件箱", icon: "inbox", activeIcon: "inboxActive" },
  settings: { title: "设置", icon: "settings", activeIcon: "settingsActive" },
} as const;
type Page = Section | "manage" | "connection" | "archive" | ManagementPage;
const tabs = Object.keys(sections) as Section[];

function BackLink({ title, onPress }: { title: string; onPress: () => void }) {
  const { colors, styles } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`返回${title}`} onPress={() => { haptic("light"); onPress(); }}
      style={({ pressed }) => [layout.backLink, pressed && styles.faded]}>
      <Icon name="back" size={18} color={colors.accent} />
    </Pressable>
  );
}

function ConnectionRow({ icon, label, value, online }: { icon: IconName; label: string; value: string; online: boolean }) {
  const { colors, styles } = useTheme();
  const reduced = useReduceMotion();
  return (
    <View style={[styles.listItem, layout.ruledRow, { borderColor: colors.edge }]}>
      <Icon name={icon} size={21} color={colors.accent} />
      <Text style={[styles.text, layout.grow]}>{label}</Text>
      {online && <View style={[layout.check, { backgroundColor: colors.accentFill }]}>
        <Icon name="check" size={12} color={colors.onAccent} />
      </View>}
      <Animated.Text style={[styles.muted, layout.value, online && { color: colors.foreground }, !reduced && motion.status]}>{value}</Animated.Text>
    </View>
  );
}

function Workspace() {
  const { colors, styles } = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const updateInFlight = useRef(false);
  const [updateStatus, setUpdateStatus] = useState<string>();
  const [profilesExpanded, setProfilesExpanded] = useState(false);
  const [managementTabsVisible, setManagementTabsVisible] = useState(true);
  const updateDisabled = Platform.OS === "web" || !!updateStatus;
  const params = useLocalSearchParams<{ page?: Page | "conversation" | "inbox-item"; topicId?: string; newProfileId?: string; archived?: string }>();
  const { session, onSignOut, workspace, section: rootSection, setSection,
    profileId, setProfileId, inboxProfileId, setInboxProfileId, inboxItem: selectedInboxItem, setInboxItem,
    drafts, setDrafts, draftAttachments, setDraftAttachments, showProcess, setShowProcess,
    signingOut, setSigningOut, push, setPush, error, setError, archiveInFlight: archiveInFlightRef, archiving, setArchiving } = useWorkspaceContext();
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
  const disconnectDisabled = signingOut || !workspace.ready || workspace.pending.length > 0;
  const connection = workspace.network === "offline" ? "离线"
    : workspace.network === "connecting" ? "连接中…"
    : connected ? "已连接" : "连接器离线";

  const showPage = useCallback((next: Page) => {
    Keyboard.dismiss();
    setProfilesExpanded(false);
    if (next === "topics" || next === "inbox" || next === "settings") {
      setSection(next);
      if (router.canDismiss()) router.dismissAll();
    } else {
      router.push({ pathname: "/[page]", params: { page: next } });
    }
    setError(undefined);
  }, [router, setError, setSection]);

  const goBack = useCallback(() => {
    Keyboard.dismiss();
    router.back();
  }, [router]);

  const closeManagement = useCallback(() => {
    Keyboard.dismiss();
    const stack = navigation.getState();
    const previous = stack?.routes[stack.index - 1]?.params;
    if (previous && "page" in previous && previous.page === "manage") router.back();
    else router.replace({ pathname: "/[page]", params: { page: "manage" } });
  }, [navigation, router]);

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
      haptic("success");
    } catch (failure) {
      haptic("error");
      setPush("idle");
      setError(failure instanceof Error ? failure.message : "无法启用通知。");
    }
  }

  async function checkUpdate() {
    if (updateInFlight.current) return;
    updateInFlight.current = true;
    haptic("light");
    setUpdateStatus("检查中…");
    let downloadRequested = false;
    try {
      const message = await checkUpdateManually((update) => new Promise<boolean>((resolve) => {
        setUpdateStatus("等待确认…");
        Alert.alert("发现热更新", [update.message?.trim(),
          `时间：${update.publishedAt === undefined ? "未知" : formatDateTime(update.publishedAt)}`,
          `ID：${update.id}`,
        ].filter(Boolean).join("\n\n"), [
          { text: "取消", style: "cancel", onPress: () => resolve(false) },
          { text: "下载", onPress: () => { downloadRequested = true; haptic("medium"); setUpdateStatus("下载中…"); resolve(true); } },
        ], { cancelable: true, onDismiss: () => resolve(false) });
      }));
      if (message) {
        if (downloadRequested) haptic("success");
        Alert.alert("热更新", message);
      }
    } catch (failure) {
      haptic("error");
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
      haptic("success");
    } catch (failure) {
      haptic("error");
      setError(failure instanceof Error ? failure.message : "退出登录失败。");
    } finally {
      setSigningOut(false);
    }
  }

  async function changeArchive(row: TopicListRow) {
    if (archiveInFlightRef.current) return;
    archiveInFlightRef.current = true;
    setArchiving(true);
    setError(undefined);
    try {
      await workspace.setTopicArchived(row.id, !archived, row.newProfileId);
      haptic("success");
    } catch (failure) {
      haptic("error");
      setError(failure instanceof Error ? failure.message : archived ? "无法恢复会话。" : "无法归档会话。");
    } finally {
      archiveInFlightRef.current = false;
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
          feedback={workspace.pending.length ? "warning" : "medium"}
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
        <PageHeader title={chatTitle} leading={<BackLink title={archived ? "已归档会话" : "话题列表"} onPress={goBack} />} />
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
    return <InboxDetail item={inboxItem} profiles={workspace.profiles} session={session} onBack={goBack} />;
  }

  const content = managementPage && profile ? (
    <ManagementScreen key={`${profile.profile_id}:${managementPage}`} page={managementPage} profile={profile} request={workspace.call} onBack={closeManagement}
      onTabVisibilityChange={setManagementTabsVisible} />
  ) : (
    <>
      {page === "topics" ? (
        <PageHeader
          leading={<Pressable accessibilityRole="button" accessibilityLabel={`选择配置档案${profile ? `，${profileLabel(profile.label)}` : ""}`}
            accessibilityState={{ expanded: profilesExpanded }}
            onPress={() => { haptic("light"); setProfilesExpanded(true); }}
            style={({ pressed }) => [layout.avatar, { backgroundColor: colors.tint }, pressed && styles.faded]}>
            <Text style={[styles.heading, { color: colors.accent }]}>{Array.from(profileLabel(profile?.label ?? "H"))[0]}</Text>
          </Pressable>}
          title={<Pressable accessibilityRole="button" accessibilityLabel={connection + "。打开连接设置"}
            onPress={() => { haptic("light"); showPage("connection"); }}
            style={({ pressed }) => [layout.connectionSummary, pressed && styles.faded]}>
            <Text accessibilityRole="header" numberOfLines={1} style={[styles.wordmark, layout.wordmark, layout.brand]}>Hermes</Text>
            <View style={[layout.dot, { backgroundColor: connected ? "#2F9461" : "#888888" }]} />
          </Pressable>}
          trailing={<Pressable accessibilityRole="button" accessibilityLabel="新建会话" accessibilityState={{ disabled: !profile }} disabled={!profile}
            onPress={() => { if (profile) { haptic("medium"); startConversation(profile.profile_id); } }}
            style={({ pressed }) => [layout.compose, { backgroundColor: colors.accentFill }, (pressed || !profile) && styles.faded]}>
            <Icon name="compose" color={colors.onAccent} size={21} />
          </Pressable>}
        />
      ) : <PageHeader title={pageTitle} leading={settingsPage && <BackLink title={sections[rootSection].title} onPress={goBack} />} />}
      <ScrollView
        contentContainerStyle={[styles.content, layout.page]}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={workspace.refreshing} onRefresh={() => { if (!workspace.refreshing) { haptic("light"); void workspace.refresh(); } }} tintColor={colors.accent} colors={[colors.accent]} />}
      >
        {error && <Notice>{error}</Notice>}
        {workspace.error && <Notice>{workspace.error}</Notice>}
        {workspace.storageError && <Notice>{workspace.storageError}</Notice>}
        {topicListPage && (rows.length > 0 ? (
          <TopicList key={archived ? "archive" : profile?.profile_id} rows={rows} archived={archived} busy={archiving}
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
              <Row title="管理" icon="manage" onPress={() => showPage("manage")} />
              <Row divided title="连接" value={connection} icon="link" onPress={() => showPage("connection")} />
              <Row divided title="已归档会话" icon="archive" onPress={() => showPage("archive")} />
            </Group>
            <View style={layout.version}>
              <SectionLabel>版本信息</SectionLabel>
              <View style={[styles.listItem, layout.ruledRow, { borderColor: colors.edge }]}>
                <Text style={styles.text}>热更新版本</Text>
                <Text selectable style={[styles.caption, layout.updateValue, currentUpdate.builtAt !== undefined && layout.updateId]}>{currentUpdate.id}</Text>
              </View>
              <View style={[styles.listItem, layout.ruledRow, { borderColor: colors.edge }]}>
                <Text style={styles.text}>构建时间</Text>
                <Text selectable style={[styles.caption, layout.updateValue]}>
                  {currentUpdate.builtAt === undefined ? "—" : formatDateTime(currentUpdate.builtAt)}
                </Text>
              </View>
              {Platform.OS !== "web" && (
                <Pressable accessibilityRole="button" accessibilityLabel={updateStatus ?? "检查更新"}
                  accessibilityState={{ busy: !!updateStatus, disabled: updateDisabled }} disabled={updateDisabled}
                  onPress={() => void checkUpdate()}
                  style={({ pressed }) => [styles.listItem, layout.ruledRow, { borderColor: colors.edge }, pressed && styles.faded]}>
                  <Icon name="refresh" size={21} color={colors.accent} />
                  <Text style={[styles.text, layout.grow]}>{updateStatus ?? "检查更新"}</Text>
                  <Icon name="chevron" size={13} color={colors.muted} />
                </Pressable>
              )}
            </View>
          </>
        )}
        {(page === "manage" || managementPage) && (
          <ManagementMenu profiles={workspace.profiles} profile={profile} onProfile={setProfileId} onOpen={showPage} />
        )}
        {page === "connection" && (
          <>
            <View>
              <Text accessibilityRole="header" style={styles.sectionLabel}>服务器</Text>
              <View style={[styles.listItem, layout.address, { backgroundColor: colors.tint }]}>
                <Icon name="server" size={21} color={colors.accent} />
                <Text selectable style={[styles.text, layout.grow]}>{session.origin}</Text>
              </View>
            </View>
            <View style={layout.connectionStatus}>
              <SectionLabel>连接状态</SectionLabel>
              <ConnectionRow icon="link" label="应用连接" value={{ online: "在线", offline: "离线", connecting: "连接中…" }[workspace.network]} online={workspace.network === "online"} />
              <ConnectionRow icon="activity" label="实时更新" value={workspace.live ? "已连接" : "重新连接中…"} online={workspace.live} />
              <ConnectionRow icon="server" label="Hermes 连接器" value={workspace.connector_online === undefined ? "未知" : workspace.connector_online ? "在线" : "离线"} online={workspace.connector_online === true} />
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
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: disconnectDisabled }}
              disabled={disconnectDisabled}
              onPress={() => { haptic("warning"); void disconnect(); }}
              style={({ pressed }) => [layout.disconnect, { borderColor: colors.edge }, (pressed || disconnectDisabled) && styles.faded]}>
              <Icon name="logout" size={21} color={colors.error} />
              <Text style={[styles.label, { color: colors.error }]}>{signingOut ? "正在退出…" : "退出此设备"}</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </>
  );

  return (
    <>
      <View style={styles.frame}>
        {content}
      </View>
      {page === "topics" && profilesExpanded && (
        <ComposerSheet title="选择配置档案" closeLabel="关闭配置档案选择" onClose={() => setProfilesExpanded(false)}>
          <ScrollView style={layout.profileList}>
            {workspace.profiles.map((item) => (
              <PickerRow key={item.profile_id} title={profileLabel(item.label)} selected={item.profile_id === profile?.profile_id}
                trailing={item.profile_id === profile?.profile_id ? "check" : undefined} disabled={false}
                feedback={item.profile_id === profile?.profile_id ? false : undefined}
                onPress={() => { setProfileId(item.profile_id); setProfilesExpanded(false); }} />
            ))}
            {workspace.profiles.length === 0 && <Text style={styles.muted}>暂无可用配置档案</Text>}
          </ScrollView>
        </ComposerSheet>
      )}
      {(!settingsPage || (managementPage && managementTabsVisible)) && (
        <View accessibilityRole="tablist" style={[layout.tabs, { borderColor: colors.edge, backgroundColor: colors.background }]}>
          {tabs.map((id) => {
            const { title, icon, activeIcon } = sections[id];
            const active = section === id;
            const color = active ? colors.accent : colors.muted;
            return (
              <Pressable key={id} accessibilityRole="tab" accessibilityLabel={title} accessibilityState={{ selected: active }}
                onPress={() => { if (!active) haptic("selection"); showPage(id); }}
                style={({ pressed }) => [layout.tab, pressed && styles.faded]}>
                <Icon name={active ? activeIcon : icon} size={23} color={color} />
                <Text style={[layout.tabLabel, { color }]}>{title}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </>
  );
}

export default function WorkspaceScreen() {
  const { styles } = useTheme();
  return <SafeAreaView style={[styles.frame, layout.clip]}><Workspace /></SafeAreaView>;
}

const layout = StyleSheet.create({
  clip: { overflow: "hidden" },
  page: { width: "100%", maxWidth: 680, alignSelf: "center", paddingTop: 10 },
  wordmark: { fontSize: 18, lineHeight: 24, fontWeight: "700" },
  brand: { flexShrink: 1 },
  grow: { flex: 1, minWidth: 0 },
  compose: { width: 48, height: 48, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  connectionSummary: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, minHeight: 48, maxWidth: "100%" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  profileList: { flexGrow: 0, flexShrink: 1 },
  version: { marginTop: 8 },
  ruledRow: { borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 56 },
  address: { borderRadius: 12, paddingHorizontal: 16, marginTop: 8 },
  connectionStatus: { marginTop: 4 },
  check: { width: 19, height: 19, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  disconnect: { borderTopWidth: StyleSheet.hairlineWidth, minHeight: 56, paddingVertical: 12, flexDirection: "row",
    alignItems: "center", justifyContent: "center", gap: 10 },
  value: { flexShrink: 1, maxWidth: "46%", textAlign: "right" },
  updateValue: { flex: 1, minWidth: 0, textAlign: "right" },
  updateId: { fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) },
  backLink: { width: 48, minHeight: 48, alignItems: "center", justifyContent: "center" },
  tabs: { width: "100%", maxWidth: 680, alignSelf: "center", flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8 },
  tab: { flex: 1, minHeight: 56, justifyContent: "center", alignItems: "center", gap: 3, paddingVertical: 6, paddingHorizontal: 2 },
  tabLabel: { fontSize: 13, fontWeight: "600", textAlign: "center" },
});
