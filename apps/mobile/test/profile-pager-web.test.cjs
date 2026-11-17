const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function mount() {
  const values = [], effects = [], selected = [], phases = [], moves = [];
  let cursor = 0;
  const props = { ref: { current: null }, initialPage: 1, children: ["日常", "研究", "工作"], scrollEnabled: true,
    onPageSelected: (event) => selected.push(event.nativeEvent.position),
    onPageScrollStateChanged: (event) => phases.push(event.nativeEvent.pageScrollState) };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: {
      Children: { count: (children) => children.length, map: (children, fn) => children.map(fn) },
      useRef(current) { return values[cursor++] ??= { current }; },
      useState(initial) { const slot = cursor++; if (!(slot in values)) values[slot] = initial;
        return [values[slot], (value) => { values[slot] = value; }]; },
      useEffect(effect, deps) { const slot = cursor++; if (!values[slot] || deps.some((v, i) => v !== values[slot][i])) effects.push(effect); values[slot] = deps; },
      useImperativeHandle(ref, create) { ref.current = create(); },
    },
    "react-native": { View: "View", ScrollView: "ScrollView" },
  };
  const exported = {};
  const source = ts.transpileModule(readFileSync(require.resolve("../src/profiles/scroll-pager-view.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  new Function("exports", "require", source)(exported, (name) => { assert.ok(name in modules, name); return modules[name]; });
  return { props, selected, phases, moves, render() {
    cursor = 0;
    const tree = exported.default(props);
    tree.props.ref.current = { scrollTo: (options) => moves.push(options) };
    effects.splice(0).forEach((effect) => effect());
    return tree;
  } };
}

test("Web 分页保持初始位置，滚动停稳才落页，窗口变化保持当前页", async () => {
  const app = mount();
  let pager = app.render();
  pager.props.onLayout({ nativeEvent: { layout: { width: 390 } } });
  pager = app.render();
  assert.deepEqual(app.moves.at(-1), { x: 390, animated: false });
  app.props.ref.current.setPage(2);
  assert.deepEqual(app.moves.at(-1), { x: 780, animated: true });
  assert.deepEqual(app.selected, []);
  pager.props.onScroll({ nativeEvent: { contentOffset: { x: 610 } } });
  pager.props.onScroll({ nativeEvent: { contentOffset: { x: 780 } } });
  assert.deepEqual(app.selected, []);
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.deepEqual(app.selected, [2]);
  assert.equal(app.phases.at(-1), "idle");
  pager.props.onLayout({ nativeEvent: { layout: { width: 430 } } });
  app.render();
  assert.deepEqual(app.moves.at(-1), { x: 860, animated: false });
  app.props.ref.current.setPageWithoutAnimation(0);
  assert.deepEqual(app.selected, [2, 0]);
  app.props.ref.current.setPage(10);
  assert.deepEqual(app.moves.at(-1), { x: 0, animated: false });
});

test("触摸按住半页或整页时不提交，拖回原页并松手后才结束分页", async () => {
  const app = mount();
  app.render().props.onLayout({ nativeEvent: { layout: { width: 390 } } });
  const pager = app.render();
  pager.props.onTouchStart?.();
  pager.props.onScroll({ nativeEvent: { contentOffset: { x: 610 } } });
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.deepEqual(app.selected, [], "手指停顿不是落页");
  pager.props.onScroll({ nativeEvent: { contentOffset: { x: 780 } } });
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.deepEqual(app.selected, [], "完整页面仍需等待松手");
  pager.props.onScroll({ nativeEvent: { contentOffset: { x: 390 } } });
  pager.props.onTouchEnd({ nativeEvent: { touches: [] } });
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.deepEqual(app.selected, [1]);
  assert.equal(app.phases.at(-1), "idle");
});
