const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");
const Image = Object.assign(() => null, { getSize: (_uri, onSize) => onSize(640, 480) });

function mountPreview({ kind = "markdown", dark = false, reduced = false, save = async () => "files" } = {}) {
  const jsx = (type, props) => ({ type, props });
  const state = [];
  const saves = [];
  let cursor = 0;
  let loadEffect;
  const colors = { background: "page", surface: "sheet", edge: "edge" };
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: {
      useEffect(effect) { loadEffect = effect; },
      useRef(initial) {
        const slot = cursor++;
        if (!(slot in state)) state[slot] = { current: initial };
        return state[slot];
      },
      useState(initial) {
        const slot = cursor++;
        if (!(slot in state)) state[slot] = initial;
        return [state[slot], (value) => { state[slot] = typeof value === "function" ? value(state[slot]) : value; }];
      },
    },
    "react-native": {
      ActivityIndicator: "ActivityIndicator", Image, Modal: "Modal", Pressable: "Pressable",
      ScrollView: "ScrollView", Text: "Text", View: "View",
      StyleSheet: { create: (styles) => styles, absoluteFill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }, hairlineWidth: 1 },
      useWindowDimensions: () => ({ width: 390, height: 844 }),
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "../ui/overlay": { OverlayModal: "Modal" },
    "../ui/haptics": { haptic() {} },
    "../ui/motion": { useReduceMotion: () => reduced },
    "../ui/page-header": { PageHeader: "PageHeader" },
    "../ui/theme": { Action: "Action", CloseButton: "CloseButton", Icon: "Icon", Notice: "Notice",
      useTheme: () => ({ colors, dark, styles: {} }) },
    "./attachment-content": { attachmentKind: () => kind },
    "./answer-markdown": { AnswerMarkdown: "AnswerMarkdown" },
    "./html-preview": { HtmlPreview: "HtmlPreview" },
    "./load-attachment": { async loadAttachment() { return { uri: "file:///cache/media", dispose() {} }; },
      saveAttachment: (...args) => { saves.push(args); return save(...args); } },
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
  const render = () => { cursor = 0; return file.type(file.props); };
  render.saves = saves;
  render.load = async () => { loadEffect(); await new Promise(setImmediate); };
  return render;
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node?.props) return;
  if (predicate(node)) return node;
  return find([node.props.children, node.props.trailing], predicate);
}
const flatten = (style) => Object.assign({}, ...[style].flat(Infinity));

test("文件预览使用共享弹出层，内容面板清晰并保留关闭与横屏支持", () => {
  for (const kind of ["markdown", "html", "image"]) for (const dark of [false, true]) {
    const render = mountPreview({ kind, dark });
    find(render(), (node) => node.type === "Pressable").props.onPress();
    const modal = find(render(), (node) => node.type === "Modal");
    assert.equal(modal.props.visible, true);
    assert.equal(modal.props.animationType, "slide");
    assert.deepEqual(modal.props.supportedOrientations, ["portrait", "landscape-left", "landscape-right"]);
    const panel = find(modal, (node) => node.props.accessibilityViewIsModal === true);
    assert.equal(panel.props.importantForAccessibility, "yes");
    assert.equal(flatten(panel.props.style).backgroundColor, "sheet");
    assert.ok(flatten(panel.props.style).borderTopWidth > 0);
    assert.ok(flatten(panel.props.style).borderTopLeftRadius > 0);
    find(panel, (node) => node.type === "CloseButton").props.onPress();
    assert.equal(find(render(), (node) => node.type === "Modal").props.visible, false);
  }
});

test("共享预览弹出层保留减少动态效果和系统返回", () => {
  const render = mountPreview({ reduced: true });
  find(render(), (node) => node.type === "Pressable").props.onPress();
  const modal = find(render(), (node) => node.type === "Modal");
  assert.equal(modal.props.animationType, "none");
  modal.props.onRequestClose();
  assert.equal(find(render(), (node) => node.type === "Modal").props.visible, false);
});

test("收到的文件可直接保存，图片预览内也能保存", async () => {
  const file = mountPreview({ kind: "file" });
  const button = find(file(), (node) => node.type === "Action" && node.props.title === "保存");
  assert.equal(button.props.accessibilityLabel, "保存报告");
  button.props.onPress();
  await new Promise(setImmediate);
  assert.equal(file.saves.length, 1);
  assert.ok(find(file(), (node) => node.props.children === "已保存到文件"));

  const image = mountPreview({ kind: "image" });
  find(image(), (node) => node.type === "Pressable").props.onPress();
  const modal = find(image(), (node) => node.type === "Modal");
  assert.ok(find(modal, (node) => node.type === "Action" && node.props.title === "保存"));
});

test("会话流中的图片和视频在媒体右上角显示独立的保存图标", async () => {
  for (const [kind, mediaType] of [["image", Image], ["video", "MediaPlayer"]]) {
    const render = mountPreview({ kind, save: async () => "album" });
    if (kind === "video") find(render(), (node) => node.props.accessibilityLabel === "打开视频：报告").props.onPress();
    render();
    await render.load();

    const frame = render().props.children[0];
    const button = find(frame, (node) => node.props.accessibilityLabel === "保存报告");
    assert.equal(button?.type, "Pressable", kind);
    assert.equal(button.props.accessibilityRole, "button");
    const { position, top, right } = flatten(button.props.style({ pressed: false }));
    assert.equal(position, "absolute");
    assert.ok(top >= 0 && right >= 0);
    assert.ok(frame.props.children.includes(button));
    assert.ok(find(frame, (node) => node.type === mediaType));
    assert.ok(find(button, (node) => node.type === "Icon" && node.props.name === "download"));
    assert.equal(find(button, (node) => node.type === "Text"), undefined);

    button.props.onPress();
    assert.equal(render.saves.length, 1);
    const pending = find(render(), (node) => node.type === "Pressable" && node.props.accessibilityState?.busy);
    assert.equal(pending?.props.disabled, true);
    await new Promise(setImmediate);
    assert.equal(find(render(), (node) => node.type === "Modal").props.visible, false);
    assert.ok(find(render(), (node) => node.props.children === "已保存到相册"));
  }
});

test("保存期间阻止重复点击，失败时显示错误并允许重试", async () => {
  let reject;
  const pending = new Promise((_resolve, fail) => { reject = fail; });
  const file = mountPreview({ kind: "file", save: () => pending });
  const button = find(file(), (node) => node.type === "Action" && node.props.title === "保存");
  button.props.onPress();
  button.props.onPress();
  assert.equal(file.saves.length, 1);
  assert.ok(find(file(), (node) => node.type === "Action" && node.props.disabled));
  reject(new Error("附件未下载完整，请重试。"));
  await new Promise(setImmediate);
  assert.ok(find(file(), (node) => node.type === "Notice" && node.props.children === "附件未下载完整，请重试。"));
  assert.equal(find(file(), (node) => node.type === "Action" && node.props.title === "保存").props.disabled, false);
});

test("原生文件错误以中文提示，不向界面显示系统异常", async () => {
  const file = mountPreview({ kind: "file", save: async () => { throw new Error("ENOSPC: 报告.pdf write failed"); } });
  find(file(), (node) => node.type === "Action" && node.props.title === "保存").props.onPress();
  await new Promise(setImmediate);
  assert.ok(find(file(), (node) => node.type === "Notice" && node.props.children === "无法保存文件，请检查存储空间或系统权限后重试。"));
});
