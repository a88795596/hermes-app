import { Image, type ImageSource } from "expo-image";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { Profile } from "@hermes-mobile/protocol";
import type { Session } from "../auth/session";
import { profileLabel } from "../ui/text";
import { useTheme } from "../ui/theme";

export function profileAvatarSource(profile: Profile | undefined, session: Session): ImageSource | undefined {
  if (!profile?.avatar_url) return;
  try {
    const url = new URL(profile.avatar_url, session.origin);
    if (url.origin !== session.origin || url.username || url.password || url.pathname !== `/mobile/v1/profiles/${encodeURIComponent(profile.profile_id)}/avatar`) return;
    return { uri: url.href, headers: { Authorization: `Bearer ${session.token}` } };
  } catch { return; }
}

export function ProfileAvatar({ profile, session, size = 40 }: { profile?: Profile; session: Session; size?: number }) {
  const { colors } = useTheme();
  const [failedProfile, setFailedProfile] = useState<Profile>();
  const source = useMemo(() => profileAvatarSource(profile, session), [profile, session]);
  const frame = { width: size, height: size, borderRadius: size / 2 };
  return <View accessible={false} style={[frame, { backgroundColor: colors.tint, alignItems: "center", justifyContent: "center", overflow: "hidden" }]}>
    {source && failedProfile !== profile ? (
      <Image source={source} style={frame} contentFit="cover" cachePolicy="memory-disk" recyclingKey={source.uri}
        onError={() => setFailedProfile(profile)} accessible={false} />
    ) : <Text style={{ color: colors.accent, fontSize: size * 0.42, fontWeight: "600" }}>
      {Array.from(profile ? profileLabel(profile) : "H")[0]}
    </Text>}
  </View>;
}
