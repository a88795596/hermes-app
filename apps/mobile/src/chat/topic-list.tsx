import { Pressable, StyleSheet, Text, View } from "react-native";
import { Group } from "../manage/shared";
import { haptic } from "../ui/haptics";
import { Action, Icon, useTheme } from "../ui/theme";
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
  const now = new Date();
  const action = archived ? "恢复" : "归档";

  return groupTopics(rows, now).map(({ title, rows }) => (
    <View key={title ?? "undated"}>
      {title && <Text accessibilityRole="header" style={styles.sectionLabel}>{title}</Text>}
      <Group>
        {rows.map((row, index) => {
          const created = `创建 ${formatTopicTime(row.created_at, now)}`;
          const updated = `更新 ${formatTopicTime(row.updated_at ?? row.created_at, now)}`;
          return (
            <View key={row.id} style={[layout.row, index > 0 && { borderTopColor: colors.edge, borderTopWidth: StyleSheet.hairlineWidth }]}>
              <Pressable accessibilityRole="button" accessibilityLabel={[row.title, row.profileLabel, row.status, created, updated].filter(Boolean).join("，")}
                onPress={() => { haptic("light"); onOpen(row); }}
                style={({ pressed }) => [styles.listItem, layout.open, pressed && { backgroundColor: colors.secondary }]}>
                <View style={[layout.icon, { backgroundColor: colors.tint }]}><Icon name="chat" size={17} color={colors.accent} /></View>
                <View style={layout.details}>
                  <Text numberOfLines={1} ellipsizeMode="tail" style={styles.heading}>{row.title}</Text>
                  {!!row.profileLabel && <Text style={styles.caption}>{row.profileLabel}</Text>}
                  {!!row.status && <Text style={styles.caption}>{row.status}</Text>}
                  <View style={layout.times}>
                    <Text style={styles.caption}>{created}</Text>
                    <Text style={styles.caption}>{updated}</Text>
                  </View>
                </View>
              </Pressable>
              <Action compact title={action} accessibilityLabel={`${action}会话：${row.title}`} disabled={busy}
                feedback={archived ? "medium" : "warning"}
                onPress={() => onArchive(row)} />
            </View>
          );
        })}
      </Group>
    </View>
  ));
}

const layout = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingRight: 10 },
  open: { flex: 1, minWidth: 0, paddingRight: 4 },
  icon: { width: 29, height: 29, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  details: { flex: 1, minWidth: 0, gap: 3 },
  times: { flexDirection: "row", flexWrap: "wrap", columnGap: 10, rowGap: 2 },
});
