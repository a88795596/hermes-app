import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type AlertButton, type AlertOptions } from "react-native";
import { useReduceMotion } from "./motion";
import { OverlayModal, OverlayNotices } from "./overlay";
import { Action, useTheme } from "./theme";

type AlertEntry = { title: string; message?: string; buttons: AlertButton[]; options?: AlertOptions };
type Alerts = { alert: (title: string, message?: string, buttons?: AlertButton[], options?: AlertOptions) => void };
const AlertContext = createContext<Alerts | null>(null);

export function AlertProvider({ children }: { children: ReactNode }) {
  const { colors, styles } = useTheme();
  const reduced = useReduceMotion();
  const [queue, setQueue] = useState<AlertEntry[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);
  const register = useCallback((id: string) => {
    setHosts((current) => current.includes(id) ? current : [...current, id]);
    return () => setHosts((current) => current.filter((host) => host !== id));
  }, []);
  const completed = useRef(new WeakSet<AlertEntry>());
  const alert = useCallback<Alerts["alert"]>((title, message, buttons, options) => {
    setQueue((current) => [...current, { title, message, buttons: buttons?.length ? buttons : [{ text: "确定" }], options }]);
  }, []);
  const value = useMemo(() => ({ alert }), [alert]);
  const current = queue[0];

  function finish(entry: AlertEntry, callback?: () => void) {
    if (completed.current.has(entry)) return;
    completed.current.add(entry);
    setQueue((items) => items.filter((item) => item !== entry));
    callback?.();
  }

  function dismiss() {
    if (current?.options?.cancelable) finish(current, current.options.onDismiss);
  }

  function renderDialog(host?: string) {
    if (!current || host !== hosts.at(-1)) return null;
    return <OverlayModal notice animationType={reduced ? "none" : "fade"} onRequestClose={dismiss}
      supportedOrientations={["portrait", "landscape-left", "landscape-right"]}>
      <View style={layout.window}>
        {current.options?.cancelable && <Pressable style={StyleSheet.absoluteFill} accessibilityRole="button"
          accessibilityLabel="关闭提示" onPress={dismiss} />}
        <View accessibilityViewIsModal importantForAccessibility="yes" role="alertdialog" accessibilityLabel={current.title}
          style={[layout.dialog, { backgroundColor: colors.surface, borderColor: colors.edge }]}>
          <ScrollView contentContainerStyle={layout.content}>
            <Text accessibilityRole="header" style={styles.heading}>{current.title}</Text>
            {!!current.message && <Text selectable style={styles.text}>{current.message}</Text>}
          </ScrollView>
          <View style={layout.actions}>
            {current.buttons.map((button, index) => <Action key={index} title={button.text ?? "确定"}
              primary={button.style !== "cancel" && button.style !== "destructive"}
              destructive={button.style === "destructive"} style={layout.action}
              onPress={() => finish(current, () => button.onPress?.())} />)}
          </View>
        </View>
      </View>
    </OverlayModal>;
  }

  return <AlertContext value={value}>
    <OverlayNotices value={{ register, render: renderDialog }}>{children}{renderDialog()}</OverlayNotices>
  </AlertContext>;
}

export function useAlert() {
  const alerts = useContext(AlertContext);
  if (!alerts) throw new Error("AlertProvider is missing.");
  return alerts;
}

const layout = StyleSheet.create({
  window: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  dialog: { width: "100%", maxWidth: 400, maxHeight: "85%", borderWidth: StyleSheet.hairlineWidth, borderRadius: 20, overflow: "hidden" },
  content: { padding: 24, gap: 14 },
  actions: { flexDirection: "row", flexWrap: "wrap", padding: 16, paddingTop: 0, gap: 10 },
  action: { flexGrow: 1, minWidth: 90 },
});
