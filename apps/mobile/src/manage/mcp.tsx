import { useState } from "react";
import { Text, View } from "react-native";
import { haptic } from "../ui/haptics";
import { Action, Card, CloseButton, EmptyState, Notice, useTheme } from "../ui/theme";
import { ActionState, Confirm, DataState, EditField, Group, InstallProgress, Row, Toggle, entries,
  useManagementAction, useManagementData, type ManageCall } from "./shared";

type Server = { name: string; transport: "http" | "stdio" | "unknown"; url?: string; command?: string; args?: string[];
  enabled: boolean; env_keys?: string[]; auth?: "header" | "oauth"; tools?: { include?: string[]; exclude?: string[] };
  url_masked?: boolean; args_masked?: boolean; bearer_managed?: boolean };
type Probe = { ok: boolean; error?: string; tools: { name: string; description?: string }[] };
const transports = new Map([["http", "HTTP"], ["stdio", "标准输入输出"], ["unknown", "传输方式未知"]]);
const authentication = { header: "请求头认证", oauth: "OAuth" };

export function Mcp({ call }: { call: ManageCall }) {
  const { styles } = useTheme();
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

  return <>
    <ActionState {...action} />
    {catalog ? <Catalog call={call} onClose={() => { showCatalog(false); void servers.reload(); }} /> : editing ?
      <ServerForm server={server} busy={action.busy} onCancel={() => edit(false)} onSave={(values) => void action.run(async () => {
        await call(server ? "mcp.edit" : "mcp.add", values);
        haptic("success");
        edit(false);
        setProbe(undefined);
        await servers.reload();
        return server ? "服务器设置已保存。" : "MCP 服务器已添加。";
      })} /> : server ? <>
      <View style={styles.row}>
        <Action icon="back" title="全部服务器" disabled={action.busy} onPress={close} />
        <Action icon="refresh" title="刷新" disabled={servers.loading || action.busy} onPress={() => void servers.reload()} />
      </View>
      <DataState {...servers} />
      <Card>
        <Text accessibilityRole="header" style={styles.heading}>{server.name}</Text>
        <Text selectable style={styles.text}>{server.url || [server.command, ...(server.args ?? [])].filter(Boolean).join(" ") || "传输方式未知"}</Text>
        <Text style={styles.caption}>{transports.get(server.transport) ?? server.transport}
          {server.transport === "http" ? ` · ${server.auth ? authentication[server.auth] : "无身份验证"}` : ""}</Text>
        {!!server.env_keys?.length && <Text style={styles.muted}>环境变量 · {server.env_keys.join("、")}</Text>}
        {!!server.tools?.include?.length && <Text style={styles.muted}>包含的工具 · {server.tools.include.join("、")}</Text>}
        {!!server.tools?.exclude?.length && <Text style={styles.muted}>排除的工具 · {server.tools.exclude.join("、")}</Text>}
        <Toggle label="启用服务器" value={server.enabled} disabled={action.busy} onChange={(enabled) => void action.run(async () => {
          await call("mcp.toggle", { name: server.name, enabled });
          haptic("success");
          await servers.reload();
          return enabled ? "MCP 服务器已启用。" : "MCP 服务器已停用。";
        })} />
        <View style={styles.row}>
          <Action title="编辑服务器" disabled={action.busy} onPress={() => { closeToken(); edit(true); }} />
          <Action title="测试连接" disabled={action.busy} onPress={() => void action.run(async () => {
            setProbe(undefined);
            const result = await call<Probe>("mcp.test", { name: server.name });
            haptic(result.ok ? "success" : "error");
            setProbe(result);
          })} />
        </View>
        {server.bearer_managed && (rotating ? <>
          <EditField label="新的 Bearer 令牌" value={replacement} onChangeText={setReplacement} secureTextEntry autoComplete="off" editable={!action.busy} />
          <View style={styles.row}>
            <Action primary title="保存 Bearer 令牌" disabled={action.busy || !replacement.trim()} onPress={() => void action.run(async () => {
              await call("mcp.token", { name: server.name, bearer_token: replacement.trim() });
              haptic("success");
              closeToken();
              setProbe(undefined);
              return "Bearer 令牌已更新。";
            })} />
            <CloseButton accessibilityLabel="取消" disabled={action.busy} onPress={closeToken} />
          </View>
        </> : <Action title="更新 Bearer 令牌" disabled={action.busy} onPress={() => rotate(true)} />)}
        <Confirm title="移除服务器" description={`确定从 Hermes 移除「${server.name}」吗？`} disabled={action.busy}
          onConfirm={() => void action.run(async () => { await call("mcp.remove", { name: server.name }); haptic("success"); close(); await servers.reload(); return "MCP 服务器已移除。"; })} />
      </Card>
      {probe && <Card>
        <Text accessibilityRole="header" style={styles.heading}>{probe.ok ? `已连接 · ${probe.tools.length} 个工具` : "连接失败"}</Text>
        {probe.error && <Notice>{probe.error}</Notice>}
        {probe.tools.map((tool) => <View key={tool.name}>
          <Text selectable style={styles.text}>{tool.name}</Text>
          {tool.description && <Text style={styles.caption}>{tool.description}</Text>}
        </View>)}
      </Card>}
    </> : <>
      <View style={styles.row}>
        <Action primary icon="compose" title="添加服务器" disabled={!servers.data} onPress={() => edit(true)} />
        <Action title="浏览目录" onPress={() => showCatalog(true)} />
        <Action icon="refresh" title="刷新" disabled={servers.loading} onPress={() => void servers.reload()} />
      </View>
      <DataState {...servers} />
      {servers.data?.servers.length ? <Group>
        {servers.data.servers.map((item, index) => <Row key={item.name} divided={index > 0} title={item.name} subtitle={item.url || item.command || undefined}
          value={item.enabled ? "已启用" : "已停用"} onPress={() => { setProbe(undefined); select(item.name); }} />)}
      </Group> : servers.data && <EmptyState icon="mcp" title="暂无 MCP 服务器" description="手动添加服务器，或从 Hermes 目录安装。" />}
    </>}
  </>;
}

