import { useEffect, useRef, useState } from "react";
import { Action, Notice } from "../ui/theme";

export function MediaPlayer({ uri, kind, name }: { uri: string; kind: "audio" | "video"; name: string }) {
  const player = useRef<HTMLMediaElement | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const media = player.current;
    const pause = () => { if (document.hidden) media?.pause(); };
    document.addEventListener("visibilitychange", pause);
    return () => { document.removeEventListener("visibilitychange", pause); media?.pause(); };
  }, [uri, kind]);
  if (!uri.startsWith("blob:")) return <Notice>媒体文件尚未下载完成。</Notice>;
  const props = {
    src: uri, controls: true, preload: "metadata", "aria-label": name,
    ref: (element: HTMLMediaElement | null) => { player.current = element; },
    onError: () => setError(true), onLoadStart: () => setError(false),
    style: { width: "100%", maxHeight: "100%" },
  };
  return <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 12, minHeight: 0 }}>
    {kind === "video" ? <video {...props} playsInline /> : <audio {...props} />}
    {error && <><Notice>无法播放此媒体，请重试。</Notice><Action title="重试" onPress={() => { setError(false); player.current?.load(); }} /></>}
  </div>;
}
