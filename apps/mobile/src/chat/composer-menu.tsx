import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Skill } from "@hermes-mobile/protocol";
import type { useWorkspace } from "../sync/use-workspace";
import { motion, useReduceMotion } from "../ui/motion";
import { profileLabel } from "../ui/text";
import { Action, Icon, Notice, useTheme } from "../ui/theme";

const commands = [
  { name: "status", label: "查看会话状态" },
  { name: "model", label: "选择模型" },
  { name: "stop", label: "停止当前回复" },
  { name: "skills", label: "浏览技能" },
  { name: "new", label: "新建话题" },
  { name: "version", label: "查看 Hermes 版本" },
] as const;

export type ComposerCommand = (typeof commands)[number]["name"];

function Skills({ call, path, onSelect }: {
  call: ReturnType<typeof useWorkspace>["call"];
  path: string;
  onSelect: (skill: Skill) => void;
}) {
  const { colors, styles } = useTheme();
  const { height } = useWindowDimensions();
  const [attempt, setAttempt] = useState(0);
  const [skills, setSkills] = useState<Skill[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const request = new AbortController();
    void call<Skill[]>(path + "/skills", { signal: request.signal }).then((items) => {
      if (!request.signal.aborted) setSkills(items);
    }, (failure: unknown) => {
      if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "无法加载技能。");
    });
    return () => request.abort();
  }, [attempt, call, path]);

  if (error) {
    return (
      <>
        <Notice>{error}</Notice>
        <View style={styles.row}>
          <Action title="重试" onPress={() => { setError(undefined); setAttempt((value) => value + 1); }} />
        </View>
      </>
    );
  }
  if (!skills) return <ActivityIndicator accessibilityLabel="正在加载技能" color={colors.accent} />;
  return (
    <FlatList
      data={skills}
      style={{ maxHeight: height * 0.58, flexGrow: 0 }}
      keyExtractor={(item, index) => `${item.name}:${index}`}
      ListEmptyComponent={<Text style={styles.muted}>此配置档案暂无可用技能。</Text>}
      renderItem={({ item }) => (
        <Pressable accessibilityRole="button" accessibilityLabel={item.name} accessibilityHint="带入输入框"
          onPress={() => onSelect(item)}
          style={({ pressed }) => [menu.skill, { borderBottomColor: colors.edge }, pressed && styles.faded]}>
          <View style={menu.grow}>
            <Text style={styles.heading}>{item.name}</Text>
            {!!item.category && <Text style={styles.caption}>{item.category}</Text>}
            {!!item.description && <Text style={styles.text}>{item.description}</Text>}
          </View>
          <Icon name="chevron" size={15} color={colors.accent} />
        </Pressable>
      )}
    />
  );
}

export function ComposerMenu({
  kind, id, call, profile, connected, canStop, onClose, onCommand, onSkill,
}: {
  kind: "commands" | "skills";
  id: string;
  call: ReturnType<typeof useWorkspace>["call"];
  profile?: string;
  connected: boolean;
  canStop: boolean;
  onClose: () => void;
  onCommand: (command: ComposerCommand) => void;
  onSkill: (skill: Skill) => void;
}) {
  const { colors, styles } = useTheme();
  const reduced = useReduceMotion();
  const { height } = useWindowDimensions();

  return (
    <Modal transparent animationType={reduced ? "none" : "fade"} onRequestClose={onClose}>
      <View style={menu.backdrop}>
        <SafeAreaView accessibilityViewIsModal edges={["bottom", "left", "right"]}
          style={[menu.sheet, { backgroundColor: colors.surface }]}>
          <Animated.View style={[menu.content, !reduced && motion.reveal]}>
            <View style={menu.header}>
              <View style={menu.grow}>
                <Text accessibilityRole="header" style={styles.heading}>{kind === "skills" ? "技能" : "命令"}</Text>
                {kind === "skills" && profile && <Text style={styles.caption}>{profileLabel(profile)}</Text>}
              </View>
              <Action title="关闭" onPress={onClose} />
            </View>
            {kind === "skills" ? <Skills call={call} path={`/topics/${id}`} onSelect={onSkill} /> : !connected ? (
              <Text style={styles.muted}>连接 Hermes 后可执行命令。</Text>
            ) : (
              <FlatList
                data={commands.filter(({ name }) => canStop || name !== "stop")}
                style={{ maxHeight: height * 0.58, flexGrow: 0 }}
                keyExtractor={({ name }) => name}
                renderItem={({ item: { name, label } }) => (
                  <Pressable accessibilityRole="button" accessibilityLabel={`/${name} ${label}`}
                    onPress={() => onCommand(name)}
                    style={({ pressed }) => [menu.skill, { borderBottomColor: colors.edge }, pressed && styles.faded]}>
                    <Text style={styles.heading}>/{name}</Text>
                    <Text style={[styles.muted, menu.grow]}>{label}</Text>
                    <Icon name="chevron" size={15} color={colors.accent} />
                  </Pressable>
                )}
              />
            )}
          </Animated.View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const menu = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0, 0, 0, 0.4)" },
  sheet: { width: "100%", maxWidth: 680, alignSelf: "center", borderTopLeftRadius: 18, borderTopRightRadius: 18 },
  content: { padding: 16, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  grow: { flex: 1, minWidth: 0 },
  skill: { minHeight: 44, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
});
