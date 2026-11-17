const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

const source = ts.transpileModule(readFileSync(require.resolve("../src/sync/use-workspace.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const topic = { topic_id: "topic", status: "ready", title: "报告", profile_id: "profile" };
const session = { origin: "https://app.example", token: "paired-device" };
class ApiError extends Error {
  constructor(status, code, message, retryable) {
    super(message);
    Object.assign(this, { status, code, retryable });
  }
}

function memoryCache() {
  const values = new Map();
  return {
    async get(key) { return structuredClone(values.get(key)); },
    async set(key, value) { values.set(key, structuredClone(value)); },
    async list(prefix) { return [...values].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value)); },
    async remove(key) { values.delete(key); },
    async clear() { values.clear(); },
    async close() {},
  };
}

async function workspace(cache, submit, messages = [], options = {}) {
  const values = [], effects = [], cleanup = [];
  const timers = new Map();
  let cursor = 0, dirty = false, current, selectedTopic = options.topicId === undefined ? "topic" : options.topicId,
    streamProfile = options.streamProfile, changeAppState, timerId = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const react = {
    useState(initial) {
      const slot = cursor++;
      if (!(slot in values)) values[slot] = initial;
      return [values[slot], (value) => {
        const next = typeof value === "function" ? value(values[slot]) : value;
        if (!Object.is(next, values[slot])) { values[slot] = next; dirty = true; }
      }];
    },
    useRef(value) { return values[cursor++] ??= { current: value }; },
    useCallback(callback, deps) {
      const slot = cursor++;
      if (!same(values[slot]?.deps, deps)) values[slot] = { deps, callback };
      return values[slot].callback;
    },
    useEffect(effect, deps) {
      const slot = cursor++;
      if (!same(values[slot], deps)) {
        values[slot] = deps;
        effects.push(() => { cleanup[slot]?.(); cleanup[slot] = effect(); });
      }
    },
  };
  const exports = {};
  const request = async (_origin, path, requestOptions = {}) => {
    if (path === "/profiles") return options.profiles ? options.profiles() : [];
    if (path === "/topics?include_archived=true") return options.topics ? options.topics() : [topic];
    if (path === "/inbox") return [];
    if (path === "/status") return { connector_online: true };
    if (path === "/ws-tickets") return { ticket: "live-ticket" };
    const status = path.match(/^\/topics\/([^/]+)\/status$/);
    if (status) return options.status ? options.status(status[1], requestOptions) : { activity: "idle" };
    if (path === `/topics/${selectedTopic}`) return { topic: { ...topic, topic_id: selectedTopic }, messages: structuredClone(messages), controls: [] };
    return submit(path, requestOptions);
  };
  // The live transport stays idle; explicit refresh exercises the real recovery path.
  class Socket { static OPEN = 1; readyState = 1; close() {} }
  new Function("exports", "require", "WebSocket", "setInterval", "clearInterval", "setTimeout", "clearTimeout", source)(
    exports, (name) => {
      if (name === "react") return react;
      if (name === "react-native") return { AppState: { currentState: "active",
        addEventListener: (_event, listener) => { changeAppState = listener; return { remove() {} }; } } };
      if (name === "../db/cache") return { openCache: async () => cache };
      if (name === "expo-crypto") return { randomUUID: require("node:crypto").randomUUID };
      if (name === "../profiles/selection") {
        const selection = {};
        new Function("exports", ts.transpileModule(readFileSync(require.resolve("../src/profiles/selection.ts"), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.CommonJS },
        }).outputText)(selection);
        return selection;
      }
      if (name === "./api") return { ApiError, request };
      throw new Error(`Unexpected dependency: ${name}`);
    }, Socket, () => 1, () => {}, (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; }, (id) => timers.delete(id),
  );
  const render = () => {
    dirty = false;
    cursor = 0;
    current = exports.useWorkspace(session, selectedTopic, false, streamProfile);
    effects.splice(0).forEach((effect) => effect());
  };
  const settle = async () => {
    for (let quiet = 0, turns = 0; quiet < 2 && turns < 20; turns++) {
      await new Promise(setImmediate);
      if (dirty) { render(); quiet = 0; } else quiet++;
    }
    assert.equal(dirty, false, "hook should settle");
  };
  render();
  await settle();
  return { get current() { return current; }, settle, close: () => cleanup.forEach((dispose) => dispose?.()),
    async pollStatus() {
      for (const [id, timer] of [...timers]) if (timer.ms === 3000) { timers.delete(id); timer.callback(); }
      await settle();
    },
    async selectTopic(id) { selectedTopic = id; render(); await settle(); },
    async selectStreamProfile(profileId) { streamProfile = { profileId }; render(); await settle(); },
    async appState(state) { changeAppState(state); await settle(); },
  };
}

