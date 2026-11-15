import { randomUUID } from "expo-crypto";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import SpeechRecognition, { type SpeechState } from "../../modules/speech-recognition";

type Recording = {
  id: string;
  conversationId: string;
  prefix: string;
  draft: string;
  state: SpeechState;
  interrupted: boolean;
  ending?: Promise<string | null>;
};

export function useSpeechInput(conversationId: string, enabled: boolean, draft: string, onDraftChange: (text: string) => void) {
  const available = SpeechRecognition?.isAvailable() ?? false;
  const active = useRef<Recording | null>(null);
  const mounted = useRef(true);
  const focused = useRef(false);
  const input = useRef({ conversationId, enabled, draft, onDraftChange });
  useLayoutEffect(() => {
    input.current = { conversationId, enabled, draft, onDraftChange };
  }, [conversationId, enabled, draft, onDraftChange]);
  const [state, setState] = useState<SpeechState>("idle");
  const [error, setError] = useState<string>();

  const updateText = useCallback((recording: Recording, text: string) => {
    if (!mounted.current || active.current !== recording || input.current.conversationId !== recording.conversationId) return;
    const separator = text && recording.prefix && !/\s$/.test(recording.prefix) ? " " : "";
    recording.draft = recording.prefix + separator + text;
    input.current.draft = recording.draft;
    input.current.onDraftChange(recording.draft);
  }, []);

  const cancel = useCallback(() => {
    const recording = active.current;
    active.current = null;
    if (mounted.current) setState("idle");
    if (recording) void SpeechRecognition?.cancel(recording.id).catch(() => {});
  }, []);

  const finish = useCallback((recording: Recording, interrupted = false): Promise<string | null> => {
    if (interrupted) recording.interrupted = true;
    if (recording.ending) return recording.ending;
    const starting = recording.state === "starting";
    recording.state = "stopping";
    if (mounted.current) setState("stopping");
    recording.ending = Promise.resolve().then(async () => {
      try {
        if (starting) await SpeechRecognition?.cancel(recording.id);
        else {
          const final = await SpeechRecognition?.stop(recording.id);
          // The returned text also covers native events delivered after this Promise settles.
          if (final) updateText(recording, final);
        }
        return active.current === recording && input.current.conversationId === recording.conversationId && !recording.interrupted
          ? recording.draft : null;
      } catch (failure) {
        if (mounted.current && active.current === recording) {
          setError(failure instanceof Error ? failure.message : "语音输入已中断，请重试。");
        }
        await SpeechRecognition?.cancel(recording.id).catch(() => {});
        return null;
      } finally {
        if (active.current === recording) {
          active.current = null;
          if (mounted.current) setState("idle");
        }
      }
    });
    return recording.ending;
  }, [updateText]);

  const stop = useCallback(() => active.current ? finish(active.current) : Promise.resolve(input.current.draft), [finish]);

  const start = useCallback(async () => {
    if (!mounted.current || !focused.current || !available || !input.current.enabled || active.current) return;
    const base = input.current.draft;
    const recording: Recording = {
      id: randomUUID(), conversationId: input.current.conversationId,
      prefix: base,
      draft: base, state: "starting", interrupted: false,
    };
    active.current = recording;
    setError(undefined);
    setState("starting");
    try {
      await SpeechRecognition!.start(recording.id);
      if (active.current === recording && recording.state === "starting") {
        recording.state = "recording";
        setState("recording");
      }
    } catch (failure) {
      if (active.current !== recording || recording.ending) return;
      setError(failure instanceof Error ? failure.message : "无法开始语音输入。");
      cancel();
    }
  }, [available, cancel]);

  useEffect(() => {
    mounted.current = true;
    const subscriptions = SpeechRecognition ? [
      SpeechRecognition.addListener("result", (event) => {
        const recording = active.current;
        if (recording?.id === event.id) updateText(recording, event.text);
      }),
      SpeechRecognition.addListener("status", (event) => {
        const recording = active.current;
        if (!recording || recording.id !== event.id || recording.ending) return;
        if (event.state === "idle") active.current = null;
        else recording.state = event.state;
        setState(event.state);
      }),
      SpeechRecognition.addListener("error", (event) => {
        const recording = active.current;
        if (!recording || recording.id !== event.id) return;
        setError(event.message);
        void finish(recording, true);
      }),
      AppState.addEventListener("change", (next) => {
        const recording = active.current;
        if (next !== "background" || !recording) return;
        // Android permission dialogs also pause the Activity; native code gates capture on foreground.
        if (Platform.OS === "android" && recording.state === "starting") return;
        void finish(recording, true);
      }),
    ] : [];
    return () => {
      mounted.current = false;
      cancel();
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, [cancel, finish, updateText]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    return () => {
      focused.current = false;
      if (active.current) void finish(active.current, true);
    };
  }, [finish]));

  useEffect(() => {
    const recording = active.current;
    if (!recording) return;
    if (recording.conversationId !== conversationId) cancel();
    else if (!enabled) void finish(recording, true);
  }, [conversationId, enabled, cancel, finish]);

  return { available, state, busy: state !== "idle", error, start, stop };
}
