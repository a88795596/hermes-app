import { useState } from "react";
import { Text, View } from "react-native";
import { Action, Card, CloseButton, useTheme } from "../ui/theme";
import { ActionState, Confirm, DataState, EditField, Group, Row, useManagementAction, useManagementData, type ManageCall } from "./shared";

type Assignment = { provider: string; model: string; base_url?: string; base_url_masked?: boolean; task?: string };
type Provider = { slug: string; name: string; models: string[]; authenticated?: boolean };
type ProviderKey = { key: string; provider: string; label: string; configured: boolean };
const taskLabels = new Map([
  ["vision", "视觉识别"], ["compression", "上下文压缩"], ["approval", "审批"], ["mcp", "MCP"],
  ["title_generation", "生成标题"], ["review", "审查"], ["memory_query_rewrite", "改写记忆查询"],
  ["tts_audio_tags", "语音合成标签"], ["voice_chat", "语音对话"], ["triage_specifier", "编写分流规格"],
  ["kanban_decomposer", "拆解看板任务"], ["profile_describer", "生成档案描述"], ["curator", "整理技能"],
  ["group_router", "群聊路由"], ["delegation", "任务委派"],
]);

export function Models({ call }: { call: ManageCall }) {
  const { styles } = useTheme();
  const assignments = useManagementData<{ main: Assignment; tasks: Assignment[] }>(call, "model.list");
  const [editing, edit] = useState<Assignment>();
  const [credentials, showCredentials] = useState(false);
  const [message, setMessage] = useState<string>();
  return editing ? <ModelForm call={call} current={editing} onClose={() => edit(undefined)} onSave={async () => {
    edit(undefined);
    setMessage("模型配置已保存。");
    await assignments.reload();
  }} /> : credentials ? <ModelKeys call={call} onClose={() => showCredentials(false)} /> : <>
    <ActionState message={message} />
    <View style={styles.row}>
      <Action title="服务商 API 密钥" onPress={() => showCredentials(true)} />
      <Action icon="refresh" title="刷新" disabled={assignments.loading} onPress={() => void assignments.reload()} />
    </View>
    <DataState {...assignments} />
    {assignments.data && <>
      <Group><Row title="默认模型" subtitle={assignments.data.main.model || "选择服务商和模型"}
        value={assignments.data.main.provider} onPress={() => { setMessage(undefined); edit(assignments.data?.main); }} /></Group>
      <Text style={styles.caption}>默认模型适用于新建的 Hermes 会话。</Text>
      <Text accessibilityRole="header" style={styles.sectionLabel}>辅助模型</Text>
      <Group>
        {assignments.data.tasks.map((item, index) => item.task && <Row key={item.task} divided={index > 0}
          title={taskLabels.get(item.task) ?? item.task} subtitle={item.model || (item.provider === "auto" ? "自动选择" : "服务商默认模型")}
          value={item.provider === "auto" ? undefined : item.provider} onPress={() => { setMessage(undefined); edit(item); }} />)}
      </Group>
    </>}
  </>;
}

