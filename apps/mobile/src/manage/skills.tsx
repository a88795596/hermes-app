import { useState } from "react";
import { Text, View } from "react-native";
import { Action, Card, CloseButton, EmptyState, useTheme } from "../ui/theme";
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
      return "技能已创建。";
    })} /> : skill ? <>
      <View style={styles.row}><Action icon="back" title="全部技能" disabled={action.busy} onPress={() => select(undefined)} /></View>
      <Card>
        <Text accessibilityRole="header" style={styles.heading}>{skill.name}</Text>
        {!!skill.description && <Text style={styles.text}>{skill.description}</Text>}
        <Text style={styles.caption}>{[skill.category, skill.provenance].filter(Boolean).join(" · ")}</Text>
        <Toggle label="启用技能" value={skill.enabled} disabled={action.busy} onChange={(enabled) => void action.run(async () => {
          await call("skill.toggle", { name: skill.name, enabled });
          await skills.reload();
          return enabled ? "技能已启用。" : "技能已停用。";
        })} />
      </Card>
      <SkillContent key={skill.name} call={call} name={skill.name} />
    </> : <>
      <View style={styles.row}>
        <Action primary icon="compose" title="新建技能" disabled={!skills.data} onPress={() => { setCreate(true); setInstall(false); }} />
        {!install && <Action title="从技能中心安装" disabled={!skills.data || !!pending || action.busy} onPress={() => setInstall(true)} />}
        <Action icon="refresh" title="刷新" disabled={skills.loading || action.busy} onPress={() => void skills.reload()} />
      </View>
      {install && <Card>
        <EditField label="技能标识或网址" placeholder="owner/repository/skill-name" value={identifier} onChangeText={setIdentifier} editable={!action.busy} />
        <View style={styles.row}>
          <Action primary title={action.busy ? "正在启动安装…" : "安装技能"} disabled={action.busy || !identifier.trim()} onPress={() => void action.run(async () => {
            setInstalled(undefined);
            const result = await call<{ name: string }>("skill.install", { identifier: identifier.trim() });
            setPending(result.name);
            setInstall(false);
            setIdentifier("");
          })} />
          <CloseButton accessibilityLabel="关闭安装" disabled={!skills.data || !!pending || action.busy} onPress={() => setInstall(false)} />
        </View>
      </Card>}
      <DataState {...skills} />
      {skills.data && <EditField label="搜索已安装的技能" value={search} onChangeText={(value) => { setSearch(value); setLimit(30); }} />}
      {results?.length ? <Group>
        {results.slice(0, limit).map((item, index) => <Row key={item.name} divided={index > 0} title={item.name}
          subtitle={item.description || item.category} value={item.enabled ? "已启用" : "已停用"} onPress={() => select(item.name)} />)}
      </Group> : skills.data && <EmptyState icon="skill" title={search ? "暂无匹配的技能" : "暂无已安装的技能"}
        description={search ? "试试其他名称或分类。" : "创建技能，或从技能中心安装。"} />}
      {results && results.length > limit && <Action title="显示更多技能" onPress={() => setLimit(limit + 30)} />}
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
        return "技能已保存。";
      })} /> : <Card>
      <Text accessibilityRole="header" style={styles.heading}>SKILL.md</Text>
      <View style={styles.row}>
        <Action title={action.busy ? "加载中…" : content === undefined ? "查看内容" : "重新加载内容"} disabled={action.busy}
          onPress={() => void action.run(async () => { setContent((await call<{ content: string }>("skill.read", { name })).content); })} />
        {content !== undefined && <Action title="编辑内容" disabled={action.busy} onPress={() => edit(true)} />}
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
    <Text accessibilityRole="header" style={styles.heading}>{name ? `编辑「${name}」` : "新建技能"}</Text>
    {!name && <>
      <EditField label="技能名称" placeholder="my-skill" value={skillName} onChangeText={setName} editable={!busy} />
      <EditField label="分类（选填）" value={category} onChangeText={setCategory} editable={!busy} />
    </>}
    <EditField label="SKILL.md 内容" value={body} onChangeText={setBody} multiline editable={!busy}
      help={name ? undefined : "请先在文件开头的元数据区填写 name 和 description，再编写技能说明。"} style={{ fontFamily: mono, minHeight: 225 }} />
    <View style={styles.row}>
      <Action primary title={busy ? "保存中…" : name ? "保存技能" : "创建技能"}
        disabled={busy || !skillName.trim() || !body.trim() || content === body} onPress={() => onSave(skillName.trim(), body, category.trim())} />
      <CloseButton accessibilityLabel="取消" disabled={busy} onPress={onCancel} />
    </View>
  </Card>;
}
