import type { Profile } from "@hermes-mobile/protocol";

export function selectProfile(profiles: Profile[], selectedId?: string) {
  return profiles.find((profile) => profile.profile_id === selectedId)
    ?? profiles.find((profile) => profile.is_default) ?? profiles[0];
}

export function adjacentProfile(profiles: Profile[], selectedId: string | undefined, direction: -1 | 1) {
  const index = profiles.findIndex((profile) => profile.profile_id === selectedId);
  return index < 0 ? undefined : profiles[index + direction];
}
