import { useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { haptic } from "../ui/haptics";
import { formatDateTime } from "../ui/text";
import { Action, EmptyState, Icon, useTheme, type IconName } from "../ui/theme";
import { ActionState, Confirm, DataState, EditField, FormHeader, Group, ManagementHeader, ManagementLayout, Row, Toggle, entries,
  useManagementAction, useManagementContext, useManagementData, type ManageCall } from "./shared";

type Job = {
  id: string;
  name?: string | null;
  prompt?: string | null;
  deliver?: string | null;
  enabled: boolean;
  state?: string;
  schedule?: { kind?: string; expr?: string; run_at?: string; display?: string; minutes?: number } | string;
  schedule_display?: string;
  last_run_at?: string | null;
  next_run_at?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  last_delivery_error?: string | null;
  skill?: string | null;
  skills?: string[] | null;
  model?: string | null;
  provider?: string | null;
  base_url?: string | null;
  script?: string | null;
  workdir?: string | null;
  no_agent?: boolean;
  context_from?: string[] | string | null;
  enabled_toolsets?: string[] | null;
};

const jobStates = new Map([
  ["scheduled", "已安排"], ["paused", "已暂停"], ["completed", "已完成"], ["error", "异常"],
  ["disabled", "已停用"], ["running", "运行中"],
]);
const runStates = new Map([
  ["ok", "成功"], ["error", "失败"], ["delivery_failed", "投递失败"], ["delivery_queued", "等待投递"],
  ["blocked_config", "配置有误"], ["cancelled", "已取消"], ["interrupted", "已中断"],
]);
const deliveryLabels = new Map([["local", "本机"], ["hermes_mobile", "Hermes 收件箱"], ["origin", "原始会话"]]);

function jobName(job: Job) { return job.name || job.prompt?.split("\n", 1)[0]?.slice(0, 80) || job.id; }
function jobState(job: Job) {
  const state = job.state || (job.enabled ? "scheduled" : "disabled");
  return jobStates.get(state) ?? state;
}
function scheduleValue(job?: Job) {
  const schedule = job?.schedule;
  if (typeof schedule === "string") return schedule;
  return schedule?.expr ?? schedule?.run_at ?? schedule?.display ?? job?.schedule_display ?? "";
}
function scheduleLabel(job: Job) {
  const schedule = job.schedule;
  if (schedule && typeof schedule !== "string") {
    if (schedule.kind === "interval" && typeof schedule.minutes === "number") return `每 ${schedule.minutes} 分钟`;
    if (schedule.kind === "once" && schedule.run_at) return `单次 · ${schedule.run_at.replace("T", " ")}`;
  }
  return job.schedule_display || scheduleValue(job) || "未设置执行计划";
}
function when(value: string | number) { return formatDateTime(typeof value === "number" ? value * 1000 : value); }

export function ScheduledTasks({ call }: { call: ManageCall }) {
  const { colors, styles } = useTheme();
  const jobs = useManagementData<Job[]>(call, "cron.list");
  const action = useManagementAction();
  const [selected, select] = useState<string>();
  const [editing, edit] = useState(false);
  const [history, showHistory] = useState(false);
  const job = jobs.data?.find((item) => item.id === selected);

  function close() { select(undefined); edit(false); showHistory(false); }

  if (editing) {
    return <JobForm job={job} busy={action.busy} onCancel={() => edit(false)} onSave={(values) => void action.run(async () => {
      if (job) await call("cron.edit", { id: job.id, updates: values });
      else await call("cron.create", values);
      haptic("success");
      edit(false);
      await jobs.reload();
      return job ? "任务已更新。" : "任务已创建。";
    })}><ActionState {...action} /></JobForm>;
  }
  if (job && history) return <RunHistory key={job.id} call={call} job={job} onClose={() => showHistory(false)} />;
  if (job) {
    return <ManagementLayout key="detail" hideTabs header={<ManagementHeader title={jobName(job)} backLabel="定时任务" onBack={close}
      backDisabled={action.busy} trailing={<View style={layout.headerActions}>
        <Pressable accessibilityRole="button" accessibilityLabel="刷新任务" accessibilityState={{ disabled: jobs.loading || action.busy }}
          disabled={jobs.loading || action.busy} onPress={() => { if (!jobs.loading && !action.busy) { haptic("light"); void jobs.reload(); } }}
          style={({ pressed }) => [layout.headerAction, (pressed || jobs.loading || action.busy) && styles.faded]}>
          <Icon name="refresh" size={20} color={colors.accent} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="编辑任务" accessibilityState={{ disabled: action.busy }} disabled={action.busy}
          onPress={() => { if (!action.busy) { haptic("light"); edit(true); } }}
          style={({ pressed }) => [layout.headerAction, (pressed || action.busy) && styles.faded]}>
          <Icon name="compose" size={20} color={colors.accent} />
        </Pressable>
      </View>} />}>
      <ActionState {...action} />
      <DataState {...jobs} />
      <View style={[layout.pill, { backgroundColor: colors.tint }]}>
        <Text style={[styles.caption, { color: colors.accent }]}>{jobState(job)}</Text>
      </View>
      <Group>
        <TaskFact icon="schedule" label="执行计划" value={scheduleLabel(job)} />
        <TaskFact icon="inbox" label="投递目标" value={deliveryLabels.get(job.deliver || "local") ?? job.deliver ?? ""} />
        {job.next_run_at && <TaskFact label="下次运行" value={when(job.next_run_at)} />}
        {job.last_run_at && <TaskFact label="上次运行" value={`${when(job.last_run_at)}${job.last_status ? ` · ${runStates.get(job.last_status) ?? job.last_status}` : ""}`} />}
        {job.prompt && <TaskFact icon="logs" label="提示词" value={job.prompt} />}
        <Row title="运行记录" icon="activity" onPress={() => showHistory(true)} />
      </Group>
      {job.last_error && <Text selectable style={styles.error}>{job.last_error}</Text>}
      {job.last_delivery_error && <Text selectable style={styles.error}>{job.last_delivery_error}</Text>}
      <View style={layout.taskActions}>
        <Action primary title="立即运行" style={layout.runAction} feedback="medium" disabled={action.busy || !job.enabled}
          onPress={() => void action.run(async () => {
            await call("cron.trigger", { id: job.id });
            await jobs.reload();
            return "已加入队列，将在 Hermes 调度器下次检查时运行。";
          })} />
        <Action title={job.enabled ? "暂停" : "恢复"} style={[layout.pauseAction, { borderColor: colors.accent }]}
          disabled={action.busy} onPress={() => void action.run(async () => {
            await call(job.enabled ? "cron.pause" : "cron.resume", { id: job.id });
            haptic("success");
            await jobs.reload();
            return job.enabled ? "任务已暂停。" : "任务已恢复。";
          })} />
      </View>
      {!job.enabled && <Text style={styles.caption}>恢复任务后即可运行。</Text>}
      <View style={[layout.danger, { borderColor: colors.edge }]}>
        <Confirm title="删除任务" description={`确定删除定时任务「${jobName(job)}」吗？`} disabled={action.busy}
          onConfirm={() => void action.run(async () => {
            await call("cron.remove", { id: job.id });
            haptic("success");
            close();
            await jobs.reload();
            return "任务已删除。";
          })} />
      </View>
    </ManagementLayout>;
  }
  return <ManagementLayout key="list" header={<ManagementHeader title="定时任务" />}>
    <ActionState {...action} />
    <View style={styles.row}>
      <Action primary icon="compose" title="新建任务" disabled={!jobs.data || action.busy} onPress={() => edit(true)} />
      <Action icon="refresh" title="刷新" disabled={jobs.loading || action.busy} onPress={() => void jobs.reload()} />
    </View>
    <DataState {...jobs} />
    {jobs.data?.length ? <Group>
      {jobs.data.map((item, index) => <Row key={item.id} divided={index > 0} title={jobName(item)} icon="schedule"
        subtitle={scheduleLabel(item)} value={jobState(item)} onPress={() => select(item.id)} />)}
    </Group> : jobs.data && <EmptyState icon="schedule" title="暂无定时任务" />}
  </ManagementLayout>;
}

function TaskFact({ icon, label, value }: { icon?: IconName; label: string; value: string }) {
  const { colors, styles } = useTheme();
  return <View style={[layout.fact, { borderColor: colors.edge }]}>
    {icon ? <>
      <View style={[layout.icon, { backgroundColor: colors.tint }]}><Icon name={icon} size={20} color={colors.accent} /></View>
      <View style={layout.grow}>
        <Text style={styles.caption}>{label}</Text>
        <Text selectable style={styles.text}>{value}</Text>
      </View>
    </> : <>
      <Text style={styles.muted}>{label}</Text>
      <Text style={[styles.text, layout.factValue]}>{value}</Text>
    </>}
  </View>;
}

function RunHistory({ call, job, onClose }: { call: ManageCall; job: Job; onClose: () => void }) {
  const { colors, styles } = useTheme();
  const input = useMemo(() => ({ id: job.id }), [job.id]);
  const history = useManagementData<{ runs: { id: string; title?: string; started_at: number; ended_at?: number | null; is_active?: boolean }[] }>(call, "cron.runs", input);
  return <ManagementLayout hideTabs header={<ManagementHeader title="运行记录" backLabel="任务详情" onBack={onClose}
    trailing={<Action compact icon="refresh" title="刷新" accessibilityLabel="刷新运行记录"
      disabled={history.loading} onPress={() => void history.reload()} />} />}>
    <TaskFact icon="schedule" label={jobName(job)} value={scheduleLabel(job)} />
    <DataState {...history} />
    <View>{history.data?.runs.map((run, index, runs) => {
      const started = when(run.started_at);
      return <View key={run.id} style={layout.run}>
        <View style={layout.track}>
          <View style={[layout.marker, { backgroundColor: colors.tint }]}>
            <Icon name={run.is_active ? "activity" : run.ended_at ? "check" : "schedule"} size={14} color={colors.accent} />
          </View>
          {index < runs.length - 1 && <View style={[layout.stem, { backgroundColor: colors.edge }]} />}
        </View>
        <View style={[layout.runContent, styles.row]}>
          <View style={layout.grow}>
            <Text style={styles.heading}>{run.title || started}</Text>
            {!!run.title && <Text style={styles.caption}>{started}</Text>}
          </View>
          <View style={[layout.pill, { backgroundColor: colors.tint }]}>
            <Text style={styles.caption}>{run.is_active ? "运行中" : run.ended_at ? "已结束" : "暂无结束时间"}</Text>
          </View>
        </View>
      </View>;
    })}</View>
    {history.data?.runs.length === 0 && <EmptyState icon="activity" title="暂无运行记录" />}
  </ManagementLayout>;
}

function jobValues(job?: Job) {
  return {
    name: job?.name ?? "", schedule: scheduleValue(job), prompt: job?.prompt ?? "", deliver: job?.deliver ?? "local",
    skills: (job?.skills ?? (job?.skill ? [job.skill] : [])).join(", "), provider: job?.provider ?? "", model: job?.model ?? "",
    base_url: job?.base_url ?? "", script: job?.script ?? "", workdir: job?.workdir ?? "", no_agent: job?.no_agent ?? false,
    context_from: Array.isArray(job?.context_from) ? job.context_from.join(", ") : job?.context_from ?? "",
    enabled_toolsets: job?.enabled_toolsets?.join(", ") ?? "",
  };
}

const advancedFields = [
  ["skills", "技能", "技能名称，用英文逗号分隔"], ["provider", "指定服务商", undefined],
  ["model", "指定模型", undefined], ["base_url", "指定模型接口地址", undefined],
  ["script", "脚本", "相对于 Hermes 脚本目录的路径"], ["workdir", "工作目录", "Hermes 主机上的绝对路径"],
  ["context_from", "引用其他任务的输出", "任务 ID，用英文逗号分隔"], ["enabled_toolsets", "工具集", "工具集名称，用英文逗号分隔"],
] as const;

function JobForm({ job, busy, onCancel, onSave, children }: {
  job?: Job; busy: boolean; onCancel: () => void; onSave: (values: object) => void; children: ReactNode;
}) {
  const { colors, styles } = useTheme();
  const { label: profile } = useManagementContext();
  const [initial] = useState(() => jobValues(job));
  const [draft, set] = useState(initial);
  const [advanced, expand] = useState(false);
  const dirty = (Object.keys(draft) as (keyof typeof draft)[]).filter((key) => draft[key] !== initial[key]);
  const field = (key: Exclude<keyof typeof draft, "no_agent">, label: string, placeholder?: string, multiline = false, help?: string) =>
    <EditField key={key} label={label} placeholder={placeholder} multiline={multiline} editable={!busy} help={help}
      value={draft[key]} onChangeText={(value) => set((current) => ({ ...current, [key]: value }))} />;
  function save() {
    const keys = job ? dirty : (["schedule", ...dirty] as const);
    onSave(Object.fromEntries(keys.map((key) => [key,
      key === "skills" || key === "context_from" || key === "enabled_toolsets" ? entries(draft[key])
        : key === "no_agent" ? draft[key] : key === "prompt" ? draft[key] : draft[key].trim()])));
  }
  return <ManagementLayout hideTabs header={<FormHeader title={job ? "编辑任务" : "新建任务"}
    saveLabel={busy ? "保存中…" : job ? "保存" : "创建"} cancelDisabled={busy}
    disabled={busy || !draft.schedule.trim() || (!!job && dirty.length === 0)} onCancel={onCancel} onSave={save} />}>
    {children}
    {!!profile && <View style={styles.row}>
      <View style={[layout.icon, { backgroundColor: colors.tint }]}><Icon name="sparkles" size={19} color={colors.accent} /></View>
      <Text style={[styles.label, layout.grow]}>{profile}</Text>
    </View>}
    {field("name", "名称")}
    {field("schedule", "执行计划", "例如 every 2h 或 0 9 * * *", false, "采用 Hermes 主机时区")}
    {field("prompt", "提示词", "希望 Hermes 执行什么？", true)}
    {field("deliver", "投递目标", undefined, false, "local 留在主机 · hermes_mobile 发送至收件箱")}
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: advanced }} onPress={() => {
      haptic("light");
      expand((current) => !current);
    }} style={({ pressed }) => [layout.disclosure, { borderColor: colors.edge }, pressed && { backgroundColor: colors.tint }]}>
      <Icon name="manage" size={20} color={colors.accent} />
      <Text style={[styles.heading, layout.grow]}>高级选项</Text>
      <View style={advanced ? layout.expanded : undefined}>
        <Icon name={advanced ? "down" : "chevron"} size={16} color={colors.muted} />
      </View>
    </Pressable>
    {advanced && <>
      {advancedFields.map(([key, label, hint]) => field(key, label, hint))}
      <Toggle label="直接运行脚本，跳过模型" disabled={busy} value={draft.no_agent} onChange={(no_agent) => set((current) => ({ ...current, no_agent }))} />
    </>}
  </ManagementLayout>;
}

const layout = StyleSheet.create({
  headerActions: { flexDirection: "row" },
  headerAction: { width: 48, minHeight: 48, alignItems: "center", justifyContent: "center" },
  grow: { flex: 1, minWidth: 0 },
  fact: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 56,
    paddingVertical: 12, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  factValue: { flexShrink: 1, textAlign: "right" },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  pill: { alignSelf: "flex-start", borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  taskActions: { flexDirection: "row", alignItems: "stretch", gap: 8, marginTop: 8 },
  runAction: { flex: 3 },
  pauseAction: { flex: 2, backgroundColor: "transparent" },
  danger: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 16 },
  run: { flexDirection: "row", alignItems: "stretch", gap: 12 },
  track: { alignItems: "center", paddingTop: 3 },
  marker: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  stem: { width: StyleSheet.hairlineWidth, flex: 1, marginTop: 4 },
  runContent: { flex: 1, minHeight: 64, minWidth: 0, paddingBottom: 16 },
  disclosure: { flexDirection: "row", alignItems: "center", minHeight: 56, gap: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  expanded: { transform: [{ rotate: "180deg" }] },
});
