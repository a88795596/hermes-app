import { randomUUID } from "expo-crypto";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { Control, Message, Topic } from "@hermes-mobile/protocol";
import type { useWorkspace } from "../sync/use-workspace";
import { Action, Card, EmptyState, Field, Icon, Notice, useTheme } from "../ui/theme";
import { ComposerMenu } from "./composer-menu";
import { ModelPicker } from "./model-picker";

const messageStatus: Record<Message["status"], string> = {
  accepted: "已接收",
  queued: "排队中",
  streaming: "回复中…",
  final: "",
  failed: "失败",
  unknown: "执行状态待确认",
  cancelled: "已停止",
};

const approvalLabels = new Map([
  ["once", "仅允许本次"],
  ["session", "本次会话内允许"],
  ["always", "始终允许"],
  ["deny", "拒绝"],
]);

const transcriptGutter = 13;

function ControlCard({
  control, enabled, onAnswer,
}: {
  control: Control;
  enabled: boolean;
  onAnswer: (control: Control, id: string, answer: string) => Promise<void>;
}) {
  const { styles } = useTheme();
  const [text, setText] = useState("");
  const [other, setOther] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string>();
  const attempt = useRef<{ id: string; answer: string }>(undefined);
  const answering = useRef(false);
  const canAnswer = enabled && !sending && !submitted && control.status === "pending";
  const clarify = control.kind === "clarify";
  const showText = clarify && (!control.choices.length || other);
  const multiSelect = clarify && control.multi_select === true;
  const choiceLabel = (choice: string) => clarify ? choice : approvalLabels.get(choice) ?? choice;

  async function answer(value: string) {
    if (!canAnswer || answering.current) return;
    answering.current = true;
    const prior = attempt.current;
    const id = prior?.answer === value ? prior.id : randomUUID();
    attempt.current = { id, answer: value };
    setSending(true);
    setError(undefined);
    try {
      await onAnswer(control, id, value);
      setSubmitted(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法确认是否已收到你的答复。");
    } finally {
      answering.current = false;
      setSending(false);
    }
  }

  function pick(choice: string) {
    if (!multiSelect) {
      void answer(choice);
      return;
    }
    setSelected((current) => current.includes(choice) ? current.filter((item) => item !== choice) : [...current, choice]);
  }

  let savedAnswer = control.answer;
  if (multiSelect && savedAnswer) {
    try {
      const values: unknown = JSON.parse(savedAnswer);
      if (Array.isArray(values) && values.every((value) => typeof value === "string")) savedAnswer = values.join("、");
    } catch {
      // 旧客户端点击单个选项时保存的是纯文本。
    }
  }

  return (
    <Card>
      <Text style={styles.label}>{clarify ? "澄清问题" : "操作审批"}</Text>
      <Text selectable style={styles.text}>
        {control.prompt === "Hermes requires an answer" ? "Hermes 正在等待回答。" : control.prompt}
      </Text>
      {control.status !== "pending" || submitted ? (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          {savedAnswer === "" ? "已跳过" : savedAnswer ? `你的答复：${choiceLabel(savedAnswer)}` : {
            responding: "正在发送答复…",
            pending: "正在发送答复…",
            closed: "已结束等待",
            unknown: "答复待确认",
          }[control.status]}
        </Text>
      ) : (
        <>
          {multiSelect && !other && <Text style={styles.muted}>可选择一项或多项。</Text>}
          {!other && control.choices.length > 0 && (
            <View style={styles.row}>
              {control.choices.map((choice) => (
                <Action key={choice} title={choiceLabel(choice)} disabled={!canAnswer} selected={multiSelect ? selected.includes(choice) : undefined}
                  icon={selected.includes(choice) ? "check" : undefined} onPress={() => pick(choice)} />
              ))}
            </View>
          )}
          {showText && (
            <Field accessibilityLabel="澄清答复" placeholder="输入你的答复" value={text} editable={canAnswer}
              onChangeText={setText} autoFocus={other} />
          )}
          {clarify ? (
            <View style={styles.row}>
              {showText && (
                <Action title="回复" primary disabled={!canAnswer || !text.trim()}
                  onPress={() => void answer(multiSelect ? JSON.stringify([text.trim()]) : text.trim())} />
              )}
              {multiSelect && !other && (
                <Action title="回复" primary disabled={!canAnswer || !selected.length}
                  onPress={() => void answer(JSON.stringify(selected))} />
              )}
              {control.choices.length > 0 && (
                <Action title={other ? "显示选项" : "其他"} disabled={!canAnswer} onPress={() => setOther(!other)} />
              )}
              <Action title="跳过" disabled={!canAnswer} onPress={() => void answer("")} />
            </View>
          ) : !control.choices.length && <Text style={styles.muted}>暂无可用的审批选项。</Text>}
        </>
      )}
      {control.status === "pending" && !submitted && !enabled && <Text style={styles.muted}>重新连接 Hermes 后即可答复。</Text>}
      {(error ?? control.error) && <Notice>{error ?? control.error}</Notice>}
    </Card>
  );
}

export function Conversation({
  id, topic, workspace, draft, onDraftChange,
}: {
  id: string;
  topic?: Topic;
  workspace: ReturnType<typeof useWorkspace>;
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const { colors, styles } = useTheme();
  const { width } = useWindowDimensions();
  const messageWidth = Math.min(560, (width - transcriptGutter * 2) * 0.86);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const pinned = useRef(true);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [draftFocused, setDraftFocused] = useState(false);
  const [sendFocused, setSendFocused] = useState(false);
  const [menu, setMenu] = useState<"commands" | "skills">();
  const [error, setError] = useState<string>();
  const [modelPicker, setModelPicker] = useState(false);
  const [modelNotice, setModelNotice] = useState<string>();
  const interruptId = useRef<string>(undefined);
  const messages = workspace.detail?.messages ?? [];
  const controls = workspace.detail?.controls ?? [];
  const submitted = new Set(messages.filter((message) => message.role === "user").map((message) => message.submission_id));
  const historyControls = new Map<string, Control[]>();
  const trailingControls: Control[] = [];
  for (const control of controls) {
    const submission = control.submission_id;
    if (!submission || !submitted.has(submission) || control.status !== "closed") {
      trailingControls.push(control);
      continue;
    }
    const group = historyControls.get(submission) ?? [];
    group.push(control);
    historyControls.set(submission, group);
  }
  const pending = workspace.pending
    .filter((item) => item.topic_id === id && !messages.some((message) => message.submission_id === item.submission_id))
    .sort((a, b) => a.created_at - b.created_at);
  const canSend = topic?.status === "ready" && workspace.ready && !sending;
  const canControl = workspace.network === "online" && workspace.connector_online === true;
  const isModelCommand = draft.trim().toLowerCase() === "/model";
  const sendDisabled = !canSend || !draft.trim() || (isModelCommand && !canControl);
  const activeSubmission = messages.find((message) => message.role === "user" && message.status === "streaming")?.submission_id;
  const running = Boolean(activeSubmission);
  const modelBusy = pending.length > 0 || messages.some((message) => message.role === "user" &&
    ["accepted", "queued", "streaming"].includes(message.status));

  function keepLatestVisible() {
    if (pinned.current) scroll.current?.scrollToEnd({ animated: false });
  }

  useEffect(() => {
    interruptId.current = undefined;
  }, [activeSubmission]);

  async function send() {
    const text = draft.trim();
    if (!text || !canSend) return;
    if (isModelCommand) {
      if (!canControl) return;
      Keyboard.dismiss();
      setError(undefined);
      setModelNotice(undefined);
      setModelPicker(true);
      onDraftChange("");
      return;
    }
    setSending(true);
    setError(undefined);
    try {
      await workspace.enqueue({ submission_id: randomUUID(), topic_id: id, text, created_at: Date.now() });
      onDraftChange("");
      setModelNotice(undefined);
      pinned.current = true;
      scroll.current?.scrollToEnd({ animated: true });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法保存消息。");
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (!activeSubmission || !canControl || stopping) return;
    const request_id = interruptId.current ?? randomUUID();
    interruptId.current = request_id;
    setStopping(true);
    setError(undefined);
    try {
      await workspace.call(`/topics/${id}/interrupt`, {
        method: "POST", body: { request_id, submission_id: activeSubmission },
      });
      await workspace.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法确认停止请求是否生效。");
    } finally {
      setStopping(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.frame} behavior={Platform.OS === "web" ? undefined : "padding"}>
      {menu && (
        <ComposerMenu kind={menu} id={id} call={workspace.call}
          profile={workspace.profiles.find((item) => item.profile_id === topic?.profile_id)?.label}
          canStop={running && canControl && !stopping}
          onClose={() => setMenu(undefined)}
          onStop={() => { setMenu(undefined); void stop(); }} />
      )}
      <ScrollView
        ref={scroll}
        contentContainerStyle={chat.transcript}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={workspace.syncing}
            onRefresh={() => void workspace.refresh()}
            tintColor={colors.accent}
            colors={[colors.accent]}
          />
        }
        onContentSizeChange={keepLatestVisible}
        onLayout={keepLatestVisible}
        onScroll={({ nativeEvent }) => {
          pinned.current = nativeEvent.contentSize.height - nativeEvent.layoutMeasurement.height - nativeEvent.contentOffset.y < 100;
        }}
        scrollEventThrottle={32}
      >
        {workspace.error && <Notice>{workspace.error}</Notice>}
        {workspace.storageError && <Notice>{workspace.storageError}</Notice>}
        {topic?.status === "creating" && (
          <View style={chat.progress}>
            <ActivityIndicator color={colors.accent} />
            <Text accessibilityLiveRegion="polite" style={styles.muted}>正在创建 Hermes 会话…</Text>
          </View>
        )}
        {topic?.status === "error" && <Notice>{topic.error ?? "Hermes 无法创建此会话。"}</Notice>}
        {topic?.status === "ready" && messages.length === 0 && pending.length === 0 && controls.length === 0 && (
          <View style={chat.empty}>
            <EmptyState icon="chat" title="开始对话" description="给 Hermes 发送一条消息。" />
          </View>
        )}
        {messages.map((message, index) => {
          const outgoing = message.role === "user";
          const startGroup = messages[index - 1]?.role !== message.role;
          const attachedControls = outgoing && message.submission_id ? historyControls.get(message.submission_id) : undefined;
          return (
            <View key={message.message_id} style={chat.messageGroup}>
              <View style={[chat.message, { maxWidth: messageWidth }, outgoing && chat.outgoing, startGroup && chat.startGroup]}>
                {!!message.text && (
                  <View style={[
                    chat.bubble,
                    outgoing ? chat.outgoingBubble : chat.incomingBubble,
                    { backgroundColor: outgoing ? colors.accentFill : colors.secondary },
                  ]}>
                    <Text
                      selectable
                      accessibilityLabel={`${outgoing ? "你" : "Hermes"}：${message.text}`}
                      style={[styles.text, chat.messageText, outgoing && { color: colors.onAccent }]}
                    >
                      {message.text}
                    </Text>
                  </View>
                )}
                {messageStatus[message.status] ? (
                  <Text style={[styles.caption, outgoing && chat.outgoingStatus]}>
                    {!outgoing && !message.text && message.status === "streaming" ? "Hermes 正在回复…" : messageStatus[message.status]}
                  </Text>
                ) : null}
                {message.error && <Notice>{message.error}</Notice>}
              </View>
              {attachedControls?.map((control) => (
                <ControlCard key={control.control_id} control={control} enabled={canControl} onAnswer={workspace.answer} />
              ))}
            </View>
          );
        })}
        {pending.map((item) => (
          <View key={item.submission_id} style={[chat.message, chat.outgoing, { maxWidth: messageWidth }]}>
            <View style={[chat.bubble, chat.outgoingBubble, { backgroundColor: colors.tint }]}>
              <Text selectable accessibilityLabel={`你：${item.text}`} style={[styles.text, chat.messageText]}>
                {item.text}
              </Text>
            </View>
            {item.error ? (
              <>
                <Notice>{item.error}</Notice>
                <Action
                  title="丢弃未发送的消息"
                  destructive
                  onPress={() => void workspace.discard(item).catch((failure: unknown) => {
                    setError(failure instanceof Error ? failure.message : "无法丢弃未发送的消息。");
                  })}
                />
              </>
            ) : <Text style={[styles.caption, chat.outgoingStatus]}>等待发送</Text>}
          </View>
        ))}
        {trailingControls.map((control) => (
          <ControlCard key={control.control_id} control={control} enabled={canControl} onAnswer={workspace.answer} />
        ))}
      </ScrollView>
      <View style={[chat.composer, { borderTopColor: colors.edge }]}>
        {error && <Notice>{error}</Notice>}
        {modelNotice && <Text accessibilityLiveRegion="polite" style={styles.muted}>{modelNotice}</Text>}
        {isModelCommand && !canControl && <Text style={styles.muted}>连接 Hermes 后即可选择模型。</Text>}
        <View style={styles.row}>
          <Action title="命令" disabled={topic?.status !== "ready"} onPress={() => { Keyboard.dismiss(); setMenu("commands"); }} />
          <Action title="技能" disabled={topic?.status !== "ready"} onPress={() => { Keyboard.dismiss(); setMenu("skills"); }} />
          {running && (
            <Action title={stopping ? "正在请求停止…" : "停止回复"} icon="stop"
              disabled={!canControl || stopping} onPress={() => void stop()} />
          )}
        </View>
        <View style={[chat.composerRow, { backgroundColor: colors.field, borderColor: draftFocused ? colors.accent : colors.edge }]}>
          <Field
            accessibilityLabel="消息"
            placeholder="发消息给 Hermes"
            style={chat.draft}
            multiline
            editable={topic?.status === "ready" && !sending}
            value={draft}
            onChangeText={onDraftChange}
            onFocus={() => setDraftFocused(true)}
            onBlur={() => setDraftFocused(false)}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="发送"
            accessibilityState={{ disabled: sendDisabled, busy: sending }}
            disabled={sendDisabled}
            onPress={() => void send()}
            onFocus={() => setSendFocused(true)}
            onBlur={() => setSendFocused(false)}
            style={[chat.sendButton, sendFocused && !sendDisabled && { borderColor: colors.accent }]}
          >
            {({ pressed }) => (
              <View style={[
                chat.sendCircle,
                { backgroundColor: sendDisabled ? colors.secondary : colors.accentFill },
                pressed && chat.pressed,
              ]}>
                {sending ? <ActivityIndicator size="small" color={colors.muted} /> : (
                  <Icon name="send" size={18} color={sendDisabled ? colors.muted : colors.onAccent} />
                )}
              </View>
            )}
          </Pressable>
        </View>
      </View>
      {modelPicker && (
        <ModelPicker
          enabled={canControl && !modelBusy}
          unavailable={modelBusy ? "请等待当前回复结束，再切换模型。"
            : !canControl ? "重新连接 Hermes 后即可选择模型。" : undefined}
          onClose={() => setModelPicker(false)}
          onRequest={(requestId, selection, signal) => workspace.requestModel(id, requestId, selection, signal)}
          onSelected={({ selection, type }) => {
            setModelPicker(false);
            setModelNotice(type === "deferred" ? `已排队切换模型 · ${selection.model}` : `已选择模型 · ${selection.model}`);
          }}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const chat = StyleSheet.create({
  transcript: { flexGrow: 1, paddingHorizontal: transcriptGutter, paddingVertical: 11, gap: 6 },
  empty: { flex: 1, justifyContent: "center" },
  progress: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginVertical: 12 },
  message: { alignSelf: "flex-start", alignItems: "flex-start", gap: 3 },
  messageGroup: { gap: 6 },
  outgoing: { alignSelf: "flex-end", alignItems: "flex-end" },
  startGroup: { marginTop: 5 },
  bubble: { borderRadius: 16, paddingHorizontal: 11, paddingVertical: 7 },
  incomingBubble: { borderBottomStartRadius: 5 },
  outgoingBubble: { borderBottomEndRadius: 5 },
  messageText: { fontSize: 14, lineHeight: 20 },
  outgoingStatus: { textAlign: "right", marginEnd: 3 },
  composer: { paddingHorizontal: 10, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, gap: 6 },
  composerRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderRadius: 23,
    borderWidth: 1,
    minHeight: 46,
    paddingStart: 4,
  },
  draft: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    fontSize: 14,
    borderWidth: 0,
    backgroundColor: "transparent",
    paddingStart: 9,
    paddingEnd: 4,
    paddingVertical: 9,
    textAlignVertical: "top",
  },
  sendButton: { minWidth: 44, height: 44, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "transparent", borderRadius: 22 },
  sendCircle: { width: 29, height: 29, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.78 },
});
