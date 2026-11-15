import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { haptic } from "../ui/haptics";
import { formatDateTime } from "../ui/text";
import { Action, Card, CloseButton, EmptyState, useTheme } from "../ui/theme";
import { ActionState, Confirm, DataState, EditField, Group, Row, Toggle, entries,
  useManagementAction, useManagementData, type ManageCall } from "./shared";

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
    if (schedule.kind === "cron" && schedule.expr) return schedule.expr;
  }
  return job.schedule_display || scheduleValue(job) || "未设置执行计划";
}
function when(value: string | number) { return formatDateTime(typeof value === "number" ? value * 1000 : value); }

export function ScheduledTasks({ call }: { call: ManageCall }) {
  const { styles } = useTheme();
  const jobs = useManagementData<Job[]>(call, "cron.list");
  const action = useManagementAction();
  const [selected, select] = useState<string>();
  const [editing, edit] = useState(false);
  const [history, showHistory] = useState(false);
  const job = jobs.data?.find((item) => item.id === selected);

  function close() { select(undefined); edit(false); showHistory(false); }

  return <>
    <ActionState {...action} />
    {editing ? <JobForm job={job} busy={action.busy} onCancel={() => edit(false)} onSave={(values) => void action.run(async () => {
      if (job) await call("cron.edit", { id: job.id, updates: values });
      else await call("cron.create", values);
      haptic("success");
      edit(false);
      await jobs.reload();
      return job ? "任务已更新。" : "任务已创建。";
    })} /> : job ? <>
      <View style={styles.row}>
        <Action icon="back" title="全部任务" disabled={action.busy} onPress={close} />
        <Action icon="refresh" title="刷新" disabled={jobs.loading || action.busy} onPress={() => void jobs.reload()} />
      </View>
      <DataState {...jobs} />
      <Card>
        <Text accessibilityRole="header" style={styles.heading}>{jobName(job)}</Text>
        <Text style={styles.text}>{jobState(job)} · {scheduleLabel(job)}</Text>
        <Text style={styles.muted}>投递至 · {deliveryLabels.get(job.deliver || "local") ?? job.deliver}</Text>
        {job.next_run_at && <Text style={styles.muted}>下次运行 · {when(job.next_run_at)}</Text>}
        {job.last_run_at && <Text style={styles.muted}>上次运行 · {when(job.last_run_at)}
          {job.last_status ? ` · ${runStates.get(job.last_status) ?? job.last_status}` : ""}</Text>}
        {job.prompt && <Text selectable style={styles.text}>{job.prompt}</Text>}
        {job.last_error && <Text selectable style={styles.error}>{job.last_error}</Text>}
        {job.last_delivery_error && <Text selectable style={styles.error}>{job.last_delivery_error}</Text>}
        <View style={styles.row}>
          <Action title="编辑任务" disabled={action.busy} onPress={() => edit(true)} />
          <Action title={job.enabled ? "暂停" : "恢复"} disabled={action.busy} onPress={() => void action.run(async () => {
            await call(job.enabled ? "cron.pause" : "cron.resume", { id: job.id });
            haptic("success");
            await jobs.reload();
            return job.enabled ? "任务已暂停。" : "任务已恢复。";
          })} />
          <Action title="立即运行" feedback="medium" disabled={action.busy || !job.enabled} onPress={() => void action.run(async () => {
            await call("cron.trigger", { id: job.id });
            await jobs.reload();
            return "已加入队列，将在 Hermes 调度器下次检查时运行。";
          })} />
        </View>
        {!job.enabled && <Text style={styles.caption}>恢复任务后即可运行。</Text>}
        <View style={styles.row}>
          {!history && <Action title="运行记录" onPress={() => showHistory(true)} />}
          <Confirm title="删除任务" description={`确定删除定时任务「${jobName(job)}」吗？`} disabled={action.busy}
            onConfirm={() => void action.run(async () => { await call("cron.remove", { id: job.id }); haptic("success"); close(); await jobs.reload(); return "任务已删除。"; })} />
        </View>
      </Card>
      {history && <RunHistory key={job.id} call={call} id={job.id} onClose={() => showHistory(false)} />}
    </> : <>
      <View style={styles.row}>
        <Action primary icon="compose" title="新建任务" disabled={!jobs.data || action.busy} onPress={() => edit(true)} />
        <Action icon="refresh" title="刷新" disabled={jobs.loading || action.busy} onPress={() => void jobs.reload()} />
      </View>
      <DataState {...jobs} />
      {jobs.data?.length ? <Group>
        {jobs.data.map((item, index) => <Row key={item.id} divided={index > 0} title={jobName(item)}
          subtitle={scheduleLabel(item)} value={jobState(item)} onPress={() => select(item.id)} />)}
      </Group> : jobs.data && <EmptyState icon="schedule" title="暂无定时任务" description="创建任务，按计划执行提示词或脚本。" />}
    </>}
  </>;
}