const supplemental = { submission_id: "supplemental-id", topic_id: "topic", text: "加上预算", created_at: 1 };

function streamServer() {
  const topics = new Map(), creates = [];
  const profiles = [{ profile_id: "daily", label: "日常助手", is_default: true }, { profile_id: "research", label: "研究助手" }];
  return {
    topics, creates,
    options: { topicId: null, streamProfile: {}, profiles: () => profiles, topics: () => [...topics.values()] },
    async request(path, options) {
      if (path === "/topics" && options.method === "POST") {
        creates.push(options.body);
        const id = options.body.request_id;
        if (!topics.has(id)) topics.set(id, { topic_id: id, profile_id: options.body.profile_id, status: "ready", title: "新会话" });
        return topics.get(id);
      }
      const id = path.match(/^\/topics\/([^/]+)$/)?.[1];
      if (id && topics.has(id)) return { topic: topics.get(id), messages: [], controls: [] };
      const archivedId = path.match(/^\/topics\/([^/]+)\/archive$/)?.[1];
      if (archivedId && topics.has(archivedId)) {
        topics.get(archivedId).archived = options.body.archived;
        return topics.get(archivedId);
      }
      throw new Error(`Unexpected stream request: ${path}`);
    },
  };
}

test("无限会话流首次安装默认关闭，未开启不创建会话", async (t) => {
  const server = streamServer();
  const app = await workspace(memoryCache(), server.request, [], server.options);
  t.after(app.close);
  assert.equal(app.current.infiniteFlow, false);
  assert.equal(app.current.streamTopic, undefined);
  assert.equal(server.creates.length, 0);
});

test("无限会话流按 Profile 持久化复用，关闭再开启和重启不重复创建", async (t) => {
  const cache = memoryCache(), server = streamServer();
  const app = await workspace(cache, server.request, [], server.options);
  t.after(app.close);
  await app.current.setInfiniteFlow(true);
  await app.settle();
  const daily = app.current.streamTopic;
  assert.equal(daily.profileId, "daily");
  assert.equal(app.current.detail.topic.topic_id, daily.id);
  await app.selectStreamProfile("research");
  const research = app.current.streamTopic;
  assert.equal(research.profileId, "research");
  assert.notEqual(research.id, daily.id);
  assert.equal(app.current.detail.topic.topic_id, research.id);
  await app.selectStreamProfile("daily");
  assert.deepEqual(app.current.streamTopic, daily);
  await Promise.all([app.current.refresh(), app.current.refresh()]);
  await app.current.setInfiniteFlow(false);
  await app.settle();
  assert.equal(app.current.streamTopic, undefined);
  await app.current.setInfiniteFlow(true);
  await app.settle();
  assert.deepEqual(app.current.streamTopic, daily);
  app.close();
  const restored = await workspace(cache, server.request, [], server.options);
  t.after(restored.close);
  assert.equal(restored.current.infiniteFlow, true);
  assert.deepEqual(restored.current.streamTopic, daily);
  assert.equal(server.creates.length, 2);
  assert.equal((await cache.get("infinite-topic:daily")), daily.id);
});

