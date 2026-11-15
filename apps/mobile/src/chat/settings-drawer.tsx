import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { haptic } from "../ui/haptics";
import { motion, useReduceMotion } from "../ui/motion";
import { PageHeader } from "../ui/page-header";
import { CloseButton, Icon, useTheme } from "../ui/theme";

export function SettingsDrawer({ busy, canWrite, reasoningLabel, onClose, onModel, onReasoning, children }: {
  busy: boolean;
  canWrite: boolean;
  reasoningLabel: string;
  onClose: () => void;
  onModel: () => void;
  onReasoning: () => void;
  children?: ReactNode;
}) {
  const { colors, styles } = useTheme();
  const reduced = useReduceMotion();
  const { width } = useWindowDimensions();
  const drawerWidth = Math.min(400, width - 32);
  const close = () => { if (!busy) onClose(); };
  return <Modal transparent animationType="none" statusBarTranslucent onRequestClose={close}>
    <View style={drawer.overlay}>
      <Animated.View style={[StyleSheet.absoluteFill, drawer.scrim, !reduced && motion.fade]}>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭会话设置" accessibilityState={{ disabled: busy }}
          disabled={busy} style={StyleSheet.absoluteFill} onPress={close} />
      </Animated.View>
      <Animated.View style={[drawer.panel, { width: drawerWidth, backgroundColor: colors.background }, !reduced && {
        ...motion.push,
        animationName: { from: { transform: [{ translateX: drawerWidth }] }, to: { transform: [{ translateX: 0 }] } },
      }]}>
        <SafeAreaView style={styles.frame} edges={["top", "bottom", "right"]}
          accessibilityViewIsModal importantForAccessibility="yes">
          {children ?? <>
            <PageHeader title="会话设置" trailing={<CloseButton accessibilityLabel="关闭会话设置" onPress={close} />} />
            <View style={drawer.content}>
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
            </View>
          </>}
        </SafeAreaView>
      </Animated.View>
    </View>
  </Modal>;
}

const drawer = StyleSheet.create({
  overlay: { flex: 1, alignItems: "flex-end" },
  scrim: { backgroundColor: "rgba(53, 40, 32, 0.27)" },
  panel: { flex: 1 },
  content: { paddingHorizontal: 24 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 64, paddingVertical: 12, gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth },
  label: { flex: 1 },
  value: { maxWidth: "42%", flexShrink: 1, textAlign: "right" },
});
