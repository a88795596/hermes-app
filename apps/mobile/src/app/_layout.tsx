import { Stack } from "expo-router";
import { Stack as JSStack } from "expo-router/js-stack";
import { useEffect } from "react";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { AlertProvider } from "../ui/alerts";
import { OverlayRoot } from "../ui/overlay";
import { MotionProvider } from "../ui/motion";
import { useTheme } from "../ui/theme";
import { prepareUpdate } from "../updates";
import { WorkspaceProvider } from "../workspace-context";

export const unstable_settings = { anchor: "index" };

export default function RootLayout() {
  const { colors } = useTheme();
  useEffect(() => { void prepareUpdate(); }, []);
  return <GestureHandlerRootView style={{ flex: 1 }}><MotionProvider><OverlayRoot><AlertProvider>
    <WorkspaceProvider>
      {Platform.OS === "android" ? (
        <JSStack screenOptions={{ headerShown: false, gestureEnabled: true, gestureDirection: "horizontal",
          animation: "slide_from_right", cardStyle: { backgroundColor: colors.background } }} />
      ) : (
        <Stack screenOptions={{ headerShown: false, gestureEnabled: true, fullScreenGestureEnabled: true,
          contentStyle: { backgroundColor: colors.background } }} />
      )}
    </WorkspaceProvider>
  </AlertProvider></OverlayRoot></MotionProvider></GestureHandlerRootView>;
}