test("开关落盘失败保持原模式且不创建会话", async (t) => {
  const cache = memoryCache(), server = streamServer();
  const save = cache.set;
  cache.set = async (key, value) => {
    if (key === "infinite-flow") throw new Error("磁盘已满");
    await save(key, value);
  };
  const app = await workspace(cache, server.request, [], server.options);
  t.after(app.close);
  await assert.rejects(app.current.setInfiniteFlow(true), /磁盘已满/);
  await app.settle();
  assert.equal(app.current.infiniteFlow, false);
  assert.equal(app.current.preferencesSaving, false);
  assert.equal(server.creates.length, 0);
});

test("分页预读相邻 Profile 的已有消息，不为未访问档案创建会话", async (t) => {
  const cache = memoryCache(), server = streamServer();
  const research = { topic_id: "research-stream", profile_id: "research", status: "ready", title: "研究" };
  server.topics.set(research.topic_id, research);
  await cache.set("infinite-topic:research", research.topic_id);
  const detail = { topic: research, messages: [{ message_id: "research-reply", role: "assistant", status: "final", text: "研究记录" }], controls: [] };
  await cache.set("topic:research-stream", detail);
  const app = await workspace(cache, server.request, [], server.options);
  t.after(app.close);
  await app.current.setInfiniteFlow(true);
  await app.settle();
  assert.equal(app.current.streamTopics?.research?.id, research.topic_id);
  assert.deepEqual(app.current.topicDetails[research.topic_id], detail);
  assert.equal(server.creates.length, 1, "预读已有相邻页不创建或重新准备其 session");
  const daily = app.current.streamTopic.id;
  await app.selectStreamProfile("research");
  assert.equal(app.current.streamTopic.id, research.topic_id);
  assert.equal(app.current.topicDetails[daily].topic.profile_id, "daily");
  assert.equal(app.current.detail.topic.profile_id, "research");
});

test("相邻页不展示归档或其他 Profile 的会话", async (t) => {
  for (const invalid of [{ archived: true }, { profile_id: "daily" }]) {
    const cache = memoryCache(), server = streamServer();
    const topic = { topic_id: "invalid", profile_id: "research", status: "ready", ...invalid };
    server.topics.set(topic.topic_id, topic);
    await cache.set("infinite-topic:research", topic.topic_id);
    await cache.set("topic:invalid", { topic, messages: [], controls: [] });
    const app = await workspace(cache, server.request, [], server.options);
    t.after(app.close);
    await app.current.setInfiniteFlow(true);
    await app.settle();
    assert.ok(app.current.streamTopics, "提供可分页的数据");
    assert.equal(app.current.streamTopics.research, undefined);
    assert.equal(server.creates.length, 1);
  }
});

test("持续会话 ID 读写短暂失败后刷新可恢复，保存成功前不创建远端会话", async (t) => {
  for (const operation of ["get", "set"]) {
    const cache = memoryCache(), server = streamServer();
    const original = cache[operation];
    let fail = true;
    cache[operation] = async (key, ...args) => {
      if (fail && key === "infinite-topic:daily") throw new Error("存储暂时不可用");
      return original(key, ...args);
    };
    const app = await workspace(cache, server.request, [], server.options);
    t.after(app.close);
    await app.current.setInfiniteFlow(true);
    await app.settle();
    assert.equal(app.current.streamTopic, undefined);
    assert.equal(server.creates.length, 0);
    assert.match(app.current.storageError, /存储暂时不可用/);
    fail = false;
    await app.current.refresh();
    await app.settle();
    assert.equal(app.current.detail.topic.status, "ready");
    assert.equal(app.current.streamTopic.id, await cache.get("infinite-topic:daily"));
    assert.equal(app.current.storageError, undefined);
    assert.equal(server.creates.length, 1);
  }
});

