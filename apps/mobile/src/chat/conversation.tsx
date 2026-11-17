import { randomUUID } from "expo-crypto";
import { openBrowserAsync, WebBrowserPresentationStyle } from "expo-web-browser";
import { useCallback, useEffect, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MAX_ATTACHMENTS, type AttachmentUpload, type Control, type Message, type MessageProcessStep, type Skill, type Topic } from "@hermes-mobile/protocol";
import type { Session } from "../auth/session";
import type { useWorkspace } from "../sync/use-workspace";
import { haptic } from "../ui/haptics";
import { useAlert } from "../ui/alerts";
import { motion, useReduceMotion } from "../ui/motion";
import { profileLabel } from "../ui/text";
import { Action, CloseButton, Field, Icon, Notice, useTheme } from "../ui/theme";
import { AnswerMarkdown } from "./answer-markdown";
import { AssistantStreamBorder } from "./assistant-stream-border";
import { pickAttachments } from "./attachments";
import { AttachmentMenu, ComposerMenu, ReasoningMenu, reasoningLabels } from "./composer-menu";
import { ModelPicker } from "./model-picker";
import { NativeCommandSheet } from "./native-command";
import { MessageAttachments } from "./message-attachments";
import { SettingsDrawer } from "./settings-drawer";
import { ProfileSwipe } from "../profiles/swipe";
import { useSpeechInput } from "./use-speech-input";

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

const transcriptGutter = 24;
const touchSize = Platform.OS === "android" ? 48 : 44;

