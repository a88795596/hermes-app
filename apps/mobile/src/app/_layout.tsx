import { Stack } from "expo-router";
import { MotionProvider } from "../ui/motion";
import { useTheme } from "../ui/theme";

export default function RootLayout() {
  const { colors } = useTheme();
  return <MotionProvider>
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />
  </MotionProvider>;
}
