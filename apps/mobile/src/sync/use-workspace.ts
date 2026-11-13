import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { Control, InboxItem, Message, MobileNotice, ModelRequest, ModelSelection, Profile, Topic, TopicDetail } from "@hermes-mobile/protocol";
import type { Session } from "../auth/session";
import { openCache, type Cache } from "../db/cache";
import { ApiError, request } from "./api";

interface Directory {
  profiles: Profile[];
  topics: Topic[];
  inbox: InboxItem[];
  connector_online?: boolean;
}

export interface Pending {
  submission_id: string;
  topic_id: string;
  text: string;
  created_at: number;
  error?: string;
}

const emptyDirectory: Directory = { profiles: [], topics: [], inbox: [] };
const topicKey = (id: string) => `topic:${id}`;
const pendingKey = (id: string) => `pending:${id}`;
const revokeError = (error: unknown) => error instanceof ApiError && error.status === 401;

export function useWorkspace(session: Session, topicId: string | null) {
  const [cache, setCache] = useState<Cache>();
  const [directory, setDirectory] = useState(emptyDirectory);
  const [detail, setDetail] = useState<TopicDetail>();
  const [pending, setPending] = useState<Pending[]>([]);
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  const [network, setNetwork] = useState<"connecting" | "online" | "offline">("connecting");
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string>();
  const [storageError, setStorageError] = useState<string>();
  const [syncing, setSyncing] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const active = useRef(true);
  const visibleTopic = useRef(topicId);
  const directoryLoad = useRef<Promise<void>>(undefined);
  const detailLoads = useRef(new Map<string, Promise<TopicDetail | undefined>>());
  const outboxLoad = useRef<Promise<void>>(undefined);
  const revoked = useRef(false);
  const signingOut = useRef(false);
  const enqueueWrites = useRef(0);

  useEffect(() => {
    active.current = true;
    let cancelled = false;
    let db: Cache | undefined;
    void openCache(session).then(async (opened) => {
      db = opened;
      if (cancelled) {
        await db.close();
        return;
      }
      const [ended, savedPending] = await Promise.all([
        db.get<boolean>("session-ended"),
        db.list<Pending>("pending:"),
      ]);
      if (ended) {
        revoked.current = true;
      } else {
        const savedDirectory = await db.get<Directory>("directory");
        if (!cancelled && savedDirectory) setDirectory(savedDirectory);
      }
      if (cancelled) return;
      setSessionEnded(Boolean(ended));
      setPending(savedPending);
      setCache(db);
    }).catch((failure: unknown) => {
      if (!cancelled) setStorageError(failure instanceof Error ? failure.message : "Local history is unavailable.");
    });
    return () => {
      cancelled = true;
      active.current = false;
      if (db) void db.close().catch(() => {});
    };
  }, [session]);

  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => listener.remove();
  }, []);

  const endSession = useCallback(async () => {
    revoked.current = true;
    setSessionEnded(true);
    await cache?.set("session-ended", true).catch((failure: unknown) => {
      if (active.current) setStorageError(failure instanceof Error ? failure.message : "The local session state could not be saved.");
    });
  }, [cache]);

  const call = useCallback(async <T,>(
    path: string, options: { method?: "GET" | "POST" | "DELETE"; body?: object; signal?: AbortSignal } = {},
  ) => {
    if (revoked.current) throw new Error("This device session has ended.");
    try {
      return await request<T>(session.origin, path, { token: session.token, ...options });
    } catch (error) {
      if (revokeError(error) && active.current && !revoked.current) {
        await endSession();
      }
      throw error;
    }
  }, [endSession, session]);

  const loadDirectory = useCallback(() => {
    if (!cache || !active.current || revoked.current) return Promise.resolve();
    if (directoryLoad.current) return directoryLoad.current;
    const task = (async () => {
      try {
        const [profiles, topics, inbox, status] = await Promise.all([
          call<Profile[]>("/profiles"),
          call<Topic[]>("/topics"),
          call<InboxItem[]>("/inbox"),
          call<{ connector_online: boolean }>("/status"),
        ]);
        if (!active.current || revoked.current) return;
        const next = { profiles, topics, inbox, ...status };
        await cache.set("directory", next);
        if (!active.current || revoked.current) return;
        setNetwork("online");
        setDirectory(next);
      } catch (failure) {
        if (!active.current || revoked.current) return;
        if (!(failure instanceof ApiError)) setNetwork("offline");
        setError(failure instanceof Error ? failure.message : "Could not refresh the workspace.");
      } finally {
        directoryLoad.current = undefined;
      }
    })();
    directoryLoad.current = task;
    return task;
  }, [cache, call]);

  const loadTopic = useCallback((id: string) => {
    if (!cache || !active.current || revoked.current) return Promise.resolve(undefined);
    const existing = detailLoads.current.get(id);
    if (existing) return existing;
    const task = (async () => {
      try {
        const next = await call<TopicDetail>(`/topics/${id}`);
        if (!active.current || revoked.current) return;
        await cache.set(topicKey(id), next);
        if (active.current && !revoked.current && visibleTopic.current === id) setDetail(next);
        return next;
      } catch (failure) {
        if (!active.current || revoked.current) return;
        if (failure instanceof ApiError && failure.status === 404) {
          if (visibleTopic.current === id) setDetail(undefined);
          await cache.remove(topicKey(id)).catch(() => {});
        }
        if (visibleTopic.current === id) {
          setError(failure instanceof Error ? failure.message : "Could not refresh the topic.");
        }
      } finally {
        detailLoads.current.delete(id);
      }
    })();
    detailLoads.current.set(id, task);
    return task;
  }, [cache, call]);

  useEffect(() => {
    visibleTopic.current = topicId;
    setError(undefined);
    if (!cache || !topicId || sessionEnded) return;
    let cancelled = false;
    void (async () => {
      try {
        const saved = await cache.get<TopicDetail>(topicKey(topicId));
        if (!cancelled && saved) setDetail((current) => current?.topic.topic_id === topicId ? current : saved);
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "Local history could not be read.");
      }
      if (!cancelled && foreground) await loadTopic(topicId);
    })();
    return () => { cancelled = true; };
  }, [cache, foreground, loadTopic, sessionEnded, topicId]);

  const flush = useCallback(() => {
    if (!cache || !foreground || !active.current || revoked.current) return Promise.resolve();
    if (outboxLoad.current) return outboxLoad.current;
    const task = (async () => {
      try {
        const entries = await cache.list<Pending>("pending:");
        entries.sort((a, b) => a.created_at - b.created_at);
        for (const item of entries) {
          if (!active.current || revoked.current) return;
          if (item.error) continue;
          try {
            await call<Message>(`/topics/${item.topic_id}/submissions`, {
              method: "POST", body: { submission_id: item.submission_id, text: item.text },
            });
          } catch (failure) {
            if (revoked.current) return;
            if (!(failure instanceof ApiError) || failure.retryable || failure.status === 429 || failure.code === "TOPIC_NOT_READY") break;
            await cache.set(pendingKey(item.submission_id), { ...item, error: failure.message });
            continue;
          }
          // Keep the queued bubble until the server's accepted copy can be written locally.
          await detailLoads.current.get(item.topic_id);
          const next = await loadTopic(item.topic_id);
          if (!active.current || revoked.current) return;
          if (!next?.messages.some((message) => message.submission_id === item.submission_id)) break;
          await cache.remove(pendingKey(item.submission_id));
        }
      } catch (failure) {
        if (active.current && !revoked.current) {
          setError(failure instanceof Error ? failure.message : "Could not update the outbox.");
        }
      } finally {
        try {
          if (active.current && !revoked.current) setPending(await cache.list<Pending>("pending:"));
        } catch (failure) {
          if (active.current) setStorageError(failure instanceof Error ? failure.message : "The local outbox is unavailable.");
        }
        outboxLoad.current = undefined;
      }
    })();
    outboxLoad.current = task;
    return task;
  }, [cache, call, foreground, loadTopic]);

  const refresh = useCallback(async () => {
    setSyncing(true);
    setError(undefined);
    try {
      const id = visibleTopic.current;
      await Promise.all([loadDirectory(), id ? loadTopic(id) : undefined]);
      await flush();
    } finally {
      if (active.current) setSyncing(false);
    }
  }, [flush, loadDirectory, loadTopic]);

  useEffect(() => {
    if (!cache || !foreground || sessionEnded) return;
    let closed = false;
    let socket: WebSocket | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let notice: ReturnType<typeof setTimeout> | undefined;
    let retry = 1000;
    let updateDirectory = false;
    const affected = new Set<string>();
    const abort = new AbortController();

    function schedule(topic?: string) {
      if (topic) affected.add(topic);
      else updateDirectory = true;
      if (notice) return;
      notice = setTimeout(() => {
        notice = undefined;
        const id = visibleTopic.current;
        if (updateDirectory || !id || [...affected].some((topic) => topic !== id)) void loadDirectory();
        if (id && (updateDirectory || affected.has(id))) {
          const existing = detailLoads.current.get(id);
          if (existing) void existing.then(() => { if (!closed) schedule(id); });
          else void loadTopic(id);
        }
        updateDirectory = false;
        affected.clear();
        void flush();
      }, 200);
    }

    function backoff() {
      if (closed || revoked.current || reconnect) return;
      setLive(false);
      reconnect = setTimeout(() => {
        reconnect = undefined;
        void connect();
      }, retry);
      retry = Math.min(retry * 2, 15_000);
    }

    async function connect() {
      try {
        const { ticket } = await call<{ ticket: string }>("/ws-tickets", { method: "POST", signal: abort.signal });
        if (closed) return;
        const url = new URL("/mobile/v1/events", session.origin);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("ticket", ticket);
        socket = new WebSocket(url.toString());
        socket.onopen = () => {
          if (closed) return;
          retry = 1000;
          setLive(true);
          void refresh();
        };
        socket.onmessage = (event) => {
          if (closed || typeof event.data !== "string") return;
          try {
            const value = JSON.parse(event.data) as MobileNotice | null;
            if (value?.type === "changed") schedule(typeof value.topic_id === "string" ? value.topic_id : undefined);
          } catch {
            // The periodic HTTP refresh repairs dropped or unsupported notices.
          }
        };
        socket.onerror = () => socket?.close();
        socket.onclose = backoff;
      } catch {
        backoff();
      }
    }

    void refresh();
    void connect();
    const poll = setInterval(() => void refresh(), 15_000);
    return () => {
      closed = true;
      setLive(false);
      abort.abort();
      clearInterval(poll);
      clearTimeout(reconnect);
      clearTimeout(notice);
      socket?.close();
    };
  }, [cache, call, flush, foreground, loadDirectory, loadTopic, refresh, session.origin, sessionEnded]);

  async function enqueue(item: Pending) {
    if (!cache || revoked.current || signingOut.current) throw new Error("Local history is unavailable.");
    enqueueWrites.current += 1;
    try {
      await cache.set(pendingKey(item.submission_id), item);
      setPending((current) => [...current.filter((row) => row.submission_id !== item.submission_id), item]);
      void flush();
    } finally {
      enqueueWrites.current -= 1;
    }
  }

  async function discard(item: Pending) {
    if (!cache || !item.error) return;
    await cache.remove(pendingKey(item.submission_id));
    setPending((current) => current.filter((row) => row.submission_id !== item.submission_id));
  }

  async function finishSession(onSignOut: () => Promise<void>, discardIds: readonly string[] = []) {
    if (!cache) throw new Error("The local outbox must be available before signing out.");
    if (signingOut.current || enqueueWrites.current) throw new Error("A message is being saved. Try again shortly.");
    signingOut.current = true;
    try {
      const savedPending = await cache.list<Pending>("pending:");
      if (savedPending.some((item) => !revoked.current || !discardIds.includes(item.submission_id))) {
        setPending(savedPending);
        throw new Error(revoked.current ? "Review the pending messages before pairing again." : "Resolve your pending messages before signing out.");
      }
      if (!revoked.current) {
        try {
          await request<void>(session.origin, "/auth/session", { method: "DELETE", token: session.token });
        } catch (failure) {
          if (!revokeError(failure)) throw failure;
        }
        await endSession();
      }
      await cache.clear();
      await onSignOut();
    } finally {
      signingOut.current = false;
    }
  }

  async function answer(control: Control, response_id: string, answer: string) {
    await call(`/controls/${control.control_id}/responses`, { method: "POST", body: { response_id, answer } });
    const id = visibleTopic.current;
    if (id) await loadTopic(id);
  }

  async function requestModel(id: string, requestId: string, selection: ModelSelection & { confirm?: string } | undefined, signal: AbortSignal) {
    const path = `/topics/${id}/model-requests`;
    await call<ModelRequest>(path, { method: "POST", body: { request_id: requestId, ...selection }, signal });
    for (let tries = 0; tries < 50; tries += 1) {
      signal.throwIfAborted();
      const result = await call<ModelRequest>(`${path}/${requestId}`, { signal });
      if (result.status !== "pending") return result;
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
    throw new Error("Hermes has not confirmed the request yet. Try again to check its status.");
  }

  return {
    ...directory,
    detail: detail?.topic.topic_id === topicId ? detail : undefined,
    pending,
    network,
    live,
    error,
    storageError,
    syncing,
    ready: Boolean(cache),
    refresh,
    call,
    enqueue,
    discard,
    sessionEnded,
    finishSession,
    answer,
    requestModel,
  };
}
