import { useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "./theme";

export function PageHeader({ title, leading, trailing }: {
  title: ReactNode; leading?: ReactNode; trailing?: ReactNode;
}) {
  const { styles } = useTheme();
  const [leadingWidth, setLeadingWidth] = useState(48);
  const [trailingWidth, setTrailingWidth] = useState(48);
  const titleInset = Math.max(48, leadingWidth, trailingWidth) + 32;
  return <View style={layout.header}>
    <View style={[layout.side, layout.leading]} onLayout={({ nativeEvent }) => setLeadingWidth(nativeEvent.layout.width)}>
      {leading}
    </View>
    <View pointerEvents="box-none" style={[layout.title, { left: titleInset, right: titleInset }]}>
      {typeof title === "string"
        ? <Text accessibilityRole="header" accessibilityLabel={title} numberOfLines={1} ellipsizeMode="tail"
          style={[styles.heading, layout.titleText]}>{title}</Text>
        : title}
    </View>
    <View style={[layout.side, layout.trailing]} onLayout={({ nativeEvent }) => setTrailingWidth(nativeEvent.layout.width)}>
      {trailing}
    </View>
  </View>;
}

const layout = StyleSheet.create({
  header: { width: "100%", maxWidth: 680, alignSelf: "center", minHeight: 56, paddingHorizontal: 24, paddingVertical: 4,
    flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  side: { minWidth: 48, minHeight: 48, maxWidth: "35%", justifyContent: "center" },
  leading: { alignItems: "flex-start" },
  trailing: { alignItems: "flex-end" },
  title: { position: "absolute", top: 4, bottom: 4, minWidth: 0, justifyContent: "center" },
  titleText: { fontSize: 18, lineHeight: 24, fontWeight: "700", textAlign: "center" },
});
