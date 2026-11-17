import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View, type TextInputProps } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ManagementOperation } from "@hermes-mobile/protocol";
import { ApiError } from "../sync/api";
import { haptic } from "../ui/haptics";
import { motion, useReduceMotion } from "../ui/motion";
import { PageHeader } from "../ui/page-header";
import { Action, CloseButton, Field, Icon, Notice, useTheme, type IconName } from "../ui/theme";

export type ManageCall = <T>(operation: ManagementOperation, input?: object, signal?: AbortSignal) => Promise<T>;

export const ManagementContext = createContext<{
  label: string;
  onBack: () => void;
  onTabVisibilityChange?: (visible: boolean) => void;
}>({ label: "", onBack: () => {} });

export const useManagementContext = () => useContext(ManagementContext);

export function ManagementLayout({ header, children, hideTabs = false }: {
  header: ReactNode; children: ReactNode; hideTabs?: boolean;
}) {
  const { styles } = useTheme();
  const { onTabVisibilityChange } = useManagementContext();
  const insets = useSafeAreaInsets();
  useEffect(() => { onTabVisibilityChange?.(!hideTabs); }, [hideTabs, onTabVisibilityChange]);
  return <KeyboardAvoidingView style={styles.frame} keyboardVerticalOffset={insets.top} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <View style={layout.page}>{header}</View>
    <ScrollView contentContainerStyle={[styles.content, layout.page, layout.content]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      {children}
    </ScrollView>
  </KeyboardAvoidingView>;
}

export function ManagementHeader({ title, onBack, backLabel = "管理", trailing, backDisabled }: {
  title: string; onBack?: () => void; backLabel?: string; trailing?: ReactNode; backDisabled?: boolean;
}) {
  const { colors, styles } = useTheme();
  const context = useManagementContext();
  return <PageHeader title={title} leading={
      <Pressable accessibilityRole="button" accessibilityLabel={`返回${backLabel}`} accessibilityState={{ disabled: backDisabled }}
        disabled={backDisabled} onPress={() => { if (!backDisabled) { haptic("light"); (onBack ?? context.onBack)(); } }}
        style={({ pressed }) => [layout.back, (pressed || backDisabled) && styles.faded]}>
        <Icon name="back" size={20} color={colors.accent} />
      </Pressable>
    } trailing={trailing} />;
}

export function FormHeader({ title, onCancel, onSave, saveLabel = "保存", disabled, cancelDisabled }: {
  title: string; onCancel: () => void; onSave: () => void; saveLabel?: string; disabled?: boolean; cancelDisabled?: boolean;
}) {
  const { colors, styles } = useTheme();
  return <PageHeader title={title} leading={
    <Pressable accessibilityRole="button" accessibilityLabel="取消" accessibilityState={{ disabled: cancelDisabled }} disabled={cancelDisabled}
      onPress={() => { if (!cancelDisabled) { haptic("light"); onCancel(); } }}
      style={({ pressed }) => [layout.back, (pressed || cancelDisabled) && styles.faded]}>
      <Text style={[styles.text, { color: colors.accent }]}>取消</Text>
    </Pressable>
  } trailing={<Action title={saveLabel} primary disabled={disabled} onPress={onSave} style={layout.back} />} />;
}

export function useManagementData<T>(call: ManageCall, operation: ManagementOperation, input?: object) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const pending = useRef<AbortController>(undefined);
  const reload = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const next = await call<T>(operation, input, controller.signal);
      if (!controller.signal.aborted) setData(next);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "无法加载 Hermes 数据。");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [call, input, operation]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Changing the remote resource clears its stale loading/error state before fetching.
    void reload();
    return () => pending.current?.abort();
  }, [reload]);
  return { data, loading, error, reload };
}

