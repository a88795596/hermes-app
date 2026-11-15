import { useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, { FadeOut, LinearTransition, ReduceMotion, useAnimatedStyle, type SharedValue } from "react-native-reanimated";
import { haptic } from "../ui/haptics";
import { useReduceMotion } from "../ui/motion";
import { Action, Icon, SectionLabel, useTheme } from "../ui/theme";
import { formatTopicTime, groupTopics } from "./topic-groups";

export interface TopicListRow {
  id: string;
  title: string;
  status: string;
  newProfileId?: string;
  profileLabel?: string;
  created_at?: string | number;
  updated_at?: string | number;
}

export interface TopicListHandle { close: () => void }

interface TopicListProps {
  rows: TopicListRow[];
  archived: boolean;
  busy: boolean;
  onOpen: (row: TopicListRow) => void;
  onArchive: (row: TopicListRow) => void;
  ref?: Ref<TopicListHandle>;
}

const actionWidth = 96;
const rearrange = LinearTransition.duration(180);

function ArchiveAction({ translation, visible, busy, title, onPress }: {
  translation: SharedValue<number>; visible: boolean; busy: boolean; title: string; onPress: () => void;
}) {
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: Math.max(translation.value, -actionWidth) + actionWidth }],
  }));
  return <Animated.View style={[layout.action, animatedStyle]} accessibilityElementsHidden={!visible}
    importantForAccessibility={visible ? "auto" : "no-hide-descendants"}>
    <Action title="归档" icon="archive" primary accessibilityLabel={`归档会话：${title}`}
      disabled={busy} feedback={false} onPress={onPress} style={layout.archive} />
  </Animated.View>;
}

function TopicRow({ row, archived, busy, onOpen, onArchive, activeRef, now }: Omit<TopicListProps, "rows" | "ref"> & {
  row: TopicListRow; activeRef: RefObject<RefObject<SwipeableMethods | null> | null>; now: Date;
}) {
  const { colors, styles } = useTheme();
  const reduced = useReduceMotion();
  const swipeableRef = useRef<SwipeableMethods>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const created = formatTopicTime(row.created_at, now);
  const updated = formatTopicTime(row.updated_at ?? row.created_at, now);

  useEffect(() => {
    return () => { if (activeRef.current === swipeableRef) activeRef.current = null; };
  }, [activeRef]);

  function claimMenu() {
    if (activeRef.current !== swipeableRef) activeRef.current?.current?.close();
    activeRef.current = swipeableRef;
  }

  function archive() {
    if (busy) return;
    swipeableRef.current?.close();
    haptic(archived ? "medium" : "warning");
    onArchive(row);
  }

  const content = <View style={[layout.row, { backgroundColor: colors.background }]}>
    <Pressable accessibilityRole="button"
      accessibilityLabel={[row.title, row.profileLabel, row.status, `创建 ${created}`, `更新 ${updated}`].filter(Boolean).join("，")}
      accessibilityHint={archived ? undefined : "向左滑动显示归档操作"}
      accessibilityActions={!archived && !busy ? [{ name: "archive", label: "归档" }] : undefined}
      onAccessibilityAction={({ nativeEvent }) => { if (!archived && nativeEvent.actionName === "archive") archive(); }}
      onPress={() => { activeRef.current?.current?.close(); haptic("light"); onOpen(row); }}
      style={({ pressed }) => [layout.open, pressed && styles.faded]}>
      <View style={[layout.icon, { backgroundColor: colors.tint }]}><Icon name="chat" size={21} color={colors.accent} /></View>
      <View style={layout.details}>
        <Text numberOfLines={2} style={styles.heading}>{row.title}</Text>
        {!!row.profileLabel && <Text style={styles.muted}>{row.profileLabel}</Text>}
        {!!row.status && <Text style={styles.caption}>{row.status}</Text>}
        <Text style={styles.caption}>
          {archived ? (created === updated ? `创建与更新于 ${updated}` : `创建 ${created} · 更新 ${updated}`) : updated}
        </Text>
      </View>
    </Pressable>
    {archived && <Pressable accessibilityRole="button" accessibilityLabel={`恢复会话：${row.title}`}
      accessibilityState={{ disabled: busy }} disabled={busy} onPress={archive}
      style={({ pressed }) => [layout.restore, { borderColor: colors.accent }, (pressed || busy) && styles.faded]}>
      <Text style={[styles.label, { color: colors.accent }]}>恢复</Text>
    </Pressable>}
  </View>;

  return archived ? content : <ReanimatedSwipeable ref={swipeableRef} enabled={!busy}
    friction={1} rightThreshold={actionWidth / 2} dragOffsetFromRight={-16} dragOffsetFromLeft={16}
    overshootLeft={false} overshootRight={false} enableTrackpadTwoFingerGesture
    animationOptions={{ reduceMotion: reduced ? ReduceMotion.Always : ReduceMotion.Never }}
    onSwipeableOpenStartDrag={claimMenu}
    onSwipeableWillOpen={() => { claimMenu(); setMenuOpen(true); }}
    onSwipeableWillClose={() => setMenuOpen(false)}
    onSwipeableClose={() => { if (activeRef.current === swipeableRef) activeRef.current = null; }}
    renderRightActions={(_progress, translation) => <ArchiveAction translation={translation} visible={menuOpen}
      busy={busy} title={row.title} onPress={archive} />}>
    {content}
  </ReanimatedSwipeable>;
}

export function TopicList({ rows, archived, busy, onOpen, onArchive, ref }: TopicListProps) {
  const { colors } = useTheme();
  const reduced = useReduceMotion();
  const activeRef = useRef<RefObject<SwipeableMethods | null>>(null);
  useImperativeHandle(ref, () => ({ close: () => activeRef.current?.current?.close() }), []);
  const now = new Date();

  return groupTopics(rows, now).map(({ title, rows }) => (
    <Animated.View key={title ?? "undated"} collapsable={false} layout={reduced ? undefined : rearrange}>
      {title && <SectionLabel>{title}</SectionLabel>}
      {rows.map((row, index) => <Animated.View key={row.id} layout={reduced ? undefined : rearrange}
        exiting={reduced ? undefined : FadeOut.duration(140)}
        style={(archived || index < rows.length - 1) && [layout.divided, { borderColor: colors.edge }]}>
        <TopicRow row={row} archived={archived} busy={busy} onOpen={onOpen} onArchive={onArchive} activeRef={activeRef} now={now} />
      </Animated.View>)}
    </Animated.View>
  ));
}

const layout = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  divided: { borderBottomWidth: StyleSheet.hairlineWidth },
  open: { flex: 1, minWidth: 0, minHeight: 64, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 14 },
  icon: { width: 38, height: 38, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  details: { flex: 1, minWidth: 0, gap: 3 },
  restore: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, borderWidth: 1 },
  action: { width: actionWidth, paddingVertical: 6, paddingLeft: 8 },
  archive: { flex: 1, paddingHorizontal: 8, gap: 6 },
});
