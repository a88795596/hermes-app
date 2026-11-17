import { Children, useEffect, useImperativeHandle, useRef, useState, type ComponentRef } from "react";
import { ScrollView, View } from "react-native";
import type { PagerViewProps, PagerViewOnPageSelectedEvent, PageScrollStateChangedEvent } from "@expo/ui/community/pager-view";

export default function PagerView({ ref, children, initialPage = 0, scrollEnabled = true, style,
  onPageSelected, onPageScrollStateChanged }: PagerViewProps) {
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const page = useRef(initialPage);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touching = useRef(false);
  const dragging = useRef(false);
  const offset = useRef(0);
  const [width, setWidth] = useState(0);
  const [scrollState, setScrollState] = useState({ prop: scrollEnabled, enabled: scrollEnabled });
  if (scrollState.prop !== scrollEnabled) setScrollState({ prop: scrollEnabled, enabled: scrollEnabled });
  const count = Children.count(children);
  const state = (pageScrollState: "idle" | "dragging" | "settling") => onPageScrollStateChanged?.({
    nativeEvent: { pageScrollState },
  } as PageScrollStateChangedEvent);
  const select = (position: number) => {
    page.current = position;
    onPageSelected?.({ nativeEvent: { position } } as PagerViewOnPageSelectedEvent);
    state("idle");
  };
  const settle = () => {
    clearTimeout(timer.current);
    if (!width || touching.current || dragging.current) return;
    const position = Math.max(0, Math.min(count - 1, Math.round(offset.current / width)));
    if (Math.abs(offset.current - position * width) < 2) select(position);
  };
  const scheduleSettle = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(settle, 120);
  };

  useEffect(() => {
    offset.current = page.current * width;
    scroll.current?.scrollTo({ x: page.current * width, animated: false });
  }, [width]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useImperativeHandle(ref, () => {
    const go = (index: number, animated: boolean) => {
      if (!Number.isInteger(index) || index < 0 || index >= count) return;
      state("settling");
      scroll.current?.scrollTo({ x: index * width, animated });
      if (!animated) { offset.current = index * width; select(index); }
    };
    return { setPage: (index) => go(index, true), setPageWithoutAnimation: (index) => go(index, false),
      setScrollEnabled: (enabled) => setScrollState({ prop: scrollEnabled, enabled }) };
  });

  return <ScrollView ref={scroll} horizontal pagingEnabled scrollEnabled={scrollState.enabled} style={style}
    showsHorizontalScrollIndicator={false} scrollEventThrottle={16}
    onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
    onTouchStart={() => { touching.current = true; clearTimeout(timer.current); }}
    onTouchEnd={({ nativeEvent }) => { if (!nativeEvent.touches.length) { touching.current = false; scheduleSettle(); } }}
    onTouchCancel={() => { touching.current = false; scheduleSettle(); }}
    onScrollBeginDrag={() => { dragging.current = true; state("dragging"); }}
    onScrollEndDrag={() => { dragging.current = false; scheduleSettle(); }}
    onMomentumScrollEnd={settle}
    onScroll={({ nativeEvent }) => {
      if (!width) return;
      offset.current = nativeEvent.contentOffset.x;
      state(touching.current || dragging.current ? "dragging" : "settling");
      scheduleSettle();
    }}>
    {Children.map(children, (child) => <View style={{ width, height: "100%" }}>{child}</View>)}
  </ScrollView>;
}
