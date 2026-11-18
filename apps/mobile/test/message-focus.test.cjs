const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function mount(props) {
  const values = [], effects = [], calls = [];
  let cursor = 0;
  const exported = {};
  const jsx = (type, props, key) => type?.name === "ConversationTranscript" ? type(props) : ({ type, props, key });
  const source = ts.transpileModule(readFileSync(require.resolve("../src/chat/conversation.tsx"), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("exports", "require", source)(exported, (name) => {
    switch (name) {
      case "react/jsx-runtime": return { jsx, jsxs: jsx, Fragment: "Fragment" };
      case "react": return {
        useState(initial) {
          const index = cursor++;
          if (!(index in values)) values[index] = initial;
          return [values[index], (value) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
        },
        useRef(current) { return values[cursor++] ??= { current }; },
        useImperativeHandle(ref, create) { if (typeof ref === "function") ref(create()); else if (ref) ref.current = create(); },
        useEffect(effect, dependencies) {
          const index = cursor++;
          if (!values[index] || dependencies.some((value, i) => value !== values[index][i])) effects.push(effect);
          values[index] = dependencies;
        },
        useCallback: (callback) => callback,
      };
      case "react-native": return {
        ActivityIndicator: "ActivityIndicator", Pressable: "Pressable", Text: "Text", View: "View", ScrollView: "ScrollView",
        KeyboardAvoidingView: "KeyboardAvoidingView", RefreshControl: "RefreshControl",
        StyleSheet: { create: (styles) => styles, hairlineWidth: 1 }, Platform: { OS: "ios" },
        Keyboard: { dismiss() {} }, useWindowDimensions: () => ({ width: 390 }),
      };
      case "react-native-reanimated": return { default: { View: "Animated.View" } };
      case "react-native-safe-area-context": return { useSafeAreaInsets: () => ({ top: 0 }) };
      case "expo-crypto": return { randomUUID: () => "new-submission" };
      case "expo-web-browser": return {};
      case "@hermes-mobile/protocol": return { MAX_ATTACHMENTS: 5 };
      case "../ui/haptics": return { haptic() {} };
      case "../ui/alerts": return { useAlert: () => ({ alert() {} }) };
      case "../ui/motion": return { motion: {}, useReduceMotion: () => true };
      case "../ui/text": return { profileLabel: (label) => label };
      case "../ui/theme": return {
        useTheme: () => ({ colors: { tint: "highlight" }, styles: {} }), Action: "Action", CloseButton: "CloseButton",
        Field: "Field", Icon: "Icon", Notice: "Notice",
      };
      case "./composer-menu": return { reasoningLabels: {} };
      case "./answer-markdown": return { AnswerMarkdown: "AnswerMarkdown" };
      case "./assistant-stream-border": return { AssistantStreamBorder: "AssistantStreamBorder" };
      case "./message-attachments": return { MessageAttachments: "MessageAttachments" };
      case "./attachments": return {};
      case "./attachment-content": return require("../src/chat/attachment-content.ts");
      case "./model-picker": return {};
      case "./native-command": return { NativeCommandSheet: "NativeCommandSheet" };
      case "./settings-drawer": return {};
      case "./use-speech-input": return { useSpeechInput: (_id, _enabled, draft) => ({
        available: false, state: "idle", busy: false, start: async () => {}, stop: async () => draft,
      }) };
      default: throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  const render = () => {
    cursor = 0;
    const tree = exported.Conversation(props);
    const transcript = find(tree, (node) => node.type === "ScrollView" && node.props.onContentSizeChange);
    transcript.props.ref.current = {
      scrollTo: (options) => calls.push({ kind: "message", ...options }),
      scrollToEnd: () => calls.push({ kind: "end" }),
    };
    effects.splice(0).forEach((effect) => effect());
    return tree;
  };
  return { render, calls };
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node?.props) return;
  if (predicate(node)) return node;
  return find(node.props.children, predicate);
}
const transcript = (tree) => find(tree, (node) => node.type === "ScrollView" && node.props.onContentSizeChange);
const message = (tree, id) => find(tree, (node) => node.key === id);
const layout = (node, y) => node.props.onLayout?.({ nativeEvent: { layout: { y } } });
const reply = (message_id) => ({ message_id, role: "assistant", status: "final", text: message_id });
const scrollEvent = (y) => ({ nativeEvent: { contentSize: { height: 1600 }, layoutMeasurement: { height: 600 }, contentOffset: { y } } });
function props(overrides = {}) {
  return { id: "topic", topic: { status: "ready" }, draft: "下一条", attachments: [], session: {},
    workspace: { ready: true, network: "online", connector_online: true, reasoning_supported: true,
      profiles: [], pending: [], detail: { messages: [] }, enqueue: async () => {} },
    onDraftChange() {}, onAttachmentsChange() {}, ...overrides };
}

test("通知目标异步加载后定位，后续布局变化不跳到底部", () => {
  const input = props({ targetMessageId: "reply" });
  const screen = mount(input);
  transcript(screen.render()).props.onContentSizeChange();
  assert.deepEqual(screen.calls, [], "目标加载前不能跳到底部");
  input.workspace.detail.messages = [reply("earlier"), reply("reply"), reply("later")];
  let tree = screen.render();
  layout(message(tree, "reply"), 480);
  assert.deepEqual(screen.calls.at(-1), { kind: "message", y: 472, animated: false });
  transcript(tree).props.onScroll(scrollEvent(1000));
  transcript(tree).props.onContentSizeChange();
  assert.equal(screen.calls.at(-1).kind, "message", "程序滚动触发 onScroll 不能恢复跟随底部");
  layout(message(tree, "reply"), 620);
  assert.equal(screen.calls.at(-1).y, 612, "图片等内容改变高度后更新目标位置");
});

test("通知定位的回复保持助手样式，只有用户消息显示发送气泡", () => {
  for (const targetMessageId of [undefined, "reply"]) {
    const input = props({ targetMessageId });
    input.workspace.detail.messages = [{ ...reply("question"), role: "user" }, reply("reply")];
    const tree = mount(input).render();
    const answer = message(tree, "reply");
    const hasBubble = (node) => Object.assign({}, ...[node.props.style].flat(Infinity)).backgroundColor === "highlight";
    assert.equal(find(answer, hasBubble), undefined, "助手回复及其容器不能套用发送气泡背景");
    assert.ok(find(answer, (node) => node.type === "AnswerMarkdown" && node.props.text === "reply"));
    const question = message(tree, "question");
    assert.ok(find(question, hasBubble), "用户消息保留发送气泡");
    assert.ok(find(question, (node) => node.props.accessibilityLabel === "你：question"));
  }
});

test("切换通知目标能定位已布局的消息，切换话题不会保留旧目标", () => {
  const input = props({ targetMessageId: "first" });
  input.workspace.detail.messages = [reply("first"), reply("second")];
  const screen = mount(input);
  const tree = screen.render();
  layout(message(tree, "first"), 300);
  layout(message(tree, "second"), 700);
  input.targetMessageId = "second";
  screen.render();
  assert.deepEqual(screen.calls.at(-1), { kind: "message", y: 692, animated: false });
  input.id = "next-topic";
  input.targetMessageId = undefined;
  input.workspace.detail.messages = [];
  transcript(screen.render()).props.onContentSizeChange();
  assert.equal(screen.calls.at(-1).kind, "end");
});

test("用户拖动后不再拉回通知消息，主动到底部或直接发送后恢复跟随", async () => {
  for (const action of ["scroll", "send"]) {
    const input = props({ targetMessageId: "reply" });
    input.workspace.detail.messages = [reply("reply")];
    const screen = mount(input);
    const tree = screen.render();
    layout(message(tree, "reply"), 480);
    const list = transcript(tree);
    if (action === "scroll") {
      list.props.onScrollBeginDrag?.();
      list.props.onScroll(scrollEvent(400));
      screen.calls.length = 0;
      list.props.onContentSizeChange();
      assert.deepEqual(screen.calls, [], "用户阅读其他消息时不强制滚动");
      list.props.onScroll(scrollEvent(1000));
    } else {
      find(tree, (node) => node.props.accessibilityLabel === "发送").props.onPress();
      await new Promise(setImmediate);
    }
    list.props.onContentSizeChange();
    assert.equal(screen.calls.at(-1).kind, "end");
  }
});
