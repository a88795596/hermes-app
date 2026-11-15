const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function compile(path) {
  return ts.transpileModule(readFileSync(require.resolve(path), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
}
const source = compile("../src/workspace-screen.tsx");
const textExports = {};
new Function("exports", compile("../src/ui/text.ts"))(textExports);
const flush = () => new Promise(setImmediate);
const ManagementScreen = Symbol("ManagementScreen");

function mountWorkspace({ update, message, params = {}, router = {}, stack } = {}) {
  const alerts = [], choices = [], statuses = [], feedback = [];
  let checks = 0;
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  new Function("exports", "require", source)(exports, (name) => {
    switch (name) {
      case "react/jsx-runtime": return { jsx, jsxs: jsx, Fragment: "Fragment" };
      case "react": return {
        useCallback: (callback) => callback,
        useRef: (current) => ({ current }),
        useState: (initial) => [initial, (value) => statuses.push(value)],
      };
      case "react-native": return {
        Alert: { alert: (title, message, buttons, options) => alerts.push({ title, message, buttons, options }) },
        Keyboard: { dismiss() {} },
        Platform: { OS: "ios", select: (options) => options.ios }, StyleSheet: { create: (styles) => styles, hairlineWidth: 1 },
        Pressable: "Pressable", Text: "Text", View: "View", ScrollView: "ScrollView", RefreshControl: "RefreshControl",
      };
      case "expo-router": return {
        useRouter: () => router, useLocalSearchParams: () => params,
        useNavigation: () => ({ getState: () => stack }), useFocusEffect() {},
      };
      case "react-native-reanimated": return { default: { View: "Animated.View" } };
      case "react-native-safe-area-context": return { SafeAreaView: "SafeAreaView" };
      case "./ui/theme": return { useTheme: () => ({ colors: {}, styles: {} }), Icon: "Icon" };
      case "./ui/motion": return { useReduceMotion: () => true, motion: {} };
      case "./ui/haptics": return { haptic: (kind) => feedback.push(kind) };
      case "./ui/text": return textExports;
      case "./workspace-context": return { useWorkspaceContext: () => ({
        section: "settings", workspace: {
          profiles: [{ profile_id: "default", label: "默认" }], topics: [], pending: [], ready: true, network: "online",
        },
      }) };
      case "./updates": return {
        currentUpdate: { id: "running-version" },
        async checkUpdateManually(confirm) {
          checks++;
          if (message) return message;
          const accepted = await confirm(update);
          choices.push(accepted);
          return accepted ? "热更新已下载，下次启动 App 时生效。" : undefined;
        },
      };
      case "expo-crypto":
      case "@hermes-mobile/protocol":
      case "./chat/conversation":
      case "./chat/topic-list":
      case "./inbox/inbox":
      case "./manage/shared":
      case "./notifications": return {};
      case "./manage": return { ManagementScreen };
      default: throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const workspace = exports.default().props.children;
  return { alerts, choices, statuses, feedback, screen: workspace.type(), checks: () => checks };
}

function findNode(node, matches) {
  if (Array.isArray(node)) return node.map((child) => findNode(child, matches)).find(Boolean);
  if (!node?.props) return;
  if (matches(node)) return node;
  return findNode(node.props.children, matches);
}

function mountSettings(update, message) {
  const { screen: settings, ...state } = mountWorkspace({ update, message });
  const button = findNode(settings, (node) => node.type === "Pressable" && node.props.accessibilityLabel === "检查更新");
  assert.ok(button, "设置中应有可点击的检查更新入口");
  assert.equal(button.props.accessibilityRole, "button");
  assert.ok(findNode(settings, (node) => node.type === "Text" && node.props.children === "running-version"), "设置中应显示正在运行的热更新版本");
  return { ...state, press: button.props.onPress };
}

test("检查更新展示说明、时间和 ID，取消可重试，确认前防止重复检查", async () => {
  const update = { id: "next-version", message: "  新增手动检查热更新  ", publishedAt: 1794700800000 };
  const screen = mountSettings(update);
  screen.press();
  screen.press();
  assert.equal(screen.checks(), 1);
  assert.deepEqual(screen.feedback, ["light"], "重复点击检查不会重复震动");
  assert.equal(screen.alerts.length, 1);
  const alert = screen.alerts[0];
  assert.equal(alert.title, "发现热更新");
  assert.equal(alert.message, `新增手动检查热更新\n\n时间：${textExports.formatDateTime(update.publishedAt)}\n\nID：next-version`);
  const cancel = alert.buttons.find((button) => button.text === "取消");
  assert.equal(cancel.style, "cancel");
  cancel.onPress();
  await flush();
  assert.deepEqual(screen.choices, [false]);
  assert.equal(screen.alerts.length, 1, "取消不显示下载完成");
  assert.equal(screen.statuses.at(-1), undefined);
  assert.deepEqual(screen.feedback, ["light"], "取消不反馈下载成功");
  screen.press();
  assert.equal(screen.checks(), 2, "取消不禁用后续手动检查");
  screen.alerts[1].buttons.find((button) => button.text === "取消").onPress();
  await flush();
});

test("未启用热更新或无需下载时只提示点击，不宣告下载成功", async () => {
  for (const message of ["当前版本未启用热更新。", "当前已是最新版本。", "热更新已下载，下次启动 App 时生效。"]) {
    const screen = mountSettings(undefined, message);
    screen.press();
    await flush();
    assert.deepEqual(screen.feedback, ["light"]);
    assert.equal(screen.alerts[0].message, message);
  }
});

test("下载按钮确认后显示完成提示，流程结束可再次检查", async () => {
  const screen = mountSettings({ id: "next-version", message: "更新说明", publishedAt: 1794700800000 });
  screen.press();
  screen.alerts[0].buttons.find((button) => button.text === "下载").onPress();
  assert.equal(screen.statuses.at(-1), "下载中…");
  await flush();
  assert.deepEqual(screen.choices, [true]);
  assert.equal(screen.alerts[1].title, "热更新");
  assert.equal(screen.alerts[1].message, "热更新已下载，下次启动 App 时生效。");
  assert.equal(screen.statuses.at(-1), undefined);
  assert.deepEqual(screen.feedback, ["light", "medium", "success"]);
});

test("缺少说明时仅展示时间和 ID，关闭确认框等同取消", async () => {
  for (const message of [null, "", "  "]) {
    const screen = mountSettings({ id: "legacy-version", message });
    screen.press();
    assert.equal(screen.alerts[0].message, "时间：未知\n\nID：legacy-version");
    assert.equal(screen.alerts[0].options.cancelable, true);
    screen.alerts[0].options.onDismiss();
    await flush();
    assert.deepEqual(screen.choices, [false]);
    assert.equal(screen.statuses.at(-1), undefined);
  }
});

test("管理分类返回到已有管理菜单，直接进入分类时补上菜单", () => {
  const actions = [];
  const router = { back: () => actions.push("back"), replace: (href) => actions.push(href) };
  for (const previous of [{ name: "[page]", params: { page: "manage" } }, { name: "index" }]) {
    const params = { page: "models" };
    const stack = { index: 1, routes: [previous, { name: "[page]", params }] };
    const { screen } = mountWorkspace({ params, router, stack });
    findNode(screen, (node) => node.type === ManagementScreen).props.onBack();
  }
  assert.deepEqual(actions, ["back", { pathname: "/[page]", params: { page: "manage" } }]);
});
