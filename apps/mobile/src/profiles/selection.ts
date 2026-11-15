import type { Profile } from "@hermes-mobile/protocol";

export function selectProfile(profiles: Profile[], selectedId?: string) {
  return profiles.find((profile) => profile.profile_id === selectedId)
    ?? profiles.find((profile) => profile.is_default) ?? profiles[0];
}
