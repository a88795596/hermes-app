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

async function workspace(cache, submit, messages = []) {
  const values = [], effects = [], cleanup = [];
  let cursor = 0, dirty = false, current;
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
  const request = async (_origin, path, options = {}) => {
    if (path === "/profiles") return [];
    if (path === "/topics?include_archived=true") return [topic];
    if (path === "/inbox") return [];
    if (path === "/status") return { connector_online: true };
    if (path === "/ws-tickets") return { ticket: "live-ticket" };
    if (path === "/topics/topic") return { topic, messages: structuredClone(messages), controls: [] };
    return submit(path, options);
  };
  // The live transport stays idle; explicit refresh exercises the real recovery path.
  class Socket { static OPEN = 1; readyState = 1; close() {} }
  new Function("exports", "require", "WebSocket", "setInterval", "clearInterval", "setTimeout", "clearTimeout", source)(
    exports, (name) => {
      if (name === "react") return react;
      if (name === "react-native") return { AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } };
      if (name === "../db/cache") return { openCache: async () => cache };
      if (name === "./api") return { ApiError, request };
      throw new Error(`Unexpected dependency: ${name}`);
    }, Socket, () => 1, () => {}, () => 1, () => {},
  );
  const render = () => {
    dirty = false;
    cursor = 0;
    current = exports.useWorkspace(session, "topic", false);
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
  return { get current() { return current; }, settle, close: () => cleanup.forEach((dispose) => dispose?.()) };
}

const supplemental = { submission_id: "supplemental-id", topic_id: "topic", text: "加上预算", created_at: 1 };

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

