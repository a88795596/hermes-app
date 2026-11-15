import { randomUUID } from "expo-crypto";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { reasoningEfforts, type ReasoningEffort, type Skill } from "@hermes-mobile/protocol";
import type { useWorkspace } from "../sync/use-workspace";
import { haptic } from "../ui/haptics";
import { motion, useReduceMotion } from "../ui/motion";
import { profileLabel } from "../ui/text";
import { Action, CloseButton, Icon, Notice, useTheme, type IconName } from "../ui/theme";

const commands = [
  { name: "status", label: "查看会话状态", icon: "chat" },
  { name: "model", label: "选择模型", icon: "model" },
  { name: "stop", label: "停止当前回复", icon: "stop" },
  { name: "skills", label: "浏览技能", icon: "skill" },
  { name: "new", label: "新建会话", icon: "compose" },
  { name: "version", label: "查看 Hermes 版本", icon: "activity" },
] as const satisfies readonly { name: string; label: string; icon: IconName }[];

export type ComposerCommand = (typeof commands)[number]["name"];

export const reasoningLabels: Record<ReasoningEffort, string> = {
  none: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高", ultra: "极限",
};

export function ComposerSheet({ title, subtitle, busy, onClose, back, closeLabel, children }: {
  title: string;
  subtitle?: string;
  busy?: boolean;
  onClose: () => void;
  back?: ReactNode;
  closeLabel?: string;
  children: ReactNode;
}) {
  const { colors, styles } = useTheme();
  const reduced = useReduceMotion();
  const close = <CloseButton disabled={busy} accessibilityLabel={closeLabel} onPress={onClose} />;
  return (
    <Modal transparent animationType={reduced ? "none" : "fade"} onRequestClose={() => { if (!busy) onClose(); }}>
      <KeyboardAvoidingView style={menu.backdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <SafeAreaView accessibilityViewIsModal importantForAccessibility="yes" edges={["bottom", "left", "right"]}
          style={[menu.sheet, { backgroundColor: colors.background }]}>
          <Animated.View style={[menu.content, !reduced && motion.reveal]}>
            <View style={[menu.handle, { backgroundColor: colors.edge }]} />
            <View>
              {back && <View style={menu.header}>{back}{close}</View>}
              <View style={menu.header}>
                <View style={menu.grow}>
                  <Text accessibilityRole="header" style={[styles.heading, menu.sheetTitle]}>{title}</Text>
                  {subtitle && <Text style={styles.caption}>{subtitle}</Text>}
                </View>
                {!back && close}
              </View>
            </View>
            {children}
          </Animated.View>
        </SafeAreaView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function PickerRow({ title, leading, trailing, filled, selected, toggled, disabled, feedback, onPress }: {
  title: string;
  leading?: ReactNode;
  trailing?: IconName;
  filled?: boolean;
  selected: boolean;
  toggled?: boolean;
  disabled: boolean;
  feedback?: false;
  onPress: () => void;
}) {
  const { colors, styles } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled }} aria-pressed={toggled}
      disabled={disabled} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onPress={() => { if (!disabled) { if (feedback !== false) haptic("selection"); onPress(); } }}
      style={({ pressed }) => [menu.row, menu.option, {
        backgroundColor: selected ? colors.tint : filled ? colors.field : "transparent",
        borderBottomColor: selected || filled ? "transparent" : colors.edge,
      }, (selected || filled) && menu.roundedOption, focused && styles.focused, (pressed || disabled) && styles.faded]}>
      {leading}
      <Text style={[styles.text, menu.grow, selected && menu.emphasis]}>{title}</Text>
      {trailing && <Icon name={trailing} size={16} color={colors.accent} />}
    </Pressable>
  );
}

