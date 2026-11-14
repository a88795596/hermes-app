import { useGlobalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { AttachmentUpload, InboxItem } from "@hermes-mobile/protocol";
import { Pairing } from "./auth/pairing";
import { loadSession, saveSession, type Session } from "./auth/session";
import { pairDevice } from "./sync/api";
import { useWorkspace } from "./sync/use-workspace";
import { useTheme } from "./ui/theme";

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
  const [showProcess, setShowProcess] = useState<Record<string, boolean>>({});
  const [signingOut, setSigningOut] = useState(false);
  const [push, setPush] = useState<"idle" | "enabling" | "enabled">("idle");
  const [error, setError] = useState<string>();
  const archiveInFlight = useRef(false);
  const [archiving, setArchiving] = useState(false);
  return {
    session, onSignOut, workspace, section, setSection, profileId, setProfileId, inboxProfileId, setInboxProfileId,
    inboxItem, setInboxItem, drafts, setDrafts, draftAttachments, setDraftAttachments, showProcess, setShowProcess,
    signingOut, setSigningOut, push, setPush, error, setError, archiveInFlight, archiving, setArchiving,
  };
}

const WorkspaceContext = createContext<ReturnType<typeof useSignedInWorkspace> | null>(null);

function SignedInWorkspace({ session, onSignOut, children }: {
  session: Session; onSignOut: () => Promise<void>; children: ReactNode;
}) {
  const router = useRouter();
  useEffect(() => {
    if (router.canDismiss()) router.dismissAll();
    router.replace("/");
  }, [router]);
  const value = useSignedInWorkspace(session, onSignOut);
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
