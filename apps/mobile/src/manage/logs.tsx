import { useState } from "react";
import { Text, View } from "react-native";
import { Action, Card, EmptyState, useTheme } from "../ui/theme";
import { ActionState, DataState, EditField, mono, useManagementAction, useManagementData, type ManageCall } from "./shared";

const files = ["agent", "errors", "gateway", "gui", "desktop", "mcp"];
const levels = ["DEBUG", "INFO", "WARNING", "ERROR"];
const components = ["all", "agent", "gateway", "tools", "cli", "cron", "gui"];

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
    <View style={styles.row}>{values.map((value) => <Action key={value} title={value === "ALL" || value === "all" ? "All" : value}
      selected={selected === value} onPress={() => choose(value)} />)}</View>;

  return <>
    <View style={styles.row}>
      <Action icon="refresh" title="Refresh" disabled={data.loading || action.busy} onPress={() => void data.reload()} />
      <Action title={options ? "Hide filters" : "Filters"} onPress={() => showOptions(!options)} />
      <Action title={settings ? "Hide log settings" : "Log settings"} disabled={!data.data || action.busy}
        onPress={() => { if (!settings) setLevel(data.data?.level ?? "INFO"); showSettings(!settings); }} />
    </View>
    <Text style={styles.caption}>Source · Hermes logs on the Connector’s host</Text>
    {options && <Card>
      <Text style={styles.label}>Log file</Text>
      {choices(files, filters.file, (file) => setFilters({ ...filters, file }))}
      <Text style={styles.label}>Minimum level</Text>
      {choices(["ALL", ...levels, "CRITICAL"], filters.level, (level) => setFilters({ ...filters, level }))}
      <Text style={styles.label}>Component</Text>
      {choices(components, filters.component, (component) => setFilters({ ...filters, component }))}
      <Text style={styles.label}>Recent lines</Text>
      {choices(["50", "100", "200"], String(filters.lines), (lines) => setFilters({ ...filters, lines: Number(lines) }))}
      <EditField label="Keyword" value={search} onChangeText={setSearch} returnKeyType="search"
        onSubmitEditing={() => setFilters({ ...filters, search })} />
      <Action title="Apply keyword" onPress={() => setFilters({ ...filters, search })} />
    </Card>}
    <ActionState {...action} />
    {settings && <Card>
      <Text accessibilityRole="header" style={styles.heading}>Logging level</Text>
      <Text style={styles.muted}>This changes what Hermes writes. Restart the relevant Hermes process to apply it.</Text>
      {choices(levels, level, setLevel)}
      <Action primary title={action.busy ? "Saving…" : "Save logging level"} disabled={action.busy || data.data?.level === level}
        onPress={() => void action.run(async () => { await call("logs.level", { level }); await data.reload(); return "Logging level saved."; })} />
    </Card>}
    <DataState {...data} />
    {data.data?.file === filters.file && !data.loading && !data.error && (
      data.data.lines.length ? <Card>
        <Text accessibilityRole="header" style={styles.heading}>{data.data.file} · {data.data.lines.length} lines</Text>
        <Text selectable style={[styles.text, { fontFamily: mono, fontSize: 12, lineHeight: 18 }]}>
          {data.data.lines.map((line) => line.replace(/\r?\n$/u, "")).join("\n")}
        </Text>
      </Card> : <EmptyState icon="logs" title="No matching log lines" description="Try another log file or clear a filter." />
    )}
  </>;
}
