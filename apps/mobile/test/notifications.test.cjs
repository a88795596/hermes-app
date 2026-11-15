const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

const source = ts.transpileModule(readFileSync(require.resolve("../src/notifications.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const flush = () => new Promise(setImmediate);
const response = (identifier, data, actionIdentifier = "default") => ({
  actionIdentifier, notification: { request: { identifier, content: { data } } },
});

function loadNotifications(initial = null, { permission = { status: "granted" }, fetchError } = {}) {
  const exports = {};
  let listener, last = initial, handler, removed = false, cleared = 0, permissionRequests = 0;
  const registrations = [];
  const native = {
    DEFAULT_ACTION_IDENTIFIER: "default",
    setNotificationHandler(value) { handler = value; },
    addNotificationResponseReceivedListener(value) {
      listener = value;
      return { remove() { removed = true; } };
    },
    getLastNotificationResponse: () => last,
    clearLastNotificationResponse() { last = null; cleared++; },
    IosAuthorizationStatus: { PROVISIONAL: "provisional" },
    getPermissionsAsync: async () => permission,
    async requestPermissionsAsync() { permissionRequests++; return { status: "granted" }; },
    getExpoPushTokenAsync: async () => ({ data: "ExpoPushToken[test]" }),
  };
  new Function("exports", "require", "fetch", source)(exports, (name) => {
    if (name === "expo-notifications") return native;
    if (name === "expo-constants") return { __esModule: true, default: { easConfig: { projectId: "project" } } };
    if (name === "react-native") return { Platform: { OS: "ios" } };
    throw new Error(`Unexpected dependency: ${name}`);
  }, async (url, options) => {
    if (fetchError) throw fetchError;
    registrations.push({ url, options });
    return { ok: true };
  });
  return {
    ...exports,
    get handler() { return handler; },
    get removed() { return removed; },
    get cleared() { return cleared; },
    get last() { return last; },
    get permissionRequests() { return permissionRequests; },
    registrations,
    emit(value) { last = value; listener(value); },
  };
}

test("前台通知显示横幅和通知列表，并播放提示音", async () => {
  const runtime = loadNotifications();
  assert.ok(runtime.handler, "应配置前台通知处理器");
  assert.deepEqual(await runtime.handler.handleNotification(), {
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false,
  });
});

test("静默恢复只注册已授权通知，不弹权限框", async () => {
  const session = { origin: "https://mobile.example", token: "device-token" };
  for (const permission of [{ status: "granted" }, { status: "denied", ios: { status: "provisional" } }]) {
    const runtime = loadNotifications(null, { permission });
    assert.equal(await runtime.enablePushNotifications(session, false), true);
    assert.equal(runtime.permissionRequests, 0);
    assert.equal(runtime.registrations.length, 1);
    assert.equal(runtime.registrations[0].url, `${session.origin}/mobile/v1/devices/current/push-registration`);
    assert.equal(runtime.registrations[0].options.headers.Authorization, "Bearer device-token");
  }
  const runtime = loadNotifications(null, { permission: { status: "denied" } });
  assert.equal(await runtime.enablePushNotifications(session, false), false);
  assert.equal(runtime.permissionRequests, 0);
  assert.deepEqual(runtime.registrations, []);
});

test("显式启用仍请求权限，静默注册失败仍交由调用方处理", async () => {
  const session = { origin: "https://mobile.example", token: "device-token" };
  const runtime = loadNotifications(null, { permission: { status: "undetermined" } });
  assert.equal(await runtime.enablePushNotifications(session), true);
  assert.equal(runtime.permissionRequests, 1);
  const offline = loadNotifications(null, { fetchError: new Error("offline") });
  await assert.rejects(offline.enablePushNotifications(session, false), /无法连接服务器/);
});

test("冷启动和事件监听收到同一次点击时仅打开一次目标消息", async () => {
  const target = { topic_id: "topic-1", message_id: "message-2" };
  const notification = response("notification-1", target);
  const runtime = loadNotifications(notification);
  const opened = [], errors = [];
  const stop = runtime.observeNotificationOpens(async (value) => { opened.push(value); }, (error) => errors.push(error));
  runtime.emit(notification);
  await flush();
  assert.deepEqual(opened, [target]);
  assert.deepEqual(errors, []);
  assert.equal(runtime.cleared, 1);
  runtime.emit(notification);
  await flush();
  assert.deepEqual(opened, [target]);
  stop();
  assert.equal(runtime.removed, true);
});

test("收件箱点击保留原有定位，通知中的 URL 不能决定跳转", async () => {
  const runtime = loadNotifications();
  const opened = [];
  const stop = runtime.observeNotificationOpens(async (value) => { opened.push(value); }, assert.fail);
  runtime.emit(response("inbox-notice", { inbox_id: "inbox-3", url: "https://untrusted.example" }));
  await flush();
  assert.deepEqual(opened, [{ inbox_id: "inbox-3" }]);
  stop();
});

test("拒绝非默认动作、缺失或不安全的定位数据", async () => {
  const runtime = loadNotifications();
  const opened = [];
  const stop = runtime.observeNotificationOpens(async (value) => { opened.push(value); }, assert.fail);
  const invalid = [null, [], {}, { url: "https://example.com" }, { inbox_id: "" }, { inbox_id: ["inbox"] },
    { inbox_id: "../settings" }, { inbox_id: "inbox?other=1" }, { inbox_id: "x".repeat(129) },
    { topic_id: "topic" }, { topic_id: "topic", message_id: 4 },
    { topic_id: "topic", message_id: "message", inbox_id: "inbox" }];
  invalid.forEach((data, index) => runtime.emit(response(`invalid-${index}`, data)));
  runtime.emit(response("dismiss", { inbox_id: "inbox" }, "dismiss"));
  await flush();
  assert.deepEqual(opened, []);
  assert.equal(runtime.cleared, 0);
  stop();
});

test("打开失败保留系统响应并允许重试，成功后才清除", async () => {
  const notification = response("retry", { inbox_id: "inbox-3" });
  const runtime = loadNotifications(notification);
  const errors = [];
  let attempts = 0;
  const failure = new Error("offline");
  const stop = runtime.observeNotificationOpens(async () => {
    if (++attempts === 1) throw failure;
  }, (error) => errors.push(error));
  await flush();
  assert.deepEqual(errors, [failure]);
  assert.equal(runtime.last, notification);
  assert.equal(runtime.cleared, 0);
  runtime.emit(notification);
  await flush();
  assert.equal(attempts, 2);
  assert.equal(runtime.cleared, 1);
  stop();
});

test("较早的打开操作完成时不会清除较新的点击", async () => {
  const runtime = loadNotifications();
  const pending = new Map();
  const stop = runtime.observeNotificationOpens((target) => new Promise((resolve) => pending.set(target.inbox_id, resolve)), assert.fail);
  runtime.emit(response("first", { inbox_id: "one" }));
  runtime.emit(response("second", { inbox_id: "two" }));
  await flush();
  pending.get("one")();
  await flush();
  assert.equal(runtime.cleared, 0);
  assert.equal(runtime.last.notification.request.identifier, "second");
  pending.get("two")();
  await flush();
  assert.equal(runtime.cleared, 1);
  stop();
});

test("取消订阅后忽略尚未开始的点击以及迟到的错误", async () => {
  const runtime = loadNotifications();
  let opened = 0, reject;
  const errors = [];
  const stop = runtime.observeNotificationOpens(() => {
    opened++;
    return new Promise((_resolve, fail) => { reject = fail; });
  }, (error) => errors.push(error));
  runtime.emit(response("first", { inbox_id: "one" }));
  await flush();
  runtime.emit(response("second", { inbox_id: "two" }));
  stop();
  reject(new Error("late failure"));
  await flush();
  assert.equal(opened, 1);
  assert.deepEqual(errors, []);
  assert.equal(runtime.cleared, 0);
});