export function useManagementAction() {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  async function run(task: () => Promise<string | void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      setMessage((await task()) ?? undefined);
    } catch (failure) {
      haptic("error");
      setError(failure instanceof ApiError ? failure.message : "无法确认操作结果，请先刷新再重试。");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return { busy, error, message, run };
}

export function DataState({ loading, error }: { loading: boolean; error?: string }) {
  const { colors, styles } = useTheme();
  return <>
    {loading && <View accessibilityLiveRegion="polite" style={styles.row}>
      <ActivityIndicator color={colors.accent} />
      <Text style={styles.muted}>正在从 Hermes 加载数据…</Text>
    </View>}
    {error && <Notice>{error}</Notice>}
  </>;
}

export function ActionState({ error, message }: { error?: string; message?: string }) {
  const { styles } = useTheme();
  const reduced = useReduceMotion();
  return <>
    {error && <Notice>{error}</Notice>}
    {message && <Animated.Text accessibilityLiveRegion="polite" style={[styles.text, !reduced && motion.fade]}>{message}</Animated.Text>}
  </>;
}

export function Group({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <View style={[layout.group, { borderColor: colors.edge }]}>{children}</View>;
}

export function Row({ title, subtitle, value, icon, onPress, divided, disabled }: {
  title: string; subtitle?: string; value?: string; icon?: IconName; onPress?: () => void; divided?: boolean; disabled?: boolean;
}) {
  const { colors, styles } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={[title, subtitle, value].filter(Boolean).join("，")}
      accessibilityState={{ disabled }} disabled={disabled} onPress={() => {
        if (disabled || !onPress) return;
        haptic("light");
        onPress();
      }}
      style={({ pressed }) => [styles.listItem, layout.row, divided && { borderTopColor: colors.edge, borderTopWidth: StyleSheet.hairlineWidth },
        pressed && { backgroundColor: colors.secondary }]}>
      {icon && <View style={[layout.rowIcon, { backgroundColor: colors.secondary }]}><Icon name={icon} size={23} color={colors.accent} /></View>}
      <View style={layout.grow}>
        <Text style={styles.heading}>{title}</Text>
        {!!subtitle && <Text style={styles.muted} numberOfLines={2}>{subtitle}</Text>}
      </View>
      {!!value && <Text style={[styles.caption, layout.value]}>{value}</Text>}
      <Icon name="chevron" size={13} color={colors.muted} />
    </Pressable>
  );
}

export function EditField({ label, help, multiline, style, ...props }: TextInputProps & { label: string; help?: string }) {
  const { styles } = useTheme();
  return <View style={layout.field}>
    <Text style={styles.label}>{label}</Text>
    <Field accessibilityLabel={label} multiline={multiline} autoCapitalize="none" autoCorrect={false}
      style={[multiline && layout.multiline, style]} {...props} />
    {help && <Text style={styles.caption}>{help}</Text>}
  </View>;
}

export function Toggle({ label, value, onChange, disabled }: {
  label: string; value: boolean; onChange: (value: boolean) => void; disabled?: boolean;
}) {
  const { colors, styles } = useTheme();
  return <View style={[styles.row, layout.toggle]}>
    <Text style={[styles.text, layout.grow]}>{label}</Text>
    <Switch accessibilityLabel={label} disabled={disabled} value={value} style={{ alignSelf: "center" }} onValueChange={(next) => {
      if (disabled) return;
      haptic("selection");
      onChange(next);
    }}
      trackColor={{ false: colors.edge, true: colors.accentFill }} thumbColor={Platform.OS === "ios" ? undefined : colors.surface}
      {...(Platform.OS === "web" ? { activeThumbColor: colors.surface } : {})} />
  </View>;
}

export function Confirm({ title, description, onConfirm, disabled }: {
  title: string; description: string; onConfirm: () => void; disabled?: boolean;
}) {
  const { styles } = useTheme();
  const reduced = useReduceMotion();
  const [asking, setAsking] = useState(false);
  return asking ? <Animated.View style={[layout.field, !reduced && motion.reveal]}>
    <Text style={styles.text}>{description}</Text>
    <View style={styles.row}>
      <Action destructive title={`确认${title}`} disabled={disabled} onPress={() => { setAsking(false); onConfirm(); }} />
      <CloseButton accessibilityLabel="取消" disabled={disabled} onPress={() => setAsking(false)} />
    </View>
  </Animated.View> : <Action destructive title={title} disabled={disabled} onPress={() => setAsking(true)} />;
}

export function InstallProgress({ call, name, onDone }: { call: ManageCall; name: string; onDone: (message: string, failed?: boolean) => void }) {
  const { styles } = useTheme();
  useEffect(() => {
    const controller = new AbortController();
    let next: ReturnType<typeof setTimeout> | undefined;
    async function check() {
      try {
        const result = await call<{ running: boolean; exit_code: number | null }>("action.status", { name }, controller.signal);
        if (controller.signal.aborted) return;
        if (result.running) next = setTimeout(() => void check(), 1800);
        else {
          haptic(result.exit_code === 0 ? "success" : result.exit_code === null ? "warning" : "error");
          if (result.exit_code === 0) onDone("安装已完成。");
          else onDone(result.exit_code === null ? "Hermes 无法确认安装结果，请刷新列表查看。"
            : `安装失败（退出码 ${result.exit_code}），请查看 Hermes 日志。`, true);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          haptic("error");
          onDone(failure instanceof ApiError ? failure.message : "无法确认安装结果，请刷新查看。", true);
        }
      }
    }
    void check();
    return () => { controller.abort(); clearTimeout(next); };
  }, [call, name, onDone]);
  return <Text accessibilityLiveRegion="polite" style={styles.muted}>正在 Hermes 主机上安装…</Text>;
}

export const entries = (value: string) => value.split(/[\n,]/u).map((item) => item.trim()).filter(Boolean);
export const mono = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

const layout = StyleSheet.create({
  page: { width: "100%", maxWidth: 680, alignSelf: "center" },
  content: { paddingTop: 8 },
  back: { minWidth: 48, minHeight: 48, alignItems: "center", justifyContent: "center" },
  group: { borderBottomWidth: StyleSheet.hairlineWidth },
  row: { minHeight: 72, paddingVertical: 16, gap: 14 },
  rowIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  grow: { flex: 1, minWidth: 0 },
  value: { maxWidth: "34%", textAlign: "right", flexShrink: 1 },
  field: { gap: 10 },
  multiline: { minHeight: 120, textAlignVertical: "top" },
  toggle: { minHeight: 56, justifyContent: "space-between", flexWrap: "nowrap" },
});