function ModelForm({ call, current, onClose, onSave }: { call: ManageCall; current: Assignment; onClose: () => void; onSave: () => Promise<void> }) {
  const { styles } = useTheme();
  const action = useManagementAction();
  const [provider, setProvider] = useState(current.provider);
  const [model, setModel] = useState(current.model);
  const initialUrl = current.base_url_masked ? "" : current.base_url ?? "";
  const [baseUrl, setBaseUrl] = useState(initialUrl);
  const [key, setKey] = useState("");
  const [browse, setBrowse] = useState(false);
  const [confirm, setConfirm] = useState<string>();
  const auxiliary = current.task !== undefined;
  const clearingUrl = provider.trim() === current.provider && !!initialUrl && !baseUrl.trim();
  const needsUrl = auxiliary && !!key.trim() && !baseUrl.trim();
  const ready = !!provider.trim() && (auxiliary || !!model.trim()) && !clearingUrl && !needsUrl;

  function save(confirmed = false) {
    void action.run(async () => {
      const result = await call<{ ok: boolean; confirm_required?: boolean; confirm_message?: string }>("model.set", {
        scope: auxiliary ? "auxiliary" : "main", task: current.task, provider: provider.trim(), model: model.trim(),
        ...(baseUrl.trim() && (provider.trim() !== current.provider || baseUrl.trim() !== initialUrl || !!key.trim()) && { base_url: baseUrl.trim() }),
        ...(key.trim() && { api_key: key.trim() }),
        ...(confirmed && { confirm_expensive_model: true }),
      });
      if (result.confirm_required) {
        setConfirm(result.confirm_message || "Hermes 需要你确认后才能使用此模型。");
        return;
      }
      setKey("");
      await onSave();
    });
  }

  function changeProvider(next: string) {
    if (next !== provider) {
      setBaseUrl(next === current.provider ? initialUrl : "");
      setKey("");
    }
    setProvider(next);
  }

  return <>
    <ActionState {...action} />
    <Card>
      <Text accessibilityRole="header" style={styles.heading}>{current.task ? taskLabels.get(current.task) ?? current.task : "默认模型"}</Text>
      <EditField label="服务商" value={provider} onChangeText={changeProvider} placeholder={auxiliary ? "auto" : "openrouter"} editable={!action.busy && !confirm} />
      <EditField label="模型 ID" value={model} onChangeText={setModel} editable={!action.busy && !confirm}
        help={auxiliary ? "留空使用服务商的默认模型。填写 auto 由 Hermes 自动选择。" : undefined} />
      <EditField label="接口地址" value={baseUrl} onChangeText={setBaseUrl} keyboardType="url" editable={!action.busy && !confirm}
        placeholder={current.base_url_masked && provider === current.provider ? current.base_url : undefined}
        help={clearingUrl ? "保留当前服务商时，Hermes 会沿用此接口地址。切换服务商可使用其默认地址。"
          : "选填。使用自定义接口时，请填写其 API 基础地址。"} />
      <EditField label="接口 API 密钥" value={key} onChangeText={setKey} secureTextEntry autoComplete="off"
        editable={!action.busy && !confirm && (!auxiliary || !!baseUrl.trim())}
        help={auxiliary && !baseUrl.trim() ? "请先填写接口地址，再设置密钥。"
          : "选填。留空将使用该服务商已有的凭证。"} />
      <View style={styles.row}>
        {!browse && <Action title="浏览模型" disabled={action.busy || !!confirm} onPress={() => setBrowse(true)} />}
        {!confirm && <Action primary title={action.busy ? "保存中…" : "保存模型"} disabled={action.busy || !ready} onPress={() => save()} />}
        <CloseButton accessibilityLabel="取消" disabled={action.busy} onPress={onClose} />
      </View>
      {confirm && <>
        <Text style={styles.muted}>请查看 Hermes 提供的模型说明，再确认保存。</Text>
        <Text style={styles.text}>{confirm}</Text>
        <View style={styles.row}>
          <Action primary title="确认选择模型" disabled={action.busy} onPress={() => save(true)} />
          <Action title="继续编辑" disabled={action.busy} onPress={() => setConfirm(undefined)} />
        </View>
      </>}
    </Card>
    {browse && !confirm && <ModelCatalog call={call} disabled={action.busy} onClose={() => setBrowse(false)} onChoose={(provider, model) => {
      changeProvider(provider);
      setModel(model);
      setBrowse(false);
    }} />}
  </>;
}

