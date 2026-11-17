import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { randomUUID } from "expo-crypto";
import type { AttachmentUpload, Control, InboxItem, Message, MobileNotice, ModelRequest, ModelSelectionRequest, NativeCommandRequest, Profile, ProfilePreferencesUpdate, ReasoningEffort, ReasoningRequest, SessionStatus, Topic, TopicDetail } from "@hermes-mobile/protocol";
import type { Session } from "../auth/session";
import { openCache, type Cache } from "../db/cache";
import { selectProfile } from "../profiles/selection";
import { ApiError, request } from "./api";

interface Directory {
  profiles: Profile[];
  topics: Topic[];
  inbox: InboxItem[];
  connector_online?: boolean;
  reasoning_supported?: boolean;
  attachments_supported?: boolean;
  native_commands_supported?: boolean;
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

export function useWorkspace(session: Session, routedTopicId: string | null, localTopic: boolean, streamProfile?: { profileId?: string }) {
  const [cache, setCache] = useState<Cache>();
  const [directory, setDirectory] = useState(emptyDirectory);
  const [infiniteFlow, updateInfiniteFlow] = useState(false);
  const [preferencesSaving, setPreferencesSaving] = useState(false);
  const preferenceWrite = useRef(false);
  const streamLoads = useRef(new Map<string, Promise<string>>());
  const streamPreparations = useRef(new Map<string, Promise<void>>());
  const [streamTopics, setStreamTopics] = useState<Record<string, { id: string; profileId: string }>>({});
  const streamProfileId = infiniteFlow && streamProfile ? selectProfile(directory.profiles, streamProfile.profileId)?.profile_id : undefined;
  const selectedStreamProfile = useRef(streamProfileId);
  const streamTopic = !routedTopicId && streamProfileId ? streamTopics[streamProfileId] : undefined;
  const topicId = routedTopicId ?? streamTopic?.id ?? null;
  const visibleStream = useRef(streamTopic);
  const currentDirectory = useRef(directory);
  const [topicDetails, setTopicDetails] = useState<Record<string, TopicDetail>>({});
  const detail = topicId ? topicDetails[topicId] : undefined;
  const [activity, setActivity] = useState<{ topicId: string; streamingIds: string; value: SessionStatus["activity"] }>();
  const [pending, setPending] = useState<Pending[]>([]);
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  const [network, setNetwork] = useState<"connecting" | "online" | "offline">("connecting");
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string>();
  const [storageError, setStorageError] = useState<string>();
  const [streamStorageError, setStreamStorageError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const hasRemoteTopic = !(localTopic || streamTopic) || detail?.topic.topic_id === topicId
    || directory.topics.some((topic) => topic.topic_id === topicId);
  const remoteId = hasRemoteTopic ? topicId : null;
  const streamingIds = detail?.topic.topic_id === topicId
    ? detail.messages.filter((message) => message.status === "streaming").map((message) => message.message_id).join(",") : "";
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
      const [ended, savedPending, savedInfiniteFlow] = await Promise.all([
        db.get<boolean>("session-ended"),
        db.list<Pending>("pending:"),
        db.get<boolean>("infinite-flow"),
      ]);
      if (ended) {
        revoked.current = true;
      } else {
        const savedDirectory = await db.get<Directory>("directory");
        if (!cancelled && savedDirectory) setDirectory(savedDirectory);
      }
      if (cancelled) return;
      setSessionEnded(Boolean(ended));
      updateInfiniteFlow(savedInfiniteFlow === true);
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

  useEffect(() => { currentDirectory.current = directory; }, [directory]);
  useEffect(() => { visibleStream.current = streamTopic; }, [streamTopic]);
  useEffect(() => { selectedStreamProfile.current = streamProfileId; }, [streamProfileId]);

  const storedTopic = directory.topics.find((topic) => topic.topic_id === streamTopic?.id);
  const invalidStream = !!storedTopic && (storedTopic.archived || storedTopic.profile_id !== streamTopic?.profileId);
  const restoreStream = useCallback(() => {
    const profileId = selectedStreamProfile.current;
    if (!cache || !profileId || !active.current || revoked.current || signingOut.current) return Promise.resolve(undefined);
    let task = streamLoads.current.get(profileId);
    if (!task) {
      task = (async () => {
        const key = `infinite-topic:${profileId}`;
        let id = await cache.get<string>(key);
        const topic = currentDirectory.current.topics.find((item) => item.topic_id === id);
        if (typeof id !== "string" || !id || topic?.archived || (topic && topic.profile_id !== profileId)) {
          if (!active.current || revoked.current || signingOut.current) throw new Error("设备会话已结束。");
          id = randomUUID();
          await cache.set(key, id);
        }
        return id;
      })().finally(() => { streamLoads.current.delete(profileId); });
      streamLoads.current.set(profileId, task);
    }
    return task.then((id) => {
      if (!active.current || revoked.current || selectedStreamProfile.current !== profileId) return;
      setStreamStorageError(undefined);
      setStreamTopics((current) => current[profileId]?.id === id ? current : { ...current, [profileId]: { id, profileId } });
      return { id, profileId };
    }).catch((failure: unknown) => {
      if (active.current && selectedStreamProfile.current === profileId) {
        syncNeedsRetry.current = true;
        setStreamStorageError(failure instanceof Error ? failure.message : "无法保存持续会话。");
      }
    });
  }, [cache]);

  useEffect(() => {
    if (!sessionEnded) void restoreStream();
  }, [invalidStream, restoreStream, sessionEnded, streamProfileId]);

  useEffect(() => {
    if (!cache || !streamProfileId || sessionEnded) return;
    let cancelled = false;
    const index = directory.profiles.findIndex((profile) => profile.profile_id === streamProfileId);
    const adjacent = directory.profiles.filter((_, i) => Math.abs(i - index) === 1);
    void Promise.all(adjacent.map(async ({ profile_id: profileId }) => {
      const id = await cache.get<string>(`infinite-topic:${profileId}`);
      if (typeof id !== "string" || !id) return;
      const saved = await cache.get<TopicDetail>(topicKey(id));
      const topic = directory.topics.find((item) => item.topic_id === id) ?? saved?.topic;
      if (cancelled || !active.current || revoked.current) return;
      if (topic?.archived || (topic && topic.profile_id !== profileId) || (saved && saved.topic.profile_id !== profileId)) {
        setStreamTopics((current) => {
          if (!current[profileId]) return current;
          const next = { ...current };
          delete next[profileId];
          return next;
        });
        return;
      }
      setStreamTopics((current) => current[profileId]?.id === id ? current : { ...current, [profileId]: { id, profileId } });
      if (saved) setTopicDetails((current) => current[id] ? current : { ...current, [id]: saved });
    })).catch(() => { /* 相邻页预读失败不阻塞当前会话，选中后走正常恢复。 */ });
    return () => { cancelled = true; };
  }, [cache, directory.profiles, directory.topics, sessionEnded, streamProfileId]);

  async function setInfiniteFlow(enabled: boolean) {
    if (!cache || revoked.current || signingOut.current) throw new Error("无法访问本地设置。");
    if (preferenceWrite.current) return;
    preferenceWrite.current = true;
    setPreferencesSaving(true);
    try {
      await cache.set("infinite-flow", enabled);
      if (active.current && !revoked.current) updateInfiniteFlow(enabled);
    } finally {
      preferenceWrite.current = false;
      if (active.current) setPreferencesSaving(false);
    }
  }

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

  useEffect(() => {
    if (!cache || !foreground || !remoteId || sessionEnded || network === "offline" || !directory.connector_online) {
      setActivity(undefined);
      return;
    }
    const abort = new AbortController();
    const id = remoteId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const status = await call<SessionStatus>(`/topics/${id}/status`, { signal: abort.signal });
        if (!abort.signal.aborted) setActivity({ topicId: id, streamingIds, value: status.activity });
      } catch {
        // 查询失败不等于任务完成，保留本次前台会话最后确认的状态。
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(poll, 3000);
      }
    }
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [cache, call, directory.connector_online, foreground, network, remoteId, sessionEnded, streamingIds]);

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
          call<Pick<Directory, "connector_online" | "reasoning_supported" | "attachments_supported" | "native_commands_supported">>("/status"),
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

  async function saveProfilePreferences(id: string, update: ProfilePreferencesUpdate) {
    if (!cache || revoked.current || signingOut.current) throw new Error("无法访问本地历史记录。");
    const profiles = await call<Profile[]>(`/profiles/${id}/preferences`, { method: "PUT", body: update });
    await directoryLoad.current;
    if (!active.current || revoked.current) return;
    setDirectory((current) => ({ ...current, profiles }));
    const save = (async () => {
      try {
        const saved = await cache.get<Directory>("directory") ?? directory;
        if (active.current && !revoked.current) await cache.set("directory", { ...saved, profiles });
      } catch (failure) {
        if (active.current) setStorageError(failure instanceof Error ? failure.message : "无法保存本地配置档案。");
      } finally {
        directoryLoad.current = undefined;
      }
    })();
    directoryLoad.current = save;
    await save;
    // 保存期间其他设备或插件可能已更新资料，再读取一次服务端的最新目录。
    await loadDirectory();
  }

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
          setTopicDetails((current) => ({ ...current, [id]: next }));
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
          setTopicDetails((current) => { const next = { ...current }; delete next[id]; return next; });
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

  const prepareTopic = useCallback(async (id: string, profileId: string, signal?: AbortSignal) => {
    let topic = await createTopic(id, profileId, signal);
    for (let tries = 0; topic.status === "creating" && tries < 20; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      signal?.throwIfAborted();
      topic = (await call<TopicDetail>(`/topics/${id}`, { signal })).topic;
    }
    await loadTopic(id);
    if (topic.status !== "ready") throw new Error(topic.error ?? "Hermes 会话尚未就绪，请稍后重试。");
  }, [call, createTopic, loadTopic]);

  const prepareStream = useCallback(async () => {
    const stream = await restoreStream();
    if (!cache || !stream || !active.current || revoked.current || signingOut.current) return Promise.resolve();
    const existing = streamPreparations.current.get(stream.id);
    if (existing) return existing;
    const task = (async () => {
      const saved = await cache.get<TopicDetail>(topicKey(stream.id));
      if (!active.current || revoked.current || signingOut.current || saved?.topic.status === "ready") return;
      await prepareTopic(stream.id, stream.profileId);
    })().catch((failure: unknown) => {
      if (active.current && !revoked.current && visibleStream.current?.id === stream.id) {
        syncNeedsRetry.current = true;
        setError(failure instanceof Error ? failure.message : "无法创建持续会话，请下拉重试。");
      }
    }).finally(() => { streamPreparations.current.delete(stream.id); });
    streamPreparations.current.set(stream.id, task);
    return task;
  }, [cache, prepareTopic, restoreStream]);

  useEffect(() => {
    visibleTopic.current = topicId;
    remoteTopic.current = remoteId;
    setError(undefined);
    if (!cache || !topicId || sessionEnded) return;
    let cancelled = false;
    void (async () => {
      try {
        const saved = await cache.get<TopicDetail>(topicKey(topicId));
        if (!cancelled && saved) setTopicDetails((current) => current[topicId] ? current : { ...current, [topicId]: saved });
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "无法读取本地历史记录。");
      }
      if (!cancelled && foreground && remoteId) await loadTopic(remoteId);
    })();
    return () => { cancelled = true; };
  }, [cache, foreground, loadTopic, remoteId, sessionEnded, topicId]);

