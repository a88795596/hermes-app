import { SymbolView, type AndroidSymbol, type SFSymbol } from "expo-symbols";
import { useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View, useColorScheme, type StyleProp, type TextInputProps, type ViewStyle } from "react-native";
import { errorLabel } from "./text";
import { haptic, type HapticKind } from "./haptics";

const light = {
  background: "#F7F2EA",
  surface: "#FFFCF7",
  edge: "#DDD0C2",
  foreground: "#352820",
  muted: "#735F50",
  accent: "#86553B",
  accentFill: "#9C6548",
  onAccent: "#FFFFFF",
  tint: "#EBDDD0",
  secondary: "#EFE5DA",
  field: "#EDE2D7",
  success: "#776349",
  error: "#A53F35",
  errorFill: "#F5E1D9",
};

const night: typeof light = {
  background: "#211C18",
  surface: "#2B241F",
  edge: "#514238",
  foreground: "#F5ECE1",
  muted: "#BEA995",
  accent: "#D9AB88",
  accentFill: "#9C6548",
  onAccent: "#FFFFFF",
  tint: "#49382D",
  secondary: "#382E27",
  field: "#392F28",
  success: "#C8B493",
  error: "#EEA08D",
  errorFill: "#4B2B24",
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
  attachment: ["paperclip", "attach_file"],
  photo: ["photo", "image"],
  link: ["link", "link"],
  close: ["xmark", "close"],
  bell: ["bell", "notifications"],
  more: ["ellipsis", "more_horiz"],
  sparkles: ["sparkles", "auto_awesome"],
  sparkle: ["sparkles", "auto_awesome"],
  chatActive: ["bubble.left.fill", "chat_bubble"],
  inboxActive: ["tray.fill", "inbox"],
  settingsActive: ["gearshape.fill", "settings"],
  command: ["command", "terminal"],
  reasoning: ["brain", "psychology"],
  process: ["list.bullet.rectangle", "account_tree"],
  approval: ["checkmark.shield", "assignment_turned_in"],
  key: ["key", "key"],
  search: ["magnifyingglass", "search"],
  book: ["book", "menu_book"],
  layers: ["square.3.layers.3d", "layers"],
  shield: ["checkmark.shield", "verified_user"],
  download: ["arrow.down.to.line", "download"],
  plus: ["plus", "add"],
  expand: ["arrow.up.left.and.arrow.down.right", "fullscreen"],
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

export function CloseButton({ onPress, disabled, accessibilityLabel = "关闭" }: {
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const { colors, styles } = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled }}
      disabled={disabled} onPress={() => { if (!disabled) { haptic("light"); onPress(); } }} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={({ pressed }) => [styles.closeButton, focused && styles.focused, (pressed || disabled) && styles.faded]}>
      <Icon name="close" size={17} color={colors.muted} />
    </Pressable>
  );
}

export function Action({
  title, onPress, primary, disabled, selected, destructive, icon, compact, disclosure, accessibilityLabel, toggled, feedback, style,
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
  feedback?: HapticKind | false;
  style?: StyleProp<ViewStyle>;
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
      onPress={() => {
        if (disabled) return;
        if (feedback !== false) haptic(feedback ?? (destructive ? "warning" : primary ? "medium"
          : selected !== undefined || toggled !== undefined ? "selection" : "light"));
        onPress();
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [
        styles.button,
        compact ? styles.compactButton : fill,
        style,
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

export function SectionLabel({ children }: { children: ReactNode }) {
  const { colors, styles } = useTheme();
  return <View style={styles.sectionHeading}>
    <Text accessibilityRole="header" style={styles.sectionLabel}>{children}</Text>
    <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.edge }} />
  </View>;
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
      content: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 16, paddingBottom: 32, gap: 24 },
      pairContent: { flexGrow: 1, justifyContent: "center", padding: 24, gap: 20 },
      header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: 24, paddingVertical: 8 },
      row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
      listItem: { minHeight: 64, paddingHorizontal: 0, paddingVertical: 14, flexDirection: "row", alignItems: "center", gap: 14 },
      wordmark: { color: colors.foreground, fontFamily: Platform.select({ ios: "Georgia", android: "serif", default: "Georgia, serif" }), fontSize: 23, lineHeight: 30, fontWeight: "600", letterSpacing: -0.5 },
      title: { color: colors.foreground, fontSize: 30, lineHeight: 39, fontWeight: "700", letterSpacing: -0.6 },
      heading: { color: colors.foreground, fontSize: 18, lineHeight: 26, fontWeight: "600" },
      text: { color: colors.foreground, fontSize: 17, lineHeight: 26 },
      muted: { color: colors.muted, fontSize: 14, lineHeight: 21 },
      caption: { color: colors.muted, fontSize: 13, lineHeight: 19 },
      sectionLabel: { color: colors.muted, fontSize: 14, lineHeight: 21, fontWeight: "500" },
      sectionHeading: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 8 },
      label: { color: colors.foreground, fontSize: 17, lineHeight: 25, fontWeight: "600" },
      error: { color: colors.error, backgroundColor: colors.errorFill, fontSize: 14, lineHeight: 22, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12 },
      card: { backgroundColor: colors.surface, borderRadius: 14, padding: 18, gap: 12 },
      input: {
        minHeight: 50,
        borderWidth: 1,
        borderColor: "transparent",
        backgroundColor: colors.field,
        color: colors.foreground,
        borderRadius: 12,
        paddingHorizontal: 16,
        paddingVertical: 12,
        fontSize: 17,
        lineHeight: 24,
      },
      button: {
        minHeight: 44,
        paddingHorizontal: 15,
        paddingVertical: 10,
        borderRadius: 12,
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
      buttonLabel: { fontSize: 16, lineHeight: 23, fontWeight: "600", flexShrink: 1, textAlign: "center" },
      closeButton: { minWidth: Platform.OS === "android" ? 48 : 44, minHeight: Platform.OS === "android" ? 48 : 44,
        alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "transparent", borderRadius: 9 },
      compactButton: { minHeight: Platform.OS === "android" ? 48 : 44, minWidth: Platform.OS === "android" ? 48 : 44,
        paddingHorizontal: 0, paddingVertical: 0, backgroundColor: "transparent", borderRadius: 7 },
      compactFace: { flexDirection: "row", alignItems: "center", justifyContent: "center", minHeight: 28, flexShrink: 1,
        paddingHorizontal: 10, paddingVertical: 5, gap: 5, borderRadius: 9, backgroundColor: colors.secondary },
      compactLabel: { fontSize: 14, lineHeight: 20 },
      focused: { borderColor: colors.accent, ...(Platform.OS === "web" ? { outlineColor: colors.accent } : {}) },
      faded: { opacity: 0.53 },
      empty: { alignItems: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 24, alignSelf: "center", maxWidth: 350 },
      emptyIcon: { alignItems: "center", justifyContent: "center", backgroundColor: colors.tint, width: 44, height: 44, borderRadius: 12, marginBottom: 3 },
      center: { textAlign: "center" },
    }),
  };
}

const lightTheme = createTheme(light, false);
const darkTheme = createTheme(night, true);
