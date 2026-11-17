const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function mount() {
  const values = [], effects = [], selected = [], moves = [], paging = [];
  let cursor = 0, dismissals = 0;
  const props = { profileIds: ["daily", "research", "work"], profileId: "daily", enabled: true,
    onSelect: (id) => selected.push(id), onMovingChange: (moving) => paging.push(moving), children: ["日常消息", "研究消息"] };
  const source = ts.transpileModule(readFileSync(require.resolve("../src/profiles/pager.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exported = {};
  const jsx = (type, props) => ({ type, props });
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: {
      useRef: (current) => values[cursor++] ??= { current },
      useState(initial) { const slot = cursor++; values[slot] ??= initial; return [values[slot], (value) => { values[slot] = value; }]; },
      useEffect(effect, deps) { const slot = cursor++; if (!values[slot] || deps.some((v, i) => v !== values[slot][i])) effects.push(effect); values[slot] = deps; },
    },
    "react-native": { Keyboard: { dismiss: () => dismissals++ }, View: "View", Platform: { OS: "ios", Version: "18.6" } },
    "./pager-view": { default: "PagerView" },
    "./paging-context": { ProfilePagingContext: "PagingContext" },
    "../ui/motion": { useReduceMotion: () => false },
  };
  new Function("exports", "require", source)(exported, (name) => { assert.ok(name in modules, name); return modules[name]; });
  function render() {
    cursor = 0;
    const tree = exported.ProfilePager(props);
    const pager = tree.props.children;
    pager.props.ref.current = { setPage: (index) => moves.push(["animated", index]), setPageWithoutAnimation: (index) => moves.push(["immediate", index]) };
    effects.splice(0).forEach((effect) => effect());
    return pager;
  }
  return { props, render, selected, moves, paging, get dismissals() { return dismissals; } };
}
const state = (pager, pageScrollState) => pager.props.onPageScrollStateChanged({ nativeEvent: { pageScrollState } });
const select = (pager, position) => pager.props.onPageSelected({ nativeEvent: { position } });

test("跟手拖动期间不切换活动 Profile，落页后才提交并收起键盘", () => {
  const app = mount(), pager = app.render();
  state(pager, "dragging");
  select(pager, 1);
  state(pager, "settling");
  assert.deepEqual(app.selected, []);
  assert.equal(app.dismissals, 1);
  state(pager, "idle");
  assert.deepEqual(app.selected, ["research"]);
  assert.equal(app.paging.at(-1), false);
});

test("取消拖动、无效页码和禁用状态不切换 Profile", () => {
  const app = mount();
  let pager = app.render();
  state(pager, "dragging"); select(pager, 0); state(pager, "idle");
  for (const index of [-1, 3, 1.5]) select(pager, index);
  assert.deepEqual(app.selected, []);
  app.props.enabled = false;
  pager = app.render();
  assert.equal(pager.props.scrollEnabled, false);
  select(pager, 1);
  assert.deepEqual(app.selected, []);
  assert.deepEqual(app.moves.at(-1), ["immediate", 0]);
});

test("头像选择通过原生动画切页，途中经过的页面不覆盖目标", () => {
  const app = mount();
  app.render();
  app.props.targetId = "work";
  const pager = app.render();
  assert.deepEqual(app.moves, [["animated", 2]]);
  state(pager, "settling"); select(pager, 1); state(pager, "idle");
  assert.deepEqual(app.selected, []);
  assert.equal(app.paging.at(-1), true);
  select(pager, 2);
  assert.deepEqual(app.selected, ["work"]);
  assert.equal(app.paging.at(-1), false);
});
