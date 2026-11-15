import { useState, type ComponentProps } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { haptic } from "../ui/haptics";
import { useReduceMotion } from "../ui/motion";
import { Action, CloseButton, Field, Icon, useTheme, type IconName } from "../ui/theme";
import { OverlayModal } from "../ui/overlay";
import { PageHeader } from "../ui/page-header";
import {
  ActionState, Confirm, DataState, EditField, FormHeader, Group, ManagementHeader, ManagementLayout, Row,
  mono, useManagementAction, useManagementContext, useManagementData, type ManageCall,
} from "./shared";

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
const taskIcons = new Map<string, IconName>([
  ["vision", "photo"], ["compression", "layers"], ["title_generation", "logs"], ["review", "shield"],
]);

export function Models({ call }: { call: ManageCall }) {
  const { styles } = useTheme();
  const assignments = useManagementData<{ main: Assignment; tasks: Assignment[] }>(call, "model.list");
  const [editing, edit] = useState<Assignment>();
  const [credentials, showCredentials] = useState(false);
  const [message, setMessage] = useState<string>();
  if (editing) return <ModelForm call={call} current={editing} onClose={() => edit(undefined)} onSave={async () => {
    edit(undefined);
    setMessage("模型配置已保存。");
    await assignments.reload();
  }} />;
  if (credentials) return <ModelKeys call={call} onClose={() => showCredentials(false)} />;

  return <ManagementLayout hideTabs header={<ManagementHeader title="模型" />}>
    <ActionState message={message} />
    <View style={styles.row}>
      <Action icon="key" title="服务商 API 密钥" style={layout.keyListAction} onPress={() => showCredentials(true)} />
      <Action icon="refresh" title="刷新" style={layout.refreshAction}
        disabled={assignments.loading} onPress={() => void assignments.reload()} />
    </View>
    <DataState {...assignments} />
    {assignments.data && <>
      <Group><Row divided title="默认模型" subtitle={assignments.data.main.model || "选择服务商和模型"}
        icon="model" value={assignments.data.main.provider}
        onPress={() => { setMessage(undefined); edit(assignments.data?.main); }} /></Group>
      <Text style={styles.caption}>默认模型适用于新建的 Hermes 会话。</Text>
      <Text accessibilityRole="header" style={styles.sectionLabel}>辅助模型</Text>
      <Group>
        {assignments.data.tasks.map((item) => item.task && <Row key={item.task} divided
          title={taskLabels.get(item.task) ?? item.task} subtitle={item.model || (item.provider === "auto" ? "自动选择" : "服务商默认模型")}
          icon={taskIcons.get(item.task) ?? "model"}
          value={item.provider === "auto" ? undefined : item.provider} onPress={() => { setMessage(undefined); edit(item); }} />)}
      </Group>
    </>}
  </ManagementLayout>;
}

