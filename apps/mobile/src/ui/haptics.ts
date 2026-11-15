import * as Haptics from "expo-haptics";
import { AppState, Platform } from "react-native";

export type HapticKind = "selection" | "light" | "medium" | "success" | "warning" | "error";

const androidEffects = {
  selection: Haptics.AndroidHaptics.Segment_Tick,
  light: Haptics.AndroidHaptics.Virtual_Key,
  medium: Haptics.AndroidHaptics.Context_Click,
  success: Haptics.AndroidHaptics.Confirm,
  warning: Haptics.AndroidHaptics.Long_Press,
  error: Haptics.AndroidHaptics.Reject,
};

const notifications = {
  success: Haptics.NotificationFeedbackType.Success,
  warning: Haptics.NotificationFeedbackType.Warning,
  error: Haptics.NotificationFeedbackType.Error,
};

export function haptic(kind: HapticKind): void {
  if (Platform.OS === "web" || AppState.currentState !== "active") return;
  try {
    const feedback = Platform.OS === "android" ? Haptics.performAndroidHapticsAsync(androidEffects[kind])
      : kind === "selection" ? Haptics.selectionAsync()
      : kind === "light" || kind === "medium" ? Haptics.impactAsync(kind === "light" ? Haptics.ImpactFeedbackStyle.Light : Haptics.ImpactFeedbackStyle.Medium)
      : Haptics.notificationAsync(notifications[kind]);
    // 触觉不可用或被系统关闭时，不影响原操作。
    void feedback.catch(() => {});
  } catch {}
}
