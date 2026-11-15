const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function mountTable(platform = "ios", failLandscape = false) {
  const jsx = (type, props) => ({ type, props });
  const state = [];
  const effects = new Map();
  const calls = [];
  let cursor = 0;
  let pendingEffects = [];
  const children = jsx("View", { children: "指数表格内容" });
  const orientation = { LANDSCAPE: 5, PORTRAIT_UP: 3 };
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    react: {
      useState(initial) {
        const slot = cursor++;
        if (!(slot in state)) state[slot] = typeof initial === "function" ? initial() : initial;
        return [state[slot], (value) => { state[slot] = typeof value === "function" ? value(state[slot]) : value; }];
      },
      useRef(initial) {
        const slot = cursor++;
        if (!(slot in state)) state[slot] = { current: initial };
        return state[slot];
      },
      useEffect(effect, dependencies) {
        const slot = cursor++;
        const previous = effects.get(slot);
        if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) {
          pendingEffects.push(() => {
            previous?.cleanup?.();
            effects.set(slot, { dependencies, cleanup: effect() });
          });
        }
      },
      useMemo: (factory) => factory(),
      useCallback: (callback) => callback,
    },
    "react-native": {
      Modal: "Modal", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View",
      Platform: { OS: platform, select: (options) => options[platform] ?? options.default },
      StyleSheet: { create: (styles) => styles, absoluteFill: {}, hairlineWidth: 1 },
      Alert: { alert() {} },
      useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1, scale: 3 }),
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView", SafeAreaProvider: "SafeAreaProvider" },
    "expo-screen-orientation": {
      OrientationLock: orientation,
      lockAsync: async (lock) => {
        calls.push(lock);
        if (failLandscape && lock === orientation.LANDSCAPE) throw new Error("orientation unavailable");
      },
    },
    "expo-status-bar": { StatusBar: "StatusBar" },
    "../ui/haptics": { haptic() {} },
    "../ui/motion": { useReduceMotion: () => false },
    "../ui/page-header": { PageHeader: "PageHeader" },
    "../ui/theme": {
      Icon: "Icon", CloseButton: "CloseButton", Notice: "Notice",
      useTheme: () => ({ colors: {}, styles: {} }),
    },
  };
  const source = ts.transpileModule(readFileSync(require.resolve("../src/chat/markdown-table.tsx"), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function("exports", "require", source)(exports, (name) => {
    assert.ok(name in modules, name);
    return modules[name];
  });
  function render() {
    cursor = 0;
    pendingEffects = [];
    const tree = exports.MarkdownTable({ columns: 4, children });
    pendingEffects.forEach((effect) => effect());
    return tree;
  }
  const unmount = () => { effects.forEach(({ cleanup }) => cleanup?.()); effects.clear(); };
  return { render, unmount, calls, orientation, children };
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node?.props) return;
  if (predicate(node)) return node;
  return find([node.props.children, node.props.trailing], predicate);
}

const modal = (tree) => find(tree, (node) => node.type === "Modal" && node.props.visible !== false);
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("表格 Modal 完成展示后才锁定横屏，关闭按钮恢复竖屏", async () => {
  for (const platform of ["ios", "android"]) {
    const table = mountTable(platform);
    let tree = table.render();
    assert.equal(modal(tree), undefined);
    assert.deepEqual(table.calls, []);
    find(tree, (node) => node.props.accessibilityLabel === "放大表格").props.onPress();
    tree = table.render();
    await settle();
    assert.ok(modal(tree));
    assert.equal(find(modal(tree), (node) => node === table.children), table.children);
    assert.deepEqual(table.calls, [], "Modal 尚未展示时不能旋转承载它的竖屏页面");
    modal(tree).props.onShow();
    await settle();
    assert.deepEqual(table.calls, [table.orientation.LANDSCAPE]);
    find(modal(tree), (node) => node.type === "CloseButton" && node.props.accessibilityLabel === "关闭表格全屏").props.onPress();
    tree = table.render();
    await settle();
    assert.equal(modal(tree), undefined);
    assert.deepEqual(table.calls, [table.orientation.LANDSCAPE, table.orientation.PORTRAIT_UP]);
    table.unmount();
  }
});

test("系统返回和打开状态卸载均恢复竖屏", async () => {
  for (const exit of ["back", "unmount"]) {
    const table = mountTable("android");
    find(table.render(), (node) => node.props.accessibilityLabel === "放大表格").props.onPress();
    const tree = table.render();
    modal(tree).props.onShow();
    await settle();
    if (exit === "back") {
      modal(tree).props.onRequestClose();
      assert.equal(modal(table.render()), undefined);
    }
    table.unmount();
    await settle();
    assert.deepEqual(table.calls, [table.orientation.LANDSCAPE, table.orientation.PORTRAIT_UP]);
  }
});

test("横屏请求失败时提示错误且仍能关闭全屏", async () => {
  const table = mountTable("ios", true);
  find(table.render(), (node) => node.props.accessibilityLabel === "放大表格").props.onPress();
  modal(table.render()).props.onShow();
  await settle();
  const tree = table.render();
  assert.ok(find(modal(tree), (node) => node.type === "Notice"));
  find(modal(tree), (node) => node.type === "CloseButton" && node.props.accessibilityLabel === "关闭表格全屏").props.onPress();
  assert.equal(modal(table.render()), undefined);
  await settle();
  assert.equal(table.calls.at(-1), table.orientation.PORTRAIT_UP);
  table.unmount();
});

test("Web 可放大和关闭表格，但不调用原生方向锁", async () => {
  const table = mountTable("web");
  find(table.render(), (node) => node.props.accessibilityLabel === "放大表格").props.onPress();
  const tree = table.render();
  assert.ok(modal(tree));
  modal(tree).props.onShow();
  modal(tree).props.onRequestClose();
  assert.equal(modal(table.render()), undefined);
  table.unmount();
  await settle();
  assert.deepEqual(table.calls, []);
});

test("展示前关闭或卸载表格后，迟到的 onShow 不会再锁定横屏", async () => {
  for (const exit of ["close", "unmount"]) {
    const table = mountTable("ios");
    find(table.render(), (node) => node.props.accessibilityLabel === "放大表格").props.onPress();
    const sheet = modal(table.render());
    assert.deepEqual(table.calls, []);
    if (exit === "close") {
      sheet.props.onRequestClose();
      assert.equal(modal(table.render()), undefined);
    } else {
      table.unmount();
    }
    await settle();
    const beforeLateShow = [...table.calls];
    sheet.props.onShow();
    await settle();
    assert.deepEqual(table.calls, beforeLateShow);
    assert.ok(!table.calls.includes(table.orientation.LANDSCAPE));
    if (exit === "close") table.unmount();
  }
});
