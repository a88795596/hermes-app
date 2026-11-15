const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

const source = ts.transpileModule(readFileSync(require.resolve("../src/chat/topic-list.tsx"), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
}).outputText;
const rows = [
  { id: "one", title: "第一条会话", status: "等待发送", newProfileId: "work" },
  { id: "two", title: "第二条会话", status: "" },
];

function mountList(options = {}) {
  const states = new Map(), handles = new Map(), effects = [];
  const archived = [], opened = [], feedback = [], ref = { current: null };
  const props = { rows, archived: false, busy: false, onArchive: (row) => archived.push(row),
    onOpen: (row) => opened.push(row), ref, ...options };
  let values, cursor;
  const jsx = (type, props, key) => ({ type, props, key });
  const animation = (name) => ({ duration: (duration) => ({ name, duration }) });
  const exports = {};
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: {
      useRef(current) { return values[cursor++] ??= { current }; },
      useState(initial) {
        const state = values[cursor++] ??= { value: initial };
        return [state.value, (value) => { state.value = value; }];
      },
      useEffect(effect) {
        const state = values[cursor++] ??= {};
        if (!state.mounted) { state.mounted = true; effects.push(() => { state.cleanup = effect(); }); }
      },
      useImperativeHandle(target, create) { if (target) target.current = create(); },
    },
    "react-native": { Pressable: "Pressable", Text: "Text", View: "View",
      StyleSheet: { create: (style) => style, hairlineWidth: 1 } },
    "react-native-gesture-handler/ReanimatedSwipeable": { __esModule: true, default: "Swipeable" },
    "react-native-reanimated": { __esModule: true, default: { View: "Animated.View" },
      FadeOut: animation("fade"), LinearTransition: animation("layout"),
      ReduceMotion: { Always: "always", Never: "never" }, useAnimatedStyle: (style) => style() },
    "../ui/haptics": { haptic: (kind) => feedback.push(kind) },
    "../ui/motion": { useReduceMotion: () => !!props.reduced },
    "../ui/theme": { Action: "Action", Icon: "Icon", SectionLabel: "SectionLabel",
      useTheme: () => ({ colors: { background: "background" }, styles: {} }) },
    "./topic-groups": { groupTopics: (rows) => [{ title: "今天", rows }], formatTopicTime: () => "12:00" },
  };
  new Function("exports", "require", source)(exports, (name) => {
    assert.ok(name in modules, name);
    return modules[name];
  });
  function resolve(node, path = "list") {
    if (Array.isArray(node)) return node.map((child, index) => resolve(child, `${path}/${child?.key ?? index}`));
    if (!node?.props) return node;
    if (typeof node.type === "function") {
      const id = node.props.row?.id ?? path;
      values = states.get(id) ?? [];
      states.set(id, values);
      cursor = 0;
      return resolve(node.type(node.props), id);
    }
    if (node.type === "Swipeable") {
      const handle = handles.get(path) ?? { closes: 0, close() { this.closes++; } };
      handles.set(path, handle);
      node.props.ref.current = handle;
    }
    return { ...node, props: { ...node.props, children: resolve(node.props.children, path) } };
  }
  function render() {
    const tree = resolve(jsx(exports.TopicList, props));
    while (effects.length) effects.shift()();
    return tree;
  }
  return { props, render, resolve, ref, archived, opened, feedback };
}

function all(node, predicate) {
  if (Array.isArray(node)) return node.flatMap((child) => all(child, predicate));
  if (!node?.props) return [];
  return [...(predicate(node) ? [node] : []), ...all(node.props.children, predicate)];
}
const swipes = (list) => all(list.render(), (node) => node.type === "Swipeable");
const openButton = (node) => all(node, (child) => child.type === "Pressable")[0];
const action = (list, swipe) => list.resolve(swipe.props.renderRightActions({ value: 1 }, { value: -80 }));

test("左滑只展示归档，第二行打开关闭第一行，晚到的关闭回调不清除当前行", () => {
  const list = mountList();
  let [first, second] = swipes(list);
  first.props.onSwipeableOpenStartDrag();
  first.props.onSwipeableWillOpen();
  assert.deepEqual(list.archived, []);
  assert.equal(action(list, swipes(list)[0]).props.accessibilityElementsHidden, false);
  second.props.onSwipeableOpenStartDrag();
  second.props.onSwipeableWillOpen();
  assert.equal(first.props.ref.current.closes, 1);
  first.props.onSwipeableClose();
  list.ref.current.close();
  assert.equal(second.props.ref.current.closes, 1);
  second.props.onSwipeableWillClose();
  second.props.onSwipeableClose();
  list.ref.current.close();
  assert.equal(second.props.ref.current.closes, 1);
  assert.equal(action(list, swipes(list)[1]).props.importantForAccessibility, "no-hide-descendants");
});

