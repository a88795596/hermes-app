const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function render(enabled, events) {
  let gesture;
  const exported = {};
  const source = ts.transpileModule(readFileSync(require.resolve("../src/profiles/swipe.tsx"), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const modules = {
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }) },
    "react-native": { View: "View" },
    "react-native-gesture-handler": { GestureDetector: "GestureDetector", usePanGesture(config) { gesture = config; return config; } },
  };
  new Function("exports", "require", source)(exported, (name) => { assert.ok(name in modules, name); return modules[name]; });
  exported.ProfileSwipe({ enabled, onSwitch: (direction) => events.push(direction), children: "transcript" });
  return gesture;
}

test("横划切换一次档案，垂直滚动、短拖动和取消手势不切换", () => {
  const events = [], gesture = render(true, events);
  for (const [x, y, canceled] of [[100, 8, false], [-110, 10, false], [20, 0, false], [120, 50, false], [100, 0, true]]) {
    gesture.onDeactivate({ translationX: x, translationY: y, canceled });
  }
  assert.deepEqual(events, [-1, 1]);
});

test("录音、弹层或单档案禁用切换时不响应横划", () => {
  const events = [], gesture = render(false, events);
  gesture.onDeactivate({ translationX: -110, translationY: 0, canceled: false });
  assert.equal(gesture.enabled, false);
  assert.deepEqual(events, []);
});
