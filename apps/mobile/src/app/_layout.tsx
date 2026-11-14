import { Stack } from "expo-router";
import { Stack as JSStack } from "expo-router/js-stack";
import { useEffect } from "react";
import { Platform } from "react-native";
import { MotionProvider } from "../ui/motion";
import { useTheme } from "../ui/theme";
import { prepareUpdate } from "../updates";
import { WorkspaceProvider } from "../workspace-context";

export const unstable_settings = { anchor: "index" };

export default function RootLayout() {
  const { colors } = useTheme();
  useEffect(() => { void prepareUpdate(); }, []);
  return <MotionProvider>
    <WorkspaceProvider>
      {Platform.OS === "android" ? (
        <JSStack screenOptions={{ headerShown: false, gestureEnabled: true, gestureDirection: "horizontal",
          animation: "slide_from_right", cardStyle: { backgroundColor: colors.background } }} />
      ) : (
        <Stack screenOptions={{ headerShown: false, gestureEnabled: true, fullScreenGestureEnabled: true,
          contentStyle: { backgroundColor: colors.background } }} />
      )}
    </WorkspaceProvider>
  </MotionProvider>;
}
