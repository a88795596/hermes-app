import { lockAsync, OrientationLock } from "expo-screen-orientation";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { ScrollView as HorizontalScrollView } from "react-native-gesture-handler";
import { ProfilePagingContext } from "../profiles/paging-context";
import { haptic } from "../ui/haptics";
import { OverlayModal } from "../ui/overlay";
import { PageHeader } from "../ui/page-header";
import { useAlert } from "../ui/alerts";
import { CloseButton, Icon, Notice, useTheme } from "../ui/theme";

export function MarkdownTable({ columns, children }: { columns: number; children: ReactNode }) {
  const { colors, styles } = useTheme();
  const alert = useAlert();
  const [open, setOpen] = useState(false);
  const [orientationError, setOrientationError] = useState<string>();
  const active = useRef(false);
  const blockPaging = useContext(ProfilePagingContext);
  useEffect(() => () => blockPaging?.(false), [blockPaging]);

  useEffect(() => {
    if (!open || Platform.OS === "web") return;
    active.current = true;
    return () => {
      active.current = false;
      void lockAsync(OrientationLock.PORTRAIT_UP).catch(() => {
        alert.alert("无法恢复竖屏", "请重新打开应用后重试。");
      });
    };
  }, [alert, open]);

  function show() {
    if (!active.current) return;
    // Wait for presentation so a portrait-only parent modal cannot conflict with the new lock.
    void lockAsync(OrientationLock.LANDSCAPE).catch(() => {
      if (active.current) setOrientationError("无法切换横屏，仍可滚动查看表格。");
    });
  }

  const close = () => setOpen(false);
  const grid = <View style={[table.frame, { borderColor: colors.edge }]}>
    <HorizontalScrollView horizontal disallowInterruption tabIndex={0} contentContainerStyle={table.scrollContent}
      onTouchStart={() => blockPaging?.(true)}
      onTouchEnd={({ nativeEvent }) => { if (!nativeEvent.touches.length) blockPaging?.(false); }}
      onTouchCancel={() => blockPaging?.(false)}>
      <View style={[table.grid, { width: columns * 100 }]}>{children}</View>
    </HorizontalScrollView>
  </View>;

  return <View>
    <View style={table.toolbar}>
      <Pressable accessibilityRole="button" accessibilityLabel="放大表格"
        style={({ pressed }) => [styles.closeButton, pressed && styles.faded]}
        onPress={() => { haptic("light"); setOrientationError(undefined); setOpen(true); }}>
        <Icon name="expand" size={19} color={colors.accent} />
      </Pressable>
    </View>
    {grid}
    {open && <OverlayModal animationType="none" onRequestClose={close} onShow={show}
      supportedOrientations={["portrait", "landscape-left", "landscape-right"]}>
      <SafeAreaProvider>
        <SafeAreaView style={[styles.frame, { backgroundColor: "transparent" }]} accessibilityViewIsModal importantForAccessibility="yes">
          <PageHeader title="表格" trailing={<CloseButton accessibilityLabel="关闭表格全屏" onPress={close} />} />
          {orientationError && <Notice>{orientationError}</Notice>}
          <ScrollView contentContainerStyle={table.fullscreenContent}>{grid}</ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </OverlayModal>}
  </View>;
}

const table = StyleSheet.create({
  toolbar: { alignItems: "flex-end" },
  frame: { borderWidth: 1, borderRadius: 12, overflow: "hidden" },
  scrollContent: { flexGrow: 1 },
  grid: { flexGrow: 1 },
  fullscreenContent: { paddingHorizontal: 16, paddingBottom: 16 },
});
