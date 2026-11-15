import { useCallback, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { haptic } from "../ui/haptics";
import { Action, EmptyState, Field, Icon, Notice, useTheme, type IconName } from "../ui/theme";
import { ActionState, Confirm, DataState, EditField, FormHeader, Group, InstallProgress, ManagementHeader, ManagementLayout,
  Row, Toggle, entries, mono, useManagementAction, useManagementData, type ManageCall } from "./shared";

type Server = { name: string; transport: "http" | "stdio" | "unknown"; url?: string; command?: string; args?: string[];
  enabled: boolean; env_keys?: string[]; auth?: "header" | "oauth"; tools?: { include?: string[]; exclude?: string[] };
  url_masked?: boolean; args_masked?: boolean; bearer_managed?: boolean };
type Probe = { ok: boolean; error?: string; tools: { name: string; description?: string }[] };
const transports = new Map([["http", "HTTP"], ["stdio", "标准输入输出"], ["unknown", "传输方式未知"]]);
const authentication = { header: "请求头认证", oauth: "OAuth" };

function transportIcon(transport: string): IconName {
  return transport === "http" ? "link" : transport === "stdio" ? "server" : "mcp";
}

function DetailLine({ icon, label, value, code }: { icon: IconName; label: string; value: string; code?: boolean }) {
  const { styles } = useTheme();
  return <DetailRow icon={icon}>
    <Text style={styles.heading}>{label}</Text>
    <Text selectable style={[styles.muted, code && layout.code]}>{value}</Text>
  </DetailRow>;
}

function DetailRow({ icon, children }: { icon: IconName; children: ReactNode }) {
  const { colors } = useTheme();
  return <View style={[layout.detailRow, { borderColor: colors.edge }]}>
    <View style={[layout.icon, { backgroundColor: colors.tint }]}><Icon name={icon} size={20} color={colors.accent} /></View>
    <View style={layout.rowBody}>{children}</View>
  </View>;
}

export function Mcp({ call }: { call: ManageCall }) {
  const { colors, styles } = useTheme();
  const servers = useManagementData<{ servers: Server[] }>(call, "mcp.list");
  const action = useManagementAction();
  const [selected, select] = useState<string>();
  const [editing, edit] = useState(false);
  const [rotating, rotate] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [catalog, showCatalog] = useState(false);
  const [probe, setProbe] = useState<Probe>();
  const server = servers.data?.servers.find((item) => item.name === selected);
  function closeToken() { rotate(false); setReplacement(""); }
  function close() { select(undefined); edit(false); setProbe(undefined); closeToken(); }

  if (catalog) return <Catalog call={call} onClose={() => { showCatalog(false); void servers.reload(); }} />;

  if (editing) return <ServerForm server={server} busy={action.busy} onCancel={() => edit(false)}
    onSave={(values) => void action.run(async () => {
      await call(server ? "mcp.edit" : "mcp.add", values);
      haptic("success");
      edit(false);
      setProbe(undefined);
      await servers.reload();
      return server ? "服务器设置已保存。" : "MCP 服务器已添加。";
    })}>
    <ActionState {...action} />
  </ServerForm>;

  const refresh = <Action icon="refresh" title="刷新" disabled={servers.loading || action.busy} onPress={() => void servers.reload()} />;
  if (server) {
    const stdio = server.transport === "stdio";
    const http = server.transport === "http";
    const auth = server.auth ? authentication[server.auth] : "无身份验证";
    const target = server.url || [server.command, ...(server.args ?? [])].filter(Boolean).join(" ");
    const compactEndpoint = http && !!target && (rotating || !!probe);
    return <ManagementLayout key={`server:${server.name}`} hideTabs header={
      <ManagementHeader title={server.name} backLabel="全部服务器" backDisabled={action.busy} onBack={close} trailing={refresh} />
    }>
      <DataState {...servers} />
      <ActionState {...action} />
      <View style={[layout.lines, { borderColor: colors.edge }]}>
        {compactEndpoint ? <DetailRow icon="link">
          <Text selectable style={styles.heading}>{target}</Text>
          <Text style={styles.muted}>HTTP · {auth}</Text>
        </DetailRow> : <>
          {!!target && <DetailLine icon={transportIcon(server.transport)} label={stdio ? "命令" : "端点"} value={target} code={stdio} />}
          <DetailLine icon="layers" label="传输方式" value={transports.get(server.transport) ?? server.transport} />
          {http && <DetailLine icon="shield" label="身份验证" value={auth} />}
        </>}
        {!!server.env_keys?.length && <DetailLine icon="settings" label="环境变量" value={server.env_keys.join("、")} code />}
        {!!server.tools?.include?.length && <DetailLine icon="skill" label="包含的工具" value={server.tools.include.join("、")} code />}
        {!!server.tools?.exclude?.length && <DetailLine icon="skill" label="排除的工具" value={server.tools.exclude.join("、")} code />}
        <DetailRow icon="server"><Toggle label="启用服务器" value={server.enabled} disabled={action.busy} onChange={(enabled) => void action.run(async () => {
          await call("mcp.toggle", { name: server.name, enabled });
          haptic("success");
          await servers.reload();
          return enabled ? "MCP 服务器已启用。" : "MCP 服务器已停用。";
        })} /></DetailRow>
      </View>
      <View style={[layout.actions, !stdio && layout.pairedActions]}>
        <Action icon="compose" title="编辑服务器" primary={stdio} disabled={action.busy} style={!stdio && layout.actionColumn}
          onPress={() => { closeToken(); edit(true); }} />
        <Action icon="link" title="测试连接" disabled={action.busy} style={!stdio && layout.actionColumn}
          onPress={() => void action.run(async () => {
            setProbe(undefined);
            const result = await call<Probe>("mcp.test", { name: server.name });
            haptic(result.ok ? "success" : "error");
            setProbe(result);
          })} />
      </View>
      {server.bearer_managed && (rotating ? <View style={layout.actions}>
        <EditField label="新的 Bearer 令牌" value={replacement} onChangeText={setReplacement} secureTextEntry autoComplete="off" editable={!action.busy} />
        <View style={[styles.row, layout.actions]}>
          <Action primary title="保存 Bearer 令牌" disabled={action.busy || !replacement.trim()} style={layout.actionColumn}
            onPress={() => void action.run(async () => {
              await call("mcp.token", { name: server.name, bearer_token: replacement.trim() });
              haptic("success");
              closeToken();
              setProbe(undefined);
              return "Bearer 令牌已更新。";
            })} />
          <Action title="取消" disabled={action.busy} onPress={closeToken} />
        </View>
      </View> : <Action icon="key" title="更新 Bearer 令牌" disabled={action.busy} onPress={() => rotate(true)} />)}
      <View style={[layout.section, { borderColor: colors.edge }]}>
        <Confirm title="移除服务器" description={`确定从 Hermes 移除「${server.name}」吗？`} disabled={action.busy}
          onConfirm={() => void action.run(async () => { await call("mcp.remove", { name: server.name }); haptic("success"); close(); await servers.reload(); return "MCP 服务器已移除。"; })} />
      </View>
      {probe && <View style={[layout.section, { borderColor: colors.edge }]}>
        <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={[styles.heading, { color: colors.accent }]}>
          {probe.ok ? `已连接 · ${probe.tools.length} 个工具` : "连接失败"}
        </Text>
        {probe.error && <Notice>{probe.error}</Notice>}
        {probe.tools.map((tool) => <DetailRow key={tool.name} icon="skill">
          <Text selectable style={[styles.text, layout.code]}>{tool.name}</Text>
          {tool.description && <Text style={styles.caption}>{tool.description}</Text>}
        </DetailRow>)}
      </View>}
    </ManagementLayout>;
  }

  return <ManagementLayout key="servers" header={<ManagementHeader title="MCP 服务器" />}>
    <View style={[styles.row, layout.actions]}>
      <Action primary icon="plus" title="添加服务器" disabled={!servers.data} onPress={() => edit(true)} />
      <Action icon="layers" title="浏览目录" onPress={() => showCatalog(true)} />
      {refresh}
    </View>
    <DataState {...servers} />
    <ActionState {...action} />
    {servers.data?.servers.length ? <Group>
      {servers.data.servers.map((item, index) => <Row key={item.name} divided={index > 0} title={item.name} subtitle={item.url || item.command}
        icon={transportIcon(item.transport)} value={item.enabled ? "已启用" : "已停用"}
        onPress={() => { setProbe(undefined); select(item.name); }} />)}
    </Group> : servers.data && <EmptyState icon="mcp" title="暂无 MCP 服务器" description="手动添加服务器，或从 Hermes 目录安装。" />}
  </ManagementLayout>;
}

function ServerForm({ server, busy, onCancel, onSave, children }: {
  server?: Server; busy: boolean; onCancel: () => void; onSave: (values: object) => void; children: ReactNode;
}) {
  const { colors, styles } = useTheme();
  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState<Server["transport"]>(server?.transport ?? "http");
  const initialUrl = server?.url_masked ? "" : server?.url ?? "";
  const [url, setUrl] = useState(initialUrl);
  const [command, setCommand] = useState(server?.command ?? "");
  const [initialArgs] = useState(() => server?.args_masked ? "" : JSON.stringify(server?.args ?? []));
  const [args, setArgs] = useState(initialArgs);
  const [env, setEnv] = useState("");
  const [removeEnv, setRemoveEnv] = useState("");
  const [token, setToken] = useState("");
  const [oauth, setOauth] = useState(false);
  const [include, setInclude] = useState(server?.tools?.include?.join(", ") ?? "");
  const [exclude, setExclude] = useState(server?.tools?.exclude?.join(", ") ?? "");
  const [error, setError] = useState<string>();
  const initialInclude = server?.tools?.include?.join(", ") ?? "";
  const initialExclude = server?.tools?.exclude?.join(", ") ?? "";
  const dirty = !server || url !== initialUrl || command !== (server.command ?? "") || args !== initialArgs || !!env.trim()
    || !!removeEnv.trim() || include !== initialInclude || exclude !== initialExclude;

  function save() {
    setError(undefined);
    const values: Record<string, unknown> = { name: name.trim() };
    if (transport === "http") {
      if (url.trim() !== initialUrl) values.url = url.trim();
      if (!server && token.trim() && !oauth) values.bearer_token = token.trim();
      if (!server && oauth) values.auth = "oauth";
    } else if (transport === "stdio") {
      if (command.trim() !== server?.command) values.command = command.trim();
      if (args !== initialArgs) {
        try {
          const parsed: unknown = JSON.parse(args.trim() || "[]");
          if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error();
          values.args = parsed;
        } catch { setError("参数必须是 JSON 字符串数组，例如 [\"server.js\", \"--flag\"]。"); return; }
      }
      if (env.trim()) {
        const vars = env.split(/\r?\n/u).filter((line) => line.trim()).map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line));
        if (vars.some((line) => !line)) { setError("每行填写一个环境变量，格式为 NAME=value。"); return; }
        values.env = Object.fromEntries(vars.map((line) => [line![1], line![2]]));
      }
      if (removeEnv.trim()) values.remove_env = entries(removeEnv);
    }
    if (server && (include !== initialInclude || exclude !== initialExclude)) {
      values.tools = { include: entries(include), exclude: entries(exclude) };
    }
    onSave(values);
  }

  const disabled = busy || !dirty || !name.trim() || (transport === "http" && !url.trim() && !server?.url_masked)
    || (transport === "stdio" && !command.trim());
  const section = [layout.section, { borderColor: colors.edge }];
  const sectionTitle = [styles.heading, { color: colors.accent }];
  return <ManagementLayout hideTabs header={
    <FormHeader title={server ? `编辑「${server.name}」` : "添加 MCP 服务器"} onCancel={onCancel} onSave={save}
      saveLabel={busy ? "保存中…" : "保存"} disabled={disabled} cancelDisabled={busy} />
  }>
    {children}
    {error && <Notice>{error}</Notice>}
    {!server && <>
      <EditField label="服务器名称" value={name} onChangeText={setName} editable={!busy} />
      <View style={[styles.row, layout.actions]}>
        <Action title="HTTP" selected={transport === "http"} disabled={busy} onPress={() => setTransport("http")} />
        <Action title="标准输入输出" selected={transport === "stdio"} disabled={busy} onPress={() => setTransport("stdio")} />
      </View>
    </>}
    {transport === "http" && <View style={section}>
      <EditField label="服务器地址" value={url} onChangeText={setUrl} keyboardType="url" editable={!busy}
        placeholder={server?.url_masked ? server.url : undefined}
        help={server?.url_masked ? "输入完整地址，以替换已保存的地址及查询参数。" : undefined} />
      {server?.auth === "header" && <Text style={styles.caption}>Hermes 会保留此服务器现有的 Authorization 请求头。</Text>}
      {!server && <>
        <DetailRow icon="shield"><Toggle label="使用 OAuth" value={oauth} onChange={setOauth} disabled={busy} /></DetailRow>
        {oauth ? <Text style={styles.caption}>请在主机上的 Hermes 控制台完成 OAuth 登录。</Text> :
          <EditField label="Bearer 令牌（选填）" value={token} onChangeText={setToken} secureTextEntry autoComplete="off" editable={!busy} />}
      </>}
    </View>}
    {transport === "stdio" && <>
      <View style={section}>
        {server && <Text accessibilityRole="header" style={sectionTitle}>启动配置</Text>}
        <EditField label="命令" value={command} onChangeText={setCommand} placeholder="npx" style={layout.code} editable={!busy} />
        <EditField label="参数" value={args} onChangeText={setArgs} multiline style={layout.code} editable={!busy}
          placeholder={server?.args_masked ? JSON.stringify(server.args) : undefined}
          help={server?.args_masked ? "输入完整的 JSON 数组以替换已保存的参数，留空则保留原参数。"
            : "JSON 数组，例如 [\"-y\", \"package-name\"]"} />
      </View>
      <View style={section}>
        {server && <Text accessibilityRole="header" style={sectionTitle}>环境变量</Text>}
        <EditField label={server ? "设置环境变量" : "环境变量（选填）"} value={env} onChangeText={setEnv} multiline style={layout.code} editable={!busy}
          help="每行填写一个 NAME=value。填写密钥时，可引用 Hermes 中已有的环境变量。" />
        {!!server?.env_keys?.length && <EditField label="移除环境变量" value={removeEnv} onChangeText={setRemoveEnv} editable={!busy}
          help={server.env_keys.join(", ")} />}
      </View>
    </>}
    {server && <View style={section}>
      <Text accessibilityRole="header" style={sectionTitle}>工具范围</Text>
      <EditField label="包含的工具" value={include} onChangeText={setInclude} editable={!busy}
        help="名称或匹配模式，用英文逗号分隔。包含列表优先于排除列表。" />
      <EditField label="排除的工具" value={exclude} onChangeText={setExclude} editable={!busy} />
    </View>}
  </ManagementLayout>;
}

