import { randomUUID } from "expo-crypto";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { Control, Message, Topic } from "@hermes-mobile/protocol";
import type { useWorkspace } from "../sync/use-workspace";
import { Action, Card, EmptyState, Field, Icon, Notice, useTheme } from "../ui/theme";
import { ComposerMenu } from "./composer-menu";

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

function ControlCard({
  control, enabled, onAnswer,
}: {
  control: Control;
  enabled: boolean;
  onAnswer: (control: Control, id: string, answer: string) => Promise<void>;
}) {
  const { styles } = useTheme();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const attempt = useRef<{ id: string; answer: string }>(undefined);
  const canAnswer = enabled && !sending && control.status === "pending";

  async function answer(value: string) {
    if (!canAnswer) return;
    const prior = attempt.current;
    const id = prior?.answer === value ? prior.id : randomUUID();
    attempt.current = { id, answer: value };
    setSending(true);
    setError(undefined);
    try {
      await onAnswer(control, id, value);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The response could not be confirmed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <Text style={styles.label}>{control.kind === "approval" ? "Approval" : "Clarification"}</Text>
      <Text selectable style={styles.text}>{control.prompt}</Text>
      {control.status !== "pending" ? (
        <Text style={styles.muted}>{{
          responding: "Sending response…",
          closed: "Closed",
          unknown: "Response unconfirmed",
        }[control.status]}</Text>
      ) : control.choices.length ? (
        <View style={styles.row}>
          {control.choices.map((choice) => (
            <Action key={choice} title={choice} disabled={!canAnswer} onPress={() => void answer(choice)} />
          ))}
        </View>
      ) : control.kind === "clarify" ? (
        <>
          <Field accessibilityLabel="Clarification answer" placeholder="Your answer" value={text} editable={canAnswer} onChangeText={setText} />
          <Action title="Reply" disabled={!canAnswer || !text.trim()} onPress={() => void answer(text.trim())} />
        </>
      ) : <Text style={styles.muted}>No approval choices available.</Text>}
      {error && <Notice>{error}</Notice>}
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
  const interruptId = useRef<string>(undefined);
  const messages = workspace.detail?.messages ?? [];
  const controls = workspace.detail?.controls ?? [];
  const pending = workspace.pending
    .filter((item) => item.topic_id === id && !messages.some((message) => message.submission_id === item.submission_id))
    .sort((a, b) => a.created_at - b.created_at);
  const canSend = topic?.status === "ready" && workspace.ready && !sending;
  const sendDisabled = !canSend || !draft.trim();
  const canControl = workspace.network === "online" && workspace.connector_online === true;
  const activeSubmission = messages.find((message) => message.role === "user" && message.status === "streaming")?.submission_id;
  const running = Boolean(activeSubmission);

  function keepLatestVisible() {
    if (pinned.current) scroll.current?.scrollToEnd({ animated: false });
  }

  useEffect(() => {
    interruptId.current = undefined;
  }, [activeSubmission]);

  async function send() {
    const text = draft.trim();
    if (!text || !canSend) return;
    setSending(true);
    setError(undefined);
    try {
      await workspace.enqueue({ submission_id: randomUUID(), topic_id: id, text, created_at: Date.now() });
      onDraftChange("");
      pinned.current = true;
      scroll.current?.scrollToEnd({ animated: true });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The message could not be saved.");
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
      setError(failure instanceof Error ? failure.message : "The stop request could not be confirmed.");
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
          return (
            <View key={message.message_id} style={[chat.message, { maxWidth: messageWidth }, outgoing && chat.outgoing, startGroup && chat.startGroup]}>
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
        {controls.map((control) => (
          <ControlCard key={control.control_id} control={control} enabled={canControl} onAnswer={workspace.answer} />
        ))}
      </ScrollView>
      <View style={[chat.composer, { borderTopColor: colors.edge }]}>
        {error && <Notice>{error}</Notice>}
        <View style={styles.row}>
          <Action title="Commands" disabled={topic?.status !== "ready"} onPress={() => { Keyboard.dismiss(); setMenu("commands"); }} />
          <Action title="Skills" disabled={topic?.status !== "ready"} onPress={() => { Keyboard.dismiss(); setMenu("skills"); }} />
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
    </KeyboardAvoidingView>
  );
}

const chat = StyleSheet.create({
  transcript: { flexGrow: 1, paddingHorizontal: transcriptGutter, paddingVertical: 11, gap: 6 },
  empty: { flex: 1, justifyContent: "center" },
  progress: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginVertical: 12 },
  message: { alignSelf: "flex-start", alignItems: "flex-start", gap: 3 },
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
