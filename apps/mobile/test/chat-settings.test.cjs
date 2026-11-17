const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function renderDrawer(props, reduced = false) {
  const jsx = (type, props) => ({ type, props });
  const source = ts.transpileModule(readFileSync(require.resolve("../src/chat/settings-drawer.tsx"), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Modal: "Modal", Pressable: "Pressable", Text: "Text", View: "View", Switch: "Switch", ScrollView: "ScrollView",
      StyleSheet: { create: (styles) => styles, absoluteFill: {}, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 390 }) },
    "react-native-reanimated": { __esModule: true, default: { View: "Animated.View" } },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "../ui/overlay": { OverlayModal: "Modal" },
    "../ui/haptics": { haptic() {} },
    "../ui/motion": { motion: { push: { animationDuration: 210 }, fade: {} }, useReduceMotion: () => reduced },
    "../ui/page-header": { PageHeader: "PageHeader" },
    "../ui/theme": { Icon: "Icon", CloseButton: "CloseButton", SectionLabel: "SectionLabel", useTheme: () => ({ colors: {}, styles: {} }) },
  };
  new Function("exports", "require", source)(exports, (name) => {
    assert.ok(name in modules, name);
    return modules[name];
  });
  return exports.SettingsDrawer({ canWrite: true, reasoningLabel: "高", ...props });
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node?.props) return;
  if (predicate(node)) return node;
  return find([node.props.children, node.props.trailing], predicate);
}

test("抽屉保留模型和思考强度操作，移除过程开关", () => {
  const events = [];
  const tree = renderDrawer({ onModel: () => events.push("model"),
    onReasoning: () => events.push("reasoning") });
  assert.equal(tree.type, "Modal");
  for (const label of ["模型", "思考强度：高"]) {
    find(tree, (node) => node.props.accessibilityLabel === label).props.onPress();
  }
  assert.equal(find(tree, (node) => node.type === "Switch"), undefined);
  assert.deepEqual(events, ["model", "reasoning"]);
  assert.equal(find(tree, (node) => node.type === "SafeAreaView").props.accessibilityViewIsModal, true);
});

test("思考请求处理中屏蔽系统返回和遮罩关闭，子页保持同一弹出层", () => {
  let closed = 0;
  for (const busy of [true, false]) {
    const child = { type: "ModelPicker", props: { embedded: true } };
    const tree = renderDrawer({ busy, children: child, onClose: () => closed++ });
    const scrim = find(tree, (node) => node.type === "Pressable" && node.props.accessibilityLabel === "关闭会话设置");
    assert.equal(scrim.props.disabled, busy);
    tree.props.onRequestClose();
    scrim.props.onPress();
    assert.equal(find(tree, (node) => node.type === "ModelPicker"), child);
    assert.equal(find(tree, (node) => node.type === "Switch"), undefined);
  }
  assert.equal(closed, 2);
});

test("减少动态效果时关闭右侧滑入动画", () => {
  for (const reduced of [true, false]) {
    const tree = renderDrawer({}, reduced);
    const panel = find(tree, (node) => node.type === "Animated.View" && node.props.style.some((style) => style?.width));
    const style = Object.assign({}, ...panel.props.style);
    assert.equal(style.width, 358);
    assert.equal(Boolean(style.animationName), !reduced);
  }
});

test("设置中心集中导航和应用设置，当前会话控件仍可操作", () => {
  let model = 0;
  const settingsNavigation = { type: "Navigation", props: { children: "收件箱" } };
  const applicationSettings = { type: "Application", props: { children: "无限会话流" } };
  const tree = renderDrawer({ settingsNavigation, applicationSettings, onModel: () => model++ });
  assert.equal(find(tree, (node) => node.type === "PageHeader").props.title, "设置中心");
  assert.equal(find(tree, (node) => node.type === "Navigation"), settingsNavigation);
  assert.equal(find(tree, (node) => node.type === "Application"), applicationSettings);
  assert.ok(find(tree, (node) => node.type === "ScrollView"));
  find(tree, (node) => node.props.accessibilityLabel === "模型").props.onPress();
  assert.equal(model, 1);
});