function RunHistory({ call, id, onClose }: { call: ManageCall; id: string; onClose: () => void }) {
  const { styles } = useTheme();
  const input = useMemo(() => ({ id }), [id]);
  const history = useManagementData<{ runs: { id: string; title?: string; started_at: number; ended_at?: number | null; is_active?: boolean }[] }>(call, "cron.runs", input);
  return <Card>
    <View style={styles.row}>
      <Text accessibilityRole="header" style={[styles.heading, { flex: 1 }]}>近期运行记录</Text>
      <CloseButton accessibilityLabel="关闭运行记录" onPress={onClose} />
    </View>
    <DataState {...history} />
    {history.data?.runs.map((run) => {
      const started = when(run.started_at);
      return <View key={run.id}>
        <Text style={styles.text}>{run.title || started}</Text>
        <Text style={styles.caption}>{run.title ? `${started} · ` : ""}{run.is_active ? "运行中" : run.ended_at ? "已结束" : "暂无结束时间"}</Text>
      </View>;
    })}
    {history.data?.runs.length === 0 && <Text style={styles.muted}>Hermes 尚未记录此任务的运行情况。</Text>}
    <Action icon="refresh" title="刷新运行记录" disabled={history.loading} onPress={() => void history.reload()} />
  </Card>;
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

function JobForm({ job, busy, onCancel, onSave }: { job?: Job; busy: boolean; onCancel: () => void; onSave: (values: object) => void }) {
  const { styles } = useTheme();
  const [initial] = useState(() => jobValues(job));
  const [draft, set] = useState(initial);
  const [advanced, expand] = useState(false);
  const dirty = (Object.keys(draft) as (keyof typeof draft)[]).filter((key) => draft[key] !== initial[key]);
  const field = (key: Exclude<keyof typeof draft, "no_agent">, label: string, placeholder?: string, multiline = false) =>
    <EditField key={key} label={label} placeholder={placeholder} multiline={multiline} editable={!busy}
      value={draft[key]} onChangeText={(value) => set({ ...draft, [key]: value })} />;
  function save() {
    const keys = job ? dirty : (["schedule", ...dirty] as const);
    onSave(Object.fromEntries(keys.map((key) => [key,
      key === "skills" || key === "context_from" || key === "enabled_toolsets" ? entries(draft[key])
        : key === "no_agent" ? draft[key] : key === "prompt" ? draft[key] : draft[key].trim()])));
  }
  return <Card>
    <Text accessibilityRole="header" style={styles.heading}>{job ? "编辑定时任务" : "新建定时任务"}</Text>
    {field("name", "名称")}
    {field("schedule", "执行计划", "例如 every 2h 或 0 9 * * *")}
    <Text style={styles.caption}>执行计划采用 Hermes 主机配置的时区。</Text>
    {field("prompt", "提示词", "希望 Hermes 执行什么？", true)}
    {field("deliver", "投递目标", "填写 local 或 hermes_mobile")}
    <Text style={styles.caption}>填写 local 将结果留在主机，填写 hermes_mobile 将结果发送到已配置的收件箱。</Text>
    {advanced ? <View style={styles.row}>
      <Text style={styles.label}>高级选项</Text>
      <CloseButton accessibilityLabel="关闭高级选项" onPress={() => expand(false)} />
    </View> : <Action title="高级选项" onPress={() => expand(true)} />}
    {advanced && <>
      {advancedFields.map(([key, label, hint]) => field(key, label, hint))}
      <Toggle label="直接运行脚本，跳过模型" disabled={busy} value={draft.no_agent} onChange={(no_agent) => set({ ...draft, no_agent })} />
    </>}
    <View style={styles.row}>
      <Action primary title={busy ? "保存中…" : job ? "保存任务" : "创建任务"}
        disabled={busy || !draft.schedule.trim() || (job && dirty.length === 0)} onPress={save} />
      <CloseButton accessibilityLabel="取消" disabled={busy} onPress={onCancel} />
    </View>
  </Card>;
}
