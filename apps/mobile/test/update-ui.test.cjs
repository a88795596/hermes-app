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

function mountWorkspace({ update, message, downloaded = false, reloadError, params = {}, router = {}, stack, context = {} } = {}) {
  const alerts = [], choices = [], reloadChoices = [], statuses = [], feedback = [];
  const values = [], focusEffects = [];
  let checks = 0, cursor = 0;
  const state = {
    section: "settings", setSection: (value) => { state.section = value; },
    setProfileId: (value) => { state.profileId = value; }, setError() {},
    ...context,
    workspace: {
      profiles: [{ profile_id: "default", label: "默认" }], topics: [], pending: [], ready: true, network: "online",
      ...context.workspace,
    },
  };
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  new Function("exports", "require", source)(exports, (name) => {
    switch (name) {
      case "react/jsx-runtime": return { jsx, jsxs: jsx, Fragment: "Fragment" };
      case "react": return {
        useCallback: (callback) => callback,
        useRef(current) { const index = cursor++; return values[index] ??= { current }; },
        useState(initial) {
          const index = cursor++;
          if (!(index in values)) values[index] = initial;
          return [values[index], (value) => { values[index] = value; statuses.push(value); }];
        },
      };
      case "react-native": return {
        Alert: { alert: (title, message, buttons, options) => alerts.push({ title, message, buttons, options }) },
        Keyboard: { dismiss() {} },
        Platform: { OS: "ios", select: (options) => options.ios }, StyleSheet: { create: (styles) => styles, hairlineWidth: 1 },
        Pressable: "Pressable", Text: "Text", View: "View", ScrollView: "ScrollView", RefreshControl: "RefreshControl",
      };
      case "expo-router": return {
        useRouter: () => ({ canDismiss: () => false, ...router }), useLocalSearchParams: () => params,
        useNavigation: () => ({ getState: () => stack }), useFocusEffect: (effect) => focusEffects.push(effect),
      };
      case "react-native-reanimated": return { default: { View: "Animated.View" } };
      case "react-native-safe-area-context": return { SafeAreaView: "SafeAreaView" };
      case "./ui/theme": return { useTheme: () => ({ colors: {}, styles: {} }), Icon: "Icon" };
      case "./ui/page-header": return { PageHeader: "PageHeader" };
      case "./ui/motion": return { useReduceMotion: () => true, motion: {} };
      case "./ui/haptics": return { haptic: (kind) => feedback.push(kind) };
      case "./ui/text": return textExports;
      case "./workspace-context": return { useWorkspaceContext: () => state };
      case "./chat/composer-menu": return { ComposerSheet: "ComposerSheet", PickerRow: "PickerRow" };
      case "./chat/topic-list": return { TopicList: "TopicList" };
      case "./updates": return {
        currentUpdate: { id: "running-version" },
        async checkUpdateManually(confirm, confirmReload) {
          checks++;
          if (message) return message;
          if (!downloaded) {
            const accepted = await confirm(update);
            choices.push(accepted);
            if (!accepted) return;
          }
          const reload = await confirmReload();
          reloadChoices.push(reload);
          if (reload && reloadError) throw reloadError;
        },
      };
      case "expo-crypto": return { randomUUID: () => "new-topic" };
      case "@hermes-mobile/protocol":
      case "./chat/conversation":
      case "./inbox/inbox":
      case "./manage/shared":
      case "./notifications": return {};
      case "./manage": return { ManagementScreen };
      default: throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const workspace = exports.default().props.children;
  const render = () => { cursor = 0; focusEffects.length = 0; return workspace.type(); };
  return { alerts, choices, reloadChoices, statuses, feedback, state, render, focusEffects, screen: render(), checks: () => checks };
}

function findNode(node, matches) {
  if (Array.isArray(node)) return node.map((child) => findNode(child, matches)).find(Boolean);
  if (!node?.props) return;
  if (matches(node)) return node;
  return findNode(node.type === "PageHeader"
    ? [node.props.leading, node.props.title, node.props.trailing]
    : node.props.children, matches);
}

function mountSettings(update, message, options = {}) {
  const { screen: settings, ...state } = mountWorkspace({ update, message, ...options });
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
  for (const message of ["当前版本未启用热更新。", "当前已是最新版本。"]) {
    const screen = mountSettings(undefined, message);
    screen.press();
    await flush();
    assert.deepEqual(screen.feedback, ["light"]);
    assert.equal(screen.alerts[0].message, message);
  }
});

test("下载完成后可选择稍后、立即重启或关闭弹窗，确认期间防止重复检查", async () => {
  for (const choice of ["稍后", "立即重启", "关闭"]) {
    const screen = mountSettings({ id: "next-version", message: "更新说明", publishedAt: 1794700800000 });
    screen.press();
    screen.alerts[0].buttons.find((button) => button.text === "下载").onPress();
    assert.equal(screen.statuses.at(-1), "下载中…");
    await flush();
    assert.deepEqual(screen.choices, [true]);
    const alert = screen.alerts[1];
    assert.equal(alert.title, "热更新已下载");
    assert.match(alert.message, /立即重启/);
    assert.equal(alert.buttons.find((button) => button.text === "稍后").style, "cancel");
    assert.equal(screen.statuses.at(-1), "等待确认…");
    assert.deepEqual(screen.feedback, ["light", "medium", "success"]);
    screen.press();
    assert.equal(screen.checks(), 1);
    if (choice === "关闭") {
      assert.equal(alert.options.cancelable, true);
      alert.options.onDismiss();
    } else {
      alert.buttons.find((button) => button.text === choice).onPress();
    }
    if (choice === "立即重启") assert.equal(screen.statuses.at(-1), "重启中…");
    await flush();
    assert.deepEqual(screen.reloadChoices, [choice === "立即重启"]);
    assert.equal(screen.alerts.length, 2, "完成后不再显示重复提示");
    assert.equal(screen.statuses.at(-1), undefined);
    screen.press();
    assert.equal(screen.checks(), 2, "结束后可以再次检查");
    screen.alerts[2].buttons.find((button) => button.text === "取消").onPress();
    await flush();
  }
});

test("已有待生效更新时直接确认重启，重启失败显示错误并允许重试", async () => {
  const screen = mountSettings(undefined, undefined, { downloaded: true, reloadError: new Error("应用重启失败，请稍后重试。") });
  screen.press();
  await flush();
  const alert = screen.alerts[0];
  assert.equal(alert.title, "热更新已下载");
  assert.deepEqual(screen.choices, []);
  assert.deepEqual(screen.feedback, ["light"], "已有下载不重复反馈下载成功");
  alert.buttons.find((button) => button.text === "立即重启").onPress();
  await flush();
  assert.deepEqual(screen.reloadChoices, [true]);
  assert.equal(screen.alerts[1].title, "热更新失败");
  assert.match(screen.alerts[1].message, /重启失败/);
  assert.equal(screen.feedback.at(-1), "error");
  assert.equal(screen.statuses.at(-1), undefined);
  screen.press();
  assert.equal(screen.checks(), 2);
  screen.alerts[2].buttons.find((button) => button.text === "稍后").onPress();
  await flush();
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

test("首页头像打开配置档案选择，取消保留原选择，切换后列表和新会话使用所选档案", () => {
  const routes = [];
  const screen = mountWorkspace({
    router: { push: (route) => routes.push(route) },
    context: {
      section: "topics",
      workspace: {
        profiles: [{ profile_id: "default", label: "default" }, { profile_id: "work", label: "工作" }],
        topics: [
          { topic_id: "personal-topic", profile_id: "default", title: "个人会话" },
          { topic_id: "work-topic", profile_id: "work", title: "工作会话" },
        ],
      },
    },
  });
  const find = (predicate) => findNode(screen.render(), predicate);
  const avatar = () => find((node) => node.props.accessibilityLabel?.startsWith("选择配置档案"));
  const sheet = () => find((node) => node.type === "ComposerSheet");
  const rows = () => find((node) => node.type === "TopicList").props.rows.map((row) => row.id);

  assert.equal(find((node) => node.props.accessibilityRole === "header" && node.props.children === "话题"), undefined);
  assert.ok(find((node) => node.props.accessibilityRole === "tab" && node.props.accessibilityLabel === "话题"));
  assert.deepEqual(rows(), ["personal-topic"]);
  assert.equal(sheet(), undefined);
  avatar().props.onPress();
  assert.equal(avatar().props.accessibilityState.expanded, true);
  assert.equal(sheet().props.title, "选择配置档案");
  sheet().props.onClose();
  assert.equal(sheet(), undefined);
  assert.deepEqual(rows(), ["personal-topic"]);

  avatar().props.onPress();
  find((node) => node.type === "PickerRow" && node.props.title === "工作").props.onPress();
  assert.equal(sheet(), undefined);
  assert.equal(avatar().props.accessibilityLabel, "选择配置档案，工作");
  assert.deepEqual(rows(), ["work-topic"]);
  avatar().props.onPress();
  assert.equal(find((node) => node.type === "PickerRow" && node.props.title === "工作").props.selected, true);
  sheet().props.onClose();
  find((node) => node.props.accessibilityLabel === "新建会话").props.onPress();
  assert.deepEqual(routes, [{ pathname: "/[page]", params: { page: "conversation", topicId: "new-topic", newProfileId: "work" } }]);
});

test("列表滚动和页面失焦收起当前左滑菜单", () => {
  const { screen, focusEffects } = mountWorkspace({ context: { section: "topics", workspace: {
    topics: [{ topic_id: "topic-1", profile_id: "default", title: "会话" }],
  } } });
  let closes = 0;
  const list = findNode(screen, (node) => node.type === "TopicList");
  list.props.ref.current = { close: () => closes++ };
  findNode(screen, (node) => node.type === "ScrollView").props.onScrollBeginDrag();
  assert.equal(closes, 1);
  for (const effect of focusEffects) effect()?.();
  assert.equal(closes, 2);
});

test("详情页刷新不会启动背后会话列表的下拉刷新控件", () => {
  const screen = mountWorkspace({ context: { section: "topics", workspace: { refreshing: true } } });
  const control = findNode(screen.render(), (node) => node.type === "ScrollView").props.refreshControl;
  assert.equal(control.props.refreshing, false);
});

test("列表自己的下拉刷新等待请求结束，成功和失败都会收起指示器", async () => {
  for (const fails of [false, true]) {
    let finish;
    const pending = new Promise((resolve, reject) => { finish = () => fails ? reject(new Error("刷新失败")) : resolve(); });
    void pending.catch(() => {});
    const screen = mountWorkspace({ context: { section: "topics", workspace: {
      refreshing: false, refresh: () => pending,
    } } });
    const control = () => findNode(screen.render(), (node) => node.type === "ScrollView").props.refreshControl;
    const result = control().props.onRefresh();
    try {
      assert.equal(control().props.refreshing, true, "请求未结束时保持本页刷新指示器");
    } finally {
      finish();
      await Promise.resolve(result).catch(() => {});
      await flush();
    }
    assert.equal(control().props.refreshing, false, "请求结束后清理本页刷新指示器");
  }
});

test("单个配置档案仍可打开选择，尚无档案时显示空态且不能新建会话", () => {
  for (const profiles of [[{ profile_id: "default", label: "默认" }], []]) {
    const routes = [];
    const screen = mountWorkspace({ router: { push: (route) => routes.push(route) }, context: { section: "topics", workspace: { profiles } } });
    const find = (predicate) => findNode(screen.render(), predicate);
    find((node) => node.props.accessibilityLabel?.startsWith("选择配置档案")).props.onPress();
    assert.ok(find((node) => node.type === "ComposerSheet"));
    if (!profiles.length) {
      assert.ok(find((node) => node.props.children === "暂无可用配置档案"));
      const compose = find((node) => node.props.accessibilityLabel === "新建会话");
      assert.equal(compose.props.disabled, true);
      compose.props.onPress();
      assert.deepEqual(routes, []);
    }
  }
});

test("首页仅在网络和连接器均在线时显示绿点，连接入口保留", () => {
  for (const [network, connector_online, label] of [
    ["online", true, "已连接"], ["online", false, "连接器离线"], ["online", undefined, "连接器离线"],
    ["offline", true, "离线"], ["connecting", true, "连接中…"],
  ]) {
    const routes = [];
    const { screen } = mountWorkspace({ router: { push: (route) => routes.push(route) }, context: { section: "topics", workspace: { network, connector_online } } });
    const connection = findNode(screen, (node) => node.props.accessibilityLabel === `${label}。打开连接设置`);
    assert.ok(connection);
    const dot = findNode(connection, (node) => node.type === "View");
    assert.equal(dot.props.style.at(-1).backgroundColor, label === "已连接" ? "#2F9461" : "#888888");
    connection.props.onPress();
    assert.deepEqual(routes, [{ pathname: "/[page]", params: { page: "connection" } }]);
  }
});

test("普通标签与二级页面把标题交给统一顶栏，二级页面保留返回入口", () => {
  for (const [section, page, title] of [
    ["inbox", undefined, "收件箱"], ["settings", undefined, "设置"],
    ["settings", "manage", "管理"], ["settings", "connection", "连接"], ["settings", "archive", "已归档会话"],
  ]) {
    let backs = 0;
    const { screen } = mountWorkspace({
      params: page ? { page } : {}, router: { back: () => backs++ },
      context: { section, session: { origin: "https://hermes.example" } },
    });
    const header = findNode(screen, (node) => node.type === "PageHeader");
    assert.equal(header?.props.title, title);
    assert.equal(Boolean(header.props.leading), Boolean(page));
    assert.equal(findNode(screen, (node) => node.type === "Text" && node.props.children === "Hermes"), undefined);
    if (page) {
      header.props.leading.props.onPress();
      assert.equal(backs, 1);
    }
  }
});
