import { Link } from "expo-router";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { EmptyState, useTheme } from "../ui/theme";

export default function NotFound() {
  const { colors, styles } = useTheme();
  return (
    <SafeAreaView style={styles.frame}>
      <View style={[styles.pairContent, { alignItems: "center" }]}>
        <EmptyState icon="topics" title="找不到页面" />
        <Link href="/" replace style={[styles.buttonLabel, { color: colors.accent, padding: 14 }]}>
          返回首页
        </Link>
      </View>
    </SafeAreaView>
  );
}