test("服务端创建失败不会自动换 ID，主动归档后恢复且保留原会话待发消息", async (t) => {
  const cache = memoryCache(), server = streamServer();
  let fail = true;
  const app = await workspace(cache, async (path, options) => {
    const result = await server.request(path, options);
    if (path === "/topics" && fail) Object.assign(result, { status: "error", error: "创建结果无法确认" });
    return result;
  }, [], server.options);
  t.after(app.close);
  await app.current.setInfiniteFlow(true);
  await app.settle();
  const first = app.current.streamTopic.id;
  const pending = { submission_id: "unsent", topic_id: first, profile_id: "daily", text: "保留内容", created_at: 1, error: "创建失败" };
  await cache.set("pending:unsent", pending);
  await app.current.refresh();
  await app.settle();
  assert.equal(app.current.detail.topic.status, "error");
  assert.equal(app.current.streamTopic.id, first);
  assert.equal(server.topics.size, 1);
  fail = false;
  await app.current.setTopicArchived(first, true);
  await app.settle();
  assert.notEqual(app.current.streamTopic.id, first);
  assert.equal(app.current.detail.topic.status, "ready");
  assert.equal(server.topics.get(first).archived, true);
  assert.deepEqual(await cache.get("pending:unsent"), pending);
});

test("创建失败重试保持同一幂等 ID，已归档流保留历史并创建新流", async (t) => {
  const cache = memoryCache(), server = streamServer();
  let fail = true;
  const attempts = [];
  const app = await workspace(cache, async (path, options) => {
    if (path === "/topics") {
      attempts.push(options.body.request_id);
      if (fail) throw new Error("暂时离线");
    }
    return server.request(path, options);
  }, [], server.options);
  t.after(app.close);
  await app.current.setInfiniteFlow(true);
  await app.settle();
  const first = app.current.streamTopic.id;
  fail = false;
  await app.current.refresh();
  await app.settle();
  assert.equal(app.current.detail.topic.topic_id, first);
  assert.ok(attempts.length >= 2);
  assert.ok(attempts.every((id) => id === first));
  await app.current.setInfiniteFlow(false);
  await app.settle();
  server.topics.get(first).archived = true;
  await app.current.refresh();
  await app.settle();
  await app.current.setInfiniteFlow(true);
  await app.settle();
  assert.notEqual(app.current.streamTopic.id, first);
  assert.equal(server.topics.get(first).archived, true);
});

test("原生命令断线后用同一请求编号查询，不生成普通聊天消息", async (t) => {
  const calls = [];
  let interrupted = true;
  const app = await workspace(memoryCache(), async (path, options) => {
    calls.push({ path, method: options.method, body: options.body });
    if (options.method === "POST") return { status: "pending" };
    if (interrupted) { interrupted = false; throw new Error("连接中断"); }
    return { status: "ok", native_result: { output: "原生命令输出" } };
  });
  t.after(app.close);
  const run = () => app.current.requestNativeCommand("topic", "same-request", "/commands 2", new AbortController().signal);
  await assert.rejects(run(), /连接中断/);
  assert.deepEqual(await run(), { status: "ok", native_result: { output: "原生命令输出" } });
  assert.deepEqual(calls, [
    { path: "/topics/topic/command-requests", method: "POST", body: { request_id: "same-request", command: "/commands 2" } },
    { path: "/topics/topic/command-requests/same-request", method: undefined, body: undefined },
    { path: "/topics/topic/command-requests", method: "POST", body: { request_id: "same-request", command: "/commands 2" } },
    { path: "/topics/topic/command-requests/same-request", method: undefined, body: undefined },
  ]);
  assert.deepEqual(app.current.pending, []);
  assert.deepEqual(app.current.detail.messages, []);
});

test("原生命令审批原样提交，断线重试保留请求编号、命令和审批选择", async (t) => {
  const cache = memoryCache(), calls = [], expected = [], interrupted = new Set();
  const app = await workspace(cache, async (path, options) => {
    calls.push({ path, method: options.method, body: options.body });
    if (options.method === "POST") return { status: "pending" };
    if (!interrupted.has(path)) { interrupted.add(path); throw new Error("审批后连接中断"); }
    return { status: "ok", native_result: { output: "原生命令输出" } };
  });
  t.after(app.close);
  for (const approval of ["once", "always"]) {
    const requestId = `approval-${approval}`, command = "/restart";
    const run = () => app.current.requestNativeCommand("topic", requestId, command, new AbortController().signal, approval);
    await assert.rejects(run(), /审批后连接中断/);
    assert.deepEqual(await run(), { status: "ok", native_result: { output: "原生命令输出" } });
    for (let attempt = 0; attempt < 2; attempt++) expected.push(
      { path: "/topics/topic/command-requests", method: "POST", body: { request_id: requestId, command, approval } },
      { path: `/topics/topic/command-requests/${requestId}`, method: undefined, body: undefined },
    );
  }
  assert.deepEqual(calls, expected);
  assert.deepEqual(app.current.pending, []);
  assert.deepEqual(app.current.detail.messages, []);
  assert.deepEqual(await cache.list("pending:"), []);
});

