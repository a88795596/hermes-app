import { SymbolView, type AndroidSymbol, type SFSymbol } from "expo-symbols";
import { useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View, useColorScheme, type TextInputProps } from "react-native";
import { errorLabel } from "./text";

const light = {
  background: "#f2f2f7",
  surface: "#ffffff",
  edge: "#d6d6df",
  foreground: "#1c1c1e",
  muted: "#62626e",
  accent: "#005fcf",
  accentFill: "#0066d6",
  onAccent: "#ffffff",
  tint: "#e8f1ff",
  secondary: "#e9e9ef",
  field: "#ececf2",
  success: "#237646",
  error: "#b4232a",
  errorFill: "#fbe8ea",
};

const night: typeof light = {
  background: "#111114",
  surface: "#1c1c21",
  edge: "#383840",
  foreground: "#f5f5f7",
  muted: "#b2b2be",
  accent: "#74b5ff",
  accentFill: "#0066d6",
  onAccent: "#ffffff",
  tint: "#202f48",
  secondary: "#282830",
  field: "#26262d",
  success: "#6cdda0",
  error: "#ff8a90",
  errorFill: "#392328",
};

const symbols = {
  topics: ["bubble.left.and.bubble.right", "forum"],
  inbox: ["tray", "inbox"],
  archive: ["archivebox", "archive"],
  settings: ["gearshape", "settings"],
  manage: ["slider.horizontal.3", "tune"],
  schedule: ["calendar", "calendar_month"],
  model: ["cpu", "memory"],
  logs: ["doc.text", "description"],
  skill: ["square.stack", "widgets"],
  mcp: ["puzzlepiece", "extension"],
  compose: ["square.and.pencil", "edit_square"],
  back: ["chevron.left", "chevron_left"],
  chevron: ["chevron.right", "chevron_right"],
  down: ["chevron.down", "expand_more"],
  lock: ["lock", "lock"],
  server: ["server.rack", "dns"],
  activity: ["waveform.path", "monitor_heart"],
  refresh: ["arrow.clockwise", "refresh"],
  logout: ["rectangle.portrait.and.arrow.right", "logout"],
  check: ["checkmark", "check"],
  stop: ["stop.fill", "stop"],
  chat: ["bubble.left", "chat_bubble"],
  send: ["arrow.up", "arrow_upward"],
  link: ["link", "link"],
  close: ["xmark", "close"],
  bell: ["bell", "notifications"],
} as const satisfies Record<string, readonly [SFSymbol, AndroidSymbol]>;

export type IconName = keyof typeof symbols;

export function Icon({ name, size = 22, color }: { name: IconName; size?: number; color: string }) {
  const [ios, material] = symbols[name];
  return <SymbolView name={{ ios, android: material, web: material }} size={size} tintColor={color} weight="medium" accessible={false} />;
}

export function useTheme() {
  const dark = useColorScheme() === "dark";
  return dark ? darkTheme : lightTheme;
}

export function Action({
  title, onPress, primary, disabled, selected, destructive, icon, compact, disclosure, accessibilityLabel, toggled,
}: {
  title: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  selected?: boolean;
  destructive?: boolean;
  icon?: IconName;
  compact?: boolean;
  disclosure?: boolean;
  accessibilityLabel?: string;
  toggled?: boolean;
}) {
  const { colors, styles } = useTheme();
  const [focused, setFocused] = useState(false);
  const tint = primary ? colors.onAccent : destructive ? colors.error : colors.accent;
  const fill = [primary && styles.buttonPrimary, selected && styles.buttonSelected];
  const content = <>
    {icon && <Icon name={icon} size={compact ? 13 : 15} color={tint} />}
    <Text style={[styles.buttonLabel, compact && styles.compactLabel, { color: tint }]}>{title}</Text>
    {disclosure && <Icon name="down" size={13} color={tint} />}
  </>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled, selected }}
      aria-pressed={toggled}
      disabled={disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [
        styles.button,
        compact ? styles.compactButton : fill,
        focused && styles.focused,
        (pressed || disabled) && styles.faded,
      ]}
    >
      {compact ? <View style={[styles.compactFace, fill]}>{content}</View> : content}
    </Pressable>
  );
}

