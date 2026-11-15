const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function mount(file, name, props) {
  const values = [], effects = [], feedback = [];
  let cursor = 0;
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
      case "expo-crypto": return { randomUUID: () => "request-id" };
      case "expo-web-browser": return { openBrowserAsync: async () => {}, WebBrowserPresentationStyle: { PAGE_SHEET: "pageSheet" } };
      case "@hermes-mobile/protocol": return { MAX_ATTACHMENTS: 5, reasoningEfforts: ["low", "high"] };
      case "../ui/haptics": return { haptic: (kind) => feedback.push(kind) };
      case "../ui/motion": return { motion: {}, useReduceMotion: () => true };
      case "../ui/text": return { profileLabel: (label) => label };
      case "../ui/theme": return {
        useTheme: () => ({ colors: {}, styles: {} }), Action: "Action", Card: "Card", CloseButton: "CloseButton",
        EmptyState: "EmptyState", Field: "Field", Icon: "Icon", Notice: "Notice",
      };
      case "./composer-menu": return { reasoningLabels: {}, AttachmentMenu: "AttachmentMenu", ComposerMenu: "ComposerMenu", ReasoningMenu: "ReasoningMenu" };
      case "./model-picker": return { ModelPicker: "ModelPicker" };
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
  return find(node.props.children, predicate);
}
const flush = () => new Promise(setImmediate);
const findSend = (tree) => find(tree, (node) => node.props.accessibilityLabel === "发送");
const findList = (tree) => find(tree, (node) => node.type === "FlatList");

function conversation(enqueue, draft = "测试消息") {
  return mount("conversation", "Conversation", {
    id: "topic", topic: { status: "ready" }, draft, attachments: [], session: {},
    workspace: { ready: true, network: "online", connector_online: true, reasoning_supported: true, profiles: [], pending: [], enqueue },
    onDraftChange() {}, onAttachmentsChange() {},
  });
}

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

async function selectModel(result, { aborted = false, currentModel = "old" } = {}) {
  const screen = mount("model-picker", "ModelPicker", {
    enabled: true, onClose() {}, onSelected() {},
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
