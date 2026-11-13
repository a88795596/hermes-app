import { useState } from "react";
import { Text, View } from "react-native";
import { Action, Card, EmptyState, useTheme } from "../ui/theme";
import { ActionState, DataState, EditField, Group, InstallProgress, Row, Toggle, mono,
  useManagementAction, useManagementData, type ManageCall } from "./shared";

type Skill = { name: string; description?: string; category?: string; provenance?: string; enabled: boolean };

export function Skills({ call }: { call: ManageCall }) {
  const { styles } = useTheme();
  const skills = useManagementData<Skill[]>(call, "skill.list");
  const action = useManagementAction();
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(30);
  const [selected, select] = useState<string>();
  const [create, setCreate] = useState(false);
  const [install, setInstall] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [pending, setPending] = useState<string>();
  const [installed, setInstalled] = useState<{ message?: string; error?: string }>();
  const skill = skills.data?.find((item) => item.name === selected);
  const results = skills.data?.filter((item) => `${item.name} ${item.description ?? ""} ${item.category ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));

  return <>
    <ActionState {...action} />
    {installed && <ActionState {...installed} />}
    {pending && <InstallProgress call={call} name={pending} onDone={(message, failed) => {
      setPending(undefined);
      setInstalled(failed ? { error: message } : { message });
      void skills.reload();
    }} />}
    {create ? <SkillForm busy={action.busy} onCancel={() => setCreate(false)} onSave={(name, content, category) => void action.run(async () => {
      await call("skill.create", { name, content, ...(category && { category }) });
      setCreate(false);
      await skills.reload();
      return "Skill created.";
    })} /> : skill ? <>
      <View style={styles.row}><Action icon="back" title="All skills" disabled={action.busy} onPress={() => select(undefined)} /></View>
      <Card>
        <Text accessibilityRole="header" style={styles.heading}>{skill.name}</Text>
        {!!skill.description && <Text style={styles.text}>{skill.description}</Text>}
        <Text style={styles.caption}>{[skill.category, skill.provenance].filter(Boolean).join(" · ")}</Text>
        <Toggle label="Skill enabled" value={skill.enabled} disabled={action.busy} onChange={(enabled) => void action.run(async () => {
          await call("skill.toggle", { name: skill.name, enabled });
          await skills.reload();
          return enabled ? "Skill enabled." : "Skill disabled.";
        })} />
      </Card>
      <SkillContent key={skill.name} call={call} name={skill.name} />
    </> : <>
      <View style={styles.row}>
        <Action primary icon="compose" title="New skill" disabled={!skills.data} onPress={() => { setCreate(true); setInstall(false); }} />
        <Action title={install ? "Close install" : "Install from Hub"} disabled={!skills.data || !!pending || action.busy} onPress={() => setInstall(!install)} />
        <Action icon="refresh" title="Refresh" disabled={skills.loading || action.busy} onPress={() => void skills.reload()} />
      </View>
      {install && <Card>
        <EditField label="Skill identifier or URL" placeholder="owner/repository/skill-name" value={identifier} onChangeText={setIdentifier} editable={!action.busy} />
        <Action primary title={action.busy ? "Starting…" : "Install skill"} disabled={action.busy || !identifier.trim()} onPress={() => void action.run(async () => {
          setInstalled(undefined);
          const result = await call<{ name: string }>("skill.install", { identifier: identifier.trim() });
          setPending(result.name);
          setInstall(false);
          setIdentifier("");
        })} />
      </Card>}
      <DataState {...skills} />
      {skills.data && <EditField label="Search installed skills" value={search} onChangeText={(value) => { setSearch(value); setLimit(30); }} />}
      {results?.length ? <Group>
        {results.slice(0, limit).map((item, index) => <Row key={item.name} divided={index > 0} title={item.name}
          subtitle={item.description || item.category} value={item.enabled ? "Enabled" : "Disabled"} onPress={() => select(item.name)} />)}
      </Group> : skills.data && <EmptyState icon="skill" title={search ? "No matching skills" : "No installed skills"}
        description={search ? "Try a different name or category." : "Create a skill or install one from the Hub."} />}
      {results && results.length > limit && <Action title="Show more skills" onPress={() => setLimit(limit + 30)} />}
    </>}
  </>;
}

function SkillContent({ call, name }: { call: ManageCall; name: string }) {
  const { styles } = useTheme();
  const [content, setContent] = useState<string>();
  const [editing, edit] = useState(false);
  const action = useManagementAction();
  return <>
    <ActionState {...action} />
    {editing && content !== undefined ? <SkillForm name={name} content={content} busy={action.busy} onCancel={() => edit(false)}
      onSave={(name, content) => void action.run(async () => {
        await call("skill.edit", { name, content });
        setContent(content);
        edit(false);
        return "Skill saved.";
      })} /> : <Card>
      <Text accessibilityRole="header" style={styles.heading}>SKILL.md</Text>
      <View style={styles.row}>
        <Action title={action.busy ? "Loading…" : content === undefined ? "Read content" : "Reload content"} disabled={action.busy}
          onPress={() => void action.run(async () => { setContent((await call<{ content: string }>("skill.read", { name })).content); })} />
        {content !== undefined && <Action title="Edit content" disabled={action.busy} onPress={() => edit(true)} />}
      </View>
      {content !== undefined && <Text selectable style={[styles.text, { fontFamily: mono }]}>{content}</Text>}
    </Card>}
  </>;
}

function SkillForm({ name, content, busy, onCancel, onSave }: {
  name?: string; content?: string; busy: boolean; onCancel: () => void; onSave: (name: string, content: string, category: string) => void;
}) {
  const { styles } = useTheme();
  const [skillName, setName] = useState(name ?? "");
  const [category, setCategory] = useState("");
  const [body, setBody] = useState(content ?? "---\nname: \ndescription: \n---\n\n");
  return <Card>
    <Text accessibilityRole="header" style={styles.heading}>{name ? `Edit ${name}` : "New skill"}</Text>
    {!name && <>
      <EditField label="Skill name" placeholder="my-skill" value={skillName} onChangeText={setName} editable={!busy} />
      <EditField label="Category (optional)" value={category} onChangeText={setCategory} editable={!busy} />
    </>}
    <EditField label="SKILL.md content" value={body} onChangeText={setBody} multiline editable={!busy}
      help={name ? undefined : "Fill in name and description in the frontmatter, then add the skill instructions."} style={{ fontFamily: mono, minHeight: 225 }} />
    <View style={styles.row}>
      <Action primary title={busy ? "Saving…" : name ? "Save skill" : "Create skill"}
        disabled={busy || !skillName.trim() || !body.trim() || content === body} onPress={() => onSave(skillName.trim(), body, category.trim())} />
      <Action title="Cancel" disabled={busy} onPress={onCancel} />
    </View>
  </Card>;
}
