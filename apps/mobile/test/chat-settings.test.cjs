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
    "react-native": { Modal: "Modal", Pressable: "Pressable", Text: "Text", View: "View", Switch: "Switch",
      StyleSheet: { create: (styles) => styles, absoluteFill: {}, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 390 }) },
    "react-native-reanimated": { __esModule: true, default: { View: "Animated.View" } },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "../ui/haptics": { haptic() {} },
    "../ui/motion": { motion: { push: { animationDuration: 210 }, fade: {} }, useReduceMotion: () => reduced },
    "../ui/page-header": { PageHeader: "PageHeader" },
    "../ui/theme": { Icon: "Icon", CloseButton: "CloseButton", useTheme: () => ({ colors: {}, styles: {} }) },
  };
  new Function("exports", "require", source)(exports, (name) => {
    assert.ok(name in modules, name);
    return modules[name];
  });
  return exports.SettingsDrawer({ canWrite: true, reasoningLabel: "高", showProcess: false, ...props });
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node?.props) return;
  if (predicate(node)) return node;
  return find([node.props.children, node.props.trailing], predicate);
}

test("抽屉集中呈现模型、思考强度和过程开关，并保持各自操作", () => {
  const events = [];
  const tree = renderDrawer({ showProcess: true, onModel: () => events.push("model"),
    onReasoning: () => events.push("reasoning"), onToggleProcess: () => events.push("process") });
  assert.equal(tree.type, "Modal");
  for (const label of ["模型", "思考强度：高"]) {
    find(tree, (node) => node.props.accessibilityLabel === label).props.onPress();
  }
  const toggle = find(tree, (node) => node.type === "Switch");
  assert.equal(toggle.props.value, true);
  toggle.props.onValueChange(false);
  assert.deepEqual(events, ["model", "reasoning", "process"]);
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
