const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function mountPreview({ kind = "markdown", dark = false, glass = true, reduced = false } = {}) {
  const jsx = (type, props) => ({ type, props });
  const state = [];
  let cursor = 0;
  const colors = { background: "page", surface: "sheet", edge: "edge" };
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: {
      useEffect() {},
      useState(initial) {
        const slot = cursor++;
        if (!(slot in state)) state[slot] = initial;
        return [state[slot], (value) => { state[slot] = typeof value === "function" ? value(state[slot]) : value; }];
      },
    },
    "react-native": {
      ActivityIndicator: "ActivityIndicator", Image: "Image", Modal: "Modal", Pressable: "Pressable",
      ScrollView: "ScrollView", Text: "Text", View: "View",
      StyleSheet: { create: (styles) => styles, absoluteFill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }, hairlineWidth: 1 },
      useWindowDimensions: () => ({ width: 390, height: 844 }),
    },
    "expo-glass-effect": { GlassView: "GlassView", isGlassEffectAPIAvailable: () => glass },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "../ui/haptics": { haptic() {} },
    "../ui/motion": { useReduceMotion: () => reduced },
    "../ui/page-header": { PageHeader: "PageHeader" },
    "../ui/theme": { Action: "Action", CloseButton: "CloseButton", Icon: "Icon", Notice: "Notice",
      useTheme: () => ({ colors, dark, styles: {} }) },
    "./attachment-content": { attachmentKind: () => kind },
    "./answer-markdown": { AnswerMarkdown: "AnswerMarkdown" },
    "./html-preview": { HtmlPreview: "HtmlPreview" },
    "./load-attachment": { loadAttachment() { throw new Error("Unexpected download"); } },
    "./media-player": { MediaPlayer: "MediaPlayer" },
  };
  const source = ts.transpileModule(readFileSync(require.resolve("../src/chat/message-attachments.tsx"), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function("exports", "require", source)(exports, (name) => {
    assert.ok(name in modules, name);
    return modules[name];
  });
  const file = exports.MessageAttachments({ items: [{ attachment_id: "file-id", name: "报告", mime: "text/plain", size: 10 }],
    session: {}, tint: "text", onOpenLink() {} }).props.children[0];
  return () => { cursor = 0; return file.type(file.props); };
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node?.props) return;
  if (predicate(node)) return node;
  return find([node.props.children, node.props.trailing], predicate);
}
const flatten = (style) => Object.assign({}, ...[style].flat(Infinity));

test("文件预览的玻璃遮罩覆盖整个窗口，位于清晰面板后且不拦截操作", () => {
  for (const kind of ["markdown", "html", "image"]) for (const dark of [false, true]) {
    const render = mountPreview({ kind, dark });
    find(render(), (node) => node.type === "Pressable").props.onPress();
    const modal = find(render(), (node) => node.type === "Modal");
    assert.equal(modal.props.visible, true);
    const window = modal.props.children;
    const [backdrop, panel] = window.props.children;
    assert.equal(backdrop.props.pointerEvents, "none");
    assert.equal(backdrop.props.accessibilityElementsHidden, true);
    assert.equal(backdrop.props.importantForAccessibility, "no-hide-descendants");
    assert.deepEqual(["top", "right", "bottom", "left"].map((edge) => flatten(backdrop.props.style)[edge]), [0, 0, 0, 0]);
    assert.ok(find(backdrop, (node) => /^rgba\(/.test(flatten(node.props.style).backgroundColor)));
    const glass = find(backdrop, (node) => node.type === "GlassView");
    assert.ok(glass);
    assert.equal(glass.props.colorScheme, dark ? "dark" : "light");
    assert.equal(find(panel, (node) => node.type === "GlassView"), undefined);
    assert.equal(panel.props.accessibilityViewIsModal, true);
    assert.equal(flatten(panel.props.style).backgroundColor, "sheet");
    assert.ok(flatten(panel.props.style).borderTopWidth > 0);
    assert.ok(flatten(panel.props.style).borderTopLeftRadius > 0);
    find(panel, (node) => node.type === "CloseButton").props.onPress();
    assert.equal(find(render(), (node) => node.type === "Modal").props.visible, false);
  }
});

test("不支持玻璃效果时仍有遮罩，减少动态效果和系统返回继续生效", () => {
  const render = mountPreview({ glass: false, reduced: true });
  find(render(), (node) => node.type === "Pressable").props.onPress();
  const modal = find(render(), (node) => node.type === "Modal");
  assert.equal(modal.props.animationType, "none");
  assert.equal(find(modal, (node) => node.type === "GlassView"), undefined);
  assert.ok(find(modal, (node) => /^rgba\(/.test(flatten(node.props.style).backgroundColor)));
  modal.props.onRequestClose();
  assert.equal(find(render(), (node) => node.type === "Modal").props.visible, false);
});
