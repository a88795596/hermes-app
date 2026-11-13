import { useCallback } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { managementTimeout, type ManagementOperation, type Profile } from "@hermes-mobile/protocol";
import type { useWorkspace } from "../sync/use-workspace";
import { profileLabel } from "../ui/text";
import { Action, EmptyState, Icon, useTheme, type IconName } from "../ui/theme";
import { ScheduledTasks } from "./cron";
import { Models } from "./models";
import { Logs } from "./logs";
import { Skills } from "./skills";
import { Mcp } from "./mcp";
import { Group, Row, type ManageCall } from "./shared";

const pages = {
  cron: { title: "定时任务", summary: "执行计划与运行记录", icon: "schedule", Screen: ScheduledTasks },
  models: { title: "模型", summary: "模型配置与服务商密钥", icon: "model", Screen: Models },
  logs: { title: "日志", summary: "查看 Hermes 日志与设置日志级别", icon: "logs", Screen: Logs },
  skills: { title: "技能", summary: "已安装的技能和 SKILL.md", icon: "skill", Screen: Skills },
  mcp: { title: "MCP 服务器", summary: "管理服务器和工具，测试连接", icon: "mcp", Screen: Mcp },
} satisfies Record<string, { title: string; summary: string; icon: IconName; Screen: (props: { call: ManageCall }) => React.JSX.Element }>;

export type ManagementPage = keyof typeof pages;

export function ManagementMenu({ profiles, profile, onProfile, onOpen }: {
  profiles: Profile[]; profile?: Profile; onProfile: (id: string) => void; onOpen: (page: ManagementPage) => void;
}) {
  const { styles } = useTheme();
  if (!profile) return <EmptyState icon="manage" title="暂无 Hermes 配置档案" description="连接服务器后刷新以加载配置档案。" />;
  return <>
    <View>
      <Text accessibilityRole="header" style={styles.sectionLabel}>Hermes 配置档案</Text>
      {profiles.length > 1 ? <View style={styles.row}>
        {profiles.map((item) => <Action key={item.profile_id} title={profileLabel(item.label)} selected={item.profile_id === profile.profile_id}
          onPress={() => onProfile(item.profile_id)} />)}
      </View> : <View style={styles.listItem}><Text style={styles.text}>{profileLabel(profile.label)}</Text></View>}
    </View>
    <Group>{(Object.keys(pages) as ManagementPage[]).map((page, index) => <Row key={page} divided={index > 0}
      title={pages[page].title} subtitle={pages[page].summary} icon={pages[page].icon} onPress={() => onOpen(page)} />)}</Group>
  </>;
}

export function ManagementScreen({ page, profile, request, onBack }: {
  page: ManagementPage; profile: Profile; request: ReturnType<typeof useWorkspace>["call"]; onBack: () => void;
}) {
  const { colors, styles } = useTheme();
  const { Screen, title } = pages[page];
  const call = useCallback(<T,>(operation: ManagementOperation, input?: object, signal?: AbortSignal) =>
    request<T>(`/profiles/${profile.profile_id}/manage/${operation}`, {
      method: "POST", body: input ? { input } : {}, signal, timeoutMs: managementTimeout(operation) + 8_000,
    }),
  [profile.profile_id, request]);

  return <KeyboardAvoidingView style={layout.frame} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <View style={[layout.bar, { backgroundColor: colors.surface, borderColor: colors.edge }]}>
      <Pressable accessibilityRole="button" accessibilityLabel="返回管理" onPress={() => { Keyboard.dismiss(); onBack(); }}
        style={({ pressed }) => [layout.back, pressed && styles.faded]}>
        <Icon name="back" size={16} color={colors.accent} />
        <Text style={[styles.text, { color: colors.accent }]}>管理</Text>
      </Pressable>
    </View>
    <ScrollView contentContainerStyle={[styles.content, layout.page]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <View style={layout.heading}>
        <Text accessibilityRole="header" style={styles.title}>{title}</Text>
        <Text style={styles.muted}>配置档案 · {profileLabel(profile.label)}</Text>
      </View>
      <Screen call={call} />
    </ScrollView>
  </KeyboardAvoidingView>;
}

const layout = StyleSheet.create({
  frame: { flex: 1 },
  bar: { borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12 },
  back: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4, minHeight: 48, paddingHorizontal: 3 },
  page: { width: "100%", maxWidth: 680, alignSelf: "center", paddingTop: 16 },
  heading: { gap: 4 },
});
