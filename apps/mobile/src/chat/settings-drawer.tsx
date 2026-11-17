import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { haptic } from "../ui/haptics";
import { motion, useReduceMotion } from "../ui/motion";
import { OverlayModal } from "../ui/overlay";
import { PageHeader } from "../ui/page-header";
import { CloseButton, Icon, SectionLabel, useTheme } from "../ui/theme";

export function SettingsDrawer({ busy, canWrite, reasoningLabel, onClose, onModel, onReasoning, children, settingsNavigation, applicationSettings }: {
  busy: boolean;
  canWrite: boolean;
  reasoningLabel: string;
  onClose: () => void;
  onModel: () => void;
  onReasoning: () => void;
  children?: ReactNode;
  settingsNavigation?: ReactNode;
  applicationSettings?: ReactNode;
}) {
  const { colors, styles } = useTheme();
  const reduced = useReduceMotion();
  const { width } = useWindowDimensions();
  const drawerWidth = applicationSettings ? Math.min(680, width) : Math.min(400, width - 32);
  const title = applicationSettings ? "设置中心" : "会话设置";
  const closeLabel = `关闭${title}`;
  const close = () => { if (!busy) onClose(); };
  return <OverlayModal animationType="none" statusBarTranslucent onRequestClose={close}>
    <View style={drawer.overlay}>
      <Animated.View style={[StyleSheet.absoluteFill, !reduced && motion.fade]}>
        <Pressable accessibilityRole="button" accessibilityLabel={closeLabel} accessibilityState={{ disabled: busy }}
          disabled={busy} style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>
      <Animated.View style={[drawer.panel, { width: drawerWidth, backgroundColor: colors.background }, !reduced && {
        ...motion.push,
        animationName: { from: { transform: [{ translateX: drawerWidth }] }, to: { transform: [{ translateX: 0 }] } },
      }]}>
        <SafeAreaView style={styles.frame} edges={["top", "bottom", "right"]}
          accessibilityViewIsModal importantForAccessibility="yes">
          {children ?? <>
            <PageHeader title={title} trailing={<CloseButton accessibilityLabel={closeLabel} disabled={busy} onPress={close} />} />
            <ScrollView contentContainerStyle={drawer.content}>
              {settingsNavigation}
              {applicationSettings && <View style={drawer.section}><SectionLabel>当前会话</SectionLabel></View>}
              {([
                { title: "模型", icon: "model", onPress: onModel },
                { title: "思考强度", icon: "reasoning", value: reasoningLabel, onPress: onReasoning },
              ] as const).map((item) => <Pressable key={item.title} accessibilityRole="button"
                accessibilityLabel={`${item.title}${"value" in item ? `：${item.value}` : ""}`}
                accessibilityState={{ disabled: !canWrite }} disabled={!canWrite}
                onPress={() => { haptic("light"); item.onPress(); }}
                style={({ pressed }) => [drawer.row, { borderColor: colors.edge }, (pressed || !canWrite) && styles.faded]}>
                <Icon name={item.icon} size={21} color={colors.accent} />
                <Text style={[styles.text, drawer.label]}>{item.title}</Text>
                {"value" in item && <Text numberOfLines={2} style={[styles.caption, drawer.value]}>{item.value}</Text>}
                <Icon name="chevron" size={15} color={colors.accent} />
              </Pressable>)}
              {applicationSettings && <View style={drawer.section}><SectionLabel>应用</SectionLabel>{applicationSettings}</View>}
            </ScrollView>
          </>}
        </SafeAreaView>
      </Animated.View>
    </View>
  </OverlayModal>;
}

const drawer = StyleSheet.create({
  overlay: { flex: 1, alignItems: "flex-end" },
  panel: { flex: 1 },
  content: { paddingHorizontal: 24, paddingBottom: 24 },
  section: { marginTop: 24 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 64, paddingVertical: 12, gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth },
  label: { flex: 1 },
  value: { maxWidth: "42%", flexShrink: 1, textAlign: "right" },
});