function ServerForm({ server, busy, onCancel, onSave }: { server?: Server; busy: boolean; onCancel: () => void; onSave: (values: object) => void }) {
  const { styles } = useTheme();
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

  return <Card>
    <Text accessibilityRole="header" style={styles.heading}>{server ? `编辑「${server.name}」` : "添加 MCP 服务器"}</Text>
    {!server && <>
      <EditField label="服务器名称" value={name} onChangeText={setName} editable={!busy} />
      <View style={styles.row}>
        <Action title="HTTP" selected={transport === "http"} disabled={busy} onPress={() => setTransport("http")} />
        <Action title="标准输入输出" selected={transport === "stdio"} disabled={busy} onPress={() => setTransport("stdio")} />
      </View>
    </>}
    {transport === "http" && <>
      <EditField label="服务器地址" value={url} onChangeText={setUrl} keyboardType="url" editable={!busy}
        placeholder={server?.url_masked ? server.url : undefined}
        help={server?.url_masked ? "输入完整地址，以替换已保存的地址及查询参数。" : undefined} />
      {server?.auth === "header" && <Text style={styles.caption}>Hermes 会保留此服务器现有的 Authorization 请求头。</Text>}
      {!server && <>
        <Toggle label="使用 OAuth" value={oauth} onChange={setOauth} disabled={busy} />
        {oauth ? <Text style={styles.caption}>请在主机上的 Hermes 控制台完成 OAuth 登录。</Text> :
          <EditField label="Bearer 令牌（选填）" value={token} onChangeText={setToken} secureTextEntry autoComplete="off" editable={!busy} />}
      </>}
    </>}
    {transport === "stdio" && <>
      <EditField label="命令" value={command} onChangeText={setCommand} placeholder="npx" editable={!busy} />
      <EditField label="参数" value={args} onChangeText={setArgs} multiline editable={!busy}
        placeholder={server?.args_masked ? JSON.stringify(server.args) : undefined}
        help={server?.args_masked ? "输入完整的 JSON 数组以替换已保存的参数，留空则保留原参数。"
          : "JSON 数组，例如 [\"-y\", \"package-name\"]"} />
      <EditField label={server ? "设置环境变量" : "环境变量（选填）"} value={env} onChangeText={setEnv} multiline editable={!busy}
        help="每行填写一个 NAME=value。填写密钥时，可引用 Hermes 中已有的环境变量。" />
      {!!server?.env_keys?.length && <EditField label="移除环境变量" value={removeEnv} onChangeText={setRemoveEnv} editable={!busy}
        help={server.env_keys.join(", ")} />}
    </>}
    {server && <>
      <EditField label="包含的工具" value={include} onChangeText={setInclude} editable={!busy}
        help="名称或匹配模式，用英文逗号分隔。包含列表优先于排除列表。" />
      <EditField label="排除的工具" value={exclude} onChangeText={setExclude} editable={!busy} />
    </>}
    {error && <Notice>{error}</Notice>}
    <View style={styles.row}>
      <Action primary title={busy ? "保存中…" : server ? "保存服务器" : "添加 MCP 服务器"} disabled={busy || !dirty || !name.trim()
        || (transport === "http" && !url.trim() && !server?.url_masked) || (transport === "stdio" && !command.trim())} onPress={save} />
      <CloseButton accessibilityLabel="取消" disabled={busy} onPress={onCancel} />
    </View>
  </Card>;
}

