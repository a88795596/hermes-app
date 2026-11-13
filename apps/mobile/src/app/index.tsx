import { randomUUID } from "expo-crypto";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Keyboard, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Topic } from "@hermes-mobile/protocol";
import { Pairing } from "../auth/pairing";
import { loadSession, saveSession, type Session } from "../auth/session";
import { Conversation } from "../chat/conversation";
import { ManagementMenu, ManagementScreen, type ManagementPage } from "../manage";
import { enablePushNotifications, pushAvailable } from "../notifications";
import { pairDevice } from "../sync/api";
import { useWorkspace } from "../sync/use-workspace";
import { formatDateTime, profileLabel } from "../ui/text";
import { Action, Card, EmptyState, Field, Icon, Notice, useTheme, type IconName } from "../ui/theme";

const sections = {
  topics: { title: "话题", icon: "topics" },
  inbox: { title: "收件箱", icon: "inbox" },
  manage: { title: "管理", icon: "manage" },
  connection: { title: "连接", icon: "settings" },
} as const;
type Section = keyof typeof sections;

function ConnectionRow({ icon, label, value, online }: { icon: IconName; label: string; value: string; online: boolean }) {
  const { colors, styles } = useTheme();
  return (
    <View style={styles.listItem}>
      <Icon name={icon} size={17} color={colors.muted} />
      <Text style={[styles.text, layout.grow]}>{label}</Text>
      <Text style={[styles.muted, layout.value, online && { color: colors.success }]}>{value}</Text>
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
  const [section, setSection] = useState<Section>("topics");
  const [managementPage, setManagementPage] = useState<ManagementPage>();
  const [topicId, setTopicId] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string>();
  const [title, setTitle] = useState("");
  const [composing, setComposing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [push, setPush] = useState<"idle" | "enabling" | "enabled">("idle");
  const [error, setError] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const createAttempt = useRef<{ request_id: string; profile_id: string; title: string }>(undefined);
  const workspace = useWorkspace(session, topicId);
  const profile = workspace.profiles.find((item) => item.profile_id === profileId) ?? workspace.profiles[0];
  const topic = workspace.detail?.topic ?? workspace.topics.find((item) => item.topic_id === topicId);
  const visibleTopics = workspace.topics.filter((item) => !profile || item.profile_id === profile.profile_id);
  const connected = workspace.network === "online" && workspace.connector_online === true;
  const connection = workspace.network === "offline" ? "离线"
    : workspace.network === "connecting" ? "连接中…"
    : connected ? "Hermes 已连接" : "连接器离线";

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (managementPage) {
        Keyboard.dismiss();
        setManagementPage(undefined);
        return true;
      }
      if (topicId) {
        setTopicId(null);
        return true;
      }
      if (section === "topics" && composing && !creating) {
        setComposing(false);
        return true;
      }
      if (section !== "topics") {
        setSection("topics");
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [composing, creating, managementPage, section, topicId]);

  async function create() {
    const name = title.trim();
    if (!profile || !name || creating) return;
    const prior = createAttempt.current;
    const body = prior?.title === name && prior.profile_id === profile.profile_id
      ? prior
      : { request_id: randomUUID(), profile_id: profile.profile_id, title: name };
    createAttempt.current = body;
    setCreating(true);
    setError(undefined);
    try {
      const next = await workspace.call<Topic>("/topics", { method: "POST", body });
      createAttempt.current = undefined;
      setTitle("");
      setComposing(false);
      Keyboard.dismiss();
      setTopicId(next.topic_id);
      await workspace.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法创建话题。");
    } finally {
      setCreating(false);
    }
  }

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

  function showSection(name: Section) {
    Keyboard.dismiss();
    setManagementPage(undefined);
    setSection(name);
    setError(undefined);
  }

  if (managementPage && profile) {
    return <ManagementScreen key={`${profile.profile_id}:${managementPage}`} page={managementPage} profile={profile}
      request={workspace.call} onBack={() => setManagementPage(undefined)} />;
  }

  if (topicId) {
    return (
      <>
        <View style={[styles.header, layout.chatHeader, { borderBottomColor: colors.edge, backgroundColor: colors.surface }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="返回话题列表" hitSlop={6} onPress={() => setTopicId(null)}
            style={({ pressed }) => [layout.back, pressed && styles.faded]}>
            <Icon name="back" size={17} color={colors.accent} />
            <Text style={[styles.text, { color: colors.accent }]}>{sections.topics.title}</Text>
          </Pressable>
          <Text accessibilityRole="header" numberOfLines={2} style={[styles.heading, layout.grow, layout.chatTitle]}>{topic?.title ?? "话题"}</Text>
          <View style={layout.backSpace} />
        </View>
        <Conversation
          key={topicId}
          id={topicId}
          topic={topic}
          workspace={workspace}
          draft={drafts[topicId] ?? ""}
          onDraftChange={(value) => setDrafts((current) => ({ ...current, [topicId]: value }))}
        />
      </>
    );
  }

  return (
    <>
      <ScrollView
        key={section}
        contentContainerStyle={[styles.content, layout.page]}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={workspace.syncing} onRefresh={() => void workspace.refresh()} tintColor={colors.accent} colors={[colors.accent]} />}
      >
        <View style={layout.pageHeader}>
          <Text accessibilityRole="header" style={[styles.title, layout.grow]}>{sections[section].title}</Text>
          {section === "topics" && profile && (
            <Pressable accessibilityRole="button" accessibilityLabel={composing ? "关闭新建话题" : "新建话题"}
              accessibilityState={{ expanded: composing, disabled: creating }} disabled={creating}
              onPress={() => { if (composing) Keyboard.dismiss(); setComposing(!composing); setError(undefined); }}
              style={({ pressed }) => [layout.compose, { backgroundColor: colors.tint }, (pressed || creating) && styles.faded]}>
              <Icon name={composing ? "close" : "compose"} color={colors.accent} size={19} />
            </Pressable>
          )}
        </View>
        {section === "topics" && (
          <Pressable accessibilityRole="button" accessibilityLabel={connection + "。打开连接设置"} onPress={() => showSection("connection")}
            style={({ pressed }) => [layout.connectionSummary, pressed && styles.faded]}>
            <View style={[layout.dot, { backgroundColor: connected ? colors.success : colors.muted }]} />
            <Text style={styles.muted}>{connection}</Text>
          </Pressable>
        )}
        {error && <Notice>{error}</Notice>}
        {workspace.error && <Notice>{workspace.error}</Notice>}
        {workspace.storageError && <Notice>{workspace.storageError}</Notice>}
        {section === "topics" && (
          <>
            {workspace.profiles.length > 1 && (
              <View style={styles.row}>
                {workspace.profiles.map((item) => (
                  <Action key={item.profile_id} title={profileLabel(item.label)} selected={profile?.profile_id === item.profile_id} onPress={() => setProfileId(item.profile_id)} />
                ))}
              </View>
            )}
            {composing && profile && (
              <Card>
                <Text accessibilityRole="header" style={styles.heading}>新建话题</Text>
                <Field autoFocus accessibilityLabel="话题名称" placeholder="话题名称" value={title} editable={!creating}
                  onChangeText={setTitle} onSubmitEditing={() => void create()} returnKeyType="done" />
                <Action primary title={creating ? "创建中…" : "创建话题"}
                  disabled={!title.trim() || creating || workspace.network !== "online"} onPress={() => void create()} />
              </Card>
            )}
            {visibleTopics.length > 0 ? (
              <View style={[layout.group, { backgroundColor: colors.surface }]}>
                {visibleTopics.map((item, index) => (
                  <Pressable key={item.topic_id} accessibilityRole="button" onPress={() => setTopicId(item.topic_id)}
                    style={({ pressed }) => [styles.listItem, index > 0 && layout.divided, { borderColor: colors.edge }, pressed && { backgroundColor: colors.secondary }]}>
                    <View style={[layout.rowIcon, { backgroundColor: colors.tint }]}><Icon name="chat" size={17} color={colors.accent} /></View>
                    <View style={layout.grow}>
                      <Text style={styles.heading}>{item.title}</Text>
                      {item.status !== "ready" && <Text style={styles.caption}>{item.status === "creating" ? "创建中…" : "创建失败"}</Text>}
                    </View>
                    <Icon name="chevron" size={14} color={colors.muted} />
                  </Pressable>
                ))}
              </View>
            ) : workspace.ready && !composing ? (
              <EmptyState icon="topics" title="暂无话题" description="点击新建按钮开始对话。" />
            ) : null}
          </>
        )}
        {section === "inbox" && (workspace.inbox.length > 0 ? (
          <View style={[layout.group, { backgroundColor: colors.surface }]}>
            {workspace.inbox.map((item, index) => (
              <View key={item.inbox_id} style={[styles.listItem, layout.inboxRow, index > 0 && layout.divided, { borderColor: colors.edge }]}>
                <View style={[layout.rowIcon, { backgroundColor: colors.tint }]}><Icon name="inbox" size={17} color={colors.accent} /></View>
                <View style={layout.grow}>
                  <Text selectable style={styles.text}>{item.text}</Text>
                  <Text style={[styles.caption, layout.date]}>{formatDateTime(item.created_at)}</Text>
                </View>
              </View>
            ))}
          </View>
        ) : workspace.ready ? <EmptyState icon="inbox" title="暂无消息" description="这里会显示定时任务结果和 Hermes 主动发送的消息。" /> : null)}
        {section === "manage" && <ManagementMenu profiles={workspace.profiles} profile={profile} onProfile={setProfileId} onOpen={setManagementPage} />}
        {section === "connection" && (
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
              <Action icon="refresh" title="刷新" disabled={workspace.syncing} onPress={() => void workspace.refresh()} />
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
      <View accessibilityRole="tablist" style={[layout.tabs, { borderColor: colors.edge, backgroundColor: colors.surface }]}>
        {(Object.keys(sections) as Section[]).map((id) => {
          const { title, icon } = sections[id];
          const active = section === id;
          const color = active ? colors.accent : colors.muted;
          return (
            <Pressable key={id} accessibilityRole="tab" accessibilityLabel={title} accessibilityState={{ selected: active }} onPress={() => showSection(id)}
              style={({ pressed }) => [layout.tab, active && { backgroundColor: colors.tint }, pressed && styles.faded]}>
              <Icon name={icon} size={19} color={color} />
              <Text style={[layout.tabLabel, { color }]}>{title}</Text>
            </Pressable>
          );
        })}
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
    <SafeAreaView style={styles.frame}>
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
  inboxRow: { alignItems: "flex-start" },
  date: { marginTop: 3 },
  chatHeader: { borderBottomWidth: StyleSheet.hairlineWidth, minHeight: 48, paddingHorizontal: 12, paddingVertical: 2 },
  back: { flexDirection: "row", gap: 2, minHeight: 44, minWidth: 65, alignItems: "center" },
  backSpace: { width: 65 },
  chatTitle: { textAlign: "center" },
  tabs: { width: "87%", maxWidth: 400, alignSelf: "center", flexDirection: "row", borderWidth: StyleSheet.hairlineWidth, borderRadius: 25, marginTop: 4, marginBottom: 5, padding: 3, gap: 2 },
  tab: { flex: 1, minHeight: 44, borderRadius: 22, justifyContent: "center", alignItems: "center", gap: 2, paddingVertical: 3, paddingHorizontal: 2 },
  tabLabel: { fontSize: 11, fontWeight: "600", textAlign: "center" },
});