function ModelForm({ call, current, onClose, onSave }: { call: ManageCall; current: Assignment; onClose: () => void; onSave: () => Promise<void> }) {
  const { colors, styles } = useTheme();
  const { label } = useManagementContext();
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
  const editable = !action.busy && !confirm;
  const keyEditable = editable && (!auxiliary || !!baseUrl.trim());
  const title = current.task ? taskLabels.get(current.task) ?? current.task : "默认模型";

  function save(confirmed = false) {
    void action.run(async () => {
      const result = await call<{ ok: boolean; confirm_required?: boolean; confirm_message?: string }>("model.set", {
        scope: auxiliary ? "auxiliary" : "main", task: current.task, provider: provider.trim(), model: model.trim(),
        ...(baseUrl.trim() && (provider.trim() !== current.provider || baseUrl.trim() !== initialUrl || !!key.trim()) && { base_url: baseUrl.trim() }),
        ...(key.trim() && { api_key: key.trim() }),
        ...(confirmed && { confirm_expensive_model: true }),
      });
      if (result.confirm_required) {
        haptic("warning");
        setConfirm(result.confirm_message || "Hermes 需要你确认后才能使用此模型。");
        return;
      }
      if (result.ok) haptic("success");
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

  return <ManagementLayout hideTabs header={<FormHeader title={title} onCancel={onClose} onSave={() => save()}
    saveLabel={action.busy ? "保存中…" : "保存"} disabled={!editable || !ready || browse} cancelDisabled={action.busy} />}>
    {!!label && <View style={layout.profile}>
      <View style={[layout.profileIcon, { backgroundColor: colors.tint }]}><Icon name="sparkles" size={20} color={colors.accent} /></View>
      <Text style={auxiliary ? styles.heading : styles.title}>{label}</Text>
    </View>}
    <ActionState {...action} />
    {confirm ? <View style={[layout.section, { borderTopColor: colors.edge }]}>
      <Text style={styles.muted}>请查看 Hermes 提供的模型说明，再确认保存。</Text>
      <Text accessibilityLiveRegion="polite" style={styles.text}>{confirm}</Text>
      <View style={styles.row}>
        <Action primary title="确认选择模型" disabled={action.busy} onPress={() => save(true)} />
        <Action title="继续编辑" disabled={action.busy} onPress={() => setConfirm(undefined)} />
      </View>
    </View> : <>
      <View style={[layout.section, { borderTopColor: colors.edge }]}>
        {auxiliary && <Text accessibilityRole="header" style={[styles.heading, layout.sectionTitle]}>模型配置</Text>}
        <ModelField icon="server" label="服务商" value={provider} onChangeText={changeProvider}
          placeholder={auxiliary ? "auto" : "openrouter"} editable={editable} style={layout.technical} />
        <ModelField icon="model" label="模型 ID" value={model} onChangeText={setModel} editable={editable} style={layout.technical}
          help={auxiliary ? "留空使用服务商默认模型，填写 auto 由 Hermes 自动选择。" : undefined} />
        <View style={[layout.leading, auxiliary && layout.fieldAction]}>
          <Action icon="book" title="浏览模型" disabled={!editable} onPress={() => { Keyboard.dismiss(); setBrowse(true); }} />
        </View>
      </View>
      <View style={[layout.section, { borderTopColor: colors.edge }]}>
        {auxiliary && <Text accessibilityRole="header" style={[styles.heading, layout.sectionTitle]}>自定义接口</Text>}
        <ModelField icon="link" label="接口地址" value={baseUrl} onChangeText={setBaseUrl} keyboardType="url" editable={editable}
          placeholder={current.base_url_masked && provider === current.provider ? current.base_url : undefined}
          help={clearingUrl ? "保留当前服务商时，Hermes 会沿用此接口地址。切换服务商可使用其默认地址。"
            : "选填。使用自定义接口时，请填写其 API 基础地址。"} />
        <ModelField icon="key" label="接口 API 密钥" value={key} onChangeText={setKey}
          secureTextEntry autoComplete="off" importantForAutofill="no" editable={keyEditable}
          style={!keyEditable && styles.faded}
          help={auxiliary && !baseUrl.trim() ? "请先填写接口地址，再设置密钥。"
            : "选填。留空将使用该服务商已有的凭证。"} />
      </View>
    </>}
    {browse && !confirm && <ModelCatalog call={call} disabled={action.busy} onClose={() => setBrowse(false)} onChoose={(provider, model) => {
      changeProvider(provider);
      setModel(model);
      setBrowse(false);
    }} />}
  </ManagementLayout>;
}

function ModelField({ icon, ...props }: ComponentProps<typeof EditField> & { icon: IconName }) {
  const { colors } = useTheme();
  return <View style={layout.fieldRow}>
    <Icon name={icon} size={19} color={colors.accent} />
    <View style={layout.grow}><EditField {...props} /></View>
  </View>;
}

function ModelSearch({ label, value, onChangeText }: { label: string; value: string; onChangeText: (value: string) => void }) {
  const { colors } = useTheme();
  return <View>
    <Field accessibilityLabel={label} placeholder={label} value={value} onChangeText={onChangeText}
      autoCapitalize="none" autoCorrect={false} style={layout.searchField} />
    <View pointerEvents="none" style={layout.searchIcon}><Icon name="search" size={18} color={colors.muted} /></View>
  </View>;
}

function ModelCatalog({ call, disabled, onClose, onChoose }: {
  call: ManageCall; disabled: boolean; onClose: () => void; onChoose: (provider: string, model: string) => void;
}) {
  const { colors, styles } = useTheme();
  const reduced = useReduceMotion();
  const catalog = useManagementData<Provider[]>(call, "model.options");
  const [slug, select] = useState<string>();
  const [search, setSearch] = useState("");
  const provider = catalog.data?.find((item) => item.slug === slug);
  const results = (provider?.models ?? []).filter((model) => model.toLowerCase().includes(search.trim().toLowerCase()));
  const [count, setCount] = useState(30);
  const header = <View style={layout.sheetHeader}>
    <View style={[layout.handle, { backgroundColor: colors.edge }]} />
    <PageHeader title="模型目录"
      trailing={<CloseButton accessibilityLabel="关闭模型目录" disabled={disabled} onPress={onClose} />} />
  </View>;

  return <OverlayModal animationType={reduced ? "none" : "fade"} onRequestClose={() => { if (!disabled) onClose(); }}>
    <KeyboardAvoidingView style={layout.backdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <SafeAreaView accessibilityViewIsModal importantForAccessibility="yes" edges={["bottom", "left", "right"]}
        style={[layout.sheet, { backgroundColor: colors.background }]}>
        <ManagementLayout hideTabs header={header}>
          <View style={styles.row}>
            {provider && <Action icon="back" title="全部服务商" onPress={() => { Keyboard.dismiss(); select(undefined); }} />}
            <Action icon="refresh" title="刷新目录" disabled={catalog.loading} onPress={() => void catalog.reload()} />
          </View>
          <DataState {...catalog} />
          {provider ? <>
            <ModelSearch label={`搜索 ${provider.name || provider.slug} 的模型`} value={search}
              onChangeText={(value) => { setSearch(value); setCount(30); }} />
            {results.length ? <Group>{results.slice(0, count).map((model, index) =>
              <Row key={model} title={model} divided={index > 0} disabled={disabled} onPress={() => onChoose(provider.slug, model)} />)}</Group>
              : <Text style={styles.muted}>暂无匹配的模型，可返回表单输入模型 ID。</Text>}
            {results.length > count && <Action title="显示更多模型" onPress={() => setCount(count + 30)} />}
            <View style={layout.catalogAction}>
              <Action primary title={`使用服务商 ${provider.name || provider.slug}`} disabled={disabled} onPress={() => onChoose(provider.slug, "")} />
            </View>
          </> : catalog.data?.length ? <Group>
            {catalog.data.map((item, index) => <Row key={item.slug} title={item.name || item.slug} divided={index > 0}
              icon="server" subtitle={`${item.models.length} 个模型`} value={item.authenticated === false ? "需要配置" : undefined}
              onPress={() => { select(item.slug); setSearch(""); setCount(30); }} />)}
          </Group> : catalog.data && <Text style={styles.muted}>Hermes 暂未提供服务商目录。</Text>}
        </ManagementLayout>
      </SafeAreaView>
    </KeyboardAvoidingView>
  </OverlayModal>;
}

function ModelKeys({ call, onClose }: { call: ManageCall; onClose: () => void }) {
  const { colors, styles } = useTheme();
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
      haptic("success");
      setValue("");
      select(undefined);
      await keys.reload();
      return replacement === undefined ? "服务商 API 密钥已移除。" : "服务商 API 密钥已保存。";
    });
  }

  if (selected) return <ManagementLayout hideTabs header={<FormHeader title="API 密钥"
    saveLabel={action.busy ? "处理中…" : "保存"} disabled={!value.trim() || action.busy} cancelDisabled={action.busy}
    onSave={() => updateKey(selected.key, value.trim())} onCancel={() => { select(undefined); setValue(""); }} />}>
    <DataState {...keys} />
    <ActionState {...action} />
    <View style={layout.keyHeading}>
      <Text accessibilityRole="header" style={styles.title}>{selected.label}</Text>
      <Text style={[styles.muted, layout.technical]}>{selected.key}</Text>
    </View>
    <EditField label="新的 API 密钥" value={value} onChangeText={setValue}
      secureTextEntry autoComplete="off" importantForAutofill="no" editable={!action.busy} />
    {configured && <View style={[layout.removeKey, { borderTopColor: colors.edge }]}>
      <Confirm title="移除 API 密钥" description={`确定移除 ${selected.label} 的 API 密钥吗？`}
        disabled={action.busy || keys.loading} onConfirm={() => updateKey(selected.key)} />
    </View>}
  </ManagementLayout>;

  return <ManagementLayout hideTabs header={<ManagementHeader title="API 密钥" onBack={onClose} backLabel="模型配置" backDisabled={action.busy} />}>
    <View style={layout.leading}>
      <Action primary icon="refresh" title="刷新密钥列表" disabled={action.busy || keys.loading} onPress={() => void keys.reload()} />
    </View>
    <DataState {...keys} />
    <ActionState {...action} />
    {keys.data && <>
      <ModelSearch label="搜索服务商密钥" value={search} onChangeText={setSearch} />
      {shown?.length ? <Group>
        {shown.map((row) => <Row key={row.key} title={row.label} subtitle={row.key} divided
          value={row.configured ? "已配置" : "未配置"} onPress={() => select(row)} />)}
      </Group> : <Text style={styles.muted}>暂无匹配的 API 密钥。</Text>}
    </>}
  </ManagementLayout>;
}

const layout = StyleSheet.create({
  keyListAction: { flexGrow: 2, flexBasis: 188 },
  refreshAction: { flexGrow: 1, flexBasis: 86 },
  profile: { flexDirection: "row", alignItems: "center", gap: 12, paddingBottom: 4 },
  profileIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  section: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 16, gap: 16 },
  sectionTitle: { fontSize: 21, lineHeight: 27 },
  fieldRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  fieldAction: { marginStart: 31 },
  grow: { flex: 1, minWidth: 0 },
  leading: { alignSelf: "flex-start" },
  technical: { fontFamily: mono },
  searchField: { paddingStart: 46 },
  searchIcon: { position: "absolute", start: 16, top: 0, bottom: 0, justifyContent: "center" },
  backdrop: { flex: 1, justifyContent: "flex-end" },
  sheet: { width: "100%", maxWidth: 680, height: "61%", alignSelf: "center",
    borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: "hidden" },
  sheetHeader: { gap: 8, paddingTop: 12 },
  handle: { alignSelf: "center", width: 44, height: 4, borderRadius: 2 },
  catalogAction: { marginTop: "auto", paddingTop: 8 },
  keyHeading: { gap: 4, paddingBottom: 8 },
  removeKey: { alignItems: "center", borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 16, marginTop: 16 },
});
