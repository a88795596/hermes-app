import { randomUUID } from "expo-crypto";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { Control, Message, SessionStatus, Skill, Topic } from "@hermes-mobile/protocol";
import type { useWorkspace } from "../sync/use-workspace";
import { Action, Card, EmptyState, Field, Icon, Notice, useTheme } from "../ui/theme";
import { ComposerMenu, type ComposerCommand } from "./composer-menu";
import { ModelPicker } from "./model-picker";

const messageStatus: Record<Message["status"], string> = {
  accepted: "Accepted",
  queued: "Queued",
  streaming: "Responding…",
  final: "",
  failed: "Failed",
  unknown: "Execution unconfirmed",
  cancelled: "Stopped",
};

const transcriptGutter = 13;
const activityLabel: Record<SessionStatus["activity"], string> = {
  idle: "空闲",
  running: "正在响应",
  queued: "排队中",
  unknown: "执行状态待确认",
};

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
      setError(failure instanceof Error ? failure.message : "The response could not be confirmed.");
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
      if (Array.isArray(values) && values.every((value) => typeof value === "string")) savedAnswer = values.join(", ");
    } catch {
      // Earlier clients stored plain text for single button taps.
    }
  }

  return (
    <Card>
      <Text style={styles.label}>{clarify ? "Clarification" : "Approval"}</Text>
      <Text selectable style={styles.text}>{control.prompt}</Text>
      {control.status !== "pending" || submitted ? (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          {savedAnswer === "" ? "Skipped" : savedAnswer ? `You answered: ${savedAnswer}` : {
            responding: "Sending response…",
            pending: "Sending response…",
            closed: "No longer awaiting an answer",
            unknown: "Response unconfirmed",
          }[control.status]}
        </Text>
      ) : (
        <>
          {multiSelect && !other && <Text style={styles.muted}>Select one or more options.</Text>}
          {!other && control.choices.length > 0 && (
            <View style={styles.row}>
              {control.choices.map((choice) => (
                <Action key={choice} title={choice} disabled={!canAnswer} selected={multiSelect ? selected.includes(choice) : undefined}
                  icon={selected.includes(choice) ? "check" : undefined} onPress={() => pick(choice)} />
              ))}
            </View>
          )}
          {showText && (
            <Field accessibilityLabel="Clarification answer" placeholder="Your answer" value={text} editable={canAnswer}
              onChangeText={setText} autoFocus={other} />
          )}
          {clarify ? (
            <View style={styles.row}>
              {showText && (
                <Action title="Reply" primary disabled={!canAnswer || !text.trim()}
                  onPress={() => void answer(multiSelect ? JSON.stringify([text.trim()]) : text.trim())} />
              )}
              {multiSelect && !other && (
                <Action title="Reply" primary disabled={!canAnswer || !selected.length}
                  onPress={() => void answer(JSON.stringify(selected))} />
              )}
              {control.choices.length > 0 && (
                <Action title={other ? "Show choices" : "Other"} disabled={!canAnswer} onPress={() => setOther(!other)} />
              )}
              <Action title="Skip" disabled={!canAnswer} onPress={() => void answer("")} />
            </View>
          ) : !control.choices.length && <Text style={styles.muted}>No approval choices available.</Text>}
        </>
      )}
      {control.status === "pending" && !submitted && !enabled && <Text style={styles.muted}>Reconnect to Hermes to answer.</Text>}
      {(error ?? control.error) && <Notice>{error ?? control.error}</Notice>}
    </Card>
  );
}

