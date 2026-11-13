import { useState } from "react";
import { Text, View } from "react-native";
import { Action, Card, EmptyState, Notice, useTheme } from "../ui/theme";
import { ActionState, Confirm, DataState, EditField, Group, InstallProgress, Row, Toggle, entries,
  useManagementAction, useManagementData, type ManageCall } from "./shared";

type Server = { name: string; transport: "http" | "stdio" | "unknown"; url?: string; command?: string; args?: string[];
  enabled: boolean; env_keys?: string[]; auth?: "header" | "oauth"; tools?: { include?: string[]; exclude?: string[] };
  url_masked?: boolean; args_masked?: boolean; bearer_managed?: boolean };
type Probe = { ok: boolean; error?: string; tools: { name: string; description?: string }[] };

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
        edit(false);
        setProbe(undefined);
        await servers.reload();
        return server ? "Server settings saved." : "MCP server added.";
      })} /> : server ? <>
      <View style={styles.row}>
        <Action icon="back" title="All servers" disabled={action.busy} onPress={close} />
        <Action icon="refresh" title="Refresh" disabled={servers.loading || action.busy} onPress={() => void servers.reload()} />
      </View>
      <DataState {...servers} />
      <Card>
        <Text accessibilityRole="header" style={styles.heading}>{server.name}</Text>
        <Text selectable style={styles.text}>{server.url || [server.command, ...(server.args ?? [])].filter(Boolean).join(" ") || "Unknown transport"}</Text>
        <Text style={styles.caption}>{server.transport === "http" ? "HTTP" : server.transport} · {server.auth || "No HTTP authentication"}</Text>
        {!!server.env_keys?.length && <Text style={styles.muted}>Environment · {server.env_keys.join(", ")}</Text>}
        {!!server.tools?.include?.length && <Text style={styles.muted}>Included tools · {server.tools.include.join(", ")}</Text>}
        {!!server.tools?.exclude?.length && <Text style={styles.muted}>Excluded tools · {server.tools.exclude.join(", ")}</Text>}
        <Toggle label="Server enabled" value={server.enabled} disabled={action.busy} onChange={(enabled) => void action.run(async () => {
          await call("mcp.toggle", { name: server.name, enabled });
          await servers.reload();
          return enabled ? "MCP server enabled." : "MCP server disabled.";
        })} />
        <View style={styles.row}>
          <Action title="Edit server" disabled={action.busy} onPress={() => { closeToken(); edit(true); }} />
          <Action title="Test connection" disabled={action.busy} onPress={() => void action.run(async () => {
            setProbe(undefined);
            setProbe(await call<Probe>("mcp.test", { name: server.name }));
          })} />
        </View>
        {server.bearer_managed && (rotating ? <>
          <EditField label="New Bearer token" value={replacement} onChangeText={setReplacement} secureTextEntry autoComplete="off" editable={!action.busy} />
          <View style={styles.row}>
            <Action primary title="Save Bearer token" disabled={action.busy || !replacement.trim()} onPress={() => void action.run(async () => {
              await call("mcp.token", { name: server.name, bearer_token: replacement.trim() });
              closeToken();
              setProbe(undefined);
              return "Bearer token updated.";
            })} />
            <Action title="Cancel" disabled={action.busy} onPress={closeToken} />
          </View>
        </> : <Action title="Update Bearer token" disabled={action.busy} onPress={() => rotate(true)} />)}
        <Confirm title="Remove server" description={`Remove ${server.name} from Hermes?`} disabled={action.busy}
          onConfirm={() => void action.run(async () => { await call("mcp.remove", { name: server.name }); close(); await servers.reload(); return "MCP server removed."; })} />
      </Card>
      {probe && <Card>
        <Text accessibilityRole="header" style={styles.heading}>{probe.ok ? `Connected · ${probe.tools.length} tools` : "Connection failed"}</Text>
        {probe.error && <Notice>{probe.error}</Notice>}
        {probe.tools.map((tool) => <View key={tool.name}>
          <Text selectable style={styles.text}>{tool.name}</Text>
          {tool.description && <Text style={styles.caption}>{tool.description}</Text>}
        </View>)}
      </Card>}
    </> : <>
      <View style={styles.row}>
        <Action primary icon="compose" title="Add server" disabled={!servers.data} onPress={() => edit(true)} />
        <Action title="Browse catalog" onPress={() => showCatalog(true)} />
        <Action icon="refresh" title="Refresh" disabled={servers.loading} onPress={() => void servers.reload()} />
      </View>
      <DataState {...servers} />
      {servers.data?.servers.length ? <Group>
        {servers.data.servers.map((item, index) => <Row key={item.name} divided={index > 0} title={item.name} subtitle={item.url || item.command || undefined}
          value={item.enabled ? "Enabled" : "Disabled"} onPress={() => { setProbe(undefined); select(item.name); }} />)}
      </Group> : servers.data && <EmptyState icon="mcp" title="No MCP servers" description="Add a server or install one from the Hermes catalog." />}
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
        } catch { setError('Arguments must be a JSON array of strings, such as ["server.js", "--flag"].'); return; }
      }
      if (env.trim()) {
        const vars = env.split(/\r?\n/u).filter((line) => line.trim()).map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line));
        if (vars.some((line) => !line)) { setError("Enter each environment variable as NAME=value on its own line."); return; }
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
    <Text accessibilityRole="header" style={styles.heading}>{server ? `Edit ${server.name}` : "Add MCP server"}</Text>
    {!server && <>
      <EditField label="Server name" value={name} onChangeText={setName} editable={!busy} />
      <View style={styles.row}>
        <Action title="HTTP" selected={transport === "http"} disabled={busy} onPress={() => setTransport("http")} />
        <Action title="Stdio" selected={transport === "stdio"} disabled={busy} onPress={() => setTransport("stdio")} />
      </View>
    </>}
    {transport === "http" && <>
      <EditField label="Server URL" value={url} onChangeText={setUrl} keyboardType="url" editable={!busy}
        placeholder={server?.url_masked ? server.url : undefined}
        help={server?.url_masked ? "Enter a full URL to replace the saved URL and its query parameters." : undefined} />
      {server?.auth === "header" && <Text style={styles.caption}>Hermes will keep the existing Authorization header for this server.</Text>}
      {!server && <>
        <Toggle label="Use OAuth" value={oauth} onChange={setOauth} disabled={busy} />
        {oauth ? <Text style={styles.caption}>Complete OAuth sign-in from Hermes Dashboard on the host.</Text> :
          <EditField label="Bearer token (optional)" value={token} onChangeText={setToken} secureTextEntry autoComplete="off" editable={!busy} />}
      </>}
    </>}
    {transport === "stdio" && <>
      <EditField label="Command" value={command} onChangeText={setCommand} placeholder="npx" editable={!busy} />
      <EditField label="Arguments" value={args} onChangeText={setArgs} multiline editable={!busy}
        placeholder={server?.args_masked ? JSON.stringify(server.args) : undefined}
        help={server?.args_masked ? "Enter a full JSON array to replace the saved arguments, or leave blank to keep them."
          : 'JSON array, such as ["-y", "package-name"]'} />
      <EditField label={server ? "Set environment variables" : "Environment variables (optional)"} value={env} onChangeText={setEnv} multiline editable={!busy}
        help="One NAME=value per line. For secrets, use an existing Hermes environment reference when available." />
      {!!server?.env_keys?.length && <EditField label="Remove environment variables" value={removeEnv} onChangeText={setRemoveEnv} editable={!busy}
        help={server.env_keys.join(", ")} />}
    </>}
    {server && <>
      <EditField label="Include tools" value={include} onChangeText={setInclude} editable={!busy}
        help="Comma-separated names or patterns. An include list takes priority over excludes." />
      <EditField label="Exclude tools" value={exclude} onChangeText={setExclude} editable={!busy} />
    </>}
    {error && <Notice>{error}</Notice>}
    <View style={styles.row}>
      <Action primary title={busy ? "Saving…" : server ? "Save server" : "Add MCP server"} disabled={busy || !dirty || !name.trim()
        || (transport === "http" && !url.trim() && !server?.url_masked) || (transport === "stdio" && !command.trim())} onPress={save} />
      <Action title="Cancel" disabled={busy} onPress={onCancel} />
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
      <Action icon="back" title={selected ? "Catalog" : "All servers"} disabled={action.busy || !!pending} onPress={() => {
        if (selected) select(undefined); else onClose();
      }} />
      <Action icon="refresh" title="Refresh catalog" disabled={catalog.loading || action.busy || !!pending} onPress={() => void catalog.reload()} />
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
        <Action primary title={action.busy || pending ? "Installing…" : "Install MCP server"} disabled={action.busy || !!pending
          || selected.required_env?.some((item) => item.required && !env[item.name]?.trim())}
          onPress={() => void action.run(async () => {
            setInstalled(undefined);
            const result = await call<{ background?: boolean; action?: string }>("mcp.install", { name: selected.name, env });
            if (result.background) {
              if (!result.action) return "Installation started. Refresh the catalog to check the result.";
              setPending(result.action);
            } else {
              select(undefined); setEnv({}); await catalog.reload(); return "MCP server installed.";
            }
          })} />
      </>}
    </Card> : catalog.data && <>
      <EditField label="Search MCP catalog" value={search} onChangeText={setSearch} />
      {results?.length ? <Group>
        {results.map((item, index) => <Row key={item.name} divided={index > 0} title={item.name} subtitle={item.description}
          value={item.installed ? "Installed" : item.transport} onPress={() => { select(item); setEnv({}); }} />)}
      </Group> : <EmptyState icon="mcp" title="No catalog matches" description="Try another search or add a server manually." />}
    </>}
  </>;
}
