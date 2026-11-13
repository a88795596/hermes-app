import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Switch, Text, View, type TextInputProps } from "react-native";
import type { ManagementOperation } from "@hermes-mobile/protocol";
import { ApiError } from "../sync/api";
import { Action, Field, Icon, Notice, useTheme, type IconName } from "../ui/theme";

export type ManageCall = <T>(operation: ManagementOperation, input?: object, signal?: AbortSignal) => Promise<T>;

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
  return <>
    {error && <Notice>{error}</Notice>}
    {message && <Text accessibilityLiveRegion="polite" style={styles.text}>{message}</Text>}
  </>;
}

export function Group({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return <View style={[layout.group, { backgroundColor: colors.surface }]}>{children}</View>;
}

export function Row({ title, subtitle, value, icon, onPress, divided, disabled }: {
  title: string; subtitle?: string; value?: string; icon?: IconName; onPress?: () => void; divided?: boolean; disabled?: boolean;
}) {
  const { colors, styles } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={[title, subtitle, value].filter(Boolean).join("，")}
      accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => [styles.listItem, layout.row, divided && { borderTopColor: colors.edge, borderTopWidth: StyleSheet.hairlineWidth },
        pressed && { backgroundColor: colors.secondary }]}>
      {icon && <Icon name={icon} size={20} color={colors.accent} />}
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
    <Switch accessibilityLabel={label} disabled={disabled} value={value} onValueChange={onChange}
      trackColor={{ false: colors.edge, true: colors.accentFill }} />
  </View>;
}

export function Confirm({ title, description, onConfirm, disabled }: {
  title: string; description: string; onConfirm: () => void; disabled?: boolean;
}) {
  const { styles } = useTheme();
  const [asking, setAsking] = useState(false);
  return asking ? <View style={layout.field}>
    <Text style={styles.text}>{description}</Text>
    <View style={styles.row}>
      <Action destructive title={`确认${title}`} disabled={disabled} onPress={() => { setAsking(false); onConfirm(); }} />
      <Action title="取消" disabled={disabled} onPress={() => setAsking(false)} />
    </View>
  </View> : <Action destructive title={title} disabled={disabled} onPress={() => setAsking(true)} />;
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
        else if (result.exit_code === 0) onDone("安装已完成。");
        else onDone(result.exit_code === null ? "Hermes 无法确认安装结果，请刷新列表查看。"
          : `安装失败（退出码 ${result.exit_code}），请查看 Hermes 日志。`, true);
      } catch (failure) {
        if (!controller.signal.aborted) onDone(failure instanceof ApiError ? failure.message : "无法确认安装结果，请刷新查看。", true);
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
  group: { borderRadius: 13, overflow: "hidden" },
  row: { paddingVertical: 11, gap: 12 },
  grow: { flex: 1, minWidth: 0 },
  value: { maxWidth: "34%", textAlign: "right", flexShrink: 1 },
  field: { gap: 5 },
  multiline: { minHeight: 94, textAlignVertical: "top" },
  toggle: { minHeight: 48, justifyContent: "space-between", flexWrap: "nowrap" },
});
