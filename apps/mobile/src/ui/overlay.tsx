import { BlurTargetView, BlurView } from "expo-blur";
import { createContext, useContext, useEffect, useId, useRef, useState, type ComponentRef, type PropsWithChildren, type ReactNode, type RefObject } from "react";
import { AccessibilityInfo, Modal, Platform, StyleSheet, View, useWindowDimensions, type ModalProps } from "react-native";
import Animated from "react-native-reanimated";
import { motion, useReduceMotion } from "./motion";
import { useTheme } from "./theme";

export const OverlayNotices = createContext<{ register: (id: string) => () => void; render: (id?: string) => ReactNode } | undefined>(undefined);

const BlurTarget = createContext<RefObject<ComponentRef<typeof View> | null> | undefined>(undefined);

export function OverlayRoot({ children }: PropsWithChildren) {
  const target = useRef<ComponentRef<typeof View>>(null);
  return <BlurTarget value={target}>
    <BlurTargetView ref={target} style={layout.fill}>{children}</BlurTargetView>
  </BlurTarget>;
}

export function OverlayBackdrop() {
  const { colors, dark } = useTheme();
  const target = useContext(BlurTarget);
  const reduced = useReduceMotion();
  const [reduceTransparency, setReduceTransparency] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    let active = true;
    let changed = false;
    const listener = AccessibilityInfo.addEventListener("reduceTransparencyChanged", (enabled) => {
      changed = true;
      setReduceTransparency(enabled);
    });
    void AccessibilityInfo.isReduceTransparencyEnabled().then((enabled) => {
      if (active && !changed) setReduceTransparency(enabled);
    }).catch(() => {});
    return () => { active = false; listener.remove(); };
  }, []);
  return <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={[StyleSheet.absoluteFill, !reduced && fadeIn]}>
    {reduceTransparency ? <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.background }]} /> : <>
      <BlurView style={StyleSheet.absoluteFill} blurTarget={target} blurMethod="dimezisBlurView"
        intensity={55} tint={dark ? "dark" : "light"} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: dark ? "rgba(0, 0, 0, 0.18)" : "rgba(53, 40, 32, 0.12)" }]} />
    </>}
  </Animated.View>;
}

export function OverlayModal({ children, animationType = "none", notice = false, ...props }: Omit<ModalProps, "transparent" | "presentationStyle"> & { notice?: boolean }) {
  const reduced = useReduceMotion();
  const { height } = useWindowDimensions();
  const notices = useContext(OverlayNotices);
  const hostId = useId();
  const register = notices?.register;
  useEffect(() => {
    if (!notice && props.visible !== false) return register?.(hostId);
  }, [hostId, notice, props.visible, register]);
  if (props.visible === false) return null;
  return <Modal statusBarTranslucent navigationBarTranslucent {...props} animationType="none" hardwareAccelerated transparent presentationStyle="overFullScreen">
    <View style={layout.fill}>
      <OverlayBackdrop />
      <Animated.View style={[layout.fill, !reduced && (animationType === "fade" ? fadeIn : animationType === "slide" && {
        ...motion.push, animationName: { from: { transform: [{ translateY: height }] }, to: { transform: [{ translateY: 0 }] } },
      })]}>
        <OverlayRoot>{children}{!notice && notices?.render(hostId)}</OverlayRoot>
      </Animated.View>
    </View>
  </Modal>;
}

const fadeIn = { ...motion.fade, animationName: { from: { opacity: 0 }, to: { opacity: 1 } } };
const layout = StyleSheet.create({ fill: { flex: 1 } });
