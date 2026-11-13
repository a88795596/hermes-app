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
import { Action, Card, EmptyState, Field, Icon, Notice, useTheme, type IconName } from "../ui/theme";

type Section = "Topics" | "Inbox" | "Manage" | "Connection";

const sections = [
  { title: "Topics", icon: "topics" },
  { title: "Inbox", icon: "inbox" },
  { title: "Manage", icon: "manage" },
  { title: "Connection", icon: "settings" },
] as const;

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
  const [section, setSection] = useState<Section>("Topics");
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
  const connection = workspace.network === "offline" ? "Offline"
    : workspace.network === "connecting" ? "Connecting…"
    : connected ? "Hermes connected" : "Connector offline";

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
      if (section === "Topics" && composing && !creating) {
        setComposing(false);
        return true;
      }
      if (section !== "Topics") {
        setSection("Topics");
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
      setError(failure instanceof Error ? failure.message : "The topic could not be created.");
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
      setError(failure instanceof Error ? failure.message : "Could not enable notifications.");
    }
  }

  async function disconnect(discardIds?: readonly string[]) {
    if (signingOut) return;
    setSigningOut(true);
    setError(undefined);
    try {
      await workspace.finishSession(onSignOut, discardIds);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Sign-out failed.");
    } finally {
      setSigningOut(false);
    }
  }

  if (workspace.sessionEnded) {
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>Device session ended</Text>
        {workspace.pending.length > 0 && (
          <>
            <Text style={styles.muted}>Copy your pending text before pairing again. Delivery of these messages could not be confirmed.</Text>
            {workspace.pending.map((item) => (
              <Card key={item.submission_id}><Text selectable style={styles.text}>{item.text}</Text></Card>
            ))}
          </>
        )}
        {error && <Notice>{error}</Notice>}
        {workspace.storageError && <Notice>{workspace.storageError}</Notice>}
        <Action
          title={workspace.pending.length ? "Discard pending text and pair again" : "Pair again"}
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
          <Pressable accessibilityRole="button" accessibilityLabel="Back to topics" hitSlop={6} onPress={() => setTopicId(null)}
            style={({ pressed }) => [layout.back, pressed && styles.faded]}>
            <Icon name="back" size={17} color={colors.accent} />
            <Text style={[styles.text, { color: colors.accent }]}>Topics</Text>
          </Pressable>
          <Text accessibilityRole="header" numberOfLines={2} style={[styles.heading, layout.grow, layout.chatTitle]}>{topic?.title ?? "Topic"}</Text>
          <View style={layout.backSpace} />
        </View>
        <Conversation
          key={topicId}
          id={topicId}
          topic={topic}
          workspace={workspace}
          draft={drafts[topicId] ?? ""}
          onDraftChange={(value) => setDrafts((current) => ({ ...current, [topicId]: value }))}
          onNewTopic={() => {
            showSection("Topics");
            setProfileId(topic?.profile_id);
            setTitle("");
            setComposing(true);
            setTopicId(null);
          }}
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
          <Text accessibilityRole="header" style={[styles.title, layout.grow]}>{section}</Text>
          {section === "Topics" && profile && (
            <Pressable accessibilityRole="button" accessibilityLabel={composing ? "Close new topic" : "New topic"}
              accessibilityState={{ expanded: composing, disabled: creating }} disabled={creating}
              onPress={() => { if (composing) Keyboard.dismiss(); setComposing(!composing); setError(undefined); }}
              style={({ pressed }) => [layout.compose, { backgroundColor: colors.tint }, (pressed || creating) && styles.faded]}>
              <Icon name={composing ? "close" : "compose"} color={colors.accent} size={19} />
            </Pressable>
          )}
        </View>
        {section === "Topics" && (
          <Pressable accessibilityRole="button" accessibilityLabel={connection + ". Open connection settings"} onPress={() => showSection("Connection")}
            style={({ pressed }) => [layout.connectionSummary, pressed && styles.faded]}>
            <View style={[layout.dot, { backgroundColor: connected ? colors.success : colors.muted }]} />
            <Text style={styles.muted}>{connection}</Text>
          </Pressable>
        )}
        {error && <Notice>{error}</Notice>}
        {workspace.error && <Notice>{workspace.error}</Notice>}
        {workspace.storageError && <Notice>{workspace.storageError}</Notice>}
        {section === "Topics" && (
          <>
            {workspace.profiles.length > 1 && (
              <View style={styles.row}>
                {workspace.profiles.map((item) => (
                  <Action key={item.profile_id} title={item.label} selected={profile?.profile_id === item.profile_id} onPress={() => setProfileId(item.profile_id)} />
                ))}
              </View>
            )}
            {composing && profile && (
              <Card>
                <Text accessibilityRole="header" style={styles.heading}>New topic</Text>
                <Field autoFocus accessibilityLabel="Topic title" placeholder="Topic title" value={title} editable={!creating}
                  onChangeText={setTitle} onSubmitEditing={() => void create()} returnKeyType="done" />
                <Action primary title={creating ? "Creating…" : "Create topic"}
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
                      {item.status !== "ready" && <Text style={styles.caption}>{item.status === "creating" ? "Creating…" : "Creation failed"}</Text>}
                    </View>
                    <Icon name="chevron" size={14} color={colors.muted} />
                  </Pressable>
                ))}
              </View>
            ) : workspace.ready && !composing ? (
              <EmptyState icon="topics" title="No topics yet" description="Tap the compose button to start a conversation." />
            ) : null}
          </>
        )}
        {section === "Inbox" && (workspace.inbox.length > 0 ? (
          <View style={[layout.group, { backgroundColor: colors.surface }]}>
            {workspace.inbox.map((item, index) => (
              <View key={item.inbox_id} style={[styles.listItem, layout.inboxRow, index > 0 && layout.divided, { borderColor: colors.edge }]}>
                <View style={[layout.rowIcon, { backgroundColor: colors.tint }]}><Icon name="inbox" size={17} color={colors.accent} /></View>
                <View style={layout.grow}>
                  <Text selectable style={styles.text}>{item.text}</Text>
                  <Text style={[styles.caption, layout.date]}>{new Date(item.created_at).toLocaleString()}</Text>
                </View>
              </View>
            ))}
          </View>
        ) : workspace.ready ? <EmptyState icon="inbox" title="No deliveries yet" description="Scheduled results and messages from Hermes appear here." /> : null)}
        {section === "Manage" && <ManagementMenu profiles={workspace.profiles} profile={profile} onProfile={setProfileId} onOpen={setManagementPage} />}
        {section === "Connection" && (
          <>
            <View>
              <Text accessibilityRole="header" style={styles.sectionLabel}>Server</Text>
              <View style={[layout.group, { backgroundColor: colors.surface }]}>
                <View style={styles.listItem}>
                  <View style={[layout.rowIcon, { backgroundColor: colors.tint }]}><Icon name="server" size={17} color={colors.accent} /></View>
                  <Text selectable style={[styles.text, layout.grow]}>{session.origin}</Text>
                </View>
              </View>
            </View>
            <View>
              <Text accessibilityRole="header" style={styles.sectionLabel}>Status</Text>
              <View style={[layout.group, { backgroundColor: colors.surface }]}>
                <ConnectionRow icon="link" label="App connection" value={{ online: "Online", offline: "Offline", connecting: "Connecting…" }[workspace.network]} online={workspace.network === "online"} />
                <View style={[layout.divided, { borderColor: colors.edge }]} />
                <ConnectionRow icon="activity" label="Live updates" value={workspace.live ? "Connected" : "Reconnecting"} online={workspace.live} />
                <View style={[layout.divided, { borderColor: colors.edge }]} />
                <ConnectionRow icon="server" label="Hermes Connector" value={workspace.connector_online === undefined ? "Unknown" : workspace.connector_online ? "Online" : "Offline"} online={workspace.connector_online === true} />
              </View>
            </View>
            <View style={styles.row}>
              <Action icon="refresh" title="Refresh" disabled={workspace.syncing} onPress={() => void workspace.refresh()} />
              {pushAvailable && (
                <Action icon="bell" title={push === "enabled" ? "Notifications enabled" : push === "enabling" ? "Enabling…" : "Enable notifications"}
                  disabled={push !== "idle" || workspace.network !== "online"} onPress={() => void enablePush()} />
              )}
            </View>
            {workspace.pending.length > 0 && (
              <Text style={styles.muted}>Resolve pending messages in their topics before signing out.</Text>
            )}
            <Action icon="logout" destructive title={signingOut ? "Signing out…" : "Sign out device"}
              disabled={signingOut || !workspace.ready || workspace.pending.length > 0} onPress={() => void disconnect()} />
          </>
        )}
      </ScrollView>
      <View accessibilityRole="tablist" style={[layout.tabs, { borderColor: colors.edge, backgroundColor: colors.surface }]}>
        {sections.map(({ title, icon }) => {
          const active = section === title;
          const color = active ? colors.accent : colors.muted;
          return (
            <Pressable key={title} accessibilityRole="tab" accessibilityLabel={title} accessibilityState={{ selected: active }} onPress={() => showSection(title)}
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
      setError(failure instanceof Error ? failure.message : "The device session could not be restored.");
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
          <ActivityIndicator accessibilityLabel="Restoring device session" color={colors.accent} />
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
