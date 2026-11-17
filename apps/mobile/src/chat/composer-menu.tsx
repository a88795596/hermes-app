import { randomUUID } from "expo-crypto";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { reasoningEfforts, type NativeCommand, type ReasoningEffort, type Skill } from "@hermes-mobile/protocol";
import type { useWorkspace } from "../sync/use-workspace";
import { haptic } from "../ui/haptics";
import { motion, useReduceMotion } from "../ui/motion";
import { OverlayModal } from "../ui/overlay";
import { PageHeader } from "../ui/page-header";
import { profileLabel } from "../ui/text";
import { Action, CloseButton, Field, Icon, Notice, useTheme, type IconName } from "../ui/theme";

const commandLabels: Record<string, string> = {
  help: "查看帮助", commands: "浏览原生命令", status: "查看会话状态", version: "查看 Hermes 版本",
  model: "选择模型", reasoning: "调整思考强度", stop: "停止执行", restart: "重启 Hermes 网关",
  new: "新建会话", sessions: "浏览历史会话", resume: "恢复会话", title: "修改会话标题",
  retry: "重试上一条消息", undo: "回退会话", branch: "创建会话分支", compress: "压缩上下文",
  context: "查看上下文", usage: "查看用量", insights: "查看使用统计", diff: "查看代码改动",
  queue: "排队执行", steer: "补充指令", background: "后台执行", agents: "查看运行任务",
  goal: "管理持续目标", subgoal: "管理子目标", rollback: "恢复文件检查点", moa: "多模型执行",
  fast: "切换快速模式", personality: "选择人格", approve: "批准操作", deny: "拒绝操作",
  approvals: "设置审批模式", yolo: "切换免审批模式", skills: "管理技能", bundles: "查看技能组合",
  "reload-skills": "重新加载技能", "reload-mcp": "重新加载 MCP", memory: "管理记忆审批",
  learn: "学习技能", cron: "管理定时任务", profile: "查看配置档案", whoami: "查看命令权限",
  update: "更新 Hermes", platform: "管理消息平台", sethome: "设置默认投递频道", voice: "设置语音模式",
  suggestions: "查看自动化建议", blueprint: "使用自动化模板", kanban: "管理协作看板",
};

function commandLabel(command: NativeCommand) {
  return Object.hasOwn(commandLabels, command.name) ? commandLabels[command.name] : command.description;
}

export const reasoningLabels: Record<ReasoningEffort, string> = {
  none: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高", ultra: "极限",
};

export function ComposerSheet({ title, subtitle, busy, onClose, back, closeLabel, embedded, children }: {
  title: string;
  subtitle?: string;
  busy?: boolean;
  onClose: () => void;
  back?: ReactNode;
  closeLabel?: string;
  embedded?: boolean;
  children: ReactNode;
}) {
  const { colors, styles } = useTheme();
  const reduced = useReduceMotion();
  const close = <CloseButton disabled={busy} accessibilityLabel={closeLabel} onPress={onClose} />;
  const content = <Animated.View style={[menu.content, embedded && menu.embedded, !reduced && motion.reveal]}>
    {!embedded && <View style={[menu.handle, { backgroundColor: colors.edge }]} />}
    <View style={menu.header}><PageHeader title={title} leading={back} trailing={close} /></View>
    {subtitle && <Text style={styles.caption}>{subtitle}</Text>}
    {children}
  </Animated.View>;
  if (embedded) return content;
  return (
    <OverlayModal animationType={reduced ? "none" : "fade"} onRequestClose={() => { if (!busy) onClose(); }}>
      <KeyboardAvoidingView style={menu.backdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <SafeAreaView accessibilityViewIsModal importantForAccessibility="yes" edges={["bottom", "left", "right"]}
          style={[menu.sheet, { backgroundColor: colors.background }]}>
          {content}
        </SafeAreaView>
      </KeyboardAvoidingView>
    </OverlayModal>
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

export function ReasoningMenu({ effort, status, unavailable, embedded, onClose, onRequest, onBusyChange }: {
  effort: ReasoningEffort | null | undefined;
  status?: "pending" | "unknown";
  unavailable?: string;
  embedded?: boolean;
  onClose: () => void;
  onBusyChange?: (busy: boolean) => void;
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
    onBusyChange?.(true);
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
      onBusyChange?.(false);
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <ComposerSheet title="思考强度" subtitle="仅影响当前话题的后续回复" busy={busy} embedded={embedded}
      closeLabel={embedded ? "返回会话设置" : undefined} onClose={onClose}>
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
  const [search, setSearch] = useState("");
  const query = search.trim();
  const pattern = query ? new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i") : undefined;

  function highlight(text: string) {
    return pattern ? text.split(pattern).map((part, index) => index % 2
      ? <Text key={index} style={{ backgroundColor: colors.tint, color: colors.accent, fontWeight: "700" }}>{part}</Text>
      : part) : text;
  }

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
    <>
      <FlatList
        data={skills.filter((skill) => !pattern || pattern.test(skill.name) || pattern.test(skill.description ?? ""))}
        style={menu.list}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item, index) => `${item.name}:${index}`}
        ListEmptyComponent={<Text style={styles.muted}>{query ? "暂无匹配的技能" : "此配置档案暂无可用技能。"}</Text>}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" accessibilityLabel={item.name} accessibilityHint="带入输入框"
            onPress={() => { haptic("selection"); onSelect(item); }}
            style={({ pressed }) => [menu.row, { borderBottomColor: colors.edge }, pressed && styles.faded]}>
            <View style={[menu.skillIcon, { backgroundColor: colors.tint }]}>
              <Icon name="skill" size={18} color={colors.accent} />
            </View>
            <View style={menu.grow}>
              <Text style={styles.heading}>{highlight(item.name)}</Text>
              {!!item.category && <Text style={styles.caption}>{item.category}</Text>}
              {!!item.description && <Text style={[styles.caption, { color: colors.foreground }]}>{highlight(item.description)}</Text>}
            </View>
            <Icon name="chevron" size={15} color={colors.accent} />
          </Pressable>
        )}
      />
      <Field accessibilityLabel="搜索技能名称或描述" placeholder="搜索技能名称或描述"
        value={search} onChangeText={setSearch} autoCapitalize="none" autoCorrect={false} returnKeyType="search" />
    </>
  );
}

