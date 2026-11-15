import { useCallback, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { ComposerSheet } from "../chat/composer-menu";
import { haptic } from "../ui/haptics";
import { Action, EmptyState, Field, Icon, useTheme } from "../ui/theme";
import {
  ActionState, DataState, EditField, FormHeader, Group, InstallProgress, ManagementHeader, ManagementLayout, Row, Toggle, mono,
  useManagementAction, useManagementData, type ManageCall,
} from "./shared";

type Skill = { name: string; description?: string; category?: string; provenance?: string; enabled: boolean };

export function Skills({ call }: { call: ManageCall }) {
  const { colors, styles } = useTheme();
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
  const { reload } = skills;
  const finishInstall = useCallback((message: string, failed?: boolean) => {
    setPending(undefined);
    setInstalled(failed ? { error: message } : { message });
    void reload();
  }, [reload]);
  const skill = skills.data?.find((item) => item.name === selected);
  const query = search.trim().toLowerCase();
  const results = skills.data?.filter((item) => `${item.name} ${item.description ?? ""} ${item.category ?? ""}`.toLowerCase().includes(query));
  const status = <>
    {!install && <ActionState {...action} />}
    {installed && <ActionState {...installed} />}
    {pending && <InstallProgress call={call} name={pending} onDone={finishInstall} />}
  </>;

  if (create) return <SkillForm busy={action.busy} onCancel={() => setCreate(false)} onSave={(name, content, category) => void action.run(async () => {
    await call("skill.create", { name, content, ...(category && { category }) });
    haptic("success");
    setCreate(false);
    await reload();
    return "技能已创建。";
  })}>{status}</SkillForm>;

  if (skill) return <SkillDetail key={skill.name} call={call} skill={skill} busy={action.busy} onBack={() => select(undefined)}
    onToggle={(enabled) => void action.run(async () => {
      await call("skill.toggle", { name: skill.name, enabled });
      haptic("success");
      await reload();
      return enabled ? "技能已启用。" : "技能已停用。";
    })}>{status}</SkillDetail>;

  return <ManagementLayout header={<ManagementHeader title="技能" />}>
    <View style={styles.row}>
      <Action primary icon="compose" title="新建技能" style={layout.action} disabled={!skills.data || action.busy} onPress={() => setCreate(true)} />
      <Action icon="download" title="从技能中心安装" style={layout.action} disabled={!skills.data || !!pending || action.busy} onPress={() => setInstall(true)} />
      <Action icon="refresh" title="刷新" style={layout.action} disabled={skills.loading || action.busy} onPress={() => void reload()} />
    </View>
    {status}
    <DataState {...skills} />
    {skills.data && <View>
      <Field accessibilityLabel="搜索已安装的技能" placeholder="搜索已安装的技能" value={search}
        autoCapitalize="none" autoCorrect={false} returnKeyType="search" style={layout.search}
        onChangeText={(value) => { setSearch(value); setLimit(30); }} />
      <View pointerEvents="none" style={layout.searchIcon}><Icon name="search" size={18} color={colors.muted} /></View>
    </View>}
    {results?.length ? <Group>
      {results.slice(0, limit).map((item, index) => <Row key={item.name} divided={index > 0} icon="skill" title={item.name}
        subtitle={item.description || item.category} value={item.enabled ? "已启用" : "已停用"} onPress={() => select(item.name)} />)}
    </Group> : skills.data && <EmptyState icon="skill" title={query ? "暂无匹配的技能" : "暂无已安装的技能"}
      description={query ? "试试其他名称或分类。" : "创建技能，或从技能中心安装。"} />}
    {results && results.length > limit && <Action title="显示更多技能" onPress={() => setLimit(limit + 30)} />}
    {install && <ComposerSheet title="从技能中心安装" closeLabel="关闭安装" busy={action.busy} onClose={() => setInstall(false)}>
      <ScrollView style={layout.sheetScroll} contentContainerStyle={layout.installFields} keyboardShouldPersistTaps="handled">
        <ActionState {...action} />
        <EditField label="技能标识或网址" placeholder="owner/repository/skill-name" value={identifier} onChangeText={setIdentifier} editable={!action.busy} />
        <Action primary title={action.busy ? "正在启动安装…" : "安装技能"} disabled={action.busy || !identifier.trim()} onPress={() => void action.run(async () => {
          setInstalled(undefined);
          const result = await call<{ name: string }>("skill.install", { identifier: identifier.trim() });
          setPending(result.name);
          setInstall(false);
          setIdentifier("");
        })} />
      </ScrollView>
    </ComposerSheet>}
  </ManagementLayout>;
}

function SkillDetail({ call, skill, busy, onBack, onToggle, children }: {
  call: ManageCall; skill: Skill; busy: boolean; onBack: () => void; onToggle: (enabled: boolean) => void; children: ReactNode;
}) {
  const { colors, styles } = useTheme();
  const { name } = skill;
  const [content, setContent] = useState<string>();
  const [editing, edit] = useState(false);
  const action = useManagementAction();
  const read = () => void action.run(async () => { setContent((await call<{ content: string }>("skill.read", { name })).content); });
  const summary = <>
    <View style={layout.summary}>
      {!editing && <View style={[layout.skillIcon, { backgroundColor: colors.tint }]}>
        <Icon name="skill" size={24} color={colors.accent} />
      </View>}
      <View style={layout.skillSummary}>
        <Text accessibilityRole="header" style={[styles.heading, layout.skillName]}>{name}</Text>
        {!!skill.description && <Text style={styles.text}>{skill.description}</Text>}
        {(skill.category || skill.provenance) && <Text style={styles.caption}>{[skill.category, skill.provenance].filter(Boolean).join(" · ")}</Text>}
      </View>
    </View>
    <View style={[layout.toggle, { borderBottomColor: colors.edge }]}>
      <Toggle label="启用技能" value={skill.enabled} disabled={busy || (editing && action.busy)} onChange={onToggle} />
    </View>
  </>;

  if (editing && content !== undefined) return <SkillForm name={name} content={content} busy={action.busy} onCancel={() => edit(false)}
    onSave={(name, content) => void action.run(async () => {
      await call("skill.edit", { name, content });
      haptic("success");
      setContent(content);
      edit(false);
      return "技能已保存。";
    })}>
    {children}
    <ActionState {...action} />
    {summary}
  </SkillForm>;

  return <ManagementLayout hideTabs header={<ManagementHeader title="技能详情" backLabel="全部技能" onBack={onBack} backDisabled={busy || action.busy} />}>
    {children}
    <ActionState {...action} />
    {summary}
    {content === undefined ? <Group>
      <Row title="SKILL.md" icon="logs" value={action.busy ? "加载中…" : "查看内容"} disabled={action.busy} onPress={read} />
    </Group> : <View style={layout.document}>
      <Text accessibilityRole="header" style={styles.heading}>SKILL.md</Text>
      <View style={styles.row}>
        <Action compact icon="refresh" title={action.busy ? "加载中…" : "重新加载内容"} disabled={action.busy} onPress={read} />
        <Action primary compact icon="compose" title="编辑内容" disabled={action.busy} onPress={() => edit(true)} />
      </View>
      <View style={[layout.sourceRule, { borderTopColor: colors.edge }]}>
        <Text selectable style={[styles.text, layout.source]}>{content}</Text>
      </View>
    </View>}
  </ManagementLayout>;
}

function SkillForm({ name, content, busy, onCancel, onSave, children }: {
  name?: string; content?: string; busy: boolean; onCancel: () => void;
  onSave: (name: string, content: string, category: string) => void; children: ReactNode;
}) {
  const { colors } = useTheme();
  const [skillName, setName] = useState(name ?? "");
  const [category, setCategory] = useState("");
  const [body, setBody] = useState(content ?? "---\nname: \ndescription: \n---\n\n");
  const disabled = busy || !skillName.trim() || !body.trim() || content === body;
  const save = () => onSave(skillName.trim(), body, category.trim());

  return <ManagementLayout hideTabs header={<FormHeader title={name ? "编辑技能" : "新建技能"} onCancel={onCancel}
    onSave={save} cancelDisabled={busy} disabled={disabled} saveLabel={busy ? "保存中…" : "保存"} />}>
    {children}
    {!name && <>
      <EditField label="技能名称" placeholder="my-skill" value={skillName} onChangeText={setName} editable={!busy} />
      <View style={[layout.divider, { borderBottomColor: colors.edge }]} />
      <EditField label="分类（选填）" value={category} onChangeText={setCategory} editable={!busy} />
      <View style={[layout.divider, { borderBottomColor: colors.edge }]} />
    </>}
    <EditField label="SKILL.md 内容" value={body} onChangeText={setBody} multiline editable={!busy}
      help={name ? undefined : "请先在文件开头的元数据区填写 name 和 description，再编写技能说明。"}
      style={[layout.editor, !!name && layout.editing]} />
    {!name && <Action primary title={busy ? "保存中…" : "创建技能"} disabled={disabled} onPress={save} />}
  </ManagementLayout>;
}

const layout = StyleSheet.create({
  action: { flexGrow: 1, paddingHorizontal: 9 },
  search: { paddingLeft: 42 },
  searchIcon: { position: "absolute", top: 0, bottom: 0, left: 13, justifyContent: "center" },
  summary: { flexDirection: "row", alignItems: "flex-start", gap: 14, paddingVertical: 8 },
  skillIcon: { width: 48, height: 48, alignItems: "center", justifyContent: "center", borderRadius: 12 },
  skillSummary: { flex: 1, minWidth: 0, gap: 5 },
  skillName: { fontSize: 24, lineHeight: 30 },
  toggle: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 8 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth },
  document: { gap: 12 },
  sourceRule: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 14 },
  source: { fontFamily: mono, fontSize: 15, lineHeight: 23 },
  editor: { fontFamily: mono, minHeight: 240 },
  editing: { minHeight: 320 },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  installFields: { gap: 12 },
});
