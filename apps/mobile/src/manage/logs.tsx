import { useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ComposerSheet } from "../chat/composer-menu";
import { haptic } from "../ui/haptics";
import { Action, EmptyState, Icon, useTheme, type IconName } from "../ui/theme";
import {
  ActionState, DataState, EditField, ManagementHeader, ManagementLayout, mono,
  useManagementAction, useManagementData, type ManageCall,
} from "./shared";

const files = ["agent", "errors", "gateway", "gui", "desktop", "mcp"];
const levels = ["DEBUG", "INFO", "WARNING", "ERROR"];
const components = ["all", "agent", "gateway", "tools", "cli", "cron", "gui"];
const labels = new Map([
  ["ALL", "全部"], ["all", "全部"], ["agent", "智能体"], ["errors", "错误"], ["gateway", "网关"], ["gui", "图形界面"],
  ["desktop", "桌面端"], ["mcp", "MCP"], ["tools", "工具"], ["cli", "命令行"], ["cron", "定时任务"],
  ["DEBUG", "调试"], ["INFO", "信息"], ["WARNING", "警告"], ["ERROR", "错误"], ["CRITICAL", "严重错误"],
]);
const logPrefix = /^((?:\d{4}-\d{2}-\d{2}[ T])?\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\s+)(DEBUG|INFO|WARNING|ERROR|CRITICAL)(\s+(?:\[[^\]]+\]\s+)?[^:\s]+(?::\s*|\s+))/u;

export function Logs({ call }: { call: ManageCall }) {
  const { colors, styles } = useTheme();
  const [filters, setFilters] = useState({ file: "agent", level: "ALL", component: "all", search: "", lines: 100 });
  const [search, setSearch] = useState("");
  const [sheet, setSheet] = useState<"filters" | "settings">();
  const [level, setLevel] = useState("INFO");
  const data = useManagementData<{ file: string; level: string; lines: string[] }>(call, "logs.read", filters);
  const action = useManagementAction();
  const choices = (values: string[], selected: string, choose: (value: string) => void, disabled?: boolean) =>
    <View style={styles.row}>{values.map((value) => <Action key={value} title={labels.get(value) ?? value}
      disabled={disabled} selected={selected === value} onPress={() => choose(value)}
      style={[layout.choice, sheet === "settings" && layout.fill,
        sheet === "filters" && selected !== value && { borderColor: colors.edge, backgroundColor: "transparent" }]} />)}</View>;
  const applySearch = () => {
    setFilters({ ...filters, search });
    setSheet(undefined);
  };

  return <ManagementLayout header={<ManagementHeader title="日志" />}>
    <View style={styles.row}>
      <Action icon="refresh" title="刷新" style={layout.fill} disabled={data.loading || action.busy} onPress={() => void data.reload()} />
      <Action icon="manage" title="筛选" style={layout.fill} onPress={() => setSheet("filters")} />
      <Action icon="settings" title="日志设置" style={layout.fill} disabled={!data.data || action.busy}
        onPress={() => { setLevel(data.data?.level ?? "INFO"); setSheet("settings"); }} />
    </View>
    <Text style={styles.caption}>来源 · 连接器所在主机的 Hermes 日志</Text>
    {sheet !== "settings" && <ActionState {...action} />}
    <DataState {...data} />
    {data.data?.file === filters.file && !data.loading && !data.error && (
      data.data.lines.length ? <View style={[layout.entries, { borderColor: colors.edge }]}>
        <Text accessibilityRole="header" style={[styles.heading, layout.entryTitle]}>
          {labels.get(data.data.file) ?? data.data.file} · {data.data.lines.length} 行
        </Text>
        {data.data.lines.map((line, index) => <LogLine key={index} line={line} />)}
      </View> : <EmptyState icon="logs" title="暂无匹配的日志" description="试试其他日志文件，或清除筛选条件。" />
    )}
    {sheet === "filters" && <ComposerSheet title="筛选日志" closeLabel="关闭筛选" onClose={() => setSheet(undefined)}>
      <ScrollView style={layout.sheetScroll} contentContainerStyle={layout.filterBody} keyboardShouldPersistTaps="handled">
        <FilterGroup title="日志文件" icon="logs">{choices(files, filters.file, (file) => setFilters({ ...filters, file }))}</FilterGroup>
        <FilterGroup title="最低级别" icon="activity">
          {choices(["ALL", ...levels, "CRITICAL"], filters.level, (level) => setFilters({ ...filters, level }))}
        </FilterGroup>
        <FilterGroup title="组件" icon="mcp">
          {choices(components, filters.component, (component) => setFilters({ ...filters, component }))}
        </FilterGroup>
        <FilterGroup title="最近行数" icon="skill">
          {choices(["50", "100", "200"], String(filters.lines), (lines) => setFilters({ ...filters, lines: Number(lines) }))}
        </FilterGroup>
        <EditField label="关键词" value={search} onChangeText={setSearch} returnKeyType="search" onSubmitEditing={applySearch} />
        <Action primary title="按关键词筛选" onPress={applySearch} />
      </ScrollView>
    </ComposerSheet>}
    {sheet === "settings" && <ComposerSheet title="日志设置" closeLabel="关闭日志设置" busy={action.busy} onClose={() => setSheet(undefined)}>
      <ScrollView style={layout.sheetScroll} contentContainerStyle={layout.filterBody} keyboardShouldPersistTaps="handled">
        <ActionState {...action} />
        <View style={layout.settingIntro}>
          <Text accessibilityRole="header" style={styles.heading}>日志级别</Text>
          <Text style={styles.muted}>此设置控制 Hermes 写入哪些日志。重启相应的 Hermes 进程后生效。</Text>
        </View>
        {choices(levels, level, setLevel, action.busy)}
        <Action primary title={action.busy ? "保存中…" : "保存日志级别"} disabled={action.busy || data.data?.level === level}
          onPress={() => void action.run(async () => {
            await call("logs.level", { level });
            haptic("success");
            await data.reload();
            return "日志级别已保存。";
          })} />
      </ScrollView>
    </ComposerSheet>}
  </ManagementLayout>;
}

