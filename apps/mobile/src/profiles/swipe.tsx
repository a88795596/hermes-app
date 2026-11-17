import type { ReactNode } from "react";
import { View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";

export function ProfileSwipe({ enabled, onSwitch, children }: {
  enabled: boolean;
  onSwitch?: (direction: -1 | 1) => void;
  children: ReactNode;
}) {
  const gesture = usePanGesture({
    enabled,
    runOnJS: true,
    activeOffsetX: [-60, 60],
    failOffsetY: [-16, 16],
    maxPointers: 1,
    onDeactivate: ({ translationX, translationY, canceled }) => {
      if (!enabled || canceled || Math.abs(translationX) < 60 || Math.abs(translationY) > 24) return;
      onSwitch?.(translationX < 0 ? 1 : -1);
    },
  });
  return <GestureDetector gesture={gesture} touchAction="pan-y">
    <View style={{ flex: 1 }} collapsable={false}>{children}</View>
  </GestureDetector>;
}