test("原生命令结束后重新加载服务端会话投影并更新本地缓存", async (t) => {
  const messages = [{ message_id: "last-user", role: "user", status: "final", text: "撤回这条" }];
  const cache = memoryCache();
  const app = await workspace(cache, async (_path, options) => {
    if (options.method === "POST") return { status: "pending" };
    messages.splice(0);
    return { status: "ok", native_result: { output: "已撤回", rewound_turns: 1 } };
  }, messages);
  t.after(app.close);
  assert.equal(app.current.detail.messages.length, 1);
  await app.current.requestNativeCommand("topic", "undo-request", "/undo", new AbortController().signal);
  await app.settle();
  assert.deepEqual(app.current.detail.messages, []);
  assert.deepEqual((await cache.list("topic:"))[0].messages, []);
});

test("后台子任务仍执行时独立更新会话状态，不触发下拉刷新或改写已完成消息", async (t) => {
  let activity = "running", calls = 0;
  const messages = [{ role: "user", status: "final" }, { role: "assistant", status: "final" }];
  const app = await workspace(memoryCache(), () => {}, messages, { status: async () => { calls++; return { activity }; } });
  t.after(app.close);
  assert.equal(app.current.activity, "running");
  assert.equal(app.current.refreshing, false);
  assert.deepEqual(app.current.detail.messages, messages);
  activity = "idle";
  await app.pollStatus();
  assert.equal(app.current.activity, "idle");
  assert.equal(calls, 2);
});

test("会话状态查询不重叠，切换会话或进入后台后忽略旧响应并停止查询", async (t) => {
  const calls = [];
  let release;
  const app = await workspace(memoryCache(), () => {}, [], { status: (id, { signal }) => {
    calls.push({ id, signal });
    return id === "topic" ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ activity: "idle" });
  } });
  t.after(app.close);
  await app.pollStatus();
  assert.equal(calls.length, 1);
  await app.selectTopic("other");
  assert.equal(calls[0].signal.aborted, true);
  release({ activity: "running" });
  await app.settle();
  assert.equal(app.current.activity, "idle", "旧话题不能点亮新话题的流光");
  await app.appState("background");
  const before = calls.length;
  await app.pollStatus();
  assert.equal(calls.length, before);
  assert.equal(app.current.activity, undefined);
  await app.appState("active");
  assert.equal(app.current.activity, "idle");
  assert.equal(calls.length, before + 1);
});

test("临时查询失败不把仍在工作的会话判为空闲，后续权威状态可恢复", async (t) => {
  let fail = false, activity = "running";
  const app = await workspace(memoryCache(), () => {}, [], { status: async () => {
    if (fail) throw new Error("offline");
    return { activity };
  } });
  t.after(app.close);
  fail = true;
  await app.pollStatus();
  assert.equal(app.current.activity, "running");
  fail = false;
  activity = "idle";
  await app.pollStatus();
  assert.equal(app.current.activity, "idle");
});

test("新执行开始后立即丢弃上一轮空闲状态，重新查询后原生状态仍优先", async (t) => {
  const messages = [];
  let release, hold = false;
  const app = await workspace(memoryCache(), () => {}, messages, { status: () => hold
    ? new Promise((resolve) => { release = resolve; }) : Promise.resolve({ activity: "idle" }) });
  t.after(app.close);
  assert.equal(app.current.activity, "idle");
  hold = true;
  messages.push({ message_id: "new-turn", role: "user", status: "streaming" });
  await app.current.refresh();
  await app.settle();
  assert.equal(app.current.activity, undefined, "等待新状态时立即按新的 streaming 显示");
  release({ activity: "idle" });
  await app.settle();
  assert.equal(app.current.activity, "idle", "重新确认的空闲可关闭过期 streaming");
});

