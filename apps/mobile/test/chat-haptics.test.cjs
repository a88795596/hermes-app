const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function mount(file, name, props) {
  const values = [], effects = [], feedback = [];
  let cursor = 0;
  let requestSequence = 0;
  const jsx = (type, props) => ({ type, props });
  const exported = {};
  const source = ts.transpileModule(readFileSync(require.resolve(`../src/chat/${file}.tsx`), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("exports", "require", source)(exported, (dependency) => {
    switch (dependency) {
      case "react/jsx-runtime": return { jsx, jsxs: jsx, Fragment: "Fragment" };
      case "react": return {
        useState(initial) {
          const index = cursor++;
          if (!(index in values)) values[index] = initial;
          return [values[index], (next) => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
        },
        useRef(current) { const index = cursor++; return values[index] ??= { current }; },
        useEffect(effect) { const index = cursor++; if (!(index in values)) { values[index] = true; effects.push(effect); } },
        useCallback: (callback) => callback,
        useEffectEvent: (callback) => callback,
      };
      case "react-native": return {
        ActivityIndicator: "ActivityIndicator", FlatList: "FlatList", Modal: "Modal", Pressable: "Pressable",
        Text: "Text", View: "View", ScrollView: "ScrollView", KeyboardAvoidingView: "KeyboardAvoidingView", RefreshControl: "RefreshControl",
        StyleSheet: { create: (styles) => styles, hairlineWidth: 1 }, Platform: { OS: "ios" },
        Keyboard: { dismiss() {} }, useWindowDimensions: () => ({ width: 390, height: 844 }),
      };
      case "react-native-reanimated": return { default: { View: "Animated.View" } };
      case "react-native-safe-area-context": return { SafeAreaView: "SafeAreaView", useSafeAreaInsets: () => ({ top: 0 }) };
      case "expo-crypto": return { randomUUID: () => `request-${++requestSequence}` };
      case "expo-web-browser": return { openBrowserAsync: async () => {}, WebBrowserPresentationStyle: { PAGE_SHEET: "pageSheet" } };
      case "@hermes-mobile/protocol": return { MAX_ATTACHMENTS: 5, reasoningEfforts: ["low", "high"] };
      case "../ui/haptics": return { haptic: (kind) => feedback.push(kind) };
      case "../ui/motion": return { motion: {}, useReduceMotion: () => true };
      case "../ui/text": return { profileLabel: (label) => label };
      case "../ui/page-header": return { PageHeader: "PageHeader" };
      case "../ui/theme": return {
        useTheme: () => ({ colors: {}, styles: {} }), Action: "Action", Card: "Card", CloseButton: "CloseButton",
        EmptyState: "EmptyState", Field: "Field", Icon: "Icon", Notice: "Notice",
      };
      case "./composer-menu": return {
        reasoningLabels: {}, AttachmentMenu: "AttachmentMenu", ComposerMenu: "ComposerMenu", ReasoningMenu: "ReasoningMenu",
        ComposerSheet: "ComposerSheet", PickerRow: "PickerRow",
      };
      case "./model-picker": return { ModelPicker: "ModelPicker" };
      case "./settings-drawer": return { SettingsDrawer: "SettingsDrawer" };
      case "./answer-markdown": return { AnswerMarkdown: "AnswerMarkdown" };
      case "./message-attachments": return { MessageAttachments: "MessageAttachments" };
      case "./attachments": return { pickAttachments: async () => [] };
      default: throw new Error(`Unexpected dependency: ${dependency}`);
    }
  });
  const render = () => { cursor = 0; return exported[name](props); };
  return { render, feedback, effects };
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node?.props) return;
  if (predicate(node)) return node;
  return find([node.props.children, node.props.leading, node.props.trailing, node.props.back], predicate);
}
const flush = () => new Promise(setImmediate);
const findSend = (tree) => find(tree, (node) => node.props.accessibilityLabel === "发送");
const findList = (tree) => find(tree, (node) => node.type === "FlatList");

test("底部选择框的返回、标题和关闭共用顶栏，忙碌时保留关闭保护", () => {
  let closed = 0;
  const back = { type: "Back", props: {} };
  for (const busy of [true, false]) {
    const sheet = mount("composer-menu", "ComposerSheet", {
      title: "选择模型", subtitle: "当前配置档案", back, busy, onClose: () => closed++,
    }).render();
    const header = find(sheet, (node) => node.type === "PageHeader");
    assert.equal(header.props.title, "选择模型");
    assert.equal(header.props.leading, back);
    assert.equal(header.props.trailing.props.disabled, busy);
    assert.ok(find(sheet, (node) => node.props.children === "当前配置档案"));
    sheet.props.onRequestClose();
  }
  assert.equal(closed, 1);
});

function conversation(enqueue, draft = "测试消息", { showProcess = false, messages = [], workspace = {}, ...props } = {}) {
  return mount("conversation", "Conversation", {
    id: "topic", topic: { status: "ready" }, draft, attachments: [], session: {}, showProcess,
    workspace: { ready: true, network: "online", connector_online: true, reasoning_supported: true, profiles: [], pending: [],
      detail: { messages }, enqueue, ...workspace },
    onDraftChange() {}, onAttachmentsChange() {},
    ...props,
  });
}

test("其他页面刷新不会启动会话详情的下拉刷新控件", () => {
  const screen = conversation(async () => {}, "", { workspace: { refreshing: true } });
  const control = find(screen.render(), (node) => node.type === "ScrollView").props.refreshControl;
  assert.equal(control.props.refreshing, false);
});

test("详情自己的下拉刷新等待请求结束，成功和失败都会收起指示器", async () => {
  for (const fails of [false, true]) {
    let finish;
    const pending = new Promise((resolve, reject) => { finish = () => fails ? reject(new Error("刷新失败")) : resolve(); });
    void pending.catch(() => {});
    const screen = conversation(async () => {}, "", { workspace: { refreshing: false, refresh: () => pending } });
    const control = () => find(screen.render(), (node) => node.type === "ScrollView").props.refreshControl;
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

const activeMessage = { message_id: "original", role: "user", text: "整理报告", status: "streaming", submission_id: "active-turn" };

test("执行中与空闲时始终使用同一个发送入口，不由前端选择插话目标", async () => {
  for (const status of ["streaming", "final"]) {
    const queued = [], drafts = [];
    const screen = conversation(async (item) => { queued.push(item); }, " 加上预算 ", {
      messages: [{ ...activeMessage, status }], onDraftChange: (value) => drafts.push(value),
    });
    const tree = screen.render();
    assert.equal(find(tree, (node) => node.props.title === "插话"), undefined);
    const send = findSend(tree);
    assert.ok(send, "发送入口不随运行状态改变");
    assert.equal(send.props.disabled, false);
    send.props.onPress();
    send.props.onPress();
    await flush();
    assert.equal(queued.length, 1);
    assert.deepEqual(Object.keys(queued[0]).sort(), ["created_at", "submission_id", "text", "topic_id"]);
    assert.equal(queued[0].text, "加上预算");
    assert.deepEqual(drafts, [""]);
    assert.deepEqual(screen.feedback, ["medium"]);
  }
});

test("执行中仍允许离线保存和发送附件，不要求客户端知道插话能力", async () => {
  for (const options of [
    { workspace: { connector_online: false, network: "offline" } },
    { workspace: { attachments_supported: true }, attachments: [{ name: "报告.pdf", mime: "application/pdf", size: 10 }] },
  ]) {
    const queued = [];
    const screen = conversation(async (item) => queued.push(item), "补充要求", { messages: [activeMessage], ...options });
    const send = findSend(screen.render());
    assert.ok(send);
    assert.equal(send.props.disabled, false);
    send.props.onPress();
    await flush();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].target_submission_id, undefined);
    assert.deepEqual(queued[0].attachments, options.attachments);
  }
});

test("发送触感确认点击，消息只保存到本地队列时不宣告送达", async () => {
  let queued = 0;
  const screen = conversation(async () => { queued++; });
  const send = findSend(screen.render());
  send.props.onPress();
  await flush();
  assert.equal(queued, 1);
  assert.deepEqual(screen.feedback, ["medium"]);
});

test("本地消息保存失败提示错误，禁用的发送不触发触感", async () => {
  const failed = conversation(async () => { throw new Error("disk full"); });
  findSend(failed.render()).props.onPress();
  await flush();
  assert.deepEqual(failed.feedback, ["medium", "error"]);
  const disabled = conversation(async () => assert.fail("empty message must not enqueue"), "");
  findSend(disabled.render()).props.onPress();
  await flush();
  assert.deepEqual(disabled.feedback, []);
});

test("过程开关只控制时间线，已结束回复保留未确认的工具结果", () => {
  const messages = [{ message_id: "reply", role: "assistant", text: "已整理。", status: "final", process: [
    { kind: "reasoning", text: "先按紧急程度整理。" },
    { kind: "tool", id: "tool", name: "读取笔记", status: "running" },
  ] }];
  const processLabel = (node) => node.props.accessibilityRole === "header" && node.props.children === "思考";
  for (const showProcess of [true, false]) {
    const screen = conversation(async () => {}, "", { showProcess, messages }).render();
    const timeline = find(screen, (node) => node.props.steps === messages[0].process);
    const process = timeline?.type(timeline.props);
    assert.equal(Boolean(find(process, processLabel)), showProcess);
    assert.equal(Boolean(find(process, (node) => node.props.children === "读取笔记 · 结果未确认")), showProcess);
    assert.equal(find(screen, (node) => node.type === "AnswerMarkdown").props.text, "已整理。");
  }
});

test("已结束的纯附件回复在隐藏过程时仍展示文件", () => {
  const attachments = [{ attachment_id: "file", name: "报告.pdf", mime: "application/pdf", size: 10 }];
  const messages = [{ message_id: "delivery", role: "assistant", text: "", status: "final", attachments }];
  for (const showProcess of [true, false]) {
    const screen = conversation(async () => {}, "", { showProcess, messages }).render();
    assert.deepEqual(find(screen, (node) => node.type === "MessageAttachments")?.props.items, attachments);
  }
});

async function selectModel(result, { aborted = false, currentModel = "old", global = false, onSelected = () => {} } = {}) {
  const screen = mount("model-picker", "ModelPicker", {
    enabled: true, onClose() {}, onSelected,
    onRequest: async (_id, selection) => selection ? result : {
      status: "ok", model_result: { type: "catalog", catalog: { provider: "p", model: currentModel, providers: [{ id: "p", name: "Provider", models: ["new"] }] } },
    },
  });
  screen.render();
  const cleanup = screen.effects.map((effect) => effect());
  await flush();
  assert.deepEqual(screen.feedback, [], "catalog loading stays silent");
  let list = findList(screen.render());
  list.props.renderItem({ item: list.props.data[0] }).props.onPress();
  list = findList(screen.render());
  list.props.renderItem({ item: list.props.data[0] }).props.onPress();
  find(screen.render(), (node) => node.props.title === (global ? "设为默认模型" : "仅当前会话")).props.onPress();
  if (aborted) cleanup.forEach((dispose) => dispose?.());
  await flush();
  return screen.feedback;
}

test("仅已生效的模型切换提示成功，排队与取消请求保持静默", async () => {
  const selection = { provider: "p", model: "new" };
  assert.deepEqual(await selectModel({ status: "ok", model_result: { type: "selected", selection } }), ["success"]);
  assert.deepEqual(await selectModel({ status: "ok", model_result: { type: "deferred", selection } }), []);
  assert.deepEqual(await selectModel({ status: "ok", model_result: { type: "selected", selection } }, { aborted: true }), []);
  assert.deepEqual(await selectModel({ status: "ok", model_result: { type: "selected", selection } }, { currentModel: "new" }), []);
});

test("旧服务端未回执 Global 时不宣告默认模型保存成功", async () => {
  const feedback = await selectModel({ status: "ok", model_result: {
    type: "selected", selection: { provider: "p", model: "new" },
  } }, { global: true, onSelected: () => assert.fail("缺少默认模型保存回执不能报成功") });
  assert.deepEqual(feedback, ["warning"]);
});

test("模型风险确认与明确失败使用对应提示，自动加载失败不振动", async () => {
  assert.deepEqual(await selectModel({ status: "ok", model_result: { type: "confirmation", confirm: "token", message: "费用变化" } }), ["warning"]);
  assert.deepEqual(await selectModel({ status: "error", error: "切换失败" }), ["error"]);
  assert.deepEqual(await selectModel({ status: "unknown", error: "结果待确认" }), ["warning"]);
  const screen = mount("model-picker", "ModelPicker", {
    enabled: true, onClose() {}, onSelected() {}, onRequest: async () => { throw new Error("offline"); },
  });
  screen.render();
  screen.effects.forEach((effect) => effect());
  await flush();
  assert.deepEqual(screen.feedback, []);
});

test("选定模型后先确认范围，仅设为默认时发送 Global，取消不提交", async () => {
  for (const global of [false, true, undefined]) {
    const writes = [], selected = [];
    const screen = mount("model-picker", "ModelPicker", {
      enabled: true, profileLabel: "日常助手", onClose() {},
      onSelected: (...args) => selected.push(args),
      onRequest: async (_id, selection) => {
        if (!selection) return { status: "ok", model_result: { type: "catalog", catalog: {
          provider: "p", model: "old", providers: [{ id: "p", name: "Provider", models: ["new"] }],
        } } };
        writes.push(selection);
        return { status: "ok", model_result: { type: "selected", global: selection.global, selection: { provider: "p", model: "new" } } };
      },
    });
    screen.render();
    screen.effects.forEach((effect) => effect());
    await flush();
    for (let i = 0; i < 2; i++) {
      const list = findList(screen.render());
      list.props.renderItem({ item: list.props.data[0] }).props.onPress();
    }
    assert.deepEqual(writes, [], "选择模型不能跳过范围确认直接修改配置");
    assert.ok(find(screen.render(), (node) => node.type === "Text"
      && JSON.stringify(node.props.children).includes("日常助手")));
    if (global === undefined) {
      find(screen.render(), (node) => node.props.accessibilityLabel === "返回模型列表").props.onPress();
      assert.ok(findList(screen.render()), "取消范围选择后回到模型列表");
      assert.deepEqual(writes, []);
    } else {
      find(screen.render(), (node) => node.props.title === (global ? "设为默认模型" : "仅当前会话")).props.onPress();
      await flush();
      assert.deepEqual(writes, [{ provider: "p", model: "new", global }]);
      assert.equal(selected[0][1], global);
    }
  }
});

test("默认模型的费用确认和网络重试保留 Global 与原请求编号", async () => {
  const writes = [], selected = [];
  const props = {
    enabled: true, onClose() {}, onSelected: (...args) => selected.push(args),
    onRequest: async (id, selection) => {
      if (!selection) return { status: "ok", model_result: { type: "catalog", catalog: {
        provider: "p", model: "old", providers: [{ id: "p", name: "Provider", models: ["new"] }],
      } } };
      writes.push({ id, ...selection });
      if (writes.length === 1) return { status: "ok", model_result: {
        type: "confirmation", confirm: "expense-token", message: "费用变化",
      } };
      if (writes.length === 2) throw new Error("网络中断");
      return { status: "ok", model_result: { type: "selected", global: true, selection: { provider: "p", model: "new" } } };
    },
  };
  const screen = mount("model-picker", "ModelPicker", props);
  screen.render();
  screen.effects.forEach((effect) => effect());
  await flush();
  for (let i = 0; i < 2; i++) {
    const list = findList(screen.render());
    list.props.renderItem({ item: list.props.data[0] }).props.onPress();
  }
  find(screen.render(), (node) => node.props.title === "设为默认模型").props.onPress();
  await flush();
  assert.deepEqual(selected, []);
  find(screen.render(), (node) => node.props.title === "确认切换").props.onPress();
  await flush();
  assert.deepEqual(selected, []);
  assert.equal(find(screen.render(), (node) => node.props.title === "确认切换").props.disabled, true);
  props.enabled = false;
  find(screen.render(), (node) => node.props.title === "重新查询请求状态").props.onPress();
  await flush();
  assert.ok(writes.every((selection) => selection.global === true));
  assert.deepEqual(writes[1], writes[2], "重试必须使用带相同确认凭证的原请求");
  assert.equal(writes[1].confirm, "expense-token");
  assert.equal(selected[0][1], true);
});

test("思考强度只在确认完成后提示成功，取消后不触发反馈", async () => {
  for (const [result, expected, aborted, effort = "low"] of [
    [{ status: "ok" }, ["success"], false],
    [{ status: "error", error: "切换失败" }, ["error"], false],
    [{ status: "unknown", error: "结果待确认" }, ["warning"], false],
    [{ status: "ok" }, [], true],
    [{ status: "ok" }, [], false, "high"],
  ]) {
    const screen = mount("composer-menu", "ReasoningMenu", {
      effort, onClose() {}, onRequest: async () => result,
    });
    const tree = screen.render();
    const cleanup = screen.effects.map((effect) => effect());
    find(tree, (node) => node.props.title === "高").props.onPress();
    if (aborted) cleanup.forEach((dispose) => dispose?.());
    await flush();
    assert.deepEqual(screen.feedback, expected);
  }
});

test("思考强度请求超时后只允许查询同一档位的请求", async () => {
  const requests = [];
  const props = {
    effort: "low", onClose() {},
    async onRequest(id, effort) {
      requests.push({ id, effort });
      if (requests.length === 1) throw new Error("Hermes 尚未确认请求");
      return { status: "ok" };
    },
  };
  const screen = mount("composer-menu", "ReasoningMenu", props);
  const row = (title) => find(screen.render(), (node) => node.props.title === title).props;
  row("高").onPress();
  await flush();
  props.status = "pending";
  assert.equal(row("低").disabled, true);
  assert.equal(row("高").disabled, false);
  row("高").onPress();
  await flush();
  assert.deepEqual(requests, [{ id: "request-1", effort: "high" }, { id: "request-1", effort: "high" }]);
});
