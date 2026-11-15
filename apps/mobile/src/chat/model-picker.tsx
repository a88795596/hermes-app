import { randomUUID } from "expo-crypto";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ModelCatalog, ModelRequest, ModelResult, ModelSelection, ModelSelectionRequest } from "@hermes-mobile/protocol";
import { haptic } from "../ui/haptics";
import { Action, Icon, Notice, useTheme } from "../ui/theme";
import { ComposerSheet, PickerRow } from "./composer-menu";

export function ModelPicker({
  enabled, unavailable, onClose, onRequest, onSelected, embedded, profileLabel,
}: {
  enabled: boolean;
  unavailable?: string;
  embedded?: boolean;
  profileLabel?: string;
  onClose: () => void;
  onRequest: (requestId: string, selection: ModelSelectionRequest | undefined, signal: AbortSignal) => Promise<Exclude<ModelRequest, { status: "pending" }>>;
  onSelected: (result: Extract<ModelResult, { selection: ModelSelection }>, global: boolean) => void;
}) {
  const { colors, styles } = useTheme();
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [providerId, setProviderId] = useState<string>();
  const [scopeSelection, setScopeSelection] = useState<ModelSelection>();
  const [confirmation, setConfirmation] = useState<{ selection: ModelSelectionRequest; message: string }>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState<{ id: string; selection?: ModelSelectionRequest }>();
  const pending = useRef<AbortController>(undefined);
  const provider = catalog?.providers.find((row) => row.id === providerId);
  const currentProvider = catalog?.providers.find((row) => row.id === catalog.provider);

  async function request(selection?: ModelSelectionRequest, id = randomUUID()) {
    if (pending.current || (selection && !enabled && id !== retry?.id)) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    setRetry(undefined);
    setScopeSelection(undefined);
    try {
      const reply = await onRequest(id, selection, controller.signal);
      if (controller.signal.aborted) return;
      if (reply.status !== "ok") {
        if (selection) haptic(reply.status === "unknown" ? "warning" : "error");
        setConfirmation(undefined);
        setError(reply.error);
        return;
      }
      const result = reply.model_result;
      if (result.type === "catalog") {
        setCatalog(result.catalog);
      } else if (result.type === "confirmation" && selection) {
        haptic("warning");
        setConfirmation({ selection: { ...selection, confirm: result.confirm }, message: result.message });
      } else if (result.type !== "confirmation") {
        if (selection?.global && result.global !== true) {
          haptic("warning");
          setConfirmation(undefined);
          setError("服务端未确认默认模型已保存，请更新服务端和连接器后重试。");
          return;
        }
        if (result.type === "selected" && (result.selection.provider !== catalog?.provider || result.selection.model !== catalog?.model)) haptic("success");
        onSelected(result, result.global === true);
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (selection) haptic("error");
        setRetry({ id, selection });
        setError(failure instanceof Error ? failure.message : "Hermes 无法完成模型请求。");
      }
    } finally {
      if (pending.current === controller) pending.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const load = useEffectEvent(() => void request());
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- On mount the request's busy and error resets already match initial state.
    load();
    return () => {
      pending.current?.abort();
      pending.current = undefined;
    };
  }, []);

  const rows = provider
    ? provider.models.map((model) => ({ id: model, name: model, selected: catalog?.provider === provider.id && catalog.model === model }))
    : (catalog?.providers ?? []).map((row) => ({
      id: row.id, name: row.models.length ? row.name : `${row.name} · 暂无可用模型`, selected: catalog?.provider === row.id,
    }));

  return (
    <ComposerSheet
      embedded={embedded}
      title={confirmation ? "确认切换模型" : scopeSelection ? "默认模型" : provider ? provider.name : "选择服务商"}
      subtitle={catalog?.model && !confirmation && !scopeSelection
        ? `当前模型 · ${catalog.model}${currentProvider ? `（${currentProvider.name}）` : ""}` : undefined}
      closeLabel={embedded ? "返回会话设置" : undefined}
      onClose={onClose}
      back={provider && !confirmation && (
        <Pressable accessibilityRole="button" accessibilityLabel={scopeSelection ? "返回模型列表" : "返回服务商列表"} accessibilityState={{ disabled: busy }}
          disabled={busy} onPress={() => {
            haptic("light");
            if (scopeSelection) setScopeSelection(undefined);
            else setProviderId(undefined);
          }}
          style={({ pressed }) => [picker.back, (pressed || busy) && styles.faded]}>
          <Icon name="back" size={16} color={colors.accent} />
        </Pressable>
      )}
    >
      {unavailable && <Text style={styles.muted}>{unavailable}</Text>}
      {error && <Notice>{error}</Notice>}
      {busy && (
        <View style={styles.row}>
          <ActivityIndicator color={colors.accent} />
          <Text accessibilityLiveRegion="polite" style={styles.muted}>{catalog ? "正在切换模型…" : "正在加载服务商…"}</Text>
        </View>
      )}
      {retry && <Action title="重新查询请求状态" disabled={busy} onPress={() => void request(retry.selection, retry.id)} />}
      {error && !retry && !catalog && <Action title="重新加载服务商" disabled={!enabled || busy} onPress={() => void request()} />}
      {scopeSelection ? (
        <ScrollView style={picker.list} contentContainerStyle={picker.rows}>
          <Text selectable style={styles.heading}>{scopeSelection.model}</Text>
          <Text style={styles.text}>是否设为{profileLabel ? `“${profileLabel}”` : "当前配置档案"}的默认模型？</Text>
          <Action title="仅当前会话" disabled={!enabled || busy}
            onPress={() => void request({ ...scopeSelection, global: false })} />
          <Action title="设为默认模型" primary disabled={!enabled || busy}
            onPress={() => void request({ ...scopeSelection, global: true })} />
        </ScrollView>
      ) : confirmation ? (
        <>
          <ScrollView style={picker.list} contentContainerStyle={picker.rows}>
            <Text style={styles.muted}>请查看 Hermes 提供的风险和费用说明，再确认切换。</Text>
            <Text selectable style={styles.text}>{confirmation.message}</Text>
          </ScrollView>
          <View style={styles.row}>
            <Action title="返回" disabled={busy} onPress={() => setConfirmation(undefined)} />
            <Action title="确认切换" primary disabled={!enabled || busy || !!retry} onPress={() => void request(confirmation.selection)} />
          </View>
        </>
      ) : catalog && (
        <FlatList
          key={provider?.id ?? "providers"}
          style={picker.list}
          data={rows}
          keyExtractor={(row) => row.id}
          contentContainerStyle={provider ? undefined : picker.rows}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <PickerRow
              title={item.name}
              filled={!provider}
              selected={item.selected}
              leading={!provider && <View style={picker.check}>{item.selected && <Icon name="check" size={18} color={colors.accent} />}</View>}
              trailing={provider ? item.selected ? "check" : undefined : item.selected ? undefined : "chevron"}
              feedback={provider && item.selected ? false : undefined}
              disabled={busy || !!retry || Boolean(provider && !enabled)}
              onPress={() => provider
                ? setScopeSelection({ provider: provider.id, model: item.id })
                : setProviderId(item.id)}
            />
          )}
          ListEmptyComponent={<Text style={styles.muted}>
            {provider ? "此服务商暂无可选模型。" : "此 Hermes 配置档案暂无可用服务商。"}
          </Text>}
        />
      )}
    </ComposerSheet>
  );
}

const picker = StyleSheet.create({
  back: { width: 48, minHeight: 48, alignItems: "center", justifyContent: "center" },
  check: { width: 18 },
  list: { flexGrow: 0, flexShrink: 1 },
  rows: { gap: 8 },
});
