import { useEffect, useRef, useState, type ReactNode } from "react";
import { Keyboard } from "react-native";
import type { PagerViewRef } from "@expo/ui/community/pager-view";
import { useReduceMotion } from "../ui/motion";
import PagerView from "./pager-view";
import { ProfilePagingContext } from "./paging-context";

export function ProfilePager({ profileIds, profileId, targetId, enabled, onSelect, onMovingChange, children }: {
  profileIds: string[];
  profileId: string;
  targetId?: string;
  enabled: boolean;
  onSelect: (id: string) => void;
  onMovingChange: (moving: boolean) => void;
  children: ReactNode;
}) {
  const pager = useRef<PagerViewRef>(null);
  const reduced = useReduceMotion();
  const index = Math.max(0, profileIds.indexOf(profileId));
  const target = targetId && profileIds.includes(targetId) ? profileIds.indexOf(targetId) : index;
  const selected = useRef(index);
  const pending = useRef(index);
  const requested = useRef<number | undefined>(undefined);
  const phase = useRef("idle");
  const [touchBlocked, setTouchBlocked] = useState(false);

  useEffect(() => {
    if (selected.current === target) return;
    requested.current = target;
    if (!reduced) phase.current = "settling";
    onMovingChange(true);
    if (reduced) pager.current?.setPageWithoutAnimation(target);
    else pager.current?.setPage(target);
  }, [target, reduced, onMovingChange]);

  useEffect(() => () => onMovingChange(false), [onMovingChange]);

  function settle() {
    const next = pending.current;
    if (requested.current !== undefined && requested.current !== next) return;
    requested.current = undefined;
    if (!enabled && next !== index) {
      pending.current = selected.current = index;
      pager.current?.setPageWithoutAnimation(index);
      onMovingChange(false);
      return;
    }
    selected.current = next;
    if (profileIds[next] !== profileId || targetId) onSelect(profileIds[next]);
    onMovingChange(false);
  }

  return <ProfilePagingContext value={setTouchBlocked}>
    <PagerView ref={pager} style={{ flex: 1 }} initialPage={index} offscreenPageLimit={1}
      scrollEnabled={enabled && !touchBlocked && profileIds.length > 1}
      onPageSelected={({ nativeEvent: { position } }) => {
        if (!Number.isInteger(position) || position < 0 || position >= profileIds.length) return;
        pending.current = position;
        if (phase.current === "idle") settle();
      }}
      onPageScrollStateChanged={({ nativeEvent: { pageScrollState } }) => {
        phase.current = pageScrollState;
        if (pageScrollState === "dragging") {
          requested.current = undefined;
          Keyboard.dismiss();
        }
        if (pageScrollState === "idle") settle();
        else onMovingChange(true);
      }}>
      {children}
    </PagerView>
  </ProfilePagingContext>;
}