  useEffect(() => {
    if (foreground && !sessionEnded && network === "online" && directory.connector_online) void prepareStream();
  }, [directory.connector_online, foreground, network, prepareStream, sessionEnded, streamTopic?.id]);

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
    await prepareStream();
    await flush();
  }, [flush, loadDirectory, loadTopic, prepareStream]);

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
      void (outboxLoad.current ?? Promise.resolve()).then(flush);
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
    if (signingOut.current || enqueueWrites.current || preferenceWrite.current || streamLoads.current.size) throw new Error("正在保存消息或设置，请稍后重试。");
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

  async function waitForRequest<T extends Exclude<ModelRequest | ReasoningRequest | NativeCommandRequest, { status: "pending" }>>(
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
    infiniteFlow,
    preferencesSaving,
    setInfiniteFlow,
    streamTopic,
    streamTopics,
    topicDetails,
    detail: detail?.topic.topic_id === topicId ? detail : undefined,
    activity: foreground && activity?.topicId === topicId && (!streamingIds || activity.streamingIds === streamingIds)
      ? activity.value : undefined,
    pending,
    network,
    live,
    error,
    storageError: storageError ?? streamStorageError,
    refreshing,
    ready: Boolean(cache),
    refresh,
    syncWorkspace,
    call,
    setTopicArchived,
    saveProfilePreferences,
    prepareTopic,
    enqueue,
    discard,
    sessionEnded,
    finishSession,
    answer,
    requestModel: (id: string, requestId: string, selection: ModelSelectionRequest | undefined, signal: AbortSignal) =>
      waitForRequest<Exclude<ModelRequest, { status: "pending" }>>(`/topics/${id}/model-requests`, requestId, selection, signal),
    requestNativeCommand: async (id: string, requestId: string, command: string, signal: AbortSignal, approval?: "once" | "always") => {
      const result = await waitForRequest<Exclude<NativeCommandRequest, { status: "pending" }>>(
        `/topics/${id}/command-requests`, requestId, { command, ...(approval && { approval }) }, signal,
      );
      if (result.status === "ok" && result.native_result.confirmation === undefined) {
        await Promise.all([directoryLoad.current, detailLoads.current.get(id)]);
        await Promise.all([loadDirectory(), loadTopic(id)]);
      }
      return result;
    },
    requestReasoning,
  };
}