export function Conversation({
  id, topic, workspace, draft, onDraftChange, onNewTopic,
}: {
  id: string;
  topic?: Topic;
  workspace: ReturnType<typeof useWorkspace>;
  draft: string;
  onDraftChange: (value: string) => void;
  onNewTopic: () => void;
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
  const [commandNotice, setCommandNotice] = useState<string>();
  const queryPending = useRef(false);
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
      setCommandNotice(undefined);
      setModelPicker(true);
      onDraftChange("");
      return;
    }
    setSending(true);
    setError(undefined);
    try {
      await workspace.enqueue({ submission_id: randomUUID(), topic_id: id, text, created_at: Date.now() });
      onDraftChange("");
      setCommandNotice(undefined);
      pinned.current = true;
      scroll.current?.scrollToEnd({ animated: true });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The message could not be saved.");
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (stopping) return;
    if (!activeSubmission || !canControl) {
      setCommandNotice(!activeSubmission ? "当前没有正在生成的响应。" : "连接 Hermes 后可停止响应。");
      return;
    }
    const request_id = interruptId.current ?? randomUUID();
    interruptId.current = request_id;
    setStopping(true);
    setError(undefined);
    setCommandNotice("正在请求停止响应…");
    try {
      await workspace.call(`/topics/${id}/interrupt`, {
        method: "POST", body: { request_id, submission_id: activeSubmission },
      });
      setCommandNotice("已请求停止响应。");
      await workspace.refresh();
    } catch (failure) {
      setCommandNotice(undefined);
      setError(failure instanceof Error ? failure.message : "The stop request could not be confirmed.");
    } finally {
      setStopping(false);
    }
  }

  async function runCommand(command: ComposerCommand) {
    if (command === "skills") {
      setMenu("skills");
      return;
    }
    setMenu(undefined);
    if (queryPending.current && (command === "status" || command === "version")) return;
    setError(undefined);
    setCommandNotice(undefined);
    if (command === "stop") {
      await stop();
    } else if (command === "model") {
      if (canControl) setModelPicker(true);
      else setCommandNotice("连接 Hermes 后可选择模型。");
    } else if (command === "new") {
      onNewTopic();
    } else {
      queryPending.current = true;
      setCommandNotice(command === "version" ? "正在查询 Hermes 版本…" : "正在查询会话状态…");
      try {
        if (command === "version") {
          setCommandNotice(`Hermes ${await workspace.call<string>(`/topics/${id}/version`)}`);
        } else {
          const status = await workspace.call<SessionStatus>(`/topics/${id}/status`);
          setCommandNotice(["/status", activityLabel[status.activity], status.model,
            status.message_count === undefined ? undefined : `${status.message_count} 条消息`,
          ].filter(Boolean).join(" · "));
        }
      } catch (failure) {
        setCommandNotice(undefined);
        setError(failure instanceof Error ? failure.message : "无法完成 Hermes 查询。");
      } finally {
        queryPending.current = false;
      }
    }
  }

  function selectSkill(skill: Skill) {
    setMenu(undefined);
    onDraftChange(`请先用 skill_view 加载技能 ${JSON.stringify(skill.name)}，再处理以下任务。\n\n${draft}`);
  }

  return (
    <KeyboardAvoidingView style={styles.frame} behavior={Platform.OS === "web" ? undefined : "padding"}>
      {menu && (
        <ComposerMenu kind={menu} id={id} call={workspace.call}
          profile={workspace.profiles.find((item) => item.profile_id === topic?.profile_id)?.label}
          connected={canControl}
          canStop={running && canControl && !stopping}
          onClose={() => setMenu(undefined)}
          onCommand={(command) => void runCommand(command)}
          onSkill={selectSkill} />
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
            <Text accessibilityLiveRegion="polite" style={styles.muted}>Creating the Hermes session…</Text>
          </View>
        )}
        {topic?.status === "error" && <Notice>{topic.error ?? "Hermes could not create this session."}</Notice>}
        {topic?.status === "ready" && messages.length === 0 && pending.length === 0 && controls.length === 0 && (
          <View style={chat.empty}>
            <EmptyState icon="chat" title="Start the conversation" description="Send a message to Hermes." />
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
                      accessibilityLabel={`${outgoing ? "You" : "Hermes"}: ${message.text}`}
                      style={[styles.text, chat.messageText, outgoing && { color: colors.onAccent }]}
                    >
                      {message.text}
                    </Text>
                  </View>
                )}
                {messageStatus[message.status] ? (
                  <Text style={[styles.caption, outgoing && chat.outgoingStatus]}>
                    {!outgoing && !message.text && message.status === "streaming" ? "Hermes is responding…" : messageStatus[message.status]}
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
              <Text selectable accessibilityLabel={`You: ${item.text}`} style={[styles.text, chat.messageText]}>
                {item.text}
              </Text>
            </View>
            {item.error ? (
              <>
                <Notice>{item.error}</Notice>
                <Action
                  title="Discard unsent message"
                  destructive
                  onPress={() => void workspace.discard(item).catch((failure: unknown) => {
                    setError(failure instanceof Error ? failure.message : "The unsent message could not be discarded.");
                  })}
                />
              </>
            ) : <Text style={[styles.caption, chat.outgoingStatus]}>Waiting to send</Text>}
          </View>
        ))}
        {trailingControls.map((control) => (
          <ControlCard key={control.control_id} control={control} enabled={canControl} onAnswer={workspace.answer} />
        ))}
      </ScrollView>
      <View style={[chat.composer, { borderTopColor: colors.edge }]}>
        {error && <Notice>{error}</Notice>}
        {commandNotice && <Text accessibilityLiveRegion="polite" style={styles.muted}>{commandNotice}</Text>}
        {isModelCommand && !canControl && <Text style={styles.muted}>Connect to Hermes to choose a model.</Text>}
        <View style={styles.row}>
          <Action title="命令" disabled={topic?.status !== "ready"} onPress={() => { Keyboard.dismiss(); setMenu("commands"); }} />
          <Action title="技能" disabled={topic?.status !== "ready"} onPress={() => { Keyboard.dismiss(); setMenu("skills"); }} />
          {running && (
            <Action title={stopping ? "Requesting stop…" : "Stop response"} icon="stop"
              disabled={!canControl || stopping} onPress={() => void stop()} />
          )}
        </View>
        <View style={[chat.composerRow, { backgroundColor: colors.field, borderColor: draftFocused ? colors.accent : colors.edge }]}>
          <Field
            accessibilityLabel="Message"
            placeholder="Message Hermes"
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
            accessibilityLabel="Send"
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
          unavailable={modelBusy ? "Wait for the current response before switching models."
            : !canControl ? "Reconnect to Hermes to choose a model." : undefined}
          onClose={() => setModelPicker(false)}
          onRequest={(requestId, selection, signal) => workspace.requestModel(id, requestId, selection, signal)}
          onSelected={({ selection, type }) => {
            setModelPicker(false);
            setCommandNotice(type === "deferred" ? `模型切换已排队 · ${selection.model}` : `已选择模型 · ${selection.model}`);
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
