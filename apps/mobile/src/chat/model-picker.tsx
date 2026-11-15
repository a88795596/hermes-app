import { randomUUID } from "expo-crypto";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ModelCatalog, ModelRequest, ModelResult, ModelSelection } from "@hermes-mobile/protocol";
import { haptic } from "../ui/haptics";
import { useReduceMotion } from "../ui/motion";
import { Action, CloseButton, Notice, useTheme } from "../ui/theme";

type Request = ModelSelection & { confirm?: string };

export function ModelPicker({
  enabled, unavailable, onClose, onRequest, onSelected,
}: {
  enabled: boolean;
  unavailable?: string;
  onClose: () => void;
  onRequest: (requestId: string, selection: Request | undefined, signal: AbortSignal) => Promise<Exclude<ModelRequest, { status: "pending" }>>;
  onSelected: (result: Extract<ModelResult, { selection: ModelSelection }>) => void;
}) {
  const { colors, styles } = useTheme();
  const reduced = useReduceMotion();
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [providerId, setProviderId] = useState<string>();
  const [confirmation, setConfirmation] = useState<{ selection: Request; message: string }>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState<{ id: string; selection?: Request }>();
  const pending = useRef<AbortController>(undefined);
  const provider = catalog?.providers.find((row) => row.id === providerId);
  const currentProvider = catalog?.providers.find((row) => row.id === catalog.provider);

  async function request(selection?: Request, id = randomUUID()) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    setRetry(undefined);
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
        if (result.type === "selected" && (result.selection.provider !== catalog?.provider || result.selection.model !== catalog?.model)) haptic("success");
        onSelected(result);
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
    <Modal visible transparent animationType={reduced ? "none" : "fade"} onRequestClose={onClose}>
      <View style={picker.overlay}>
        <View accessibilityViewIsModal style={[styles.card, picker.panel, { borderColor: colors.edge }]}>
          <View style={picker.header}>
            <Text accessibilityRole="header" style={[styles.heading, picker.heading]}>
              {confirmation ? "确认切换模型" : provider ? provider.name : "选择服务商"}
            </Text>
            <CloseButton onPress={onClose} />
          </View>
          {catalog?.model && !confirmation && (
            <Text style={styles.muted}>当前模型 · {catalog.model}{currentProvider ? `（${currentProvider.name}）` : ""}</Text>
          )}
          {unavailable && <Text style={styles.muted}>{unavailable}</Text>}
          {error && <Notice>{error}</Notice>}
          {busy && (
            <View style={styles.row}>
              <ActivityIndicator color={colors.accent} />
              <Text accessibilityLiveRegion="polite" style={styles.muted}>{catalog ? "正在切换模型…" : "正在加载服务商…"}</Text>
            </View>
          )}
          {retry && (
            <Action title="重新查询请求状态" disabled={busy} onPress={() => void request(retry.selection, retry.id)} />
          )}
          {error && !retry && !catalog && <Action title="重新加载服务商" disabled={!enabled || busy} onPress={() => void request()} />}
          {confirmation ? (
            <>
              <ScrollView style={picker.list}>
                <Text style={styles.muted}>请查看 Hermes 提供的风险和费用说明，再确认切换。</Text>
                <Text selectable style={styles.text}>{confirmation.message}</Text>
              </ScrollView>
              <View style={styles.row}>
                <Action title="返回" disabled={busy} onPress={() => setConfirmation(undefined)} />
                <Action title="确认切换" primary disabled={!enabled || busy} onPress={() => void request(confirmation.selection)} />
              </View>
            </>
          ) : catalog && (
            <>
              {provider && <View style={styles.row}><Action title="返回服务商列表" icon="back" disabled={busy} onPress={() => setProviderId(undefined)} /></View>}
              <FlatList
                key={provider?.id ?? "providers"}
                style={picker.list}
                data={rows}
                keyExtractor={(row) => row.id}
                contentContainerStyle={picker.rows}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => (
                  <Action
                    title={item.name}
                    selected={item.selected}
                    feedback={provider && item.selected ? false : "selection"}
                    icon={item.selected ? "check" : provider ? undefined : "chevron"}
                    disabled={busy || Boolean(provider && !enabled)}
                    onPress={() => provider
                      ? void request({ provider: provider.id, model: item.id })
                      : setProviderId(item.id)}
                  />
                )}
                ListEmptyComponent={<Text style={styles.muted}>
                  {provider ? "此服务商暂无可选模型。" : "此 Hermes 配置档案暂无可用服务商。"}
                </Text>}
              />
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const picker = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "#0008", justifyContent: "center", alignItems: "center", padding: 18 },
  panel: { width: "100%", maxWidth: 480, maxHeight: "82%", borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  header: { flexDirection: "row", gap: 8, alignItems: "center" },
  heading: { flex: 1 },
  list: { flexGrow: 0, flexShrink: 1 },
  rows: { gap: 6 },
});
