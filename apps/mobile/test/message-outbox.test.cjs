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
  let cursor = 0, dirty = false, current, selectedTopic = "topic", changeAppState, timerId = 0;
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
    if (path === "/profiles") return [];
    if (path === "/topics?include_archived=true") return [topic];
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
      if (name === "./api") return { ApiError, request };
      throw new Error(`Unexpected dependency: ${name}`);
    }, Socket, () => 1, () => {}, (callback, ms) => { timers.set(++timerId, { callback, ms }); return timerId; }, (id) => timers.delete(id),
  );
  const render = () => {
    dirty = false;
    cursor = 0;
    current = exports.useWorkspace(session, selectedTopic, false);
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
    async appState(state) { changeAppState(state); await settle(); },
  };
}

const supplemental = { submission_id: "supplemental-id", topic_id: "topic", text: "加上预算", created_at: 1 };

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