function FilterGroup({ title, icon, children }: { title: string; icon: IconName; children: ReactNode }) {
  const { colors, styles } = useTheme();
  return <View style={[layout.filterGroup, { borderColor: colors.edge }]}>
    <View style={styles.row}>
      <Icon name={icon} size={17} color={colors.accent} />
      <Text accessibilityRole="header" style={styles.heading}>{title}</Text>
    </View>
    {children}
  </View>;
}

function LogLine({ line }: { line: string }) {
  const { colors, styles } = useTheme();
  const raw = line.replace(/\r?\n$/u, "");
  const prefix = logPrefix.exec(raw);
  return <View style={[layout.entry, { borderBottomColor: colors.edge }]}>
    <Text selectable style={[styles.text, layout.logText]}>
      {prefix ? <>
        {prefix[1]}
        <Text style={[layout.level, { color: colors.accent, backgroundColor: colors.tint }]}>{prefix[2]}</Text>
        <Text style={{ color: colors.muted }}>{prefix[3]}</Text>
        {raw.slice(prefix[0].length)}
      </> : raw}
    </Text>
  </View>;
}

const layout = StyleSheet.create({
  entries: { borderTopWidth: StyleSheet.hairlineWidth },
  entryTitle: { paddingTop: 16, paddingBottom: 8 },
  entry: { minHeight: 44, justifyContent: "center", paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  logText: { fontFamily: mono, fontSize: 14, lineHeight: 21 },
  level: { fontWeight: "700" },
  choice: { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 9 },
  fill: { flexGrow: 1 },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  filterBody: { gap: 12 },
  filterGroup: { gap: 6, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  settingIntro: { gap: 6 },
});
