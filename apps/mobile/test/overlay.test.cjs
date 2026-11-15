const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

const source = ts.transpileModule(readFileSync(require.resolve("../src/ui/overlay.tsx"), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
}).outputText;
function mount(platform = "ios", dark = false, reduced = false, notices) {
  const values = [], disposers = [];
  let contextIndex = 0;
  const target = { current: "underlying-screen" };
  let cursor = 0, listener, resolvePreference, removed = false;
  const jsx = (type, props) => ({ type, props });
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    react: {
      createContext: () => contextIndex++ === 0 ? "Notices" : "BlurContext", useContext: (context) => context === "Notices" ? notices : target, useId: () => "host-1", useRef: (current) => ({ current }),
      useState(initial) {
        const slot = cursor++;
        if (!(slot in values)) values[slot] = initial;
        return [values[slot], (next) => { values[slot] = next; }];
      },
      useEffect(callback) {
        const slot = cursor++;
        if (!(slot in values)) { values[slot] = true; disposers.push(callback()); }
      },
    },
    "react-native-reanimated": { __esModule: true, default: { View: "Animated.View" } },
    "./motion": { motion: { fade: { animationDuration: 150 }, push: { animationDuration: 210 } }, useReduceMotion: () => reduced },
    "expo-blur": { BlurTargetView: "BlurTargetView", BlurView: "BlurView" },
    "react-native": { useWindowDimensions: () => ({ height: 844 }), Modal: "Modal", View: "View", Platform: { OS: platform },
      StyleSheet: { create: (value) => value, absoluteFill: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 } },
      AccessibilityInfo: { addEventListener: (name, callback) => {
        assert.equal(name, "reduceTransparencyChanged"); listener = callback; return { remove: () => { removed = true; } };
      }, isReduceTransparencyEnabled: () => new Promise((resolve) => { resolvePreference = resolve; }) } },
    "./theme": { useTheme: () => ({ colors: { background: "opaque" }, dark }) },
  };
  const exports = {};
  new Function("exports", "require", source)(exports, (name) => { assert.ok(name in modules, name); return modules[name]; });
  return { ...exports, target, render: () => { cursor = 0; return exports.OverlayBackdrop(); },
    preference: (value) => resolvePreference(value), change: (value) => listener(value),
    unmount: () => disposers.forEach((dispose) => dispose?.()), get removed() { return removed; } };
}
function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node?.props) return;
  if (predicate(node)) return node;
  return find(node.props.children, predicate);
}

test("每个平台使用真正模糊、正确主题和 Android 取景目标，装饰层不拦截操作", () => {
  for (const platform of ["ios", "android", "web"]) for (const dark of [false, true]) {
    const app = mount(platform, dark);
    const tree = app.render();
    assert.equal(tree.props.pointerEvents, "none");
    assert.equal(tree.props.accessibilityElementsHidden, true);
    assert.equal(tree.props.importantForAccessibility, "no-hide-descendants");
    assert.deepEqual(["left", "right", "top", "bottom"].map((key) => Object.assign({}, ...tree.props.style)[key]), [0, 0, 0, 0]);
    const blur = find(tree, (node) => node.type === "BlurView");
    assert.equal(blur.props.blurTarget, app.target);
    assert.equal(blur.props.blurMethod, "dimezisBlurView");
    assert.equal(blur.props.tint, dark ? "dark" : "light");
    assert.ok(blur.props.intensity > 0);
    app.unmount();
  }
});

test("透明弹出窗口保留展示和关闭回调，嵌套弹窗取景目标不包含自己的遮罩", () => {
  const app = mount("android");
  let closes = 0, shows = 0;
  const content = { type: "Content", props: {} };
  const tree = app.OverlayModal({ children: content, onRequestClose: () => closes++, onShow: () => shows++, animationType: "fade" });
  assert.equal(tree.type, "Modal");
  assert.equal(tree.props.transparent, true);
  assert.equal(tree.props.presentationStyle, "overFullScreen");
  assert.equal(tree.props.statusBarTranslucent, true);
  assert.equal(tree.props.navigationBarTranslucent, true);
  assert.equal(tree.props.hardwareAccelerated, true);
  tree.props.onRequestClose(); tree.props.onShow();
  assert.deepEqual([closes, shows], [1, 1]);
  const [backdrop, panel] = tree.props.children.props.children;
  const nested = panel.props.children;
  assert.equal(backdrop.type, app.OverlayBackdrop);
  assert.equal(nested.type, app.OverlayRoot);
  assert.equal(nested.props.children[0], content);
  const root = app.OverlayRoot({ children: content });
  assert.equal(root.props.children.type, "BlurTargetView");
  assert.equal(root.props.value, root.props.children.props.ref);
  assert.equal(app.OverlayModal({ visible: false, children: content }), null);
});

test("减少透明度偏好实时生效，过期初始查询不覆盖新偏好，卸载移除监听", async () => {
  const app = mount();
  app.render();
  app.change(true);
  app.preference(false);
  await new Promise(setImmediate);
  assert.equal(find(app.render(), (node) => node.type === "BlurView"), undefined);
  assert.ok(find(app.render(), (node) => node.props.style?.some?.((style) => style.backgroundColor === "opaque")));
  app.change(false);
  assert.ok(find(app.render(), (node) => node.type === "BlurView"));
  app.unmount();
  assert.equal(app.removed, true);
});

test("背景固定以透明度渐入，原生窗口不移动，内容独立滑入且遵循减少动态效果", () => {
  for (const reduced of [false, true]) for (const animationType of ["slide", "fade", "none"]) {
    const app = mount("ios", false, reduced);
    const tree = app.OverlayModal({ animationType });
    assert.equal(tree.props.animationType, "none");
    const [backdrop, panel] = tree.props.children.props.children;
    assert.equal(backdrop.type, app.OverlayBackdrop);
    const backgroundStyle = Object.assign({}, ...app.render().props.style);
    const panelStyle = Object.assign({}, ...panel.props.style);
    assert.equal(backgroundStyle.position, "absolute");
    if (reduced) {
      assert.equal(backgroundStyle.animationName, undefined);
      assert.equal(panelStyle.animationName, undefined);
    } else {
      assert.deepEqual(backgroundStyle.animationName, { from: { opacity: 0 }, to: { opacity: 1 } });
      if (animationType === "slide") {
        assert.deepEqual(panelStyle.animationName.from.transform, [{ translateY: 844 }]);
        assert.deepEqual(panelStyle.animationName.to.transform, [{ translateY: 0 }]);
      } else if (animationType === "none") assert.equal(panelStyle.animationName, undefined);
    }
    app.unmount();
  }
});

test("普通弹层注册提示宿主，提示自身不重复注册，隐藏或卸载移除宿主", () => {
  for (const props of [{}, { notice: true }, { visible: false }]) {
    const registered = [], removed = [], rendered = [];
    const app = mount("ios", false, false, {
      register: (id) => { registered.push(id); return () => removed.push(id); },
      render: (id) => { rendered.push(id); return "active-notice"; },
    });
    const tree = app.OverlayModal(props);
    const hosts = !props.notice && props.visible !== false;
    assert.deepEqual(registered, hosts ? ["host-1"] : []);
    assert.deepEqual(rendered, hosts ? ["host-1"] : []);
    if (hosts) {
      const panel = tree.props.children.props.children[1];
      assert.equal(panel.props.children.props.children[1], "active-notice");
    }
    app.unmount();
    assert.deepEqual(removed, registered);
  }
});
