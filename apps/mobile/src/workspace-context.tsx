import { useGlobalSearchParams, useRootNavigationState, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AttachmentUpload, InboxItem, TopicDetail } from "@hermes-mobile/protocol";
import { Pairing } from "./auth/pairing";
import { loadSession, saveSession, type Session } from "./auth/session";
import { enablePushNotifications, observeNotificationOpens, pushAvailable } from "./notifications";
import { pairDevice } from "./sync/api";
import { useWorkspace } from "./sync/use-workspace";
import { useTheme } from "./ui/theme";
import { useAlert } from "./ui/alerts";

export type Section = "topics" | "inbox" | "settings";

function useSignedInWorkspace(session: Session, onSignOut: () => Promise<void>) {
  const params = useGlobalSearchParams<{ page?: string; topicId?: string; newProfileId?: string }>();
  const topicId = params.page === "conversation" && typeof params.topicId === "string" ? params.topicId : null;
  const workspace = useWorkspace(session, topicId, topicId !== null && typeof params.newProfileId === "string");
  const [section, setSection] = useState<Section>("topics");
  const [profileId, setProfileId] = useState<string>();
  const [inboxProfileId, setInboxProfileId] = useState<string>();
  const [inboxItem, setInboxItem] = useState<InboxItem>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftAttachments, setDraftAttachments] = useState<Record<string, AttachmentUpload[]>>({});
  const [signingOut, setSigningOut] = useState(false);
  const [push, setPush] = useState<"idle" | "enabling" | "enabled">("idle");
  const [error, setError] = useState<string>();
  const archiveInFlight = useRef(false);
  const [archiving, setArchiving] = useState(false);
  return {
    session, onSignOut, workspace, section, setSection, profileId, setProfileId, inboxProfileId, setInboxProfileId,
    inboxItem, setInboxItem, drafts, setDrafts, draftAttachments, setDraftAttachments,
    signingOut, setSigningOut, push, setPush, error, setError, archiveInFlight, archiving, setArchiving,
  };
}

const WorkspaceContext = createContext<ReturnType<typeof useSignedInWorkspace> | null>(null);

function SignedInWorkspace({ session, onSignOut, children }: {
  session: Session; onSignOut: () => Promise<void>; children: ReactNode;
}) {
  const router = useRouter();
  const alert = useAlert();
  const rootKey = useRootNavigationState()?.key;
  const navigationInitialized = useRef(false);
  useEffect(() => {
    if (!rootKey || navigationInitialized.current) return;
    navigationInitialized.current = true;
    if (router.canDismiss()) router.dismissAll();
    router.replace("/");
  }, [rootKey, router]);
  const value = useSignedInWorkspace(session, onSignOut);
  const { workspace: { ready, call, network, sessionEnded }, setSection, setProfileId, setInboxItem, setInboxProfileId, setError, setPush } = value;

  useEffect(() => {
    if (!pushAvailable || network !== "online" || sessionEnded) return;
    let active = true;
    void enablePushNotifications(session, false).then((enabled) => {
      if (active && enabled) setPush("enabled");
    }).catch(() => { /* 设置中的启用入口可重试注册。 */ });
    return () => { active = false; };
  }, [network, session, sessionEnded, setPush]);

  useEffect(() => {
    if (!rootKey || !ready || sessionEnded) return;
    let active = true;
    let latest = 0;
    const controller = new AbortController();
    const stop = observeNotificationOpens(async (target) => {
      const intent = ++latest;
      const requestFailed = (failure: unknown) => {
        if (active && intent === latest) throw failure;
      };
      if ("topic_id" in target) {
        const detail = await call<TopicDetail>(`/topics/${target.topic_id}`, { signal: controller.signal }).catch(requestFailed);
        if (!detail || !active || intent !== latest) return;
        if (detail.topic.topic_id !== target.topic_id || !detail.messages.some((message) => message.message_id === target.message_id)) {
          throw new Error("找不到通知对应的消息。");
        }
        setSection("topics");
        setProfileId(detail.topic.profile_id);
        setError(undefined);
        if (router.canDismiss()) router.dismissAll();
        router.push({ pathname: "/[page]", params: {
          page: "conversation", topicId: target.topic_id, messageId: target.message_id,
          ...(detail.topic.archived && { archived: "1" }),
        } });
      } else {
        const items = await call<InboxItem[]>("/inbox", { signal: controller.signal }).catch(requestFailed);
        if (!items || !active || intent !== latest) return;
        const item = items.find((entry) => entry.inbox_id === target.inbox_id);
        if (!item) throw new Error("找不到通知对应的收件箱消息。");
        setSection("inbox");
        setInboxProfileId(item.profile_id);
        setInboxItem(item);
        setError(undefined);
        if (router.canDismiss()) router.dismissAll();
        router.push({ pathname: "/[page]", params: { page: "inbox-item" } });
      }
    }, (failure) => {
      if (active) alert.alert("无法打开通知", failure instanceof Error ? failure.message : "请稍后重试。");
    });
    return () => { active = false; controller.abort(); stop(); };
  }, [alert, call, rootKey, ready, router, sessionEnded, setError, setInboxItem, setInboxProfileId, setProfileId, setSection]);
  return <WorkspaceContext value={value}>{children}</WorkspaceContext>;
}

export function useWorkspaceContext() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("WorkspaceProvider is missing.");
  return context;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
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

  return <>
    <StatusBar style={dark ? "light" : "dark"} />
    {session ? (
      <SignedInWorkspace session={session} onSignOut={signOut}>{children}</SignedInWorkspace>
    ) : (
      <SafeAreaView style={styles.frame}>
        {session === undefined ? (
          <View style={styles.pairContent}>
            <ActivityIndicator accessibilityLabel="正在恢复设备会话" color={colors.accent} />
          </View>
        ) : (
          <Pairing onPair={pair} initialError={error} />
        )}
      </SafeAreaView>
    )}
  </>;
}