function Commands({ call, path, connected, reasoningSupported, onClose, onCommand }: {
  call: ReturnType<typeof useWorkspace>["call"];
  path: string;
  connected: boolean;
  reasoningSupported: boolean;
  onClose: () => void;
  onCommand: (command: string) => void;
}) {
  const { colors, styles } = useTheme();
  const [attempt, setAttempt] = useState(0);
  const [commands, setCommands] = useState<NativeCommand[]>();
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<NativeCommand>();
  const [args, setArgs] = useState("");
  const [fastGlobal, setFastGlobal] = useState(false);
  const query = search.trim().toLowerCase();

  useEffect(() => {
    if (!connected) return;
    const request = new AbortController();
    void call<NativeCommand[]>(path + "/commands", { signal: request.signal }).then((items) => {
      if (!request.signal.aborted) setCommands(items);
    }, (failure: unknown) => {
      if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "无法加载原生命令目录。");
    });
    return () => request.abort();
  }, [attempt, call, connected, path]);

  function back() {
    setSelected(undefined);
    setArgs("");
    setFastGlobal(false);
  }

  const isFast = selected?.name === "fast";
  const preview = selected ? `/${selected.name}${args ? ` ${args}` : ""}${isFast && fastGlobal && args !== "status" ? " --global" : ""}` : "";
  const canExecute = isFast ? selected.supported && !!args : selected?.supported || !args.trim();
  const content = !connected ? <Text style={styles.muted}>连接 Hermes 后可读取原生命令目录。</Text>
    : error ? <>
    <Notice>{error}</Notice>
    <Action title="重试" onPress={() => { setError(undefined); setAttempt((value) => value + 1); }} />
  </> : !commands ? <ActivityIndicator accessibilityLabel="正在加载原生命令目录" color={colors.accent} />
    : selected ? <>
    {isFast ? <ScrollView style={menu.list} contentContainerStyle={menu.parameters} keyboardShouldPersistTaps="handled">
      {[["fast", "快速"], ["normal", "普通"], ["status", "查看状态"]].map(([value, title]) =>
        <PickerRow key={value} title={title} selected={args === value} disabled={false}
          onPress={() => { setArgs(value); if (value === "status") setFastGlobal(false); }} />)}
      {!!args && args !== "status" && <>
        <Text style={styles.caption}>作用范围</Text>
        <PickerRow title="当前会话" selected={!fastGlobal} disabled={false} onPress={() => setFastGlobal(false)} />
        <PickerRow title="保存为默认" selected={fastGlobal} disabled={false} onPress={() => setFastGlobal(true)} />
      </>}
    </ScrollView> : <>
    <Text style={styles.caption}>/{selected.name} {selected.args_hint}</Text>
    {!!selected.subcommands?.length && <ScrollView style={menu.argumentOptions} keyboardShouldPersistTaps="handled">
      {selected.subcommands.map((option) => <PickerRow key={option} title={option} selected={args === option}
        disabled={false} onPress={() => setArgs(option)} />)}
    </ScrollView>}
    <Field accessibilityLabel={`/${selected.name} 参数`} placeholder="参数（可留空）" value={args} onChangeText={setArgs}
      autoCapitalize="none" autoCorrect={false} returnKeyType="done" />
    </>}
    <Text style={styles.caption}>执行预览</Text>
    <Text testID="command-preview" accessibilityLabel={`完整命令：${preview}`} selectable style={styles.text}>{preview}</Text>
    {!canExecute && !isFast && <Notice>{selected.unavailable_reason || "当前会话暂不支持此命令的参数。"}</Notice>}
    <View style={styles.row}>
      <Action title="取消" onPress={back} />
      <Action title="执行" primary disabled={!canExecute} onPress={() => {
        if (!canExecute) return;
        haptic("light");
        onCommand(preview);
      }} />
    </View>
  </> : <>
    <FlatList
      data={commands.filter((command) => [command.name, command.description, commandLabel(command), ...command.aliases]
        .some((value) => value.toLowerCase().includes(query)))}
      style={menu.list} keyboardShouldPersistTaps="handled" keyExtractor={({ name }) => name}
      ListEmptyComponent={<Text style={styles.muted}>{query ? "暂无匹配的命令" : "Hermes 未返回内置命令。"}</Text>}
      renderItem={({ item }) => {
        const picker = item.name === "model" || (item.name === "reasoning" && reasoningSupported);
        const available = item.supported || picker || item.name === "stop" || item.name === "skills";
        const label = commandLabel(item);
        const reason = item.unavailable_reason || "当前会话暂不支持此原生命令。";
        return <Pressable accessibilityRole="button" accessibilityLabel={`/${item.name} ${label}`}
          accessibilityHint={!available ? reason : undefined}
          accessibilityState={{ disabled: !available }} disabled={!available}
          onPress={() => {
            if (!available) return;
            haptic("light");
            if ((item.name === "fast" || item.args_hint || item.subcommands?.length) && !picker) {
              setArgs(""); setFastGlobal(false); setSelected(item);
            }
            else onCommand(`/${item.name}`);
          }}
          style={({ pressed }) => [menu.row, { borderBottomColor: colors.edge }, (pressed || !available) && styles.faded]}>
          <Icon name="command" size={21} color={available ? colors.accent : colors.muted} />
          <View style={menu.grow}>
            <View style={menu.commandText}>
              <Text style={styles.heading}>/{item.name}</Text>
              <Text style={styles.caption}>{label}</Text>
            </View>
            {!available && <Text style={styles.caption}>{reason}</Text>}
          </View>
          {available ? <Icon name="chevron" size={15} color={colors.accent} /> : <Text style={styles.caption}>不可用</Text>}
        </Pressable>;
      }}
    />
    <Field accessibilityLabel="搜索命令、别名或描述" placeholder="搜索命令、别名或描述" value={search} onChangeText={setSearch}
      autoCapitalize="none" autoCorrect={false} returnKeyType="search" />
  </>;
  return <ComposerSheet title={selected ? `/${selected.name}` : "命令"} onClose={onClose}
    back={selected && <Pressable accessibilityRole="button" accessibilityLabel="返回命令目录"
      onPress={() => { haptic("light"); back(); }} style={({ pressed }) => [menu.back, pressed && styles.faded]}>
      <Icon name="back" size={20} color={colors.accent} />
    </Pressable>}>
    {content}
  </ComposerSheet>;
}

