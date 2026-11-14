import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { AttachmentUpload, Control, InboxItem, Message, MobileNotice, ModelRequest, ModelSelection, Profile, ReasoningEffort, ReasoningRequest, Topic, TopicDetail } from "@hermes-mobile/protocol";
import type { Session } from "../auth/session";
import { openCache, type Cache } from "../db/cache";
import { ApiError, request } from "./api";

interface Directory {
  profiles: Profile[];
  topics: Topic[];
  inbox: InboxItem[];
  connector_online?: boolean;
  reasoning_supported?: boolean;
  attachments_supported?: boolean;
}

export interface Pending {
  submission_id: string;
  topic_id: string;
  profile_id?: string;
  text: string;
  attachments?: AttachmentUpload[];
  created_at: number;
  error?: string;
}

const emptyDirectory: Directory = { profiles: [], topics: [], inbox: [] };
const topicKey = (id: string) => `topic:${id}`;
const pendingKey = (id: string) => `pending:${id}`;
const revokeError = (error: unknown) => error instanceof ApiError && error.status === 401;
const isPermanentApiFailure = (error: unknown): error is ApiError =>
  error instanceof ApiError && !error.retryable && error.status !== 429;

export function useWorkspace(session: Session, topicId: string | null, localTopic: boolean) {
  const [cache, setCache] = useState<Cache>();
  const [directory, setDirectory] = useState(emptyDirectory);
  const [detail, setDetail] = useState<TopicDetail>();
  const [pending, setPending] = useState<Pending[]>([]);
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  const [network, setNetwork] = useState<"connecting" | "online" | "offline">("connecting");
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string>();
  const [storageError, setStorageError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const hasRemoteTopic = !localTopic || detail?.topic.topic_id === topicId
    || directory.topics.some((topic) => topic.topic_id === topicId);
  const remoteId = hasRemoteTopic ? topicId : null;
  const active = useRef(true);
  const visibleTopic = useRef(topicId);
  const remoteTopic = useRef(remoteId);
  const directoryLoad = useRef<Promise<void>>(undefined);
  const detailLoads = useRef(new Map<string, Promise<TopicDetail | undefined>>());
  const outboxLoad = useRef<Promise<void>>(undefined);
  const manualRefresh = useRef<Promise<void>>(undefined);
  const outboxNeedsRetry = useRef(false);
  const syncNeedsRetry = useRef(false);
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
      if (!cancelled) setStorageError(failure instanceof Error ? failure.message : "无法访问本地历史记录。");
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
      if (active.current) setStorageError(failure instanceof Error ? failure.message : "无法保存本地会话状态。");
    });
  }, [cache]);

  const call = useCallback(async <T,>(
    path: string, options: Omit<NonNullable<Parameters<typeof request>[2]>, "token"> = {},
  ) => {
    if (revoked.current) throw new Error("此设备的会话已结束。");
    try {
      return await request<T>(session.origin, path, { token: session.token, ...options });
    } catch (error) {
      if (revokeError(error) && active.current && !revoked.current) {
        await endSession();
      }
      throw error;
    }
  }, [endSession, session]);

  const createTopic = useCallback((id: string, profileId: string, signal?: AbortSignal) => call<Topic>("/topics", {
    method: "POST", body: { request_id: id, profile_id: profileId }, signal,
  }), [call]);

  const loadDirectory = useCallback(() => {
    if (!cache || !active.current || revoked.current) return Promise.resolve();
    if (directoryLoad.current) return directoryLoad.current;
    const task = (async () => {
      try {
        const [profiles, topics, inbox, status] = await Promise.all([
          call<Profile[]>("/profiles"),
          call<Topic[]>("/topics?include_archived=true"),
          call<InboxItem[]>("/inbox"),
          call<Pick<Directory, "connector_online" | "reasoning_supported" | "attachments_supported">>("/status"),
        ]);
        if (!active.current || revoked.current) return;
        const next = { profiles, topics, inbox, ...status };
        await cache.set("directory", next);
        if (!active.current || revoked.current) return;
        setNetwork("online");
        setDirectory(next);
      } catch (failure) {
        if (!active.current || revoked.current) return;
        if (!isPermanentApiFailure(failure)) syncNeedsRetry.current = true;
        if (!(failure instanceof ApiError)) setNetwork("offline");
        setError(failure instanceof Error ? failure.message : "无法刷新工作区。");
      } finally {
        directoryLoad.current = undefined;
      }
    })();
    directoryLoad.current = task;
    return task;
  }, [cache, call]);

  async function setTopicArchived(id: string, archived: boolean, newProfileId?: string) {
    if (!cache || revoked.current || signingOut.current) throw new Error("无法访问本地历史记录。");
    if (newProfileId && !directory.topics.some((topic) => topic.topic_id === id)) await createTopic(id, newProfileId);
    const next = await call<Topic>(`/topics/${id}/archive`, { method: "PUT", body: { archived } });
    await directoryLoad.current;
    if (!active.current || revoked.current) return;
    const applyArchive = (current: Directory): Directory => ({
      ...current,
      topics: current.topics.some((topic) => topic.topic_id === id)
        ? current.topics.map((topic) => topic.topic_id === id ? { ...topic, archived: next.archived } : topic)
        : [...current.topics, next],
    });
    // 与目录拉取共用写入顺序，确保已确认的归档状态可离线读取。
    const save = (async () => {
      try {
        const saved = await cache.get<Directory>("directory") ?? directory;
        if (active.current && !revoked.current) await cache.set("directory", applyArchive(saved));
      } catch (failure) {
        if (active.current) setStorageError(failure instanceof Error ? failure.message : "无法保存本地归档状态。");
      } finally {
        directoryLoad.current = undefined;
      }
    })();
    directoryLoad.current = save;
    await save;
    if (active.current && !revoked.current) {
      setDirectory(applyArchive);
      void loadDirectory();
    }
  }

  const loadTopic = useCallback((id: string) => {
    if (!cache || !active.current || revoked.current) return Promise.resolve(undefined);
    const existing = detailLoads.current.get(id);
    if (existing) return existing;
    const task = (async () => {
      try {
        const next = await call<TopicDetail>(`/topics/${id}`);
        if (!active.current || revoked.current) return;
        await cache.set(topicKey(id), next);
        if (active.current && !revoked.current) {
          if (visibleTopic.current === id) setDetail(next);
          setDirectory((current) => {
            const topic = current.topics.find((topic) => topic.topic_id === id);
            const updated = next.topic;
            if (!topic || (topic.updated_at && updated.updated_at && topic.updated_at > updated.updated_at)
              || (topic.title === updated.title && topic.status === updated.status && topic.updated_at === updated.updated_at)) return current;
            return { ...current, topics: current.topics.map((entry) => entry.topic_id === id ? { ...updated, archived: topic.archived } : entry) };
          });
        }
        return next;
      } catch (failure) {
        if (!active.current || revoked.current) return;
        if (failure instanceof ApiError && failure.status === 404) {
          if (visibleTopic.current === id) setDetail(undefined);
          await cache.remove(topicKey(id)).catch(() => {});
        }
        if (visibleTopic.current === id) {
          if (!isPermanentApiFailure(failure)) syncNeedsRetry.current = true;
          setError(failure instanceof Error ? failure.message : "无法刷新话题。");
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
    remoteTopic.current = remoteId;
    setError(undefined);
    if (!cache || !topicId || sessionEnded) return;
    let cancelled = false;
    void (async () => {
      try {
        const saved = await cache.get<TopicDetail>(topicKey(topicId));
        if (!cancelled && saved) setDetail((current) => current?.topic.topic_id === topicId ? current : saved);
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "无法读取本地历史记录。");
      }
      if (!cancelled && foreground && remoteId) await loadTopic(remoteId);
    })();
    return () => { cancelled = true; };
  }, [cache, foreground, loadTopic, remoteId, sessionEnded, topicId]);

  const flush = useCallback(() => {
    if (!cache || !foreground || !active.current || revoked.current) return Promise.resolve();
    if (outboxLoad.current) return outboxLoad.current;
    const task = (async () => {
      try {
        const entries = await cache.list<Pending>("pending:");
        entries.sort((a, b) => a.created_at - b.created_at);
        const waiting = new Set<string>();
        for (const item of entries) {
          if (!active.current || revoked.current) return;
          if (item.error || waiting.has(item.topic_id)) continue;
          try {
            if (item.profile_id) {
              const saved = await cache.get<TopicDetail>(topicKey(item.topic_id));
              const topic = saved?.topic ?? await createTopic(item.topic_id, item.profile_id);
              if (topic.status === "error") {
                throw new ApiError(409, "TOPIC_CREATE_FAILED", topic.error ?? "Hermes 无法创建此会话。", false);
              }
            }
            await call<Message>(`/topics/${item.topic_id}/submissions`, {
              method: "POST", body: { submission_id: item.submission_id, text: item.text,
                ...(item.attachments?.length && { attachments: item.attachments }) },
              timeoutMs: item.attachments?.length ? 60_000 : undefined,
            });
          } catch (failure) {
            if (revoked.current) return;
            if (failure instanceof ApiError && failure.code === "TOPIC_NOT_READY") {
              waiting.add(item.topic_id);
              const next = await loadTopic(item.topic_id);
              if (next?.topic.status !== "error") continue;
              await cache.set(pendingKey(item.submission_id), { ...item, error: next.topic.error ?? "Hermes 无法创建此会话。" });
              continue;
            }
            if (!isPermanentApiFailure(failure)) break;
            await cache.set(pendingKey(item.submission_id), { ...item, error: failure.message });
            continue;
          }
          // 服务端接收的消息写入本地缓存后，再移除待发送气泡。
          await detailLoads.current.get(item.topic_id);
          const next = await loadTopic(item.topic_id);
          if (!active.current || revoked.current) return;
          if (!next?.messages.some((message) => message.submission_id === item.submission_id)) break;
          await cache.remove(pendingKey(item.submission_id));
        }
      } catch (failure) {
        if (active.current && !revoked.current) {
          setError(failure instanceof Error ? failure.message : "无法更新待发送的消息。");
        }
      } finally {
        try {
          if (active.current && !revoked.current) {
            outboxNeedsRetry.current = false;
            const saved = await cache.list<Pending>("pending:");
            outboxNeedsRetry.current ||= saved.some((item) => !item.error);
            setPending(saved);
          }
        } catch (failure) {
          if (active.current) {
            outboxNeedsRetry.current = true;
            setStorageError(failure instanceof Error ? failure.message : "无法访问本地待发送的消息。");
          }
        }
        outboxLoad.current = undefined;
      }
    })();
    outboxLoad.current = task;
    return task;
  }, [cache, call, createTopic, foreground, loadTopic]);

  const syncWorkspace = useCallback(async () => {
    syncNeedsRetry.current = false;
    setError(undefined);
    const id = remoteTopic.current;
    await Promise.all([loadDirectory(), id ? loadTopic(id) : undefined]);
    await flush();
  }, [flush, loadDirectory, loadTopic]);

  function refresh() {
    if (manualRefresh.current) return manualRefresh.current;
    setRefreshing(true);
    const task = syncWorkspace().finally(() => {
      manualRefresh.current = undefined;
      if (active.current) setRefreshing(false);
    });
    manualRefresh.current = task;
    return task;
  }

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
        const id = remoteTopic.current;
        if (updateDirectory || !id || [...affected].some((topic) => topic !== id)) {
          const existing = directoryLoad.current;
          if (existing) void existing.then(() => { if (!closed) schedule(); });
          else void loadDirectory();
        }
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
          void syncWorkspace();
        };
        socket.onmessage = (event) => {
          if (closed || typeof event.data !== "string") return;
          try {
            const value = JSON.parse(event.data) as MobileNotice | null;
            if (value?.type === "changed") schedule(typeof value.topic_id === "string" ? value.topic_id : undefined);
          } catch {
            syncNeedsRetry.current = true;
          }
        };
        socket.onerror = () => socket?.close();
        socket.onclose = backoff;
      } catch {
        backoff();
      }
    }

    void syncWorkspace();
    void connect();
    const poll = setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN || syncNeedsRetry.current) void syncWorkspace();
      else if (outboxNeedsRetry.current) void flush();
    }, 15_000);
    return () => {
      closed = true;
      setLive(false);
      abort.abort();
      clearInterval(poll);
      clearTimeout(reconnect);
      clearTimeout(notice);
      socket?.close();
    };
  }, [cache, call, flush, foreground, loadDirectory, loadTopic, session.origin, sessionEnded, syncWorkspace]);

  async function enqueue(item: Pending) {
    if (!cache || revoked.current || signingOut.current) throw new Error("无法访问本地历史记录。");
    enqueueWrites.current += 1;
    try {
      await cache.set(pendingKey(item.submission_id), item);
      setPending((current) => [...current.filter((row) => row.submission_id !== item.submission_id), item]);
      if (outboxLoad.current) outboxNeedsRetry.current = true;
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
    if (!cache) throw new Error("需要能够访问本地待发送的消息才能退出。");
    if (signingOut.current || enqueueWrites.current) throw new Error("正在保存消息，请稍后重试。");
    signingOut.current = true;
    try {
      const savedPending = await cache.list<Pending>("pending:");
      if (savedPending.some((item) => !revoked.current || !discardIds.includes(item.submission_id))) {
        setPending(savedPending);
        throw new Error(revoked.current ? "请先查看待发送的消息，再重新配对。" : "请先处理待发送的消息，再退出登录。");
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

  async function prepareTopic(id: string, profileId: string, signal?: AbortSignal) {
    let topic = await createTopic(id, profileId, signal);
    for (let tries = 0; topic.status === "creating" && tries < 20; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      signal?.throwIfAborted();
      topic = (await call<TopicDetail>(`/topics/${id}`, { signal })).topic;
    }
    void loadTopic(id);
    if (topic.status !== "ready") throw new Error(topic.error ?? "Hermes 会话尚未就绪，请稍后重试。");
  }

  async function waitForRequest<T extends Exclude<ModelRequest | ReasoningRequest, { status: "pending" }>>(
    path: string, requestId: string, input: object | undefined, signal: AbortSignal,
  ) {
    await call(path, { method: "POST", body: { request_id: requestId, ...input }, signal });
    for (let tries = 0; tries < 50; tries += 1) {
      signal.throwIfAborted();
      const result = await call<T | { status: "pending" }>(`${path}/${requestId}`, { signal });
      if (result.status !== "pending") return result;
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
    throw new Error("Hermes 尚未确认请求，请重试以查看状态。");
  }

  async function requestReasoning(id: string, requestId: string, effort: ReasoningEffort | null, signal: AbortSignal) {
    try {
      return await waitForRequest<Exclude<ReasoningRequest, { status: "pending" }>>(
        `/topics/${id}/reasoning-requests`, requestId, { effort }, signal,
      );
    } finally {
      await detailLoads.current.get(id);
      await loadTopic(id);
    }
  }

  return {
    ...directory,
    detail: detail?.topic.topic_id === topicId ? detail : undefined,
    pending,
    network,
    live,
    error,
    storageError,
    refreshing,
    ready: Boolean(cache),
    refresh,
    syncWorkspace,
    call,
    setTopicArchived,
    prepareTopic,
    enqueue,
    discard,
    sessionEnded,
    finishSession,
    answer,
    requestModel: (id: string, requestId: string, selection: ModelSelection & { confirm?: string } | undefined, signal: AbortSignal) =>
      waitForRequest<Exclude<ModelRequest, { status: "pending" }>>(`/topics/${id}/model-requests`, requestId, selection, signal),
    requestReasoning,
  };
}