function ModelCatalog({ call, disabled, onClose, onChoose }: {
  call: ManageCall; disabled: boolean; onClose: () => void; onChoose: (provider: string, model: string) => void;
}) {
  const { styles } = useTheme();
  const catalog = useManagementData<Provider[]>(call, "model.options");
  const [slug, select] = useState<string>();
  const [search, setSearch] = useState("");
  const provider = catalog.data?.find((item) => item.slug === slug);
  const results = (provider?.models ?? []).filter((model) => model.toLowerCase().includes(search.trim().toLowerCase()));
  const [count, setCount] = useState(30);
  return <>
    <View style={styles.row}>
      <Text accessibilityRole="header" style={[styles.heading, { flex: 1 }]}>模型目录</Text>
      <CloseButton accessibilityLabel="关闭模型目录" disabled={disabled} onPress={onClose} />
    </View>
    <View style={styles.row}>
      {provider && <Action icon="back" title="全部服务商" onPress={() => select(undefined)} />}
      <Action icon="refresh" title="刷新目录" disabled={catalog.loading} onPress={() => void catalog.reload()} />
    </View>
    <DataState {...catalog} />
    {provider ? <>
      <EditField label={`搜索 ${provider.name} 的模型`} value={search} onChangeText={(value) => { setSearch(value); setCount(30); }} />
      {results.length ? <Group>{results.slice(0, count).map((model, index) =>
        <Row key={model} title={model} divided={index > 0} disabled={disabled} onPress={() => onChoose(provider.slug, model)} />)}</Group>
        : <Text style={styles.muted}>暂无匹配的模型，可在上方输入模型 ID。</Text>}
      {results.length > count && <Action title="显示更多模型" onPress={() => setCount(count + 30)} />}
      <Action title={`使用服务商 ${provider.name}`} disabled={disabled} onPress={() => onChoose(provider.slug, "")} />
    </> : catalog.data?.length ? <Group>
      {catalog.data.map((item, index) => <Row key={item.slug} title={item.name || item.slug} divided={index > 0}
        subtitle={`${item.models.length} 个模型`} value={item.authenticated === false ? "需要配置" : undefined}
        onPress={() => { select(item.slug); setSearch(""); setCount(30); }} />)}
    </Group> : catalog.data && <Text style={styles.muted}>Hermes 暂未提供服务商目录。</Text>}
  </>;
}

function ModelKeys({ call, onClose }: { call: ManageCall; onClose: () => void }) {
  const { styles } = useTheme();
  const keys = useManagementData<ProviderKey[]>(call, "model.keys");
  const action = useManagementAction();
  const [search, setSearch] = useState("");
  const [selected, select] = useState<ProviderKey>();
  const [value, setValue] = useState("");
  const shown = keys.data?.filter((row) => `${row.key} ${row.label}`.toLowerCase().includes(search.trim().toLowerCase()));
  const configured = keys.data?.find((row) => row.key === selected?.key)?.configured;

  function updateKey(key: string, replacement?: string) {
    void action.run(async () => {
      if (replacement === undefined) await call("model.key.remove", { key });
      else await call("model.key", { key, value: replacement });
      setValue("");
      select(undefined);
      await keys.reload();
      return replacement === undefined ? "服务商 API 密钥已移除。" : "服务商 API 密钥已保存。";
    });
  }
  return <>
    <View style={styles.row}>
      <Action icon="back" title="模型配置" disabled={action.busy} onPress={onClose} />
      <Action icon="refresh" title="刷新密钥列表" disabled={action.busy || keys.loading} onPress={() => void keys.reload()} />
    </View>
    <DataState {...keys} />
    <ActionState {...action} />
    {selected ? <Card>
      <Text accessibilityRole="header" style={styles.heading}>{selected.label}</Text>
      <Text style={styles.muted}>{selected.key}</Text>
      <EditField label="新的 API 密钥" value={value} onChangeText={setValue} secureTextEntry autoComplete="off" editable={!action.busy} />
      <View style={styles.row}>
        <Action primary title={action.busy ? "处理中…" : "保存 API 密钥"} disabled={!value.trim() || action.busy}
          onPress={() => updateKey(selected.key, value.trim())} />
        <CloseButton accessibilityLabel="取消" disabled={action.busy} onPress={() => { select(undefined); setValue(""); }} />
      </View>
      {configured && <Confirm title="移除 API 密钥" description={`确定移除 ${selected.label} 的 API 密钥吗？`}
        disabled={action.busy || keys.loading} onConfirm={() => updateKey(selected.key)} />}
    </Card> : keys.data && <>
      <EditField label="搜索服务商密钥" value={search} onChangeText={setSearch} />
      {shown?.length ? <Group>
        {shown.map((row, index) => <Row key={row.key} title={row.label} subtitle={row.key} divided={index > 0}
          value={row.configured ? "已配置" : "未配置"} onPress={() => select(row)} />)}
      </Group> : <Text style={styles.muted}>暂无匹配的 API 密钥。</Text>}
    </>}
  </>;
}
