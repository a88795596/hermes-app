import { useCallback, useEffect, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { managementTimeout, type ManagementOperation, type Profile } from "@hermes-mobile/protocol";
import type { useWorkspace } from "../sync/use-workspace";
import { profileLabel } from "../ui/text";
import { EmptyState, useTheme, type IconName } from "../ui/theme";
import { haptic } from "../ui/haptics";
import { ScheduledTasks } from "./cron";
import { Models } from "./models";
import { Logs } from "./logs";
import { Skills } from "./skills";
import { Mcp } from "./mcp";
import { Group, ManagementContext, Row, type ManageCall } from "./shared";

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
  const { colors, styles } = useTheme();
  if (!profile) return <EmptyState icon="manage" title="暂无 Hermes 配置档案" description="连接服务器后刷新以加载配置档案。" />;
  return <>
    <View style={layout.profileSection}>
      <Text accessibilityRole="header" style={styles.sectionLabel}>配置档案</Text>
      <View style={[layout.profiles, { borderColor: colors.edge }]}>
        {profiles.map((item) => <Pressable key={item.profile_id} accessibilityRole="button" accessibilityLabel={profileLabel(item)}
          accessibilityState={{ selected: item.profile_id === profile.profile_id }}
          onPress={() => { if (item.profile_id !== profile.profile_id) { haptic("selection"); onProfile(item.profile_id); } }}
          style={({ pressed }) => [layout.profile, item.profile_id === profile.profile_id && { backgroundColor: colors.tint }, pressed && styles.faded]}>
          <Text style={styles.label}>{profileLabel(item)}</Text>
        </Pressable>)}
      </View>
    </View>
    <Group>{(Object.keys(pages) as ManagementPage[]).map((page, index) => <Row key={page} divided={index > 0}
      title={pages[page].title} icon={pages[page].icon} onPress={() => onOpen(page)} />)}</Group>
  </>;
}

export function ManagementScreen({ page, profile, request, onBack, onTabVisibilityChange }: {
  page: ManagementPage; profile: Profile; request: ReturnType<typeof useWorkspace>["call"];
  onBack: () => void; onTabVisibilityChange?: (visible: boolean) => void;
}) {
  const { Screen } = pages[page];
  const call = useCallback(<T,>(operation: ManagementOperation, input?: object, signal?: AbortSignal) =>
    request<T>(`/profiles/${profile.profile_id}/manage/${operation}`, {
      method: "POST", body: input ? { input } : {}, signal, timeoutMs: managementTimeout(operation) + 8_000,
    }),
  [profile.profile_id, request]);

  const context = useMemo(() => ({ label: profileLabel(profile), onBack, onTabVisibilityChange }), [profile, onBack, onTabVisibilityChange]);
  useEffect(() => () => onTabVisibilityChange?.(true), [onTabVisibilityChange]);
  return <ManagementContext.Provider value={context}>
      <Screen call={call} />
  </ManagementContext.Provider>;
}

const layout = StyleSheet.create({
  profileSection: { gap: 12 },
  profiles: { flexDirection: "row", flexWrap: "wrap", borderWidth: StyleSheet.hairlineWidth, borderRadius: 13, overflow: "hidden", alignSelf: "flex-start" },
  profile: { minHeight: 46, minWidth: 120, paddingHorizontal: 22, paddingVertical: 10, alignItems: "center", justifyContent: "center", borderRadius: 12 },
});
