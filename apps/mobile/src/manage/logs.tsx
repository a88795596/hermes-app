import { useState } from "react";
import { Text, View } from "react-native";
import { Action, Card, EmptyState, useTheme } from "../ui/theme";
import { ActionState, DataState, EditField, mono, useManagementAction, useManagementData, type ManageCall } from "./shared";

const files = ["agent", "errors", "gateway", "gui", "desktop", "mcp"];
const levels = ["DEBUG", "INFO", "WARNING", "ERROR"];
const components = ["all", "agent", "gateway", "tools", "cli", "cron", "gui"];
const labels = new Map([
  ["ALL", "全部"], ["all", "全部"], ["agent", "智能体"], ["errors", "错误"], ["gateway", "网关"], ["gui", "图形界面"],
  ["desktop", "桌面端"], ["mcp", "MCP"], ["tools", "工具"], ["cli", "命令行"], ["cron", "定时任务"],
  ["DEBUG", "调试"], ["INFO", "信息"], ["WARNING", "警告"], ["ERROR", "错误"], ["CRITICAL", "严重错误"],
]);

export function Logs({ call }: { call: ManageCall }) {
  const { styles } = useTheme();
  const [filters, setFilters] = useState({ file: "agent", level: "ALL", component: "all", search: "", lines: 100 });
  const [search, setSearch] = useState("");
  const [options, showOptions] = useState(false);
  const [settings, showSettings] = useState(false);
  const [level, setLevel] = useState("INFO");
  const data = useManagementData<{ file: string; level: string; lines: string[] }>(call, "logs.read", filters);
  const action = useManagementAction();
  const choices = (values: string[], selected: string, choose: (value: string) => void) =>
    <View style={styles.row}>{values.map((value) => <Action key={value} title={labels.get(value) ?? value}
      selected={selected === value} onPress={() => choose(value)} />)}</View>;

  return <>
    <View style={styles.row}>
      <Action icon="refresh" title="刷新" disabled={data.loading || action.busy} onPress={() => void data.reload()} />
      <Action title={options ? "隐藏筛选条件" : "筛选"} onPress={() => showOptions(!options)} />
      <Action title={settings ? "隐藏日志设置" : "日志设置"} disabled={!data.data || action.busy}
        onPress={() => { if (!settings) setLevel(data.data?.level ?? "INFO"); showSettings(!settings); }} />
    </View>
    <Text style={styles.caption}>来源 · 连接器所在主机的 Hermes 日志</Text>
    {options && <Card>
      <Text style={styles.label}>日志文件</Text>
      {choices(files, filters.file, (file) => setFilters({ ...filters, file }))}
      <Text style={styles.label}>最低级别</Text>
      {choices(["ALL", ...levels, "CRITICAL"], filters.level, (level) => setFilters({ ...filters, level }))}
      <Text style={styles.label}>组件</Text>
      {choices(components, filters.component, (component) => setFilters({ ...filters, component }))}
      <Text style={styles.label}>最近行数</Text>
      {choices(["50", "100", "200"], String(filters.lines), (lines) => setFilters({ ...filters, lines: Number(lines) }))}
      <EditField label="关键词" value={search} onChangeText={setSearch} returnKeyType="search"
        onSubmitEditing={() => setFilters({ ...filters, search })} />
      <Action title="按关键词筛选" onPress={() => setFilters({ ...filters, search })} />
    </Card>}
    <ActionState {...action} />
    {settings && <Card>
      <Text accessibilityRole="header" style={styles.heading}>日志级别</Text>
      <Text style={styles.muted}>此设置控制 Hermes 写入哪些日志。重启相应的 Hermes 进程后生效。</Text>
      {choices(levels, level, setLevel)}
      <Action primary title={action.busy ? "保存中…" : "保存日志级别"} disabled={action.busy || data.data?.level === level}
        onPress={() => void action.run(async () => { await call("logs.level", { level }); await data.reload(); return "日志级别已保存。"; })} />
    </Card>}
    <DataState {...data} />
    {data.data?.file === filters.file && !data.loading && !data.error && (
      data.data.lines.length ? <Card>
        <Text accessibilityRole="header" style={styles.heading}>{labels.get(data.data.file) ?? data.data.file} · {data.data.lines.length} 行</Text>
        <Text selectable style={[styles.text, { fontFamily: mono, fontSize: 12, lineHeight: 18 }]}>
          {data.data.lines.map((line) => line.replace(/\r?\n$/u, "")).join("\n")}
        </Text>
      </Card> : <EmptyState icon="logs" title="暂无匹配的日志" description="试试其他日志文件，或清除筛选条件。" />
    )}
  </>;
}