function ProcessTimeline({ steps, final }: { steps: MessageProcessStep[]; final: boolean }) {
  const { colors, styles } = useTheme();
  const { height } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  const visibleSteps = expanded ? steps : steps.slice(-1);
  const title = steps.some((step) => step.kind === "reasoning") ? "思考" : "执行过程";
  return (
    <View style={[chat.process, { borderColor: colors.edge }, expanded && { maxHeight: height / 3 }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? "收起" : "展开"}${title}`}
        accessibilityState={{ expanded }}
        onPress={() => { haptic("selection"); setExpanded((current) => !current); }}
        style={({ pressed }) => [chat.sectionHeader, { minHeight: touchSize }, pressed && styles.faded]}>
        <View style={[chat.sectionIcon, { backgroundColor: colors.tint }]}>
          <Icon name="sparkle" size={17} color={colors.accent} />
        </View>
        <Text accessibilityRole="header" style={[styles.heading, chat.sectionTitle, { flex: 1 }]}>
          {title}
        </Text>
        <Icon name={expanded ? "down" : "chevron"} size={17} color={colors.muted} />
      </Pressable>
      {(expanded || !final) && <ScrollView style={chat.processScroll} contentContainerStyle={chat.processSteps}
        scrollEnabled={expanded} nestedScrollEnabled bounces={false} keyboardShouldPersistTaps="handled">
        {visibleSteps.map((step, index) => {
          const status = step.kind !== "tool" || (step.status === "running" && final) ? "unknown" : step.status;
          const complete = status === "succeeded";
          return (
            <View key={expanded ? index : steps.length - 1} style={chat.processStep}>
              {index < visibleSteps.length - 1 && <View style={[chat.processRail, { backgroundColor: colors.edge }]} />}
              <View style={[chat.processMarker, {
                borderColor: status === "failed" ? colors.error : colors.accent,
                backgroundColor: complete ? colors.accentFill : colors.background,
              }]}>{complete && <Icon name="check" size={10} color={colors.onAccent} />}</View>
              <Text selectable style={[styles.text, chat.processText]}>
                {step.kind === "tool" ? `${step.name} · ${toolStatus[status]}` : step.text}
              </Text>
            </View>
          );
        })}
      </ScrollView>}
    </View>
  );
}

function ControlPrompt({
  control, enabled, onAnswer,
}: {
  control: Control;
  enabled: boolean;
  onAnswer: (control: Control, id: string, answer: string) => Promise<void>;
}) {
  const { colors, styles } = useTheme();
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
  const secondaryAction = [chat.controlAction, { backgroundColor: "transparent", borderColor: colors.edge }];

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
      haptic("error");
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
    <View style={chat.control}>
      <View style={chat.sectionHeader}>
        <View style={[chat.sectionIcon, { backgroundColor: colors.tint }]}>
          <Icon name={clarify ? "sparkle" : "approval"} size={17} color={colors.accent} />
        </View>
        <Text accessibilityRole="header" style={[styles.heading, chat.sectionTitle]}>{clarify ? "澄清问题" : "操作审批"}</Text>
      </View>
      <Text selectable style={[styles.text, chat.messageText, clarify && chat.clarifyPrompt]}>
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
            <View style={chat.controlActions}>
              {control.choices.map((choice) => (
                <Action key={choice} title={choiceLabel(choice)} disabled={!canAnswer} primary={!clarify && choice === "once"}
                  selected={multiSelect ? selected.includes(choice) : undefined} style={[chat.controlAction, clarify && chat.controlChoice]}
                  feedback={multiSelect ? "selection" : choice === "deny" ? "warning" : "medium"}
                  icon={selected.includes(choice) ? "check" : undefined} onPress={() => pick(choice)} />
              ))}
            </View>
          )}
          {showText && (
            <Field accessibilityLabel="澄清答复" placeholder="输入你的答复" value={text} editable={canAnswer}
              onChangeText={setText} autoFocus={other} />
          )}
          {clarify ? (
            <View style={chat.controlActions}>
              {showText && (
                <Action title="回复" primary style={chat.controlAction} disabled={!canAnswer || !text.trim()}
                  onPress={() => void answer(multiSelect ? JSON.stringify([text.trim()]) : text.trim())} />
              )}
              {multiSelect && !other && (
                <Action title="回复" primary style={chat.controlAction} disabled={!canAnswer || !selected.length}
                  onPress={() => void answer(JSON.stringify(selected))} />
              )}
              {control.choices.length > 0 && (
                <Action title={other ? "显示选项" : "其他"} style={secondaryAction} disabled={!canAnswer} onPress={() => setOther(!other)} />
              )}
              <Action title="跳过" style={secondaryAction} disabled={!canAnswer} onPress={() => void answer("")} />
            </View>
          ) : !control.choices.length && <Text style={styles.muted}>暂无可用的审批选项。</Text>}
        </>
      )}
      {control.status === "pending" && !submitted && !enabled && <Text style={styles.muted}>重新连接 Hermes 后即可答复。</Text>}
      {(error ?? control.error) && <Notice>{error ?? control.error}</Notice>}
    </View>
  );
}

export function Conversation({
  id, topic, newProfileId, workspace, session, draft, onDraftChange, attachments, onAttachmentsChange,
  settingsOpen, onCloseSettings, targetMessageId, settingsNavigation, applicationSettings, onSwitchProfile, onSwitchBlockedChange,
}: {
  id: string;
  topic?: Topic;
  newProfileId?: string;
  targetMessageId?: string;
  workspace: ReturnType<typeof useWorkspace>;
  session: Session;
  draft: string;
  attachments: AttachmentUpload[];
  settingsOpen: boolean;
  onCloseSettings: () => void;
  settingsNavigation?: React.ReactNode;
  applicationSettings?: React.ReactNode;
  onSwitchProfile?: (direction: -1 | 1) => void;
  onSwitchBlockedChange?: (blocked: boolean) => void;
  onDraftChange: (value: string) => void;
  onAttachmentsChange: (value: AttachmentUpload[]) => void;
}) {
  const { colors, styles } = useTheme();
  const { alert } = useAlert();
  const reduced = useReduceMotion();
  const { width } = useWindowDimensions();
  const { top: safeAreaTop } = useSafeAreaInsets();
  const messageWidth = Math.min(560, (width - transcriptGutter * 2) * 0.84);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const pinned = useRef(!targetMessageId);
  const focusTarget = useRef(Boolean(targetMessageId));
  const messageOffsets = useRef(new Map<string, number>());
  const [sending, setSending] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const recoveryInFlight = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const enqueueing = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [draftFocused, setDraftFocused] = useState(false);
  const [sendFocused, setSendFocused] = useState(false);
  const [menu, setMenu] = useState<"commands" | "skills" | "reasoning" | "attachments">();
  const [picking, setPicking] = useState(false);
  const choosingAttachment = useRef(false);
  const [error, setError] = useState<string>();
  const [modelPicker, setModelPicker] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [commandNotice, setCommandNotice] = useState<string>();
  const [openingSkills, setOpeningSkills] = useState(false);
  const commandOpen = useRef(false);
  const [nativeCommand, setNativeCommand] = useState<{ command: string; requestId: string }>();
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
  const speech = useSpeechInput(id, canWrite && !picking, draft, onDraftChange);
  const canSend = canWrite && workspace.ready && !sending && !picking;
  const canControl = workspace.network === "online" && workspace.connector_online === true;
  const isModelCommand = !attachments.length && draft.trim().toLowerCase() === "/model";
  const isNativeCommand = /^\/[a-z0-9][a-z0-9_-]*(?:\s|$)/iu.test(draft.trim());
  const activeSubmission = messages.find((message) => message.role === "user" && message.status === "streaming")?.submission_id;
  const running = Boolean(activeSubmission);
  const topicBusy = sending || pending.some((item) => !item.error) || messages.some((message) => message.role === "user" &&
    ["accepted", "queued", "streaming"].includes(message.status));
  const reasoning = topic?.reasoning_effort ?? null;
  const reasoningStatus = topic?.reasoning_status;
  const reasoningLegacy = canControl && workspace.reasoning_supported !== true;
  const reasoningBlocked = reasoningLegacy && (reasoningStatus !== undefined || reasoning !== null);
  const attachmentsBlocked = canControl && workspace.attachments_supported !== true;
  const sendDisabled = !canSend || (!draft.trim() && !attachments.length && !speech.busy) || (!!attachments.length && attachmentsBlocked)
    || (isNativeCommand ? !canControl : reasoningBlocked);
  const speechVisible = !draft.length || speech.busy;
  const speechDisabled = !speechVisible || sending || speech.state === "stopping" || (!speech.busy && (!canWrite || picking || openingSkills));
  const attachmentDisabled = !canWrite || picking || sending || attachments.length >= MAX_ATTACHMENTS;
  const reasoningUnavailable = !canControl ? "重新连接 Hermes 后即可切换思考强度。"
    : reasoningLegacy ? "更新服务端和连接器后即可切换思考强度。"
    : topicBusy ? "请等待当前消息处理完成，再切换思考强度。" : undefined;
  const reasoningLabel = reasoningBlocked ? "不可用"
    : reasoningStatus === "pending" ? "切换中" : reasoningStatus === "unknown" ? "待确认"
    : reasoning === null ? "跟随配置档案" : reasoningLabels[reasoning];
  const currentProfile = workspace.profiles.find((item) => item.profile_id === (topic?.profile_id ?? newProfileId));
  const switchBlocked = speech.busy || picking || sending || recovering || openingSkills || !!nativeCommand;
  useEffect(() => {
    onSwitchBlockedChange?.(switchBlocked);
    return () => onSwitchBlockedChange?.(false);
  }, [onSwitchBlockedChange, switchBlocked]);

  function recoverStream() {
    alert("恢复会话", "将当前会话归档后重新连接。历史记录、草稿和待发消息会保留。", [
      { text: "取消", style: "cancel" },
      { text: "恢复", onPress: () => {
        if (recoveryInFlight.current) return;
        recoveryInFlight.current = true;
        setRecovering(true);
        void workspace.setTopicArchived(id, true).catch((failure: unknown) => {
          setError(failure instanceof Error ? failure.message : "无法恢复会话，请重试。");
        }).finally(() => { recoveryInFlight.current = false; setRecovering(false); });
      } },
    ]);
  }

  const openLink = useCallback((url: string) => {
    haptic("light");
    Keyboard.dismiss();
    setError(undefined);
    void openBrowserAsync(url, {
      dismissButtonStyle: "close",
      presentationStyle: WebBrowserPresentationStyle.PAGE_SHEET,
      createTask: false,
      toolbarColor: colors.surface,
      controlsColor: colors.foreground,
      windowFeatures: { noopener: true, noreferrer: true },
    }).catch(() => { haptic("error"); setError("无法打开网页，请重试。"); });
  }, [colors.foreground, colors.surface, setError]);

  function keepLatestVisible() {
    if (focusTarget.current && targetMessageId) {
      const y = messageOffsets.current.get(targetMessageId);
      if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, y - 8), animated: false });
    } else if (pinned.current) scroll.current?.scrollToEnd({ animated: false });
  }

  useEffect(() => {
    focusTarget.current = Boolean(targetMessageId);
    pinned.current = !targetMessageId;
    const y = targetMessageId ? messageOffsets.current.get(targetMessageId) : undefined;
    if (y !== undefined) scroll.current?.scrollTo({ y: Math.max(0, y - 8), animated: false });
    else if (!targetMessageId) scroll.current?.scrollToEnd({ animated: false });
  }, [id, targetMessageId]);

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
      if (selected.length) {
        onAttachmentsChange([...attachments, ...selected]);
        haptic("selection");
      }
    } catch (failure) {
      haptic("error");
      setMenu(undefined);
      setError(failure instanceof Error ? failure.message : "无法读取所选附件。");
    } finally {
      choosingAttachment.current = false;
      setPicking(false);
    }
  }

  const stop = useCallback(async () => {
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
      haptic("error");
      setCommandNotice(undefined);
      setError(failure instanceof Error ? failure.message : "无法确认停止请求是否生效。");
    } finally {
      setStopping(false);
    }
  }, [activeSubmission, canControl, id, setCommandNotice, setError, setStopping, stopping, workspace]);

  const openMenu = useCallback(async (kind: "skills" | "commands") => {
    if (openingSkills) return;
    setOpeningSkills(true);
    setMenu(undefined);
    setError(undefined);
    try {
      if (newProfileId && topic?.status !== "ready") await workspace.prepareTopic(id, newProfileId);
      setMenu(kind);
    } catch (failure) {
      haptic("error");
      setError(failure instanceof Error ? failure.message : "无法加载 Hermes 菜单。");
    } finally {
      setOpeningSkills(false);
    }
  }, [id, newProfileId, openingSkills, setError, setMenu, setOpeningSkills, topic, workspace]);

  const runCommand = useCallback((command: string) => {
    if (!canControl || commandOpen.current) return;
    setMenu(undefined);
    setError(undefined);
    setCommandNotice(undefined);
    const name = command.trim().toLowerCase();
    if (name === "/stop") {
      void stop();
    } else if (name === "/skills") {
      void openMenu("skills");
    } else if (name === "/model") {
      setModelPicker(true);
    } else if (name === "/reasoning") {
      setMenu("reasoning");
    } else {
      commandOpen.current = true;
      setNativeCommand({ command, requestId: randomUUID() });
    }
  }, [canControl, openMenu, setCommandNotice, setError, setMenu, setModelPicker, setNativeCommand, stop]);

  const send = useCallback(async () => {
    if (enqueueing.current || sendDisabled) return;
    enqueueing.current = true;
    setSending(true);
    setError(undefined);
    try {
      const finalDraft = await speech.stop();
      if (finalDraft === null) return;
      const text = finalDraft.trim();
      const native = /^\/[a-z0-9][a-z0-9_-]*(?:\s|$)/iu.test(text);
      if ((!text && !attachments.length) || (native ? !canControl : reasoningBlocked)) return;
      if (native && attachments.length) {
        setError("命令不能附带文件，请先移除附件。");
        return;
      }
      haptic(native ? "light" : "medium");
      if (native) {
        Keyboard.dismiss();
        if (newProfileId && topic?.status !== "ready") await workspace.prepareTopic(id, newProfileId);
        runCommand(finalDraft.trimStart());
        onDraftChange("");
        return;
      }
      await workspace.enqueue({ submission_id: randomUUID(), topic_id: id, text, created_at: Date.now(),
        ...(attachments.length && { attachments }),
        ...(newProfileId && { profile_id: newProfileId }) });
      onDraftChange("");
      if (attachments.length) onAttachmentsChange([]);
      setCommandNotice(undefined);
      focusTarget.current = false;
      pinned.current = true;
      scroll.current?.scrollToEnd({ animated: true });
    } catch (failure) {
      haptic("error");
      setError(failure instanceof Error ? failure.message : "无法保存消息。");
    } finally {
      enqueueing.current = false;
      setSending(false);
    }
  }, [attachments, canControl, id, newProfileId, onAttachmentsChange, onDraftChange, reasoningBlocked, runCommand,
    sendDisabled, setCommandNotice, setError, setSending, speech, topic, workspace]);

  function selectSkill(skill: Skill) {
    setMenu(undefined);
    onDraftChange(`请先用 skill_view 加载技能 ${JSON.stringify(skill.name)}，再处理以下任务。\n\n${draft}`);
  }

  const modelSelection = modelPicker && <ModelPicker
    embedded={settingsOpen}
    profileLabel={currentProfile ? profileLabel(currentProfile) : undefined}
    enabled={canControl && !topicBusy}
    unavailable={topicBusy ? "请等待当前回复结束，再切换模型。"
      : !canControl ? "重新连接 Hermes 后即可选择模型。" : undefined}
    onClose={() => setModelPicker(false)}
    onRequest={async (requestId, selection, signal) => {
      if (newProfileId && topic?.status !== "ready") await workspace.prepareTopic(id, newProfileId, signal);
      return workspace.requestModel(id, requestId, selection, signal);
    }}
    onSelected={({ selection, type }, global) => {
      setModelPicker(false);
      setCommandNotice(type === "deferred" ? `模型切换已排队 · ${selection.model}`
        : global ? `已选择并设为默认模型 · ${selection.model}` : `已选择模型 · ${selection.model}`);
    }}
  />;

  const reasoningSelection = menu === "reasoning" && <ReasoningMenu embedded={settingsOpen}
    effort={reasoningStatus || reasoningBlocked ? undefined : reasoning}
    status={reasoningStatus} unavailable={reasoningUnavailable}
    onBusyChange={setSettingsBusy} onClose={() => setMenu(undefined)}
    onRequest={async (requestId, effort, signal) => {
      if (newProfileId && topic?.status !== "ready") await workspace.prepareTopic(id, newProfileId, signal);
      return workspace.requestReasoning(id, requestId, effort, signal);
    }} />;

  return (
    <KeyboardAvoidingView style={styles.frame} behavior={Platform.OS === "web" ? undefined : "padding"}
      keyboardVerticalOffset={safeAreaTop}>
      {menu === "attachments" ? (
        <AttachmentMenu busy={picking} onClose={() => setMenu(undefined)} onPick={(kind) => void addAttachments(kind)} />
      ) : menu && menu !== "reasoning" && (
        <ComposerMenu kind={menu} id={id} call={workspace.call}
          profile={workspace.profiles.find((item) => item.profile_id === (topic?.profile_id ?? newProfileId))?.label}
          connected={canControl}
          reasoningSupported={workspace.reasoning_supported === true}
          onClose={() => setMenu(undefined)}
          onCommand={runCommand}
          onSkill={selectSkill} />
      )}
      {nativeCommand && <NativeCommandSheet key={nativeCommand.requestId} {...nativeCommand} onOpenLink={openLink}
        onClose={() => { commandOpen.current = false; setNativeCommand(undefined); }}
        onRequest={(requestId, command, signal, approval) => workspace.requestNativeCommand(id, requestId, command, signal, approval)} />}
      <ProfileSwipe onSwitch={onSwitchProfile} enabled={!!onSwitchProfile && !switchBlocked && !settingsOpen && !menu && !modelPicker}>
      <ScrollView
        ref={scroll}
        contentContainerStyle={[chat.column, chat.transcript]}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              if (refreshing) return;
              setRefreshing(true);
              try { await workspace.refresh(); } finally { setRefreshing(false); }
            }}
            tintColor={colors.accent}
            colors={[colors.accent]}
          />
        }
        onContentSizeChange={keepLatestVisible}
        onLayout={keepLatestVisible}
        onScrollBeginDrag={() => { focusTarget.current = false; pinned.current = false; }}
        onScroll={({ nativeEvent }) => {
          if (!focusTarget.current) {
            pinned.current = nativeEvent.contentSize.height - nativeEvent.layoutMeasurement.height - nativeEvent.contentOffset.y < 100;
          }
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
        {topic?.status === "error" && workspace.streamTopic?.id === id && <Action title={recovering ? "恢复中…" : "恢复会话"}
          icon="refresh" disabled={!canControl || recovering} onPress={recoverStream} />}
        {(topic?.status === "ready" || (!topic && newProfileId)) && messages.length === 0 && pending.length === 0 && controls.length === 0 && (
          <View style={chat.empty}>
            <Icon name="chat" size={36} color={colors.accent} />
            <Text accessibilityRole="header" style={[styles.heading, chat.emptyTitle]}>开始对话</Text>
            {workspace.streamTopic?.id !== id && <Text style={[styles.muted, chat.emptyDescription]}>给 Hermes 发送一条消息。</Text>}
          </View>
        )}
        {messages.map((message, index) => {
          const outgoing = message.role === "user";
          const process = !outgoing ? message.process : undefined;
          if (!outgoing && !message.text && !message.attachments?.length && !process?.length && message.status === "final") return null;
          const startGroup = messages[index - 1]?.role !== message.role;
          const attachedControls = outgoing && message.submission_id ? historyControls.get(message.submission_id) : undefined;
          return (
            <View key={message.message_id}
              onLayout={({ nativeEvent }) => {
                messageOffsets.current.set(message.message_id, nativeEvent.layout.y);
                if (message.message_id === targetMessageId && focusTarget.current) keepLatestVisible();
              }}
              style={chat.messageGroup}>
              <View style={[chat.message, outgoing ? [chat.outgoing, { maxWidth: messageWidth }] : chat.incoming, startGroup && chat.startGroup]}>
                {!!process?.length && <ProcessTimeline steps={process} final={message.status === "final"} />}
                {(!!message.text || !!message.attachments?.length) && (
                  <View style={[
                    chat.messageContent,
                    outgoing ? [chat.outgoingBubble, { backgroundColor: colors.tint }] : chat.incomingBody,
                  ]}>
                    {!!message.attachments?.length && <MessageAttachments items={message.attachments} session={session}
                      onOpenLink={openLink} tint={colors.foreground} />}
                    {!!message.text && (outgoing ? <Text
                      selectable
                      accessibilityLabel={`你：${message.text}`}
                      style={[styles.text, chat.messageText]}
                    >
                      {message.text}
                    </Text> : <AnswerMarkdown text={message.text} onOpenLink={openLink} />)}
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
                <ControlPrompt key={control.control_id} control={control} enabled={canControl} onAnswer={workspace.answer} />
              ))}
            </View>
          );
        })}
        {pending.map((item) => (
          <Animated.View key={item.submission_id} style={[chat.message, chat.outgoing, { maxWidth: messageWidth }, !reduced && motion.reveal]}>
            <View style={[chat.messageContent, chat.outgoingBubble, { backgroundColor: colors.tint }]}>
              {!!item.attachments?.length && <MessageAttachments items={item.attachments} onOpenLink={openLink} tint={colors.foreground} />}
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
                    haptic("error");
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
            <ControlPrompt control={control} enabled={canControl} onAnswer={workspace.answer} />
          </Animated.View>
        ))}
      </ScrollView>
      </ProfileSwipe>
      <View style={[chat.column, chat.composer, { borderTopColor: colors.edge }]}>
        {(error ?? speech.error) && <Notice>{error ?? speech.error}</Notice>}
        {commandNotice && <Text accessibilityLiveRegion="polite" style={styles.muted}>{commandNotice}</Text>}
        {isModelCommand && !canControl && <Text style={styles.muted}>连接 Hermes 后即可选择模型。</Text>}
        {isNativeCommand && !isModelCommand && !canControl && <Text style={styles.muted}>连接 Hermes 后即可执行命令。</Text>}
        {reasoningBlocked && <Text accessibilityLiveRegion="polite" style={styles.muted}>更新 Hermes 连接器后可继续发送。</Text>}
        {!!attachments.length && attachmentsBlocked && <Notice>更新服务端和连接器后可发送附件。</Notice>}
        <ScrollView horizontal accessibilityLabel="会话操作" keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false} style={chat.toolbarScroll} contentContainerStyle={chat.toolbar}>
          <Action compact icon="command" title="命令" disabled={!canWrite || speech.busy || openingSkills} onPress={() => { Keyboard.dismiss(); void openMenu("commands"); }} />
          <Action compact icon="skill" title={openingSkills ? "正在加载技能…" : "技能"}
            disabled={!canWrite || speech.busy || openingSkills || (topic?.status !== "ready" && !canControl)}
            onPress={() => { Keyboard.dismiss(); void openMenu("skills"); }} />
          {running && (
            <Action compact title={stopping ? "停止中…" : "停止回复"} icon="stop"
              feedback="warning"
              accessibilityLabel={stopping ? "正在请求停止回复" : undefined} disabled={!canControl || stopping} onPress={() => void stop()} />
          )}
        </ScrollView>
        {!!attachments.length && (
          <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={chat.attachmentTray}>
            {attachments.map((item, index) => (
              <View key={index} style={[chat.attachmentChip, { backgroundColor: colors.tint, borderColor: colors.edge }]}>
                <Icon name={item.mime.startsWith("image/") ? "photo" : "attachment"} size={16} color={colors.accent} />
                <Text numberOfLines={1} style={[styles.text, chat.attachmentName, chat.chipName]}>{item.name}</Text>
                <CloseButton accessibilityLabel={`移除附件 ${item.name}`} disabled={sending || picking}
                  onPress={() => {
                    onAttachmentsChange(attachments.filter((_item, itemIndex) => itemIndex !== index));
                    setError(undefined);
                  }} />
              </View>
            ))}
          </ScrollView>
        )}
        <View style={chat.composerControls}>
          <View style={[chat.composerRow, { backgroundColor: colors.secondary, borderColor: draftFocused ? colors.accent : colors.edge }]}>
            {speech.state === "recording" && <AssistantStreamBorder variant="composer" />}
            <Pressable accessibilityRole="button" accessibilityLabel="添加附件"
              accessibilityState={{ disabled: attachmentDisabled, busy: picking, expanded: menu === "attachments" }}
              disabled={attachmentDisabled} onPress={() => { haptic("light"); Keyboard.dismiss(); setMenu("attachments"); }}
              style={({ pressed }) => [chat.iconButton, (pressed || attachmentDisabled) && styles.faded]}>
              {picking ? <ActivityIndicator size="small" color={colors.accent} /> : <Icon name="attachment" size={22} color={colors.accent} />}
            </Pressable>
            <View style={[chat.composerDivider, { backgroundColor: colors.edge }]} />
            <Field
              accessibilityLabel="消息"
              placeholder={speech.busy ? "正在聆听…" : attachments.length ? "添加描述…" : "发消息给 Hermes"}
              style={chat.draft}
              multiline
              numberOfLines={Platform.OS === "web" ? 1 : undefined}
              editable={canWrite && !sending && !speech.busy}
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
                  !sendDisabled && { backgroundColor: colors.accentFill },
                  pressed && chat.pressed,
                ]}>
                  {sending ? <ActivityIndicator size="small" color={colors.muted} /> : (
                    <Icon name="send" size={22} color={sendDisabled ? colors.muted : colors.onAccent} />
                  )}
                </View>
              )}
            </Pressable>
          </View>
          {speech.available && <Animated.View
            pointerEvents={speechVisible ? "auto" : "none"}
            accessibilityElementsHidden={!speechVisible}
            importantForAccessibility={speechVisible ? "auto" : "no-hide-descendants"}
            style={[chat.speechButton, {
              transitionProperty: ["width", "marginLeft", "opacity", "transform"],
              transitionDuration: reduced ? 0 : 360,
              transitionTimingFunction: "ease-in-out",
              width: speechVisible ? touchSize : 0,
              marginLeft: speechVisible ? 8 : 0,
              opacity: speechVisible ? 1 : 0,
              transform: [{ translateX: speechVisible ? 0 : 8 }],
            }]}>
            <Pressable accessibilityRole="button"
              accessibilityLabel={speech.busy ? "停止语音输入" : "开始语音输入"}
              accessibilityState={{ disabled: speechDisabled, selected: speech.busy,
                busy: speech.state === "starting" || speech.state === "stopping" }}
              disabled={speechDisabled} onPress={() => {
                if (speechDisabled) return;
                haptic("light");
                Keyboard.dismiss();
                setMenu(undefined);
                setError(undefined);
                if (speech.busy) void speech.stop();
                else void speech.start();
              }}
              style={({ pressed }) => [chat.iconButton, (pressed || speechDisabled) && styles.faded]}>
              {speech.state === "starting" || speech.state === "stopping"
                ? <ActivityIndicator size="small" color={colors.error} />
                : <Icon name={speech.busy ? "stop" : "microphone"} size={22} color={speech.busy ? colors.error : colors.accent} />}
            </Pressable>
          </Animated.View>}
        </View>
      </View>
      {settingsOpen ? <SettingsDrawer busy={settingsBusy} canWrite={canWrite} reasoningLabel={reasoningLabel}
        settingsNavigation={settingsNavigation} applicationSettings={applicationSettings}
        onModel={() => setModelPicker(true)} onReasoning={() => setMenu("reasoning")}
        onClose={() => { setModelPicker(false); setMenu(undefined); onCloseSettings(); }}>
        {modelSelection || reasoningSelection || undefined}
      </SettingsDrawer> : modelSelection || reasoningSelection}
    </KeyboardAvoidingView>
  );
}

const chat = StyleSheet.create({
  column: { width: "100%", maxWidth: 768, alignSelf: "center", paddingHorizontal: transcriptGutter },
  transcript: { flexGrow: 1, paddingTop: 8, paddingBottom: 24, gap: 12 },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", gap: 8, paddingBottom: 32 },
  emptyTitle: { textAlign: "center", fontSize: 24, lineHeight: 32, fontWeight: "700", marginTop: 8 },
  emptyDescription: { textAlign: "center", fontSize: 16, lineHeight: 23 },
  progress: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginVertical: 12 },
  message: { alignItems: "flex-start", gap: 8 },
  messageGroup: { gap: 16 },
  process: { borderBottomWidth: StyleSheet.hairlineWidth, gap: 8, alignSelf: "stretch", marginBottom: 8, paddingBottom: 8 },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  sectionIcon: { height: 32, width: 32, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  sectionTitle: { flexShrink: 1, fontSize: 17, lineHeight: 25, fontWeight: "700" },
  processScroll: { flexGrow: 0 },
  processSteps: { paddingStart: 8 },
  processStep: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  processRail: { position: "absolute", top: 12, bottom: -12, start: 7.5, width: 1 },
  processMarker: { width: 16, height: 16, marginTop: 4, borderRadius: 8, borderWidth: 1,
    alignItems: "center", justifyContent: "center" },
  processText: { flex: 1, fontSize: 15, lineHeight: 23, paddingBottom: 8 },
  control: { alignSelf: "stretch", gap: 12, paddingVertical: 8 },
  clarifyPrompt: { fontWeight: "600" },
  controlActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "stretch", gap: 8, marginTop: 4 },
  controlAction: { flexGrow: 1, minWidth: 68, maxWidth: "100%", borderRadius: 14 },
  controlChoice: { minHeight: 64, paddingVertical: 12 },
  incoming: { alignSelf: "stretch" },
  outgoing: { alignSelf: "flex-end", alignItems: "flex-end" },
  startGroup: { marginTop: 8 },
  messageContent: { gap: 8, maxWidth: "100%" },
  incomingBody: { alignSelf: "stretch" },
  outgoingBubble: { borderRadius: 19, paddingHorizontal: 16, paddingVertical: 11 },
  messageText: { fontSize: 17, lineHeight: 26 },
  outgoingStatus: { textAlign: "right", marginEnd: 3 },
  composer: { paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, gap: 4 },
  toolbarScroll: { flexGrow: 0 },
  toolbar: { flexDirection: "row", flexWrap: "nowrap", alignItems: "center", gap: 6 },
  attachmentName: { flexShrink: 1, fontSize: 13 },
  attachmentTray: { gap: 6, paddingVertical: 3 },
  attachmentChip: { flexDirection: "row", gap: 6, alignItems: "center", paddingStart: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  chipName: { maxWidth: 140 },
  iconButton: { width: touchSize, height: touchSize, alignItems: "center", justifyContent: "center" },
  composerDivider: { height: 22, width: StyleSheet.hairlineWidth, marginBottom: (touchSize - 22) / 2 },
  composerControls: { flexDirection: "row", alignItems: "flex-end" },
  speechButton: { flexShrink: 0, marginBottom: 4, overflow: "hidden" },
  composerRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "flex-end",
    borderRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: touchSize + 8,
    paddingHorizontal: 3,
    paddingVertical: 3,
  },
  draft: {
    ...(Platform.OS === "web" && { fieldSizing: "content" }),
    flex: 1,
    minHeight: touchSize,
    maxHeight: 120,
    fontSize: 17,
    lineHeight: 24,
    borderWidth: 0,
    backgroundColor: "transparent",
    paddingStart: 12,
    paddingEnd: 4,
    paddingVertical: (touchSize - 24) / 2,
    textAlignVertical: "top",
  },
  sendButton: { width: touchSize, height: touchSize, alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: "transparent", borderRadius: touchSize / 2 },
  sendCircle: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.78 },
});
