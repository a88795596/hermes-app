const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function compile(path) {
  return ts.transpileModule(readFileSync(join(__dirname, path), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

function loadHaptics(platform = "ios", state = "active", fail) {
  const calls = [];
  const exports = {};
  const native = Object.fromEntries(["selectionAsync", "impactAsync", "notificationAsync", "performAndroidHapticsAsync"]
    .map((method) => [method, (...args) => { calls.push([method, ...args]); return fail?.() ?? Promise.resolve(); }]));
  Object.assign(native, {
    ImpactFeedbackStyle: { Light: "light", Medium: "medium" },
    NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
    AndroidHaptics: { Segment_Tick: "segment-tick", Virtual_Key: "virtual-key", Context_Click: "context-click", Long_Press: "long-press", Confirm: "confirm", Reject: "reject" },
  });
  new Function("exports", "require", compile("../src/ui/haptics.ts"))(exports, (name) => {
    if (name === "expo-haptics") return native;
    if (name === "react-native") return { Platform: { OS: platform }, AppState: { currentState: state } };
    throw new Error(`Unexpected dependency: ${name}`);
  });
  return { haptic: exports.haptic, calls };
}

test("iOS 区分选择、轻触、中等确认以及成功、警告、失败", () => {
  const { haptic, calls } = loadHaptics();
  for (const kind of ["selection", "light", "medium", "success", "warning", "error"]) haptic(kind);
  assert.deepEqual(calls, [["selectionAsync"], ["impactAsync", "light"], ["impactAsync", "medium"],
    ["notificationAsync", "success"], ["notificationAsync", "warning"], ["notificationAsync", "error"]]);
});

test("Android 使用系统触觉语义并保留等级差异", () => {
  const { haptic, calls } = loadHaptics("android");
  for (const kind of ["selection", "light", "medium", "success", "warning", "error"]) haptic(kind);
  assert.deepEqual(calls, ["segment-tick", "virtual-key", "context-click", "confirm", "long-press", "reject"]
    .map((effect) => ["performAndroidHapticsAsync", effect]));
});

test("Web 和后台不震动", () => {
  for (const [platform, state] of [["web", "active"], ["ios", "background"], ["android", "inactive"]]) {
    const { haptic, calls } = loadHaptics(platform, state);
    haptic("success");
    assert.deepEqual(calls, []);
  }
});

test("不支持的硬件、同步异常和异步拒绝不会中断操作", async () => {
  for (const fail of [() => { throw new Error("unavailable"); }, () => Promise.reject(new Error("disabled"))]) {
    const { haptic } = loadHaptics("ios", "active", fail);
    assert.doesNotThrow(() => haptic("light"));
    await new Promise(setImmediate);
  }
});

function loadControls() {
  const calls = [];
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  new Function("exports", "require", compile("../src/ui/theme.tsx"))(exports, (name) => {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "react") return { useState: (value) => [value, () => {}] };
    if (name === "react-native") return { Platform: { select: (values) => values.ios }, Pressable: "Pressable", StyleSheet: { create: (styles) => styles }, useColorScheme: () => "light" };
    if (name === "./haptics") return { haptic: (kind) => calls.push(kind) };
    if (name === "expo-symbols" || name === "./text") return {};
    throw new Error(`Unexpected dependency: ${name}`);
  });
  return { ...exports, calls };
}

test("公共按钮按场景反馈，禁用按钮静默且不执行操作，显式关闭保留操作", () => {
  const { Action, CloseButton, calls } = loadControls();
  let presses = 0;
  const onPress = () => presses++;
  for (const props of [{}, { primary: true }, { destructive: true }, { selected: false }, { toggled: true }, { feedback: "warning" }]) {
    Action({ title: "操作", onPress, ...props }).props.onPress();
  }
  CloseButton({ onPress }).props.onPress();
  Action({ title: "操作", onPress, disabled: true }).props.onPress();
  CloseButton({ onPress, disabled: true }).props.onPress();
  Action({ title: "操作", onPress, feedback: false }).props.onPress();
  assert.deepEqual(calls, ["light", "medium", "warning", "selection", "selection", "warning", "light"]);
  assert.equal(presses, 8);
});
