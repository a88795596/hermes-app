import { randomUUID } from "expo-crypto";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MAX_ATTACHMENTS, type Attachment, type AttachmentUpload, type Control, type Message, type MessageProcessStep, type SessionStatus, type Skill, type Topic } from "@hermes-mobile/protocol";
import type { useWorkspace } from "../sync/use-workspace";
import { motion, useReduceMotion } from "../ui/motion";
import { Action, Card, EmptyState, Field, Icon, Notice, useTheme } from "../ui/theme";
import { pickAttachments } from "./attachments";
import { AttachmentMenu, ComposerMenu, ReasoningMenu, reasoningLabels, type ComposerCommand } from "./composer-menu";
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

const toolStatus: Record<Extract<MessageProcessStep, { kind: "tool" }>["status"], string> = {
  running: "执行中…",
  succeeded: "已完成",
  failed: "失败",
  unknown: "结果未确认",
};

const approvalLabels = new Map([
  ["once", "仅允许本次"],
  ["session", "本次会话内允许"],
  ["always", "始终允许"],
  ["deny", "拒绝"],
]);

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

function MessageAttachments({ items, tint }: { items: Attachment[]; tint: string }) {
  const { styles } = useTheme();
  return items.map((item, index) => (
    <View key={index} style={chat.attachmentLine}>
      <Icon name={item.mime.startsWith("image/") ? "photo" : "attachment"} size={15} color={tint} />
      <Text numberOfLines={2} style={[styles.text, chat.attachmentName, { color: tint }]}>{item.name}</Text>
    </View>
  ));
}