test("手势库更新 methods 对象后仍按行互斥并清理关闭状态", () => {
  const list = mountList();
  const [first, second] = swipes(list);
  first.props.onSwipeableOpenStartDrag();
  const oldHandle = first.props.ref.current;
  const newHandle = { closes: 0, close() { this.closes++; } };
  first.props.ref.current = newHandle;
  first.props.onSwipeableWillOpen();
  assert.equal(oldHandle.closes, 0, "同一行的 handle 变化不应触发自己关闭");
  assert.equal(newHandle.closes, 0);
  list.ref.current.close();
  assert.equal(newHandle.closes, 1, "关闭使用该行的最新 handle");
  first.props.onSwipeableClose();
  list.ref.current.close();
  assert.equal(newHandle.closes, 1, "关闭完成后清除当前行");
  first.props.onSwipeableWillOpen();
  second.props.onSwipeableOpenStartDrag();
  assert.equal(newHandle.closes, 2, "打开另一行关闭旧行的最新 handle");
  first.props.onSwipeableClose();
  list.ref.current.close();
  assert.equal(second.props.ref.current.closes, 1, "旧行回调不影响当前行");
});

test("点击归档传递完整行，正文仍打开会话并收起菜单", () => {
  const list = mountList();
  const [first, second] = swipes(list);
  first.props.onSwipeableWillOpen();
  all(action(list, first), (node) => node.type === "Action")[0].props.onPress();
  assert.equal(list.archived[0], rows[0]);
  assert.equal(first.props.ref.current.closes, 1);
  second.props.onSwipeableWillOpen();
  openButton(first).props.onPress();
  assert.equal(list.opened[0], rows[0]);
  assert.equal(second.props.ref.current.closes, 1);
  assert.deepEqual(list.feedback, ["warning", "light"]);
});

test("归档辅助操作可用，处理中同时禁止左滑、按钮和辅助操作", () => {
  for (const busy of [false, true]) {
    const list = mountList({ busy });
    const [first] = swipes(list);
    const button = openButton(first);
    assert.equal(first.props.enabled, !busy);
    assert.deepEqual(button.props.accessibilityActions, busy ? undefined : [{ name: "archive", label: "归档" }]);
    button.props.onAccessibilityAction({ nativeEvent: { actionName: "activate" } });
    assert.deepEqual(list.archived, []);
    button.props.onAccessibilityAction({ nativeEvent: { actionName: "archive" } });
    const archive = all(action(list, first), (node) => node.type === "Action")[0];
    assert.equal(archive.props.disabled, busy);
    archive.props.onPress();
    assert.deepEqual(list.archived, busy ? [] : [rows[0], rows[0]]);
  }
});

test("已归档列表保留恢复按钮且没有滑动归档", () => {
  for (const busy of [false, true]) {
    const list = mountList({ archived: true, busy });
    const tree = list.render();
    assert.equal(all(tree, (node) => node.type === "Swipeable").length, 0);
    assert.equal(openButton(tree).props.accessibilityActions, undefined);
    const restore = all(tree, (node) => node.props.accessibilityLabel === `恢复会话：${rows[0].title}`)[0];
    assert.equal(restore.props.disabled, busy);
    restore.props.onPress();
    assert.deepEqual(list.archived, busy ? [] : [rows[0]]);
    assert.deepEqual(list.feedback, busy ? [] : ["medium"]);
  }
});

test("减少动态效果时关闭弹簧与列表布局、退出动画", () => {
  for (const reduced of [false, true]) {
    const list = mountList({ reduced });
    const tree = list.render();
    const [first] = all(tree, (node) => node.type === "Swipeable");
    assert.equal(first.props.animationOptions.reduceMotion, reduced ? "always" : "never");
    const containers = all(tree, (node) => node.type === "Animated.View");
    assert.equal(containers.some((node) => node.props.layout), !reduced);
    assert.equal(containers.some((node) => node.props.exiting), !reduced);
  }
});
