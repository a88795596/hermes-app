import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { haptic } from "../ui/haptics";
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

export function TopicList({ rows, archived, busy, onOpen, onArchive }: {
  rows: TopicListRow[];
  archived: boolean;
  busy: boolean;
  onOpen: (row: TopicListRow) => void;
  onArchive: (row: TopicListRow) => void;
}) {
  const { colors, styles } = useTheme();
  const [openMenuId, setOpenMenuId] = useState<string>();
  const now = new Date();

  return groupTopics(rows, now).map(({ title, rows }) => (
    <View key={title ?? "undated"}>
      {title && <SectionLabel>{title}</SectionLabel>}
      {rows.map((row, index) => {
        const created = formatTopicTime(row.created_at, now);
        const updated = formatTopicTime(row.updated_at ?? row.created_at, now);
        const menuOpen = openMenuId === row.id;
        return (
          <View key={row.id} style={(archived || index < rows.length - 1) && [layout.divided, { borderColor: colors.edge }]}>
            <View style={layout.row}>
              <Pressable accessibilityRole="button"
                accessibilityLabel={[row.title, row.profileLabel, row.status, `创建 ${created}`, `更新 ${updated}`].filter(Boolean).join("，")}
                onPress={() => { setOpenMenuId(undefined); haptic("light"); onOpen(row); }}
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
              {archived ? (
                <Pressable accessibilityRole="button" accessibilityLabel={`恢复会话：${row.title}`}
                  accessibilityState={{ disabled: busy }} disabled={busy}
                  onPress={() => { haptic("medium"); onArchive(row); }}
                  style={({ pressed }) => [layout.restore, { borderColor: colors.accent }, (pressed || busy) && styles.faded]}>
                  <Text style={[styles.label, { color: colors.accent }]}>恢复</Text>
                </Pressable>
              ) : (
                <Pressable accessibilityRole="button" accessibilityLabel={`会话操作：${row.title}`}
                  accessibilityState={{ expanded: menuOpen, disabled: busy }} disabled={busy}
                  onPress={() => { haptic("light"); setOpenMenuId(menuOpen ? undefined : row.id); }}
                  style={({ pressed }) => [styles.closeButton, (pressed || busy) && styles.faded]}>
                  <Icon name="more" size={20} color={colors.muted} />
                </Pressable>
              )}
            </View>
            {!archived && menuOpen && <View style={layout.menu}>
              <Action title="归档" icon="archive" accessibilityLabel={`归档会话：${row.title}`} disabled={busy} feedback="warning"
                onPress={() => { setOpenMenuId(undefined); onArchive(row); }} />
            </View>}
          </View>
        );
      })}
    </View>
  ));
}

const layout = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
  divided: { borderBottomWidth: StyleSheet.hairlineWidth },
  open: { flex: 1, minWidth: 0, minHeight: 64, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 14 },
  icon: { width: 38, height: 38, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  details: { flex: 1, minWidth: 0, gap: 3 },
  restore: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, borderWidth: 1 },
  menu: { alignItems: "flex-end", paddingBottom: 8 },
});
