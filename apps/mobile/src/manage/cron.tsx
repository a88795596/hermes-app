import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Action, Card, EmptyState, useTheme } from "../ui/theme";
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

function jobName(job: Job) { return job.name || job.prompt?.split("\n", 1)[0]?.slice(0, 80) || job.id; }
function jobState(job: Job) { return job.state?.replaceAll("_", " ") ?? (job.enabled ? "Scheduled" : "Disabled"); }
function scheduleValue(job?: Job) {
  const schedule = job?.schedule;
  if (typeof schedule === "string") return schedule;
  return schedule?.expr ?? schedule?.run_at ?? schedule?.display ?? job?.schedule_display ?? "";
}
function when(value: string | number) { return new Date(typeof value === "number" ? value * 1000 : value).toLocaleString(); }

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
      edit(false);
      await jobs.reload();
      return job ? "Task updated." : "Task scheduled.";
    })} /> : job ? <>
      <View style={styles.row}>
        <Action icon="back" title="All tasks" disabled={action.busy} onPress={close} />
        <Action icon="refresh" title="Refresh" disabled={jobs.loading || action.busy} onPress={() => void jobs.reload()} />
      </View>
      <DataState {...jobs} />
      <Card>
        <Text accessibilityRole="header" style={styles.heading}>{jobName(job)}</Text>
        <Text style={styles.text}>{jobState(job)} · {job.schedule_display || scheduleValue(job) || "No schedule"}</Text>
        <Text style={styles.muted}>Delivery · {job.deliver || "local"}</Text>
        {job.next_run_at && <Text style={styles.muted}>Next run · {when(job.next_run_at)}</Text>}
        {job.last_run_at && <Text style={styles.muted}>Last run · {when(job.last_run_at)}{job.last_status ? ` · ${job.last_status}` : ""}</Text>}
        {job.prompt && <Text selectable style={styles.text}>{job.prompt}</Text>}
        {job.last_error && <Text selectable style={styles.error}>{job.last_error}</Text>}
        {job.last_delivery_error && <Text selectable style={styles.error}>{job.last_delivery_error}</Text>}
        <View style={styles.row}>
          <Action title="Edit task" disabled={action.busy} onPress={() => edit(true)} />
          <Action title={job.enabled ? "Pause" : "Resume"} disabled={action.busy} onPress={() => void action.run(async () => {
            await call(job.enabled ? "cron.pause" : "cron.resume", { id: job.id });
            await jobs.reload();
            return job.enabled ? "Task paused." : "Task resumed.";
          })} />
          <Action title="Run now" disabled={action.busy || !job.enabled} onPress={() => void action.run(async () => {
            await call("cron.trigger", { id: job.id });
            await jobs.reload();
            return "Queued for the next Hermes scheduler tick.";
          })} />
        </View>
        {!job.enabled && <Text style={styles.caption}>Resume the task to run it.</Text>}
        <View style={styles.row}>
          <Action title={history ? "Hide run history" : "Run history"} onPress={() => showHistory(!history)} />
          <Confirm title="Delete task" description={`Delete the schedule for ${jobName(job)}?`} disabled={action.busy}
            onConfirm={() => void action.run(async () => { await call("cron.remove", { id: job.id }); close(); await jobs.reload(); return "Task deleted."; })} />
        </View>
      </Card>
      {history && <RunHistory key={job.id} call={call} id={job.id} />}
    </> : <>
      <View style={styles.row}>
        <Action primary icon="compose" title="New task" disabled={!jobs.data || action.busy} onPress={() => edit(true)} />
        <Action icon="refresh" title="Refresh" disabled={jobs.loading || action.busy} onPress={() => void jobs.reload()} />
      </View>
      <DataState {...jobs} />
      {jobs.data?.length ? <Group>
        {jobs.data.map((item, index) => <Row key={item.id} divided={index > 0} title={jobName(item)}
          subtitle={item.schedule_display || scheduleValue(item)} value={jobState(item)} onPress={() => select(item.id)} />)}
      </Group> : jobs.data && <EmptyState icon="schedule" title="No scheduled tasks" description="Create a task to run a prompt or a script on a schedule." />}
    </>}
  </>;
}

function RunHistory({ call, id }: { call: ManageCall; id: string }) {
  const { styles } = useTheme();
  const input = useMemo(() => ({ id }), [id]);
  const history = useManagementData<{ runs: { id: string; title?: string; started_at: number; ended_at?: number | null; is_active?: boolean }[] }>(call, "cron.runs", input);
  return <Card>
    <Text accessibilityRole="header" style={styles.heading}>Recent runs</Text>
    <DataState {...history} />
    {history.data?.runs.map((run) => <View key={run.id}>
      <Text style={styles.text}>{run.title || when(run.started_at)}</Text>
      <Text style={styles.caption}>{run.title ? `${when(run.started_at)} · ` : ""}{run.is_active ? "Running" : run.ended_at ? "Ended" : "No end time"}</Text>
    </View>)}
    {history.data?.runs.length === 0 && <Text style={styles.muted}>Hermes has recorded no session runs for this task.</Text>}
    <Action icon="refresh" title="Refresh runs" disabled={history.loading} onPress={() => void history.reload()} />
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
  ["skills", "Skills", "Comma-separated skill names"], ["provider", "Provider override", undefined],
  ["model", "Model override", undefined], ["base_url", "Model endpoint override", undefined],
  ["script", "Script", "Relative to Hermes scripts directory"], ["workdir", "Working directory", "Absolute path on the Hermes host"],
  ["context_from", "Use output from tasks", "Comma-separated job IDs"], ["enabled_toolsets", "Toolsets", "Comma-separated toolset names"],
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
    <Text accessibilityRole="header" style={styles.heading}>{job ? "Edit scheduled task" : "New scheduled task"}</Text>
    {field("name", "Name")}
    {field("schedule", "Schedule", "every 2h or 0 9 * * *")}
    <Text style={styles.caption}>Schedules use the Hermes host’s configured time zone.</Text>
    {field("prompt", "Prompt", "What should Hermes do?", true)}
    {field("deliver", "Delivery target", "local or hermes_mobile")}
    <Text style={styles.caption}>Use local to keep output on the host, or hermes_mobile for a configured Inbox.</Text>
    <Action title={advanced ? "Hide advanced options" : "Advanced options"} onPress={() => expand(!advanced)} />
    {advanced && <>
      {advancedFields.map(([key, label, hint]) => field(key, label, hint))}
      <Toggle label="Run script without a model" disabled={busy} value={draft.no_agent} onChange={(no_agent) => set({ ...draft, no_agent })} />
    </>}
    <View style={styles.row}>
      <Action primary title={busy ? "Saving…" : job ? "Save task" : "Schedule task"}
        disabled={busy || !draft.schedule.trim() || (job && dirty.length === 0)} onPress={save} />
      <Action title="Cancel" disabled={busy} onPress={onCancel} />
    </View>
  </Card>;
}
