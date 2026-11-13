import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Modal, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { SessionStatus, Skill } from "@hermes-mobile/protocol";
import type { useWorkspace } from "../sync/use-workspace";
import { profileLabel } from "../ui/text";
import { Action, Notice, useTheme } from "../ui/theme";

const activityLabel: Record<SessionStatus["activity"], string> = {
  idle: "空闲",
  running: "运行中",
  queued: "排队中",
  unknown: "执行状态待确认",
};

function Skills({ call, path }: { call: ReturnType<typeof useWorkspace>["call"]; path: string }) {
  const { colors, styles } = useTheme();
  const { height } = useWindowDimensions();
  const [attempt, setAttempt] = useState(0);
  const [skills, setSkills] = useState<Skill[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const request = new AbortController();
    void call<Skill[]>(path + "/skills", { signal: request.signal }).then((items) => {
      if (!request.signal.aborted) setSkills(items);
    }, (failure: unknown) => {
      if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "无法加载技能。");
    });
    return () => request.abort();
  }, [attempt, call, path]);

  if (error) {
    return (
      <>
        <Notice>{error}</Notice>
        <View style={styles.row}>
          <Action title="重试" onPress={() => { setError(undefined); setAttempt((value) => value + 1); }} />
        </View>
      </>
    );
  }
  if (!skills) return <ActivityIndicator accessibilityLabel="正在加载技能" color={colors.accent} />;
  return (
    <FlatList
      data={skills}
      style={{ maxHeight: height * 0.58, flexGrow: 0 }}
      keyExtractor={(item, index) => `${item.name}:${index}`}
      ListEmptyComponent={<Text style={styles.muted}>此配置档案暂无可用技能。</Text>}
      renderItem={({ item }) => (
        <View style={[menu.skill, { borderBottomColor: colors.edge }]}>
          <Text selectable style={styles.heading}>{item.name}</Text>
          {!!item.category && <Text style={styles.caption}>{item.category}</Text>}
          {!!item.description && <Text selectable style={styles.text}>{item.description}</Text>}
        </View>
      )}
    />
  );
}

export function ComposerMenu({
  kind, id, call, profile, canStop, onClose, onStop,
}: {
  kind: "commands" | "skills";
  id: string;
  call: ReturnType<typeof useWorkspace>["call"];
  profile?: string;
  canStop: boolean;
  onClose: () => void;
  onStop: () => void;
}) {
  const { colors, styles } = useTheme();
  const [status, setStatus] = useState<SessionStatus>();
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [error, setError] = useState<string>();
  const path = `/topics/${id}`;

  async function showStatus() {
    setLoadingStatus(true);
    setStatus(undefined);
    setError(undefined);
    try {
      setStatus(await call<SessionStatus>(path + "/status"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法获取会话状态。");
    } finally {
      setLoadingStatus(false);
    }
  }

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={menu.backdrop}>
        <SafeAreaView accessibilityViewIsModal edges={["bottom", "left", "right"]}
          style={[menu.sheet, { backgroundColor: colors.surface }]}>
          <View style={menu.content}>
            <View style={menu.header}>
              <View style={menu.grow}>
                <Text accessibilityRole="header" style={styles.heading}>{kind === "skills" ? "技能" : "命令"}</Text>
                {kind === "skills" && profile && <Text style={styles.caption}>{profileLabel(profile)}</Text>}
              </View>
              <Action title="关闭" onPress={onClose} />
            </View>
            {kind === "skills" ? <Skills call={call} path={path} /> : (
              <>
                <View style={styles.row}>
                  <Action title="/status" disabled={loadingStatus} onPress={() => void showStatus()} />
                  <Action title="/stop" disabled={!canStop} onPress={onStop} />
                </View>
                {loadingStatus && <ActivityIndicator accessibilityLabel="正在获取会话状态" color={colors.accent} />}
                {error && <Notice>{error}</Notice>}
                {status && (
                  <Text accessibilityLiveRegion="polite" style={styles.text}>
                    {[activityLabel[status.activity], status.model,
                      status.message_count === undefined ? undefined : `${status.message_count} 条消息`,
                    ].filter(Boolean).join(" · ")}
                  </Text>
                )}
              </>
            )}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const menu = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0, 0, 0, 0.4)" },
  sheet: { width: "100%", maxWidth: 680, alignSelf: "center", borderTopLeftRadius: 18, borderTopRightRadius: 18 },
  content: { padding: 16, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  grow: { flex: 1, minWidth: 0 },
  skill: { paddingVertical: 9, gap: 3, borderBottomWidth: StyleSheet.hairlineWidth },
});
