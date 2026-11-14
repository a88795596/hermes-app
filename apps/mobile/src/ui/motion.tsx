import { createContext, useContext, useEffect, useState, type PropsWithChildren } from "react";
import { AccessibilityInfo } from "react-native";
import { cubicBezier, useReducedMotion } from "react-native-reanimated";

const easeOut = cubicBezier(0.2, 0.75, 0.25, 1);
const fade = {
  animationName: { from: { opacity: 0.72 }, to: { opacity: 1 } },
  animationDuration: 150,
  animationTimingFunction: easeOut,
};

export const motion = {
  fade,
  push: {
    ...fade,
    animationName: { from: { opacity: 0.78, transform: [{ translateX: 18 }] }, to: { opacity: 1, transform: [{ translateX: 0 }] } },
    animationDuration: 210,
  },
  pop: {
    ...fade,
    animationName: { from: { opacity: 0.78, transform: [{ translateX: -12 }] }, to: { opacity: 1, transform: [{ translateX: 0 }] } },
    animationDuration: 180,
  },
  reveal: {
    ...fade,
    animationName: { from: { opacity: 0.72, transform: [{ translateY: 8 }] }, to: { opacity: 1, transform: [{ translateY: 0 }] } },
    animationDuration: 180,
  },
  indicator: { transitionProperty: "transform", transitionDuration: 210, transitionTimingFunction: easeOut },
  status: { transitionProperty: "color", transitionDuration: 150, transitionTimingFunction: easeOut },
} as const;

const ReducedMotion = createContext(false);

export function MotionProvider({ children }: PropsWithChildren) {
  const initiallyReduced = useReducedMotion();
  const [reduced, setReduced] = useState(initiallyReduced);

  useEffect(() => {
    let awaitingInitialPreference = true;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (enabled) => {
      awaitingInitialPreference = false;
      setReduced(enabled);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (awaitingInitialPreference) setReduced(enabled);
    }, () => {});
    return () => {
      awaitingInitialPreference = false;
      subscription?.remove();
    };
  }, []);

  return <ReducedMotion value={reduced}>{children}</ReducedMotion>;
}

export function useReduceMotion() {
  return useContext(ReducedMotion);
}