test("已有发送结束后立即发送补充要求，网络失败不会反复立即重试", async (t) => {
  for (const fails of [false, true]) {
    const requests = [], messages = [], cache = memoryCache();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const app = await workspace(cache, async (path, { body }) => {
      requests.push({ path, body });
      if (body.submission_id === "ordinary-id") await held;
      if (fails) throw new Error("offline");
      const message = { message_id: body.submission_id, submission_id: body.submission_id, role: "user", text: body.text, status: "accepted" };
      messages.push(message);
      return message;
    }, messages);
    t.after(app.close);
    await app.current.enqueue({ submission_id: "ordinary-id", topic_id: "topic", text: "下一轮", created_at: 1 });
    await app.settle();
    await app.current.enqueue({ ...supplemental, created_at: 2 });
    await app.settle();
    release();
    await app.settle();
    assert.deepEqual(requests.map(({ path }) => path), ["/topics/topic/submissions", "/topics/topic/submissions"]);
    assert.equal((await cache.list("pending:")).length, fails ? 2 : 0);
  }
});

test("所有消息使用同一提交入口，不携带前端判断的模式或目标", async (t) => {
  const requests = [], messages = [], cache = memoryCache();
  const app = await workspace(cache, async (path, { body }) => {
    requests.push({ path, body });
    const message = { message_id: body.submission_id, submission_id: body.submission_id, role: "user", text: body.text, status: "accepted" };
    messages.push(message);
    return message;
  }, messages);
  t.after(app.close);
  await app.current.enqueue(supplemental);
  await app.settle();
  await app.current.enqueue({ submission_id: "next-id", topic_id: "topic", text: "下一轮", created_at: 2 });
  await app.settle();
  assert.deepEqual(requests, [
    { path: "/topics/topic/submissions", body: { submission_id: "supplemental-id", text: "加上预算" } },
    { path: "/topics/topic/submissions", body: { submission_id: "next-id", text: "下一轮" } },
  ]);
  assert.deepEqual(await cache.list("pending:"), []);
});

test("发送响应丢失后重启仍用同一请求，投影落盘前不删除待发送内容", async (t) => {
  const requests = [], messages = [], cache = memoryCache();
  const submit = async (path, { body }) => {
    requests.push({ path, body });
    if (requests.length === 1) throw new Error("connection lost after acceptance");
    return { message_id: "saved", submission_id: body.submission_id, role: "user", text: body.text, status: "accepted" };
  };
  const first = await workspace(cache, submit, messages);
  await first.current.enqueue(supplemental);
  await first.settle();
  assert.deepEqual(await cache.get("pending:supplemental-id"), supplemental);
  first.close();
  const resumed = await workspace(cache, submit, messages);
  t.after(resumed.close);
  assert.equal(requests.length, 2);
  assert.deepEqual(await cache.get("pending:supplemental-id"), supplemental, "HTTP acceptance alone must not remove the durable bubble");
  messages.push({ message_id: "saved", submission_id: "supplemental-id", role: "user", text: "加上预算", status: "final" });
  await resumed.current.refresh();
  await resumed.settle();
  assert.deepEqual(await cache.list("pending:"), []);
  assert.equal((await cache.get("topic:topic")).messages[0].submission_id, "supplemental-id");
  assert.equal(requests.length, 3);
  for (const item of requests) assert.deepEqual(item, {
    path: "/topics/topic/submissions", body: { submission_id: "supplemental-id", text: "加上预算" },
  });
});

