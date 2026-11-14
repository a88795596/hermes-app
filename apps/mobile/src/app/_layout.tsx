import { Stack } from "expo-router";
import { useEffect } from "react";
import { MotionProvider } from "../ui/motion";
import { useTheme } from "../ui/theme";
import { prepareUpdate } from "../updates";

export default function RootLayout() {
  const { colors } = useTheme();
  useEffect(() => { void prepareUpdate(); }, []);
  return <MotionProvider>
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />
  </MotionProvider>;
}
