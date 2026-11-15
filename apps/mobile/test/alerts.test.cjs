const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function mount(reduced = false) {
  const values = [];
  let cursor = 0;
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: {
      createContext: () => "AlertContext",
      useState(initial) {
        const slot = cursor++;
        if (!(slot in values)) values[slot] = initial;
        return [values[slot], (value) => { values[slot] = typeof value === "function" ? value(values[slot]) : value; }];
      },
      useRef(value) { return values[cursor++] ??= { current: value }; },
      useCallback: (callback) => callback,
      useMemo: (factory) => factory(),
    },
    "react-native": { Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View",
      StyleSheet: { create: (styles) => styles, absoluteFill: {}, hairlineWidth: 1 } },
    "./motion": { useReduceMotion: () => reduced },
    "./overlay": { OverlayModal: "OverlayModal", OverlayNotices: "OverlayNotices" },
    "./theme": { Action: "Action", useTheme: () => ({ colors: {}, styles: {} }) },
  };
  const source = ts.transpileModule(readFileSync(require.resolve("../src/ui/alerts.tsx"), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("exports", "require", source)(exports, (name) => {
    assert.ok(name in modules, name);
    return modules[name];
  });
  const render = () => { cursor = 0; return exports.AlertProvider({ children: "App" }); };
  return { render, alert: (...args) => render().props.value.alert(...args),
    get notices() { return find(render(), (node) => node.type === "OverlayNotices").props.value; } };
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node?.props) return;
  if (predicate(node)) return node;
  return find(node.props.children, predicate);
}
const dialog = (app) => find(app.render(), (node) => node.type === "OverlayModal");
const button = (app, title) => find(app.render(), (node) => node.type === "Action" && node.props.title === title);
const title = (app) => find(app.render(), (node) => node.props.accessibilityRole === "header")?.props.children;

test("提示使用统一毛玻璃弹层，默认确认按钮可关闭，长正文可滚动", () => {
  const app = mount(true);
  app.alert("提示", "正文".repeat(200));
  assert.equal(dialog(app).props.animationType, "none");
  assert.deepEqual(dialog(app).props.supportedOrientations, ["portrait", "landscape-left", "landscape-right"]);
  assert.ok(find(app.render(), (node) => node.type === "ScrollView"));
  assert.equal(find(app.render(), (node) => node.props.role === "alertdialog").props.accessibilityLabel, "提示");
  dialog(app).props.onRequestClose();
  assert.equal(title(app), "提示", "默认系统返回不能丢弃确认");
  button(app, "确定").props.onPress();
  assert.equal(dialog(app), undefined);
});

test("按钮仅执行自己的回调，队列保留后续提示并防止旧按钮重复执行", () => {
  const app = mount(), calls = [];
  app.alert("下载", "确认下载", [{ text: "下载", onPress: () => { calls.push("download"); app.alert("完成"); } }],
    { cancelable: true, onDismiss: () => calls.push("dismiss") });
  app.alert("下一条", undefined, [{ text: "继续", onPress: () => calls.push("next") }]);
  const oldButton = button(app, "下载");
  oldButton.props.onPress();
  assert.equal(title(app), "下一条");
  button(app, "继续").props.onPress();
  oldButton.props.onPress();
  assert.equal(title(app), "完成");
  assert.deepEqual(calls, ["download", "next"]);
});

test("允许取消时系统返回与背景关闭只回调一次 onDismiss，不执行取消按钮", () => {
  const app = mount(), calls = [];
  app.alert("重启", "是否重启", [{ text: "稍后", style: "cancel", onPress: () => calls.push("later") }],
    { cancelable: true, onDismiss: () => calls.push("dismiss") });
  const modal = dialog(app);
  const backdrop = find(app.render(), (node) => node.props.accessibilityLabel === "关闭提示");
  modal.props.onRequestClose();
  backdrop.props.onPress();
  assert.equal(dialog(app), undefined);
  assert.deepEqual(calls, ["dismiss"]);
  app.alert("重启", undefined, [{ text: "稍后", style: "cancel", onPress: () => calls.push("later") }],
    { cancelable: true, onDismiss: () => calls.push("dismiss") });
  button(app, "稍后").props.onPress();
  assert.deepEqual(calls, ["dismiss", "later"]);
});

test("提示从当前最上层弹窗展示，弹窗卸载后回到上一层且不丢失待确认队列", () => {
  const app = mount(), calls = [];
  const unregisterSheet = app.notices.register("sheet");
  const unregisterPreview = app.notices.register("preview");
  app.alert("第一条", undefined, [{ text: "确认", onPress: () => calls.push("confirm") }]);
  app.alert("第二条");
  assert.equal(dialog(app), undefined, "已有原生 Modal 时根层不能再呈现兄弟 Modal");
  assert.equal(app.notices.render("sheet"), null);
  const top = app.notices.render("preview");
  assert.equal(top.type, "OverlayModal");
  assert.equal(top.props.notice, true, "提示不能把自己再次注册为宿主");
  assert.equal(find(top, (node) => node.props.accessibilityRole === "header").props.children, "第一条");
  unregisterPreview();
  assert.equal(app.notices.render("preview"), null);
  const sheetDialog = app.notices.render("sheet");
  find(sheetDialog, (node) => node.type === "Action").props.onPress();
  assert.deepEqual(calls, ["confirm"]);
  unregisterSheet();
  assert.equal(title(app), "第二条");
  button(app, "确定").props.onPress();
  assert.equal(dialog(app), undefined);
});