export function AttachmentMenu({ busy, onClose, onPick }: {
  busy: boolean;
  onClose: () => void;
  onPick: (kind: "image" | "file") => void;
}) {
  const { colors, styles } = useTheme();
  return (
    <ComposerSheet title="添加附件" busy={busy} onClose={onClose}>
      <View style={menu.attachments}>
        {([["image", "图片", "photo"], ["file", "文件", "logs"]] as const).map(([kind, title, icon]) => (
          <Pressable key={kind} accessibilityRole="button" accessibilityState={{ disabled: busy }} disabled={busy}
            onPress={() => { haptic("light"); onPick(kind); }}
            style={({ pressed }) => [styles.button, menu.attachmentChoice, { backgroundColor: colors.field }, (pressed || busy) && styles.faded]}>
            <Icon name={icon} size={32} color={colors.accent} />
            <Text style={[styles.heading, styles.center]}>{title}</Text>
          </Pressable>
        ))}
      </View>
    </ComposerSheet>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [attemptedEffort, setAttemptedEffort] = useState<ReasoningEffort | null>();
  const pending = useRef<AbortController>(undefined);
  const attempt = useRef<{ id: string; effort: ReasoningEffort | null }>(undefined);
  useEffect(() => () => pending.current?.abort(), []);
  const waiting = status === "pending" && attemptedEffort === undefined;

  async function select(next: ReasoningEffort | null) {
    const prior = attempt.current;
    if (unavailable || pending.current || (status === "pending" && prior?.effort !== next)) return;
    const id = prior?.effort === next ? prior.id : randomUUID();
    attempt.current = { id, effort: next };
    setAttemptedEffort(next);
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const result = await onRequest(id, next, controller.signal);
      if (controller.signal.aborted) return;
      attempt.current = undefined;
      setAttemptedEffort(undefined);
      if (result.status === "ok") {
        if (next !== effort || status) haptic("success");
        onClose();
      } else {
        haptic(result.status === "unknown" ? "warning" : "error");
        setError(result.error);
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        haptic("error");
        setError(failure instanceof Error ? failure.message : "无法切换思考强度。");
      }
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
      <ScrollView style={menu.list}>
        {[null, ...reasoningEfforts].map((level) => (
          <PickerRow key={level ?? "default"} title={level === null ? "跟随配置档案" : level === "none" ? "关闭思考" : reasoningLabels[level]}
            toggled={level === effort} selected={level === effort}
            leading={level === effort && <Icon name="check" size={17} color={colors.accent} />}
            feedback={level === effort && !status ? false : undefined}
            disabled={busy || !!unavailable || (status === "pending" && attemptedEffort !== level)}
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
      style={menu.list}
      keyExtractor={(item, index) => `${item.name}:${index}`}
      ListEmptyComponent={<Text style={styles.muted}>此配置档案暂无可用技能。</Text>}
      renderItem={({ item }) => (
        <Pressable accessibilityRole="button" accessibilityLabel={item.name} accessibilityHint="带入输入框"
          onPress={() => { haptic("selection"); onSelect(item); }}
          style={({ pressed }) => [menu.row, { borderBottomColor: colors.edge }, pressed && styles.faded]}>
          <View style={[menu.skillIcon, { backgroundColor: colors.tint }]}>
            <Icon name="skill" size={18} color={colors.accent} />
          </View>
          <View style={menu.grow}>
            <Text style={styles.heading}>{item.name}</Text>
            {!!item.category && <Text style={styles.caption}>{item.category}</Text>}
            {!!item.description && <Text style={[styles.caption, { color: colors.foreground }]}>{item.description}</Text>}
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

  return (
    <ComposerSheet title={kind === "skills" ? "技能" : "命令"} subtitle={kind === "skills" && profile ? profileLabel(profile) : undefined}
      onClose={onClose}>
      {kind === "commands" && !connected && <Text style={styles.muted}>连接 Hermes 后可执行其他命令。</Text>}
      {kind === "skills" ? <Skills call={call} path={`/topics/${id}`} onSelect={onSkill} /> : (
        <FlatList
          data={commands.filter(({ name }) => name === "new" || (connected && (canStop || name !== "stop")))}
          style={menu.list}
          keyExtractor={({ name }) => name}
          renderItem={({ item: { name, label, icon } }) => (
            <Pressable accessibilityRole="button" accessibilityLabel={`/${name} ${label}`}
              onPress={() => { haptic(name === "stop" ? "warning" : "light"); onCommand(name); }}
              style={({ pressed }) => [menu.row, { borderBottomColor: colors.edge }, pressed && styles.faded]}>
              <Icon name={icon} size={21} color={colors.accent} />
              <View style={[menu.grow, menu.commandText]}>
                <Text style={styles.heading}>/{name}</Text>
                <Text style={styles.caption}>{label}</Text>
              </View>
              <Icon name="chevron" size={15} color={colors.accent} />
            </Pressable>
          )}
        />
      )}
    </ComposerSheet>
  );
}

const menu = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(53, 40, 32, 0.27)" },
  sheet: { width: "100%", maxWidth: 680, maxHeight: "92%", flexShrink: 1, alignSelf: "center",
    borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  content: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 16, gap: 12, flexShrink: 1 },
  handle: { alignSelf: "center", width: 44, height: 4, borderRadius: 2 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44, gap: 8 },
  sheetTitle: { fontSize: 22, lineHeight: 28 },
  list: { flexGrow: 0, flexShrink: 1 },
  grow: { flex: 1, minWidth: 0 },
  row: { minHeight: 56, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  option: { paddingHorizontal: 12, borderWidth: 1, borderColor: "transparent" },
  roundedOption: { borderRadius: 11 },
  emphasis: { fontWeight: "600" },
  skillIcon: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  commandText: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 12, rowGap: 2 },
  attachments: { flexDirection: "row", gap: 12 },
  attachmentChoice: { flex: 1, flexDirection: "column", justifyContent: "center", minHeight: 108, padding: 12, gap: 8, borderRadius: 16 },
});