export function Field({ style, onFocus, onBlur, ...props }: TextInputProps) {
  const { colors, styles } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      placeholderTextColor={colors.muted}
      selectionColor={colors.accent}
      {...props}
      onFocus={(event) => { setFocused(true); onFocus?.(event); }}
      onBlur={(event) => { setFocused(false); onBlur?.(event); }}
      style={[styles.input, style, focused && styles.focused]}
    />
  );
}

export function Card({ children }: { children: ReactNode }) {
  const { styles } = useTheme();
  return <View style={styles.card}>{children}</View>;
}

export function Notice({ children }: { children: ReactNode }) {
  const { styles } = useTheme();
  return <Text accessibilityLiveRegion="polite" style={styles.error}>
    {typeof children === "string" ? errorLabel(children) : children}
  </Text>;
}

export function EmptyState({ icon, title, description }: { icon: IconName; title: string; description?: string }) {
  const { colors, styles } = useTheme();
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}><Icon name={icon} size={23} color={colors.accent} /></View>
      <Text accessibilityRole="header" style={[styles.heading, styles.center]}>{title}</Text>
      {description && <Text style={[styles.muted, styles.center]}>{description}</Text>}
    </View>
  );
}

function createTheme(colors: typeof light, dark: boolean) {
  return {
    colors, dark,
    styles: StyleSheet.create({
      frame: { flex: 1, backgroundColor: colors.background },
      content: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 20, gap: 14 },
      pairContent: { flexGrow: 1, justifyContent: "center", padding: 20, gap: 12 },
      header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingHorizontal: 16, paddingVertical: 8 },
      row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
      listItem: { minHeight: 48, paddingHorizontal: 13, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 10 },
      title: { color: colors.foreground, fontSize: 29, lineHeight: 35, fontWeight: "700", letterSpacing: -0.7 },
      heading: { color: colors.foreground, fontSize: 16, lineHeight: 21, fontWeight: "600", letterSpacing: -0.2 },
      text: { color: colors.foreground, fontSize: 14, lineHeight: 20 },
      muted: { color: colors.muted, fontSize: 13, lineHeight: 18 },
      caption: { color: colors.muted, fontSize: 12, lineHeight: 16 },
      sectionLabel: { color: colors.muted, fontSize: 12, lineHeight: 16, fontWeight: "600", marginLeft: 12, marginBottom: 5 },
      label: { color: colors.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" },
      error: { color: colors.error, backgroundColor: colors.errorFill, fontSize: 13, lineHeight: 18, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 9 },
      card: { backgroundColor: colors.surface, borderRadius: 13, padding: 12, gap: 8 },
      input: {
        minHeight: 44,
        borderWidth: 1,
        borderColor: "transparent",
        backgroundColor: colors.field,
        color: colors.foreground,
        borderRadius: 9,
        paddingHorizontal: 10,
        paddingVertical: 8,
        fontSize: 14,
      },
      button: {
        minHeight: 44,
        paddingHorizontal: 11,
        paddingVertical: 7,
        borderRadius: 9,
        flexDirection: "row",
        gap: 6,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: colors.secondary,
        borderWidth: 1,
        borderColor: "transparent",
      },
      buttonPrimary: { backgroundColor: colors.accentFill },
      buttonSelected: { backgroundColor: colors.tint },
      buttonLabel: { fontSize: 14, fontWeight: "600", flexShrink: 1, textAlign: "center" },
      compactButton: { minHeight: Platform.OS === "android" ? 48 : 44, minWidth: Platform.OS === "android" ? 48 : 44,
        paddingHorizontal: 0, paddingVertical: 0, backgroundColor: "transparent", borderRadius: 7 },
      compactFace: { flexDirection: "row", alignItems: "center", justifyContent: "center", minHeight: 28, flexShrink: 1,
        paddingHorizontal: 7, paddingVertical: 3, gap: 3, borderRadius: 7, backgroundColor: colors.secondary },
      compactLabel: { fontSize: 13 },
      focused: { borderColor: colors.accent },
      faded: { opacity: 0.53 },
      empty: { alignItems: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 24, alignSelf: "center", maxWidth: 350 },
      emptyIcon: { alignItems: "center", justifyContent: "center", backgroundColor: colors.tint, width: 44, height: 44, borderRadius: 12, marginBottom: 3 },
      center: { textAlign: "center" },
    }),
  };
}

const lightTheme = createTheme(light, false);
const darkTheme = createTheme(night, true);