type CatalogEntry = { name: string; description: string; transport: string; installed: boolean; command?: string; url?: string; args?: string[];
  required_env?: { name: string; prompt?: string; required: boolean }[]; post_install?: string };

function Catalog({ call, onClose }: { call: ManageCall; onClose: () => void }) {
  const { styles } = useTheme();
  const catalog = useManagementData<{ entries: CatalogEntry[] }>(call, "mcp.catalog");
  const action = useManagementAction();
  const [selected, select] = useState<CatalogEntry>();
  const [search, setSearch] = useState("");
  const [env, setEnv] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string>();
  const [installed, setInstalled] = useState<{ message?: string; error?: string }>();
  const results = catalog.data?.entries.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(search.trim().toLowerCase()));

  return <>
    <View style={styles.row}>
      <Action icon="back" title={selected ? "目录" : "全部服务器"} disabled={action.busy || !!pending} onPress={() => {
        if (selected) select(undefined); else onClose();
      }} />
      <Action icon="refresh" title="刷新目录" disabled={catalog.loading || action.busy || !!pending} onPress={() => void catalog.reload()} />
    </View>
    <DataState {...catalog} />
    <ActionState {...action} />
    {installed && <ActionState {...installed} />}
    {pending && <InstallProgress call={call} name={pending} onDone={(message, failed) => {
      setPending(undefined);
      setInstalled(failed ? { error: message } : { message });
      if (!failed) { select(undefined); setEnv({}); }
      void catalog.reload();
    }} />}
    {selected ? <Card>
      <Text accessibilityRole="header" style={styles.heading}>{selected.name}</Text>
      <Text style={styles.text}>{selected.description}</Text>
      <Text selectable style={styles.caption}>{selected.url || [selected.command, ...(selected.args ?? [])].filter(Boolean).join(" ")}</Text>
      {selected.post_install && <Text style={styles.muted}>{selected.post_install}</Text>}
      {!selected.installed && <>
        {selected.required_env?.map((item) => <EditField key={item.name} label={item.name} help={item.prompt} value={env[item.name] ?? ""}
          secureTextEntry autoComplete="off" editable={!action.busy && !pending} onChangeText={(value) => setEnv({ ...env, [item.name]: value })} />)}
        <Action primary title={action.busy || pending ? "安装中…" : "安装 MCP 服务器"} disabled={action.busy || !!pending
          || selected.required_env?.some((item) => item.required && !env[item.name]?.trim())}
          onPress={() => void action.run(async () => {
            setInstalled(undefined);
            const result = await call<{ background?: boolean; action?: string }>("mcp.install", { name: selected.name, env });
            if (result.background) {
              if (!result.action) return "安装已启动，请刷新目录查看结果。";
              setPending(result.action);
            } else {
              haptic("success");
              select(undefined); setEnv({}); await catalog.reload(); return "MCP 服务器已安装。";
            }
          })} />
      </>}
    </Card> : catalog.data && <>
      <EditField label="搜索 MCP 目录" value={search} onChangeText={setSearch} />
      {results?.length ? <Group>
        {results.map((item, index) => <Row key={item.name} divided={index > 0} title={item.name} subtitle={item.description}
          value={item.installed ? "已安装" : transports.get(item.transport) ?? item.transport} onPress={() => { select(item); setEnv({}); }} />)}
      </Group> : <EmptyState icon="mcp" title="暂无匹配结果" description="试试其他关键词，或手动添加服务器。" />}
    </>}
  </>;
}