type CatalogEntry = { name: string; description: string; transport: string; installed: boolean; command?: string; url?: string; args?: string[];
  required_env?: { name: string; prompt?: string; required: boolean }[]; post_install?: string };

function Catalog({ call, onClose }: { call: ManageCall; onClose: () => void }) {
  const { colors, styles } = useTheme();
  const catalog = useManagementData<{ entries: CatalogEntry[] }>(call, "mcp.catalog");
  const action = useManagementAction();
  const [selected, select] = useState<CatalogEntry>();
  const [search, setSearch] = useState("");
  const [env, setEnv] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string>();
  const [installed, setInstalled] = useState<{ message?: string; error?: string }>();
  const results = catalog.data?.entries.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(search.trim().toLowerCase()));
  const reloadCatalog = catalog.reload;
  const finishInstall = useCallback((message: string, failed?: boolean) => {
    setPending(undefined);
    setInstalled(failed ? { error: message } : { message });
    if (!failed) { select(undefined); setEnv({}); }
    void reloadCatalog();
  }, [reloadCatalog]);
  const busy = action.busy || !!pending;
  const target = selected?.url || [selected?.command, ...(selected?.args ?? [])].filter(Boolean).join(" ");

  return <ManagementLayout key={selected ? `entry:${selected.name}` : "catalog"} hideTabs header={
    <ManagementHeader title={selected?.name ?? "MCP 目录"} backLabel={selected ? "目录" : "全部服务器"} backDisabled={busy}
      onBack={selected ? () => select(undefined) : onClose}
      trailing={<Action icon="refresh" title="刷新目录" primary={!selected} disabled={catalog.loading || busy}
        onPress={() => void reloadCatalog()} />} />
  }>
    <DataState {...catalog} />
    <ActionState {...action} />
    {installed && <ActionState {...installed} />}
    {pending && <InstallProgress call={call} name={pending} onDone={finishInstall} />}
    {selected ? <View style={[layout.section, { borderColor: colors.edge }]}>
      <Text style={styles.text}>{selected.description}</Text>
      {!!target && <Text selectable style={[styles.text, layout.code, layout.command, { backgroundColor: colors.field }]}>{target}</Text>}
      {selected.post_install && <Text style={styles.muted}>{selected.post_install}</Text>}
      {selected.installed ? <Text style={styles.caption}>已安装</Text> : <>
        {selected.required_env?.map((item) => <EditField key={item.name} label={item.name} help={item.prompt} value={env[item.name] ?? ""}
          secureTextEntry autoComplete="off" editable={!busy} onChangeText={(value) => setEnv({ ...env, [item.name]: value })} />)}
        <Action primary title={busy ? "安装中…" : "安装 MCP 服务器"} disabled={busy
          || selected.required_env?.some((item) => item.required && !env[item.name]?.trim())}
          onPress={() => void action.run(async () => {
            setInstalled(undefined);
            const result = await call<{ background?: boolean; action?: string }>("mcp.install", { name: selected.name, env });
            if (result.background) {
              if (!result.action) return "安装已启动，请刷新目录查看结果。";
              setPending(result.action);
            } else {
              haptic("success");
              select(undefined); setEnv({}); await reloadCatalog(); return "MCP 服务器已安装。";
            }
          })} />
      </>}
    </View> : catalog.data && <>
      <View style={layout.search}>
        <Field accessibilityLabel="搜索 MCP 目录" placeholder="搜索 MCP 目录" value={search} onChangeText={setSearch}
          autoCapitalize="none" autoCorrect={false} returnKeyType="search" style={layout.searchField} />
        <View pointerEvents="none" style={layout.searchIcon}><Icon name="search" size={20} color={colors.muted} /></View>
      </View>
      {results?.length ? <Group>
        {results.map((item, index) => <Row key={item.name} divided={index > 0} title={item.name} subtitle={item.description} icon={transportIcon(item.transport)}
          value={item.installed ? "已安装" : transports.get(item.transport) ?? item.transport} onPress={() => { select(item); setEnv({}); }} />)}
      </Group> : <EmptyState icon="mcp" title="暂无匹配结果" description="试试其他关键词，或手动添加服务器。" />}
    </>}
  </ManagementLayout>;
}

const layout = StyleSheet.create({
  lines: { borderTopWidth: StyleSheet.hairlineWidth },
  detailRow: { minHeight: 60, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row", alignItems: "center", gap: 12 },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  rowBody: { flex: 1, minWidth: 0, gap: 3 },
  code: { fontFamily: mono },
  command: { borderRadius: 12, padding: 12 },
  actions: { gap: 8 },
  pairedActions: { flexDirection: "row", flexWrap: "wrap" },
  actionColumn: { flexGrow: 1, flexBasis: 128, minWidth: 0 },
  section: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 16, gap: 12 },
  search: { justifyContent: "center" },
  searchField: { paddingStart: 40 },
  searchIcon: { position: "absolute", start: 12 },
});
