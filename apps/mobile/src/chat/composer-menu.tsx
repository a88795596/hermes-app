import { randomUUID } from "expo-crypto";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { reasoningEfforts, type ReasoningEffort, type Skill } from "@hermes-mobile/protocol";
import type { useWorkspace } from "../sync/use-workspace";
import { motion, useReduceMotion } from "../ui/motion";
import { profileLabel } from "../ui/text";
import { Action, Icon, Notice, useTheme } from "../ui/theme";

const commands = [
  { name: "status", label: "查看会话状态" },
  { name: "model", label: "选择模型" },
  { name: "stop", label: "停止当前回复" },
  { name: "skills", label: "浏览技能" },
  { name: "new", label: "新建话题" },
  { name: "version", label: "查看 Hermes 版本" },
] as const;

export type ComposerCommand = (typeof commands)[number]["name"];

export const reasoningLabels: Record<ReasoningEffort, string> = {
  none: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高", ultra: "极限",
};

function ComposerSheet({ title, subtitle, busy, onClose, children }: {
  title: string;
  subtitle?: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const { colors, styles } = useTheme();
  const reduced = useReduceMotion();
  return (
    <Modal transparent animationType={reduced ? "none" : "fade"} onRequestClose={() => { if (!busy) onClose(); }}>
      <View style={menu.backdrop}>
        <SafeAreaView accessibilityViewIsModal edges={["bottom", "left", "right"]}
          style={[menu.sheet, { backgroundColor: colors.surface }]}>
          <Animated.View style={[menu.content, !reduced && motion.reveal]}>
            <View style={menu.header}>
              <View style={menu.grow}>
                <Text accessibilityRole="header" style={styles.heading}>{title}</Text>
                {subtitle && <Text style={styles.caption}>{subtitle}</Text>}
              </View>
              <Action title="关闭" disabled={busy} onPress={onClose} />
            </View>
            {children}
          </Animated.View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

export function ReasoningMenu({ effort, status, unavailable, onClose, onRequest }: {
  effort: ReasoningEffort | null | undefined;
  status?: "pending" | "unknown";
  unavailable?: string;
  onClose: () => void;
  onRequest: (id: string, effort: ReasoningEffort | null, signal: AbortSignal) =>
    ReturnType<ReturnType<typeof useWorkspace>["requestReasoning"]>;
}) {
  const { colors, styles } = useTheme();
  const { height } = useWindowDimensions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef<AbortController>(undefined);
  const attempt = useRef<{ id: string; effort: ReasoningEffort | null }>(undefined);
  useEffect(() => () => pending.current?.abort(), []);
  const waiting = status === "pending" && !attempt.current;

  async function select(next: ReasoningEffort | null) {
    if (unavailable || waiting || pending.current) return;
    const prior = attempt.current;
    const id = prior?.effort === next ? prior.id : randomUUID();
    attempt.current = { id, effort: next };
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const result = await onRequest(id, next, controller.signal);
      if (controller.signal.aborted) return;
      attempt.current = undefined;
      if (result.status === "ok") onClose();
      else setError(result.error);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "无法切换思考强度。");
    } finally {
      pending.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <ComposerSheet title="思考强度" subtitle="仅影响当前话题的后续回复" busy={busy} onClose={onClose}>
      {unavailable && <Text style={styles.muted}>{unavailable}</Text>}
      {waiting && <Text style={styles.muted}>Hermes 正在处理上一次切换。</Text>}
      {status === "unknown" && !error && <Notice>上一次切换尚未确认，请重新选择档位。</Notice>}
      {error && <Notice>{error}</Notice>}
      {busy && <View style={styles.row}>
        <ActivityIndicator color={colors.accent} />
        <Text accessibilityLiveRegion="polite" style={styles.muted}>正在切换思考强度…</Text>
      </View>}
      <ScrollView style={{ maxHeight: height * 0.58, flexGrow: 0 }} contentContainerStyle={menu.options}>
        {[null, ...reasoningEfforts].map((level) => (
          <Action key={level ?? "default"} title={level === null ? "跟随配置档案" : level === "none" ? "关闭思考" : reasoningLabels[level]}
            toggled={level === effort} selected={level === effort} icon={level === effort ? "check" : undefined}
            disabled={busy || waiting || !!unavailable || (status === "pending" && attempt.current?.effort !== level)}
            onPress={() => void select(level)} />
        ))}
      </ScrollView>
    </ComposerSheet>
  );
}

function Skills({ call, path, onSelect }: {
  call: ReturnType<typeof useWorkspace>["call"];
  path: string;
  onSelect: (skill: Skill) => void;
}) {
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
        <Pressable accessibilityRole="button" accessibilityLabel={item.name} accessibilityHint="带入输入框"
          onPress={() => onSelect(item)}
          style={({ pressed }) => [menu.skill, { borderBottomColor: colors.edge }, pressed && styles.faded]}>
          <View style={menu.grow}>
            <Text style={styles.heading}>{item.name}</Text>
            {!!item.category && <Text style={styles.caption}>{item.category}</Text>}
            {!!item.description && <Text style={styles.text}>{item.description}</Text>}
          </View>
          <Icon name="chevron" size={15} color={colors.accent} />
        </Pressable>
      )}
    />
  );
}

export function ComposerMenu({
  kind, id, call, profile, connected, canStop, onClose, onCommand, onSkill,
}: {
  kind: "commands" | "skills";
  id: string;
  call: ReturnType<typeof useWorkspace>["call"];
  profile?: string;
  connected: boolean;
  canStop: boolean;
  onClose: () => void;
  onCommand: (command: ComposerCommand) => void;
  onSkill: (skill: Skill) => void;
}) {
  const { colors, styles } = useTheme();
  const { height } = useWindowDimensions();

  return (
    <ComposerSheet title={kind === "skills" ? "技能" : "命令"} subtitle={kind === "skills" && profile ? profileLabel(profile) : undefined}
      onClose={onClose}>
      {kind === "skills" ? <Skills call={call} path={`/topics/${id}`} onSelect={onSkill} /> : !connected ? (
        <Text style={styles.muted}>连接 Hermes 后可执行命令。</Text>
      ) : (
        <FlatList
          data={commands.filter(({ name }) => canStop || name !== "stop")}
          style={{ maxHeight: height * 0.58, flexGrow: 0 }}
          keyExtractor={({ name }) => name}
          renderItem={({ item: { name, label } }) => (
            <Pressable accessibilityRole="button" accessibilityLabel={`/${name} ${label}`}
              onPress={() => onCommand(name)}
              style={({ pressed }) => [menu.skill, { borderBottomColor: colors.edge }, pressed && styles.faded]}>
              <Text style={styles.heading}>/{name}</Text>
              <Text style={[styles.muted, menu.grow]}>{label}</Text>
              <Icon name="chevron" size={15} color={colors.accent} />
            </Pressable>
          )}
        />
      )}
    </ComposerSheet>
  );
}

const menu = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0, 0, 0, 0.4)" },
  sheet: { width: "100%", maxWidth: 680, alignSelf: "center", borderTopLeftRadius: 18, borderTopRightRadius: 18 },
  content: { padding: 16, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  options: { gap: 6 },
  grow: { flex: 1, minWidth: 0 },
  skill: { minHeight: 44, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
});