export function ComposerMenu({
  kind, id, call, profile, connected, reasoningSupported, onClose, onCommand, onSkill,
}: {
  kind: "commands" | "skills";
  id: string;
  call: ReturnType<typeof useWorkspace>["call"];
  profile?: string;
  connected: boolean;
  reasoningSupported: boolean;
  onClose: () => void;
  onCommand: (command: string) => void;
  onSkill: (skill: Skill) => void;
}) {
  if (kind === "commands") return <Commands key={`${id}:${connected}`} call={call} path={`/topics/${id}`} connected={connected}
    reasoningSupported={reasoningSupported} onClose={onClose} onCommand={onCommand} />;
  return (
    <ComposerSheet title="技能" subtitle={profile ? profileLabel(profile) : undefined} onClose={onClose}>
      <Skills call={call} path={`/topics/${id}`} onSelect={onSkill} />
    </ComposerSheet>
  );
}

const menu = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end" },
  sheet: { width: "100%", maxWidth: 680, maxHeight: "92%", flexShrink: 1, alignSelf: "center",
    borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  content: { paddingHorizontal: 24, paddingTop: 12, paddingBottom: 16, gap: 12, flexShrink: 1 },
  embedded: { flex: 1, paddingTop: 0 },
  handle: { alignSelf: "center", width: 44, height: 4, borderRadius: 2 },
  header: { marginHorizontal: -24, marginBottom: -6 },
  back: { width: 48, minHeight: 48, alignItems: "center", justifyContent: "center" },
  list: { flexGrow: 0, flexShrink: 1 },
  parameters: { gap: 12 },
  argumentOptions: { maxHeight: 240, flexShrink: 1 },
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
