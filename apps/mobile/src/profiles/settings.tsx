import { Image } from "expo-image";
import { useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { MAX_PROFILE_ALIAS_LENGTH, type AttachmentUpload, type Profile, type ProfilePreferencesUpdate } from "@hermes-mobile/protocol";
import type { Session } from "../auth/session";
import { ComposerSheet, PickerRow } from "../chat/composer-menu";
import { EditField, Toggle } from "../manage/shared";
import { haptic } from "../ui/haptics";
import { profileLabel } from "../ui/text";
import { Action, EmptyState, Notice, useTheme } from "../ui/theme";
import { ProfileAvatar } from "./avatar";
import { pickProfileAvatar } from "./pick-avatar";

interface Props {
  profiles: Profile[];
  session: Session;
  onSave: (id: string, update: ProfilePreferencesUpdate) => Promise<void>;
}

export function ProfileSettings({ profiles, session, onSave }: Props) {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = profiles.find((profile) => profile.profile_id === selectedId);
  return <>
    {profiles.length === 0 ? <EmptyState icon="manage" title="暂无可用配置档案" /> : profiles.map((profile) => (
      <PickerRow key={profile.profile_id} title={`${profileLabel(profile)}${profile.is_default ? " · 首页默认" : ""}`}
        leading={<ProfileAvatar profile={profile} session={session} />} trailing="chevron" selected={false} disabled={false}
        onPress={() => setSelectedId(profile.profile_id)} />
    ))}
    {selected && <ProfileEditor key={selected.profile_id} profile={selected} session={session} onSave={onSave} onClose={() => setSelectedId(undefined)} />}
  </>;
}

function ProfileEditor({ profile, session, onSave, onClose }: Pick<Props, "session" | "onSave"> & { profile: Profile; onClose: () => void }) {
  const { styles } = useTheme();
  const [initial] = useState(profile);
  const [alias, setAlias] = useState(initial.alias ?? "");
  const [isDefault, setDefault] = useState(initial.is_default === true);
  const [avatar, setAvatar] = useState<AttachmentUpload | null>();
  const [busy, setBusy] = useState<"image" | "save">();
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const update: ProfilePreferencesUpdate = {
    ...(alias.trim() !== (initial.alias ?? "") && { alias: alias.trim() || null }),
    ...(isDefault !== (initial.is_default === true) && { is_default: isDefault }),
    ...(avatar !== undefined && { avatar }),
  };
  const changed = Object.keys(update).length > 0;

  async function chooseAvatar() {
    if (pending.current) return;
    pending.current = true;
    setBusy("image");
    setError(undefined);
    try {
      const image = await pickProfileAvatar();
      if (image) setAvatar(image);
    } catch (failure) {
      haptic("error");
      setError(failure instanceof Error ? failure.message : "无法选择头像。");
    } finally { pending.current = false; setBusy(undefined); }
  }

  async function save() {
    if (pending.current || !changed) return;
    pending.current = true;
    setBusy("save");
    setError(undefined);
    try {
      await onSave(profile.profile_id, update);
      haptic("success");
      onClose();
    } catch (failure) {
      haptic("error");
      setError(failure instanceof Error ? failure.message : "无法保存配置档案。");
    } finally { pending.current = false; setBusy(undefined); }
  }

  return <ComposerSheet title={profileLabel(profile.label)} busy={!!busy} onClose={onClose} closeLabel="关闭配置档案设置">
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={layout.form}>
      <View style={layout.avatar}>
        {avatar ? <Image source={{ uri: `data:${avatar.mime};base64,${avatar.content_base64}` }} style={layout.preview}
          contentFit="cover" accessibilityLabel="新头像预览" />
          : <ProfileAvatar profile={avatar === null ? { ...profile, avatar_url: undefined } : profile} session={session} size={88} />}
        <View style={styles.row}>
          <Action title={busy === "image" ? "选择中…" : "上传头像"} icon="photo" disabled={!!busy} onPress={() => void chooseAvatar()} />
          {(avatar || (avatar === undefined && profile.avatar_url)) && <Action title="移除头像" destructive disabled={!!busy} onPress={() => setAvatar(null)} />}
        </View>
      </View>
      <EditField label="别名" value={alias} onChangeText={setAlias} placeholder={profileLabel(profile.label)} maxLength={MAX_PROFILE_ALIAS_LENGTH} editable={!busy} />
      <Toggle label="首页默认选中" value={isDefault} onChange={setDefault} disabled={!!busy} />
      {error && <Notice>{error}</Notice>}
      <Action title={busy === "save" ? "保存中…" : "保存"} primary disabled={!!busy || !changed} onPress={() => void save()} />
    </ScrollView>
  </ComposerSheet>;
}

const layout = StyleSheet.create({
  form: { gap: 18, paddingBottom: 12 },
  avatar: { alignItems: "center", gap: 12 },
  preview: { width: 88, height: 88, borderRadius: 44 },
});
