import { useEvent } from "expo";
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, StyleSheet, Text, View } from "react-native";
import { Action, Notice, useTheme } from "../ui/theme";

type Props = { uri: string; kind: "audio" | "video"; name: string };

export function MediaPlayer({ uri, kind, name }: Props) {
  const [attempt, setAttempt] = useState(0);
  if (!uri.startsWith("file://")) return <Notice>媒体文件尚未下载完成。</Notice>;
  const retry = () => setAttempt((value) => value + 1);
  return kind === "audio"
    ? <AudioPlayer key={`${uri}:${attempt}`} uri={uri} name={name} onRetry={retry} />
    : <VideoPlayer key={`${uri}:${attempt}`} uri={uri} name={name} onRetry={retry} />;
}

function usePauseInBackground(player: { pause(): void }) {
  const active = useRef(true);
  useEffect(() => {
    active.current = AppState.currentState !== "background" && AppState.currentState !== "inactive";
    const subscription = AppState.addEventListener("change", (state) => {
      active.current = state === "active";
      if (!active.current) player.pause();
    });
    return () => { active.current = false; subscription.remove(); };
  }, [player]);
  return active;
}

function AudioPlayer({ uri, name, onRetry }: Omit<Props, "kind"> & { onRetry(): void }) {
  const { colors, styles } = useTheme();
  const player = useAudioPlayer(uri, { updateInterval: 250, allowsExternalPlayback: false });
  const status = useAudioPlayerStatus(player);
  const active = usePauseInBackground(player);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  const failed = error || Boolean(status.error);
  const loading = !failed && (!status.isLoaded || status.isBuffering);

  async function play(restart = false) {
    if (status.playing && !restart) { player.pause(); return; }
    setPending(true);
    try {
      await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false, interruptionMode: "doNotMix" });
      if (!active.current) return;
      if (restart || status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration)) await player.seekTo(0);
      if (active.current) player.play();
    } catch {
      if (active.current) setError(true);
    } finally {
      setPending(false);
    }
  }

  const progress = status.duration > 0 ? Math.max(0, Math.min(1, status.currentTime / status.duration)) : 0;
  return <View style={[media.audio, { backgroundColor: colors.field }]}>
    <Text style={styles.heading} numberOfLines={2}>{name}</Text>
    <View accessibilityRole="progressbar" accessibilityLabel="播放进度"
      accessibilityValue={{ min: 0, max: status.duration || 0, now: status.currentTime || 0 }}
      style={[media.track, { backgroundColor: colors.secondary }]}>
      <View style={[media.progress, { width: `${progress * 100}%`, backgroundColor: colors.accent }]} />
    </View>
    <View style={media.time}><Text style={[styles.caption, media.timestamp]}>{formatTime(status.currentTime)}</Text><Text style={[styles.caption, media.timestamp]}>{formatTime(status.duration)}</Text></View>
    {loading && <View style={styles.row}><ActivityIndicator color={colors.accent} /><Text style={styles.muted}>正在加载音频…</Text></View>}
    {failed ? <><Notice>无法播放此音频，请重试。</Notice><Action title="重试" onPress={onRetry} /></> :
      <View style={styles.row}>
        <Action title={status.playing ? "暂停" : "播放"} primary disabled={!status.isLoaded || pending} onPress={() => play()} />
        <Action title="从头播放" disabled={!status.isLoaded || pending} onPress={() => play(true)} />
      </View>}
  </View>;
}

function VideoPlayer({ uri, name, onRetry }: Omit<Props, "kind"> & { onRetry(): void }) {
  const { colors, styles } = useTheme();
  const player = useVideoPlayer(uri, (video) => {
    video.staysActiveInBackground = false;
    video.allowsExternalPlayback = false;
    video.audioMixingMode = "doNotMix";
  });
  const { status } = useEvent(player, "statusChange", { status: player.status });
  usePauseInBackground(player);
  return <View style={media.videoContainer}>
    <VideoView player={player} accessibilityLabel={name} style={media.video} nativeControls contentFit="contain"
      fullscreenOptions={{ enable: true }} allowsPictureInPicture={false} />
    {(status === "idle" || status === "loading") && <View style={styles.row}><ActivityIndicator color={colors.accent} /><Text style={styles.muted}>正在加载视频…</Text></View>}
    {status === "error" && <><Notice>无法播放此视频，请重试。</Notice><Action title="重试" onPress={onRetry} /></>}
  </View>;
}

function formatTime(value: number) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const media = StyleSheet.create({
  audio: { justifyContent: "center", borderRadius: 16, padding: 16, gap: 12 },
  track: { height: 4, borderRadius: 2, overflow: "hidden" },
  progress: { height: "100%" },
  time: { flexDirection: "row", justifyContent: "space-between" },
  timestamp: { fontVariant: ["tabular-nums"] },
  videoContainer: { gap: 12 },
  video: { width: "100%", aspectRatio: 16 / 9, minHeight: 180, borderRadius: 16, overflow: "hidden", backgroundColor: "black" },
});
