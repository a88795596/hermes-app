import { randomUUID } from "expo-crypto";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import type { NativeCommandRequest } from "@hermes-mobile/protocol";
import { haptic } from "../ui/haptics";
import { Action, Notice, useTheme } from "../ui/theme";
import { AnswerMarkdown } from "./answer-markdown";
import { ComposerSheet } from "./composer-menu";

export function NativeCommandSheet({ command, requestId, onRequest, onClose, onOpenLink }: {
  command: string;
  requestId: string;
  onRequest: (requestId: string, command: string, signal: AbortSignal, approval?: "once" | "always") =>
    Promise<Exclude<NativeCommandRequest, { status: "pending" }>>;
  onClose: () => void;
  onOpenLink: (url: string) => void;
}) {
  const { colors, styles } = useTheme();
  const [busy, setBusy] = useState(true);
  const [output, setOutput] = useState<string>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(false);
  const [confirmation, setConfirmation] = useState<string>();
  const awaitingApproval = useRef(false);
  const attempt = useRef<{ requestId: string; approval?: "once" | "always" }>({ requestId });
  const pending = useRef<AbortController>(undefined);

  async function request(approval?: "once" | "always") {
    if (pending.current) return;
    if (approval) {
      if (!awaitingApproval.current) return;
      awaitingApproval.current = false;
      attempt.current = { requestId: randomUUID(), approval };
      setConfirmation(undefined);
      setOutput(undefined);
    }
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError(undefined);
    setRetry(false);
    try {
      const result = await onRequest(attempt.current.requestId, command, controller.signal, attempt.current.approval);
      if (controller.signal.aborted) return;
      if (result.status === "ok") {
        setOutput(result.native_result.output);
        setConfirmation(result.native_result.confirmation);
        awaitingApproval.current = result.native_result.confirmation !== undefined;
      } else {
        haptic(result.status === "unknown" ? "warning" : "error");
        setError(result.error);
        setRetry(result.status === "unknown");
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        haptic("warning");
        setError(failure instanceof Error ? failure.message : "尚未确认命令结果。");
        setRetry(true);
      }
    } finally {
      if (pending.current === controller) pending.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const load = useEffectEvent(() => void request());
  useEffect(() => {
    load();
    return () => { pending.current?.abort(); pending.current = undefined; };
  }, []);

  return <ComposerSheet title={confirmation !== undefined ? "命令确认" : "命令结果"} busy={busy} onClose={onClose}>
    <Text selectable style={styles.heading}>{command}</Text>
    {busy && <ActivityIndicator accessibilityLabel="正在等待 Hermes 命令结果" color={colors.accent} />}
    {error && <Notice>{error}</Notice>}
    {retry && <Action title="查看结果" disabled={busy} onPress={() => void request()} />}
    {output !== undefined && <ScrollView style={layout.output}>
      <AnswerMarkdown text={output || "命令已返回，无输出。"} onOpenLink={onOpenLink} />
    </ScrollView>}
    {confirmation !== undefined && <View style={styles.row}>
      <Action title="仅本次" primary disabled={busy} onPress={() => void request("once")} />
      <Action title="始终允许" disabled={busy} onPress={() => void request("always")} />
      <Action title="取消" disabled={busy} onPress={() => { if (!pending.current) onClose(); }} />
    </View>}
  </ComposerSheet>;
}

const layout = StyleSheet.create({ output: { flexGrow: 0, flexShrink: 1 } });
