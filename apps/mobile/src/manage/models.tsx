import { useState } from "react";
import { Text, View } from "react-native";
import { Action, Card, useTheme } from "../ui/theme";
import { ActionState, Confirm, DataState, EditField, Group, Row, useManagementAction, useManagementData, type ManageCall } from "./shared";

type Assignment = { provider: string; model: string; base_url?: string; base_url_masked?: boolean; task?: string };
type Provider = { slug: string; name: string; models: string[]; authenticated?: boolean };
type ProviderKey = { key: string; provider: string; label: string; configured: boolean };
const taskLabel = (task: string) => task.charAt(0).toUpperCase() + task.slice(1).replaceAll("_", " ");

export function Models({ call }: { call: ManageCall }) {
  const { styles } = useTheme();
  const assignments = useManagementData<{ main: Assignment; tasks: Assignment[] }>(call, "model.list");
  const [editing, edit] = useState<Assignment>();
  const [credentials, showCredentials] = useState(false);
  const [message, setMessage] = useState<string>();
  return editing ? <ModelForm call={call} current={editing} onClose={() => edit(undefined)} onSave={async () => {
    edit(undefined);
    setMessage("Model assignment saved.");
    await assignments.reload();
  }} /> : credentials ? <ModelKeys call={call} onClose={() => showCredentials(false)} /> : <>
    <ActionState message={message} />
    <View style={styles.row}>
      <Action title="Provider API keys" onPress={() => showCredentials(true)} />
      <Action icon="refresh" title="Refresh" disabled={assignments.loading} onPress={() => void assignments.reload()} />
    </View>
    <DataState {...assignments} />
    {assignments.data && <>
      <Group><Row title="Default model" subtitle={assignments.data.main.model || "Choose a provider and model"}
        value={assignments.data.main.provider} onPress={() => { setMessage(undefined); edit(assignments.data?.main); }} /></Group>
      <Text style={styles.caption}>The default assignment applies to new Hermes sessions.</Text>
      <Text accessibilityRole="header" style={styles.sectionLabel}>Auxiliary models</Text>
      <Group>
        {assignments.data.tasks.map((item, index) => item.task && <Row key={item.task} divided={index > 0}
          title={taskLabel(item.task)} subtitle={item.model || (item.provider === "auto" ? "Automatic" : "Provider default")}
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
        setConfirm(result.confirm_message || "Hermes requires confirmation to select this model.");
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
      <Text accessibilityRole="header" style={styles.heading}>{current.task ? taskLabel(current.task) : "Default model"}</Text>
      <EditField label="Provider" value={provider} onChangeText={changeProvider} placeholder={auxiliary ? "auto" : "openrouter"} editable={!action.busy && !confirm} />
      <EditField label="Model ID" value={model} onChangeText={setModel} editable={!action.busy && !confirm}
        help={auxiliary ? "Leave empty to use the provider default. Use auto for Hermes routing." : undefined} />
      <EditField label="Endpoint URL" value={baseUrl} onChangeText={setBaseUrl} keyboardType="url" editable={!action.busy && !confirm}
        placeholder={current.base_url_masked && provider === current.provider ? current.base_url : undefined}
        help={clearingUrl ? "Hermes retains this endpoint for the same provider. Change provider to use another default endpoint."
          : "Optional. For a custom endpoint, enter its API base URL."} />
      <EditField label="Endpoint API key" value={key} onChangeText={setKey} secureTextEntry autoComplete="off"
        editable={!action.busy && !confirm && (!auxiliary || !!baseUrl.trim())}
        help={auxiliary && !baseUrl.trim() ? "Enter an endpoint URL to set its key."
          : "Optional. Leave blank to use the credentials already configured for this provider."} />
      <View style={styles.row}>
        <Action title={browse ? "Hide model catalog" : "Browse models"} disabled={action.busy || !!confirm} onPress={() => setBrowse(!browse)} />
        {!confirm && <Action primary title={action.busy ? "Saving…" : "Save model"} disabled={action.busy || !ready} onPress={() => save()} />}
        <Action title="Cancel" disabled={action.busy} onPress={onClose} />
      </View>
      {confirm && <>
        <Text style={styles.text}>{confirm}</Text>
        <View style={styles.row}>
          <Action primary title="Confirm model" disabled={action.busy} onPress={() => save(true)} />
          <Action title="Keep editing" disabled={action.busy} onPress={() => setConfirm(undefined)} />
        </View>
      </>}
    </Card>
    {browse && !confirm && <ModelCatalog call={call} disabled={action.busy} onChoose={(provider, model) => {
      changeProvider(provider);
      setModel(model);
      setBrowse(false);
    }} />}
  </>;
}

function ModelCatalog({ call, disabled, onChoose }: { call: ManageCall; disabled: boolean; onChoose: (provider: string, model: string) => void }) {
  const { styles } = useTheme();
  const catalog = useManagementData<Provider[]>(call, "model.options");
  const [slug, select] = useState<string>();
  const [search, setSearch] = useState("");
  const provider = catalog.data?.find((item) => item.slug === slug);
  const results = (provider?.models ?? []).filter((model) => model.toLowerCase().includes(search.trim().toLowerCase()));
  const [count, setCount] = useState(30);
  return <>
    <View style={styles.row}>
      {provider && <Action icon="back" title="All providers" onPress={() => select(undefined)} />}
      <Action icon="refresh" title="Refresh catalog" disabled={catalog.loading} onPress={() => void catalog.reload()} />
    </View>
    <DataState {...catalog} />
    {provider ? <>
      <EditField label={`Search ${provider.name} models`} value={search} onChangeText={(value) => { setSearch(value); setCount(30); }} />
      {results.length ? <Group>{results.slice(0, count).map((model, index) =>
        <Row key={model} title={model} divided={index > 0} disabled={disabled} onPress={() => onChoose(provider.slug, model)} />)}</Group>
        : <Text style={styles.muted}>No matching models. You can enter a model ID in the form above.</Text>}
      {results.length > count && <Action title="Show more models" onPress={() => setCount(count + 30)} />}
      <Action title={`Use ${provider.name} provider`} disabled={disabled} onPress={() => onChoose(provider.slug, "")} />
    </> : catalog.data?.length ? <Group>
      {catalog.data.map((item, index) => <Row key={item.slug} title={item.name || item.slug} divided={index > 0}
        subtitle={`${item.models.length} models`} value={item.authenticated === false ? "Setup required" : undefined}
        onPress={() => { select(item.slug); setSearch(""); setCount(30); }} />)}
    </Group> : catalog.data && <Text style={styles.muted}>Hermes returned no provider catalog.</Text>}
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
      return replacement === undefined ? "Provider API key removed." : "Provider API key saved.";
    });
  }
  return <>
    <View style={styles.row}>
      <Action icon="back" title="Model assignments" disabled={action.busy} onPress={onClose} />
      <Action icon="refresh" title="Refresh keys" disabled={action.busy || keys.loading} onPress={() => void keys.reload()} />
    </View>
    <DataState {...keys} />
    <ActionState {...action} />
    {selected ? <Card>
      <Text accessibilityRole="header" style={styles.heading}>{selected.label}</Text>
      <Text style={styles.muted}>{selected.key}</Text>
      <EditField label="New API key" value={value} onChangeText={setValue} secureTextEntry autoComplete="off" editable={!action.busy} />
      <View style={styles.row}>
        <Action primary title={action.busy ? "Working…" : "Save API key"} disabled={!value.trim() || action.busy}
          onPress={() => updateKey(selected.key, value.trim())} />
        <Action title="Cancel" disabled={action.busy} onPress={() => { select(undefined); setValue(""); }} />
      </View>
      {configured && <Confirm title="Remove API key" description={`Remove the saved API key for ${selected.label}?`}
        disabled={action.busy || keys.loading} onConfirm={() => updateKey(selected.key)} />}
    </Card> : keys.data && <>
      <EditField label="Search provider keys" value={search} onChangeText={setSearch} />
      {shown?.length ? <Group>
        {shown.map((row, index) => <Row key={row.key} title={row.label} subtitle={row.key} divided={index > 0}
          value={row.configured ? "Configured" : "Unset"} onPress={() => select(row)} />)}
      </Group> : <Text style={styles.muted}>No matching API keys.</Text>}
    </>}
  </>;
}
