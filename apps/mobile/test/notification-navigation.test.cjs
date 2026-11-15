const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

const source = ts.transpileModule(readFileSync(require.resolve("../src/workspace-context.tsx"), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
}).outputText;
const session = { origin: "https://app.example", token: "device-token" };
const topic = { topic_id: "topic", profile_id: "work", archived: true };

async function mount({ ready = true, call = async () => ({ topic, messages: [{ message_id: "reply" }] }) } = {}) {
  const slots = [], setters = [], effects = [], cleanup = [], routes = [], registrations = [], alerts = [];
  let cursor = 0, dirty = false, parent = true, rootKey = ready ? "root" : undefined, open, errors, value;
  const same = (a, b) => a && b && a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  const react = {
    createContext: () => "WorkspaceContext",
    useState(initial) {
      if (parent) return [cursor++ === 0 ? session : initial, () => {}];
      const slot = cursor++;
      if (!(slot in slots)) slots[slot] = initial;
      setters[slot] ??= (next) => {
        next = typeof next === "function" ? next(slots[slot]) : next;
        if (!Object.is(next, slots[slot])) { slots[slot] = next; dirty = true; }
      };
      return [slots[slot], setters[slot]];
    },
    useRef(current) { return slots[cursor++] ??= { current }; },
    useEffect(effect, deps) {
      if (parent) return;
      const slot = cursor++;
      if (!same(slots[slot], deps)) {
        slots[slot] = deps;
        effects.push(() => { cleanup[slot]?.(); cleanup[slot] = effect(); });
      }
    },
  };
  const router = { canDismiss: () => true, dismissAll: () => routes.push("dismiss"), replace: (route) => routes.push(route),
    push: (route) => routes.push(route) };
  const workspace = { ready: true, network: "online", call, sessionEnded: false };
  const alertApi = { alert: (...args) => alerts.push(args) };
  const exports = {};
  new Function("exports", "require", source)(exports, (name) => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (name === "expo-router") return { useRouter: () => router, useRootNavigationState: () => rootKey ? { key: rootKey } : undefined,
      useGlobalSearchParams: () => ({}) };
    if (name === "./notifications") return {
      pushAvailable: true,
      async enablePushNotifications(...args) { registrations.push(args); return true; },
      observeNotificationOpens(callback, onError) { open = callback; errors = onError; return () => { open = undefined; }; },
    };
    if (name === "./sync/use-workspace") return { useWorkspace: () => workspace };
    if (name === "react-native") return {};
    if (name === "./ui/alerts") return { useAlert: () => alertApi };
    if (name === "./ui/theme") return { useTheme: () => ({ colors: {}, styles: {} }) };
    return {};
  });
  const signedIn = exports.WorkspaceProvider({ children: "Stack" }).props.children[1];
  parent = false;
  const render = () => {
    dirty = false; cursor = 0;
    value = signedIn.type(signedIn.props).props.value;
    effects.splice(0).forEach((effect) => effect());
  };
  const settle = async () => {
    for (let quiet = 0; quiet < 2;) {
      await new Promise(setImmediate);
      if (dirty) { render(); quiet = 0; } else quiet++;
    }
  };
  render(); await settle();
  return { routes, registrations, alerts, get value() { return value; }, get open() { return open; }, get onError() { return errors; },
    async ready() { rootKey = "root"; render(); await settle(); }, settle,
    close() { cleanup.forEach((fn) => fn?.()); } };
}

test("通知跳转等待路由就绪，鉴权读取目标后定位归档会话与消息", async (t) => {
  const calls = [];
  const app = await mount({ ready: false, call: async (path) => {
    calls.push(path); return { topic, messages: [{ message_id: "reply" }] };
  } });
  t.after(app.close);
  assert.equal(app.open, undefined);
  assert.deepEqual(app.routes, []);
  await app.ready();
  assert.equal(typeof app.open, "function");
  await app.open({ topic_id: "topic", message_id: "reply" });
  await app.settle();
  assert.deepEqual(calls, ["/topics/topic"]);
  assert.equal(app.value.profileId, "work");
  assert.equal(app.value.section, "topics");
  assert.deepEqual(app.routes.at(-1), { pathname: "/[page]", params: { page: "conversation", topicId: "topic", messageId: "reply", archived: "1" } });
});

test("收件箱通知从服务端恢复所选消息，再进入详情", async (t) => {
  const item = { inbox_id: "inbox", profile_id: "work", text: "报告" };
  const app = await mount({ call: async (path) => { assert.equal(path, "/inbox"); return [item]; } });
  t.after(app.close);
  assert.equal(typeof app.open, "function");
  await app.open({ inbox_id: "inbox" });
  await app.settle();
  assert.equal(app.value.inboxItem, item);
  assert.equal(app.value.section, "inbox");
  assert.deepEqual(app.routes.at(-1), { pathname: "/[page]", params: { page: "inbox-item" } });
});

test("目标消息不存在或退出后请求才返回时，不跳转", async (t) => {
  const missing = await mount({ call: async () => ({ topic, messages: [] }) });
  t.after(missing.close);
  assert.equal(typeof missing.open, "function");
  const before = missing.routes.length;
  await assert.rejects(missing.open({ topic_id: "topic", message_id: "missing" }), /消息/);
  assert.equal(missing.routes.length, before);
  let resolve;
  const app = await mount({ call: () => new Promise((done) => { resolve = done; }) });
  const pending = app.open({ topic_id: "topic", message_id: "reply" });
  const count = app.routes.length;
  app.close();
  resolve({ topic, messages: [{ message_id: "reply" }] });
  await pending;
  assert.equal(app.routes.length, count);
});

test("在线恢复已有推送授权时不主动申请系统权限", async (t) => {
  const app = await mount();
  t.after(app.close);
  assert.deepEqual(app.registrations, [[session, false]]);
  assert.equal(app.value.push, "enabled");
});

test("打开失败显示独立于当前页面的提示，旧点击失败不打断最新消息", async (t) => {
  let rejectOld;
  const app = await mount({ call: (path) => path === "/topics/old"
    ? new Promise((_, reject) => { rejectOld = reject; })
    : Promise.resolve({ topic, messages: [{ message_id: "reply" }] }) });
  t.after(app.close);
  app.onError(new Error("无法连接服务器"));
  assert.deepEqual(app.alerts, [["无法打开通知", "无法连接服务器"]]);
  const old = app.open({ topic_id: "old", message_id: "old-reply" });
  await app.open({ topic_id: "topic", message_id: "reply" });
  rejectOld(new Error("过期请求失败"));
  await assert.doesNotReject(old);
  assert.equal(app.routes.at(-1).params.topicId, "topic");
});