export function Conversation({
  id, topic, newProfileId, workspace, draft, onDraftChange, attachments, onAttachmentsChange, onNewTopic, showProcess,
}: {
  id: string;
  topic?: Topic;
  newProfileId?: string;
  workspace: ReturnType<typeof useWorkspace>;
  draft: string;
  attachments: AttachmentUpload[];
  showProcess: boolean;
  onDraftChange: (value: string) => void;
  onAttachmentsChange: (value: AttachmentUpload[]) => void;
  onNewTopic: () => void;
}) {
  const { colors, styles } = useTheme();
  const reduced = useReduceMotion();
  const { width } = useWindowDimensions();
  const { top: safeAreaTop } = useSafeAreaInsets();
  const messageWidth = Math.min(560, (width - transcriptGutter * 2) * 0.86);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const pinned = useRef(true);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [draftFocused, setDraftFocused] = useState(false);
  const [sendFocused, setSendFocused] = useState(false);
  const [menu, setMenu] = useState<"commands" | "skills" | "reasoning" | "attachments">();
  const [picking, setPicking] = useState(false);
  const choosingAttachment = useRef(false);
  const [error, setError] = useState<string>();
  const [modelPicker, setModelPicker] = useState(false);
  const [commandNotice, setCommandNotice] = useState<string>();
  const [openingSkills, setOpeningSkills] = useState(false);
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
  const canWrite = topic?.status === "ready" || (!!newProfileId && topic?.status !== "error");
  const canSend = canWrite && workspace.ready && !sending && !picking;
  const canControl = workspace.network === "online" && workspace.connector_online === true;
  const isModelCommand = !attachments.length && draft.trim().toLowerCase() === "/model";
  const activeSubmission = messages.find((message) => message.role === "user" && message.status === "streaming")?.submission_id;
  const running = Boolean(activeSubmission);
  const topicBusy = sending || pending.some((item) => !item.error) || messages.some((message) => message.role === "user" &&
    ["accepted", "queued", "streaming"].includes(message.status));
  const reasoning = topic?.reasoning_effort ?? null;
  const reasoningStatus = topic?.reasoning_status;
  const reasoningLegacy = canControl && workspace.reasoning_supported !== true;
  const reasoningBlocked = reasoningLegacy && (reasoningStatus !== undefined || reasoning !== null);
  const attachmentsBlocked = canControl && workspace.attachments_supported !== true;
  const sendDisabled = !canSend || (!draft.trim() && !attachments.length) || (!!attachments.length && attachmentsBlocked)
    || (isModelCommand ? !canControl : reasoningBlocked);
  const attachmentDisabled = !canWrite || picking || sending || attachments.length >= MAX_ATTACHMENTS;
  const reasoningUnavailable = !canControl ? "重新连接 Hermes 后即可切换思考强度。"
    : reasoningLegacy ? "更新服务端和连接器后即可切换思考强度。"
    : topicBusy ? "请等待当前消息处理完成，再切换思考强度。" : undefined;
  const reasoningLabel = reasoningBlocked ? "不可用"
    : reasoningStatus === "pending" ? "切换中" : reasoningStatus === "unknown" ? "待确认"
    : reasoning === null ? "跟随配置档案" : reasoningLabels[reasoning];

  function keepLatestVisible() {
    if (pinned.current) scroll.current?.scrollToEnd({ animated: false });
  }

  useEffect(() => {
    interruptId.current = undefined;
  }, [activeSubmission]);

  async function addAttachments(kind: "image" | "file") {
    if (choosingAttachment.current) return;
    choosingAttachment.current = true;
    setError(undefined);
    setPicking(true);
    try {
      // Keep the sheet mounted while iOS presents its system picker.
      const selected = await pickAttachments(kind, attachments);
      setMenu(undefined);
      if (selected.length) onAttachmentsChange([...attachments, ...selected]);
    } catch (failure) {
      setMenu(undefined);
      setError(failure instanceof Error ? failure.message : "无法读取所选附件。");
    } finally {
      choosingAttachment.current = false;
      setPicking(false);
    }
  }

  async function send() {
    const text = draft.trim();
    if (sendDisabled) return;
    if (isModelCommand) {
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
      await workspace.enqueue({ submission_id: randomUUID(), topic_id: id, text, created_at: Date.now(),
        ...(attachments.length && { attachments }),
        ...(newProfileId && { profile_id: newProfileId }) });
      onDraftChange("");
      if (attachments.length) onAttachmentsChange([]);
      setCommandNotice(undefined);
      pinned.current = true;
      scroll.current?.scrollToEnd({ animated: true });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法保存消息。");
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (stopping) return;
    if (!activeSubmission || !canControl) {
      setCommandNotice(!activeSubmission ? "当前没有正在生成的回复。" : "连接 Hermes 后可停止回复。");
      return;
    }
    const request_id = interruptId.current ?? randomUUID();
    interruptId.current = request_id;
    setStopping(true);
    setError(undefined);
    setCommandNotice("正在请求停止回复…");
    try {
      await workspace.call(`/topics/${id}/interrupt`, {
        method: "POST", body: { request_id, submission_id: activeSubmission },
      });
      setCommandNotice("已请求停止回复。");
      await workspace.syncWorkspace();
    } catch (failure) {
      setCommandNotice(undefined);
      setError(failure instanceof Error ? failure.message : "无法确认停止请求是否生效。");
    } finally {
      setStopping(false);
    }
  }

  async function runCommand(command: ComposerCommand) {
    if (command === "skills") {
      await openSkills();
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
      if (!canControl) return;
      queryPending.current = true;
      setCommandNotice(command === "version" ? "正在查询 Hermes 版本…" : "正在查询会话状态…");
      try {
        if (newProfileId && topic?.status !== "ready") await workspace.prepareTopic(id, newProfileId);
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

  async function openSkills() {
    if (openingSkills) return;
    setOpeningSkills(true);
    setMenu(undefined);
    setError(undefined);
    try {
      if (newProfileId && topic?.status !== "ready") await workspace.prepareTopic(id, newProfileId);
      setMenu("skills");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法加载技能。");
    } finally {
      setOpeningSkills(false);
    }
  }

  function selectSkill(skill: Skill) {
    setMenu(undefined);
    onDraftChange(`请先用 skill_view 加载技能 ${JSON.stringify(skill.name)}，再处理以下任务。\n\n${draft}`);
  }

  return (
    <KeyboardAvoidingView style={styles.frame} behavior={Platform.OS === "web" ? undefined : "padding"}
      keyboardVerticalOffset={safeAreaTop}>
      {menu === "attachments" ? (
        <AttachmentMenu busy={picking} onClose={() => setMenu(undefined)} onPick={(kind) => void addAttachments(kind)} />
      ) : menu === "reasoning" ? (
        <ReasoningMenu effort={reasoningStatus || reasoningBlocked ? undefined : reasoning}
          status={reasoningStatus} unavailable={reasoningUnavailable}
          onClose={() => setMenu(undefined)}
          onRequest={async (requestId, effort, signal) => {
            if (newProfileId && topic?.status !== "ready") await workspace.prepareTopic(id, newProfileId, signal);
            return workspace.requestReasoning(id, requestId, effort, signal);
          }} />
      ) : menu && (
        <ComposerMenu kind={menu} id={id} call={workspace.call}
          profile={workspace.profiles.find((item) => item.profile_id === (topic?.profile_id ?? newProfileId))?.label}
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
            refreshing={workspace.refreshing}
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
        {(topic?.status === "ready" || (!topic && newProfileId)) && messages.length === 0 && pending.length === 0 && controls.length === 0 && (
          <View style={chat.empty}>
            <EmptyState icon="chat" title="开始对话" description="给 Hermes 发送一条消息。" />
          </View>
        )}
        {messages.map((message, index) => {
          const outgoing = message.role === "user";
          const process = !outgoing && showProcess ? message.process : undefined;
          if (!outgoing && !message.text && !process?.length && message.status === "final") return null;
          const startGroup = messages[index - 1]?.role !== message.role;
          const attachedControls = outgoing && message.submission_id ? historyControls.get(message.submission_id) : undefined;
          return (
            <View key={message.message_id} style={chat.messageGroup}>
              <View style={[chat.message, { maxWidth: messageWidth }, outgoing && chat.outgoing, startGroup && chat.startGroup]}>
                {!!process?.length && (
                  <View style={[chat.process, { borderStartColor: colors.edge }]}>
                    {process.map((step, stepIndex) => {
                      if (step.kind === "tool") {
                        const status = step.status === "running" && message.status === "final" ? "unknown" : step.status;
                        return <Text key={stepIndex} style={styles.muted}>{step.name} · {toolStatus[status]}</Text>;
                      }
                      return (
                        <Text key={stepIndex} selectable style={styles.muted}>
                          {step.kind === "reasoning" && <Text style={styles.label}>思考{"\n"}</Text>}
                          {step.text}
                        </Text>
                      );
                    })}
                  </View>
                )}
                {(!!message.text || !!message.attachments?.length) && (
                  <View style={[
                    chat.bubble,
                    outgoing ? chat.outgoingBubble : chat.incomingBubble,
                    { backgroundColor: outgoing ? colors.accentFill : colors.secondary },
                  ]}>
                    {!!message.attachments?.length && <MessageAttachments items={message.attachments} tint={colors.onAccent} />}
                    {!!message.text && <Text
                      selectable
                      accessibilityLabel={`${outgoing ? "你" : "Hermes"}：${message.text}`}
                      style={[styles.text, chat.messageText, outgoing && { color: colors.onAccent }]}
                    >
                      {message.text}
                    </Text>}
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
          <Animated.View key={item.submission_id} style={[chat.message, chat.outgoing, { maxWidth: messageWidth }, !reduced && motion.reveal]}>
            <View style={[chat.bubble, chat.outgoingBubble, { backgroundColor: colors.tint }]}>
              {!!item.attachments?.length && <MessageAttachments items={item.attachments} tint={colors.foreground} />}
              {!!item.text && <Text selectable accessibilityLabel={`你：${item.text}`} style={[styles.text, chat.messageText]}>
                {item.text}
              </Text>}
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
            ) : <Text style={[styles.caption, chat.outgoingStatus]}>
              {item.attachments?.length && attachmentsBlocked ? "更新连接器后发送" : "等待发送"}
            </Text>}
          </Animated.View>
        ))}
        {trailingControls.map((control) => (
          <Animated.View key={control.control_id} style={!reduced && motion.reveal}>
            <ControlCard control={control} enabled={canControl} onAnswer={workspace.answer} />
          </Animated.View>
        ))}
      </ScrollView>
      <View style={[chat.composer, { borderTopColor: colors.edge }]}>
        {error && <Notice>{error}</Notice>}
        {commandNotice && <Text accessibilityLiveRegion="polite" style={styles.muted}>{commandNotice}</Text>}
        {isModelCommand && !canControl && <Text style={styles.muted}>连接 Hermes 后即可选择模型。</Text>}
        {reasoningBlocked && <Text accessibilityLiveRegion="polite" style={styles.muted}>更新 Hermes 连接器后可继续发送。</Text>}
        {!!attachments.length && attachmentsBlocked && <Notice>更新服务端和连接器后可发送附件。</Notice>}
        <View style={[styles.row, chat.toolbar]}>
          <Action compact title="命令" disabled={!canWrite} onPress={() => { Keyboard.dismiss(); setMenu("commands"); }} />
          <Action compact title={openingSkills ? "正在加载技能…" : "技能"}
            disabled={!canWrite || openingSkills || (topic?.status !== "ready" && !canControl)}
            onPress={() => { Keyboard.dismiss(); void openSkills(); }} />
          <Action compact disclosure title={reasoningLabel === "跟随配置档案" ? "思考强度" : `思考 · ${reasoningLabel}`}
            accessibilityLabel={`思考强度：${reasoningLabel}`} selected={reasoning !== null && !reasoningLegacy} disabled={!canWrite}
            onPress={() => { Keyboard.dismiss(); setMenu("reasoning"); }} />
          {running && (
            <Action compact title={stopping ? "停止中…" : "停止回复"} icon="stop"
              accessibilityLabel={stopping ? "正在请求停止回复" : undefined} disabled={!canControl || stopping} onPress={() => void stop()} />
          )}
        </View>
        {!!attachments.length && (
          <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={chat.attachmentTray}>
            {attachments.map((item, index) => (
              <View key={index} style={[chat.attachmentChip, { backgroundColor: colors.tint, borderColor: colors.edge }]}>
                <Icon name={item.mime.startsWith("image/") ? "photo" : "attachment"} size={16} color={colors.accent} />
                <Text numberOfLines={1} style={[styles.text, chat.attachmentName, chat.chipName]}>{item.name}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={`移除附件 ${item.name}`} disabled={sending || picking}
                  onPress={() => {
                    onAttachmentsChange(attachments.filter((_item, itemIndex) => itemIndex !== index));
                    setError(undefined);
                  }} style={({ pressed }) => [chat.iconButton, pressed && styles.faded]}>
                  <Icon name="close" size={14} color={colors.muted} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}
        <View style={[chat.composerRow, { backgroundColor: colors.field, borderColor: draftFocused ? colors.accent : colors.edge }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="添加附件"
            accessibilityState={{ disabled: attachmentDisabled, busy: picking, expanded: menu === "attachments" }}
            disabled={attachmentDisabled} onPress={() => { Keyboard.dismiss(); setMenu("attachments"); }}
            style={({ pressed }) => [chat.iconButton, (pressed || attachmentDisabled) && styles.faded]}>
            {picking ? <ActivityIndicator size="small" color={colors.accent} /> : <Icon name="attachment" size={20} color={colors.accent} />}
          </Pressable>
          <Field
            accessibilityLabel="消息"
            placeholder={attachments.length ? "添加描述…" : "发消息给 Hermes"}
            style={chat.draft}
            multiline
            editable={canWrite && !sending}
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
          enabled={canControl && !topicBusy}
          unavailable={topicBusy ? "请等待当前回复结束，再切换模型。"
            : !canControl ? "重新连接 Hermes 后即可选择模型。" : undefined}
          onClose={() => setModelPicker(false)}
          onRequest={async (requestId, selection, signal) => {
            if (newProfileId && topic?.status !== "ready") await workspace.prepareTopic(id, newProfileId, signal);
            return workspace.requestModel(id, requestId, selection, signal);
          }}
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
  process: { borderStartWidth: 1, paddingStart: 10, paddingVertical: 4, gap: 6, alignSelf: "stretch" },
  outgoing: { alignSelf: "flex-end", alignItems: "flex-end" },
  startGroup: { marginTop: 5 },
  bubble: { borderRadius: 16, paddingHorizontal: 11, paddingVertical: 7, gap: 4 },
  incomingBubble: { borderBottomStartRadius: 5 },
  outgoingBubble: { borderBottomEndRadius: 5 },
  messageText: { fontSize: 14, lineHeight: 20 },
  outgoingStatus: { textAlign: "right", marginEnd: 3 },
  composer: { paddingHorizontal: 10, paddingBottom: 6, borderTopWidth: StyleSheet.hairlineWidth, gap: 2 },
  toolbar: { gap: 8 },
  attachmentLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  attachmentName: { flexShrink: 1, fontSize: 13 },
  attachmentTray: { gap: 6, paddingVertical: 3 },
  attachmentChip: { flexDirection: "row", gap: 6, alignItems: "center", paddingStart: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  chipName: { maxWidth: 140 },
  iconButton: { minWidth: 44, height: 44, alignItems: "center", justifyContent: "center" },
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
