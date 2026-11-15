const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function mount() {
  const values = [], effects = [], feedback = [], timers = [];
  const modules = new Map();
  let cursor = 0;
  const jsx = (type, props) => ({ type, props });
  class ApiError extends Error {}
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const exports = {};
    modules.set(file, exports);
    const source = ts.transpileModule(readFileSync(require.resolve(`../src/manage/${file}.tsx`), "utf8"), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
    }).outputText;
    new Function("exports", "require", "setTimeout", "clearTimeout", source)(exports, (name) => {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react") return {
        useState(initial) {
          const index = cursor++;
          if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
          return [values[index], (next) => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
        },
        useRef(current) { const index = cursor++; return values[index] ??= { current }; },
        useEffect(effect) { const index = cursor++; if (!(index in values)) { values[index] = true; effects.push(effect); } },
        useCallback: (callback) => callback,
      };
      if (name === "react-native") return {
        Platform: { select: (options) => options.ios }, StyleSheet: { create: (styles) => styles },
        Pressable: "Pressable", Switch: "Switch", Text: "Text", View: "View",
      };
      if (name === "react-native-reanimated") return { default: {} };
      if (name === "../sync/api") return { ApiError };
      if (name === "../ui/haptics") return { haptic: (kind) => feedback.push(kind) };
      if (name === "../ui/motion") return { motion: {}, useReduceMotion: () => true };
      if (name === "../ui/theme") return {
        useTheme: () => ({ colors: {}, styles: {} }), Action: "Action", Card: "Card", CloseButton: "CloseButton",
        EmptyState: "EmptyState", Field: "Field", Icon: "Icon", Notice: "Notice",
      };
      if (name === "./shared") return load("shared");
      throw new Error(`Unexpected dependency: ${name}`);
    }, (callback) => { timers.push(callback); return timers.length; }, (id) => { if (id) timers[id - 1] = undefined; });
    return exports;
  }
  return {
    render(file, name, ...args) { cursor = 0; return load(file)[name](...args); },
    feedback, effects, timers, ApiError,
  };
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node?.props) return;
  if (predicate(node)) return node;
  return find(node.props.children, predicate);
}
const flush = () => new Promise(setImmediate);

test("管理列表与开关提供轻触和选择反馈，禁用控件保持静默", () => {
  const screen = mount();
  let changes = 0;
  const onPress = () => changes++;
  screen.render("shared", "Row", { title: "模型", onPress }).props.onPress();
  screen.render("shared", "Row", { title: "模型", onPress, disabled: true }).props.onPress();
  for (const disabled of [false, true]) {
    find(screen.render("shared", "Toggle", { label: "启用", value: false, disabled, onChange: onPress }),
      (node) => node.type === "Switch").props.onValueChange(true);
  }
  assert.equal(changes, 2);
  assert.deepEqual(screen.feedback, ["light", "selection"]);
});

test("管理操作防止重复提交且只提示一次失败，读取与排队回执不会提示成功", async () => {
  const screen = mount();
  const action = screen.render("shared", "useManagementAction");
  let reject;
  const first = action.run(() => new Promise((_, fail) => { reject = fail; }));
  await action.run(async () => assert.fail("busy action must not run"));
  assert.deepEqual(screen.feedback, []);
  reject(new screen.ApiError("保存失败"));
  await first;
  assert.equal(screen.render("shared", "useManagementAction").error, "保存失败");
  await action.run(async () => {});
  await action.run(async () => "安装已启动，请刷新目录查看结果。");
  assert.deepEqual(screen.feedback, ["error"]);
});

test("自动数据加载失败不会产生触觉反馈", async () => {
  const screen = mount();
  screen.render("shared", "useManagementData", async () => { throw new Error("offline"); }, "skill.list");
  screen.effects.forEach((effect) => effect());
  await flush();
  assert.deepEqual(screen.feedback, []);
});

test("安装轮询只在实际完成后反馈，区分失败与未知结果", async () => {
  for (const [exit_code, expected] of [[0, "success"], [1, "error"], [null, "warning"]]) {
    const screen = mount();
    const completed = [];
    let running = true;
    screen.render("shared", "InstallProgress", {
      call: async () => ({ running, exit_code }), name: "install", onDone: (...args) => completed.push(args),
    });
    screen.effects[0]();
    await flush();
    assert.deepEqual(screen.feedback, []);
    running = false;
    screen.timers[0]();
    await flush();
    assert.deepEqual(screen.feedback, [expected]);
    assert.equal(completed.length, 1);
  }
});

test("手动测试 MCP 连接根据真实结果提示成功或失败", async () => {
  for (const ok of [true, false]) {
    const screen = mount();
    const call = async (operation) => operation === "mcp.list"
      ? { servers: [{ name: "server", transport: "stdio", enabled: true }] } : { ok, tools: [] };
    const render = () => screen.render("mcp", "Mcp", { call });
    render();
    screen.effects.forEach((effect) => effect());
    await flush();
    assert.deepEqual(screen.feedback, []);
    find(render(), (node) => node.props.title === "server").props.onPress();
    find(render(), (node) => node.props.title === "测试连接").props.onPress();
    await flush();
    assert.deepEqual(screen.feedback, [ok ? "success" : "error"]);
  }
});

test("离开安装页面后返回的结果与异常均保持静默", async () => {
  for (const failed of [false, true]) {
    const screen = mount();
    let resolve, reject;
    screen.render("shared", "InstallProgress", {
      call: () => new Promise((done, fail) => { resolve = done; reject = fail; }),
      name: "install", onDone: () => assert.fail("aborted install must not finish in UI"),
    });
    screen.effects[0]()();
    if (failed) reject(new Error("offline")); else resolve({ running: false, exit_code: 0 });
    await flush();
    assert.deepEqual(screen.feedback, []);
  }
});

test("技能创建等待保存成功，后台安装启动时不提前提示成功", async () => {
  for (const installing of [false, true]) {
    const screen = mount();
    let resolve;
    const call = (operation) => operation === "skill.list" ? Promise.resolve([]) : new Promise((done) => { resolve = done; });
    const render = () => screen.render("skills", "Skills", { call });
    render();
    screen.effects.forEach((effect) => effect());
    await flush();
    find(render(), (node) => node.props.title === (installing ? "从技能中心安装" : "新建技能")).props.onPress();
    if (installing) {
      find(render(), (node) => node.props.label === "技能标识或网址").props.onChangeText("owner/skill");
      find(render(), (node) => node.props.title === "安装技能").props.onPress();
    } else find(render(), (node) => node.type?.name === "SkillForm").props.onSave("skill", "content", "");
    assert.deepEqual(screen.feedback, []);
    resolve({ name: "install" });
    await flush();
    assert.deepEqual(screen.feedback, installing ? [] : ["success"]);
  }
});