test("提交被明确拒绝时保留错误和正文，不持续重发", async (t) => {
  const requests = [], cache = memoryCache();
  const app = await workspace(cache, async (path, { body }) => {
    requests.push({ path, body });
    throw new ApiError(422, "VALIDATION_FAILED", "消息正文无效。", false);
  });
  t.after(app.close);
  await app.current.enqueue(supplemental);
  await app.settle();
  await app.current.refresh();
  await app.settle();
  assert.deepEqual(requests, [{
    path: "/topics/topic/submissions", body: { submission_id: "supplemental-id", text: "加上预算" },
  }]);
  assert.deepEqual(await cache.get("pending:supplemental-id"), { ...supplemental, error: "消息正文无效。" });
  assert.equal(app.current.pending[0].error, "消息正文无效。");
});


test("配置档案保存更新全部默认标记并落盘，拒绝的保存不覆盖已有资料", async (t) => {
  const cache = memoryCache(), requests = [];
  const original = [{ profile_id: "first", label: "default", is_default: true }, { profile_id: "second", label: "work" }];
  const updated = [{ profile_id: "first", label: "default" }, { profile_id: "second", label: "work", alias: "工作助手", is_default: true }];
  let reject = false, remote = original;
  const app = await workspace(cache, async (path, { method, body }) => {
    requests.push({ path, method, body });
    if (reject) throw new ApiError(422, "VALIDATION_FAILED", "别名过长", false);
    remote = updated;
    return updated;
  }, [], { profiles: () => remote });
  t.after(app.close);
  await app.current.saveProfilePreferences("second", { alias: "工作助手", is_default: true });
  await app.settle();
  assert.deepEqual(app.current.profiles, updated);
  assert.deepEqual((await cache.get("directory")).profiles, updated);
  assert.deepEqual(requests[0], { path: "/profiles/second/preferences", method: "PUT", body: { alias: "工作助手", is_default: true } });
  reject = true;
  await assert.rejects(app.current.saveProfilePreferences("second", { alias: "失败" }), /别名过长/);
  await app.settle();
  assert.deepEqual(app.current.profiles, updated);
  assert.deepEqual((await cache.get("directory")).profiles, updated);
});

test("配置档案保存不会被已在途的旧目录响应覆盖", async (t) => {
  const cache = memoryCache();
  const original = [{ profile_id: "first", label: "default" }];
  const updated = [{ ...original[0], alias: "助手", avatar_url: "/mobile/v1/profiles/first/avatar?v=new" }];
  let hold = false, release, remote = original;
  const app = await workspace(cache, async () => { remote = updated; return updated; }, [], { profiles: () => {
    if (hold) { hold = false; return new Promise((resolve) => { release = resolve; }); }
    return remote;
  } });
  t.after(app.close);
  hold = true;
  const refresh = app.current.refresh();
  await app.settle();
  const saving = app.current.saveProfilePreferences("first", { alias: "助手" });
  await app.settle();
  release(original);
  await Promise.all([refresh, saving]);
  await app.settle();
  assert.deepEqual(app.current.profiles, updated);
  assert.deepEqual((await cache.get("directory")).profiles, updated);
});

test("保存回执不能覆盖插件或另一设备刚刚写入的新头像和默认项", async (t) => {
  const cache = memoryCache();
  const original = [{ profile_id: "first", label: "default" }, { profile_id: "second", label: "work" }];
  const receipt = [{ ...original[0], alias: "助手" }, original[1]];
  const latest = [{ ...receipt[0], avatar_url: "/mobile/v1/profiles/first/avatar?v=plugin" }, { ...original[1], is_default: true }];
  let remote = original, release, hold = false;
  const app = await workspace(cache, async () => { remote = latest; return receipt; }, [], { profiles: () => {
    if (hold) { hold = false; return new Promise((resolve) => { release = resolve; }); }
    return remote;
  } });
  t.after(app.close);
  hold = true;
  const refresh = app.current.refresh();
  await app.settle();
  const saving = app.current.saveProfilePreferences("first", { alias: "助手" });
  await app.settle();
  release(latest);
  await Promise.all([refresh, saving]);
  await app.settle();
  assert.deepEqual(app.current.profiles, latest);
  assert.deepEqual((await cache.get("directory")).profiles, latest);
});
