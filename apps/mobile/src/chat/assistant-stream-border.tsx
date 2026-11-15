import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { Animated, Easing, Image, View, useAnimatedValue, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReduceMotion } from "../ui/motion";

const tiles = {
  top: require("../../assets/assistant-aurora-top.png"),
  right: require("../../assets/assistant-aurora-right.png"),
  bottom: require("../../assets/assistant-aurora-bottom.png"),
  left: require("../../assets/assistant-aurora-left.png"),
};
const corner = require("../../assets/assistant-aurora-corner.png");
const period = 384;
const glow = 28;
const cornerStyle = { position: "absolute" as const, width: 96, height: 96 };

function Edge({ side, length, motion }: {
  side: keyof typeof tiles;
  length: number;
  motion: Animated.Value;
}) {
  const vertical = side === "right" || side === "left";
  const forward = side === "top" || side === "right";
  const count = Math.ceil(length / period) + 2;
  const shift = motion.interpolate({
    inputRange: [0, 1],
    outputRange: forward ? [-period, 0] : [0, -period],
  });
  return (
    <View style={{
      position: "absolute", overflow: "hidden", [side]: 0,
      ...(vertical ? { top: 0, bottom: 0, width: glow } : { left: 0, right: 0, height: glow }),
    }}>
      <Animated.View style={{
        flexDirection: vertical ? "column" : "row",
        width: vertical ? glow : count * period,
        height: vertical ? count * period : glow,
        transform: [vertical ? { translateY: shift } : { translateX: shift }],
      }}>
        {Array.from({ length: count }, (_, index) => (
          <Image key={index} source={tiles[side]} resizeMode="stretch"
            style={{ width: vertical ? glow : period, height: vertical ? period : glow }} />
        ))}
      </Animated.View>
    </View>
  );
}

export function AssistantStreamBorder() {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const motion = useAnimatedValue(0);
  const reduced = useReduceMotion();

  useFocusEffect(useCallback(() => {
    if (reduced) {
      motion.setValue(0);
      return;
    }
    const animation = Animated.loop(Animated.timing(motion, {
      toValue: 1, duration: 6000, easing: Easing.linear,
      useNativeDriver: true, isInteraction: false,
    }));
    animation.start();
    return () => { animation.stop(); motion.setValue(0); };
  }, [motion, reduced]));

  return (
    <View testID="assistant-stream-border" pointerEvents="none" accessible={false}
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      // Extend past the page's safe-area padding to keep the glow on the screen edges.
      style={{ position: "absolute", top: -insets.top, right: -insets.right, bottom: -insets.bottom, left: -insets.left }}>
      <Edge side="top" length={width} motion={motion} />
      <Edge side="right" length={height} motion={motion} />
      <Edge side="bottom" length={width} motion={motion} />
      <Edge side="left" length={height} motion={motion} />
      <Image source={corner} style={[cornerStyle, { top: 0, left: 0 }]} />
      <Image source={corner} style={[cornerStyle, { top: 0, right: 0, transform: [{ scaleX: -1 }] }]} />
      <Image source={corner} style={[cornerStyle, { bottom: 0, right: 0, transform: [{ scaleX: -1 }, { scaleY: -1 }] }]} />
      <Image source={corner} style={[cornerStyle, { bottom: 0, left: 0, transform: [{ scaleY: -1 }] }]} />
    </View>
  );
}
