const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree?.props ? [tree, ...nodes(tree.props.children)] : [];
}

function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  return typeof tree === "string" ? tree : tree?.props ? text(tree.props.children) : "";
}

function mountCommands(call, connected = true, reasoningSupported = false) {
  const state = [], effects = [], cleanup = [], selected = [];
  let stateCursor = 0, effectCursor = 0;
  const jsx = (type, props) => ({ type, props });
  const source = ts.transpileModule(readFileSync(require.resolve("../src/chat/composer-menu.tsx"), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  const modules = {
    "expo-crypto": { randomUUID() {} },
    "react": {
      useState(initial) {
        const index = stateCursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], (value) => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
      },
      useEffect(effect, deps) {
        const index = effectCursor++;
        if (effects[index]?.every((value, i) => Object.is(value, deps[i]))) return;
        cleanup[index]?.();
        effects[index] = deps;
        cleanup[index] = effect();
      },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { FlatList: "FlatList", Pressable: "Pressable", Text: "Text", View: "View", ActivityIndicator: "ActivityIndicator",
      StyleSheet: { create: (styles) => styles, hairlineWidth: 1 } },
    "react-native-reanimated": { __esModule: true, default: { View: "Animated.View" } },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "@hermes-mobile/protocol": { reasoningEfforts: [] },
    "../ui/overlay": { OverlayModal: "Modal" },
    "../ui/haptics": { haptic() {} },
    "../ui/motion": {},
    "../ui/page-header": { PageHeader: "PageHeader" },
    "../ui/text": {},
    "../ui/theme": { Action: "Action", Field: "Field", Icon: "Icon", Notice: "Notice",
      useTheme: () => ({ colors: {}, styles: {} }) },
  };
  new Function("exports", "require", source)(exports, (name) => {
    assert.ok(name in modules, name);
    return modules[name];
  });
  const menu = exports.ComposerMenu({ kind: "commands", id: "topic", call, connected, reasoningSupported,
    onCommand: (command) => selected.push(command) });
  const component = nodes(menu).find((node) => node.props.path === "/topics/topic");
  assert.ok(component, "命令菜单应读取当前话题的目录");
  const render = (props = {}) => {
    Object.assign(component.props, props);
    stateCursor = effectCursor = 0;
    return component.type(component.props);
  };
  return { render, selected, close: () => cleanup.forEach((fn) => fn?.()),
    search(query) {
      nodes(render()).find((node) => node.type === "Field").props.onChangeText(query);
      return nodes(render()).find((node) => node.type === "FlatList");
    },
  };
}

const command = (name, fields = {}) => ({ name, description: name, category: "Session", aliases: [], supported: true, ...fields });
const list = (tree) => nodes(tree).find((node) => node.type === "FlatList");
const flush = () => new Promise(setImmediate);

test("fast 点击先选模式和作用范围，确认后才发送完整指令", async () => {
  const fast = command("fast", { args_hint: "[normal|fast|status] [--global]",
    subcommands: ["normal", "fast", "status", "on", "off", "--global"] });
  const screen = mountCommands(async () => [fast]);
  screen.render();
  await flush();
  list(screen.render()).props.renderItem({ item: fast }).props.onPress();
  assert.equal(screen.render().props.title, "/fast");
  assert.deepEqual(screen.selected, []);
  assert.equal(nodes(screen.render()).find((node) => node.type === "Field"), undefined);
  assert.equal(nodes(screen.render()).find((node) => node.props.title === "执行").props.disabled, true);
  const choose = (title) => nodes(screen.render()).find((node) => node.props.title === title).props.onPress();
  choose("快速");
  choose("保存为默认");
  assert.deepEqual(screen.selected, []);
  assert.equal(nodes(screen.render()).find((node) => node.props.testID === "command-preview").props.children, "/fast fast --global");
  choose("执行");
  assert.deepEqual(screen.selected, ["/fast fast --global"]);
  choose("查看状态");
  assert.equal(nodes(screen.render()).find((node) => node.props.testID === "command-preview").props.children, "/fast status");
  choose("执行");
  assert.deepEqual(screen.selected, ["/fast fast --global", "/fast status"]);
  choose("取消");
  list(screen.render()).props.renderItem({ item: fast }).props.onPress();
  choose("普通");
  choose("执行");
  assert.equal(screen.selected.at(-1), "/fast normal");
});

test("只显示原生目录项目，远端新增指令无须前端更新，支持名称别名及描述搜索", async () => {
  const commands = [command("fresh-native", { description: "服务端新增功能", aliases: ["fresh"] }), command("version"), command("constructor")];
  const calls = [];
  const screen = mountCommands(async (path) => { calls.push(path); return commands; });
  assert.ok(nodes(screen.render()).some((node) => node.type === "ActivityIndicator"));
  await flush();
  assert.deepEqual(list(screen.render()).props.data, commands);
  for (const query of [" FRESH ", "新增", "fresh-native"]) assert.deepEqual(screen.search(query).props.data, [commands[0]]);
  assert.deepEqual(screen.search("不存在").props.data, []);
  assert.deepEqual(screen.search("").props.data, commands);
  assert.deepEqual(calls, ["/topics/topic/commands"]);
  const row = list(screen.render()).props.renderItem({ item: commands[0] });
  row.props.onPress();
  assert.deepEqual(screen.selected, ["/fresh-native"]);
});

test("带参数命令展开输入，参数保留原文，取消及空参数执行均不改写目录", async () => {
  const title = command("title", { args_hint: "[name]" });
  const screen = mountCommands(async () => [title]);
  screen.render();
  await flush();
  const select = () => list(screen.render()).props.renderItem({ item: title }).props.onPress();
  select();
  assert.equal(screen.render().props.title, "/title", "参数页拥有独立标题");
  assert.equal(screen.render().props.back.props.accessibilityLabel, "返回命令目录");
  assert.equal(list(screen.render()), undefined, "参数页取代命令列表");
  const args = nodes(screen.render()).find((node) => node.type === "Field");
  assert.match(args.props.accessibilityLabel, /title.*参数/);
  args.props.onChangeText('  中文 "原样"  ');
  const preview = nodes(screen.render()).find((node) => node.props.testID === "command-preview");
  assert.equal(preview.props.children, '/title   中文 "原样"  ');
  assert.equal(preview.props.accessibilityLabel, '完整命令：/title   中文 "原样"  ');
  nodes(screen.render()).find((node) => node.props.title === "执行").props.onPress();
  assert.deepEqual(screen.selected, ['/title   中文 "原样"  ']);
  nodes(screen.render()).find((node) => node.props.title === "取消").props.onPress();
  assert.ok(list(screen.render()));
  select();
  nodes(screen.render()).find((node) => node.props.title === "执行").props.onPress();
  assert.deepEqual(screen.selected, ['/title   中文 "原样"  ', "/title"]);
  screen.render().props.back.props.onPress();
  assert.equal(screen.render().props.title, "命令");
  assert.ok(list(screen.render()));
});

test("参数页按原生 subcommands 展示选项，选择后仍可补充原样参数", async () => {
  const entry = command("remote-options", { args_hint: "[mode] [text]", subcommands: ["server-option", "--native-flag"] });
  const screen = mountCommands(async () => [entry]);
  screen.render();
  await flush();
  list(screen.render()).props.renderItem({ item: entry }).props.onPress();
  const options = nodes(screen.render()).filter((node) => typeof node.type === "function" && typeof node.props.selected === "boolean");
  assert.deepEqual(options.map((node) => node.props.title), entry.subcommands);
  options[0].props.onPress();
  assert.equal(nodes(screen.render()).find((node) => node.type === "Field").props.value, "server-option");
  nodes(screen.render()).find((node) => node.type === "Field").props.onChangeText("server-option  补充参数");
  assert.equal(nodes(screen.render()).find((node) => node.props.testID === "command-preview").props.children, "/remote-options server-option  补充参数");
  nodes(screen.render()).find((node) => node.props.title === "执行").props.onPress();
  assert.deepEqual(screen.selected, ["/remote-options server-option  补充参数"]);
});

test("不支持的命令展示原因并禁用，离线不请求目录或显示静态兜底", async () => {
  const unsupported = command("undo", { supported: false, unavailable_reason: "当前会话未开放原生回退接口。" });
  const screen = mountCommands(async () => [unsupported]);
  screen.render();
  await flush();
  const row = list(screen.render()).props.renderItem({ item: unsupported });
  assert.equal(row.props.disabled, true);
  assert.deepEqual(row.props.accessibilityState, { disabled: true });
  assert.equal(row.props.accessibilityHint, unsupported.unavailable_reason);
  assert.match(text(row), /当前会话未开放原生回退接口/);
  row.props.onPress();
  assert.deepEqual(screen.selected, []);
  const offline = mountCommands(async () => assert.fail("离线不能请求目录"), false);
  assert.equal(list(offline.render()), undefined);
  assert.match(text(offline.render()), /连接 Hermes/);
});

test("查询失败只显示错误和重试，关闭菜单取消请求并忽略迟到响应", async () => {
  let attempts = 0;
  const screen = mountCommands(async () => {
    if (++attempts === 1) throw new Error("原生命令目录不可用");
    return [command("help")];
  });
  screen.render();
  await flush();
  assert.equal(list(screen.render()), undefined);
  assert.match(text(screen.render()), /原生命令目录不可用/);
  nodes(screen.render()).find((node) => node.props.title === "重试").props.onPress();
  screen.render();
  await flush();
  assert.deepEqual(list(screen.render()).props.data.map((item) => item.name), ["help"]);
  let finish, signal;
  const waiting = mountCommands((_path, options) => {
    signal = options.signal;
    return new Promise((resolve) => { finish = resolve; });
  });
  waiting.render();
  waiting.close();
  assert.equal(signal.aborted, true);
  finish([command("late")]);
  await flush();
  assert.equal(list(waiting.render()), undefined);
});

test("原生目录中的模型和思考命令复用已有选择器，不替原生目录添加项目", async () => {
  const model = command("model", { supported: false, args_hint: "[model]" });
  const reasoning = command("reasoning", { supported: false, args_hint: "[level]" });
  for (const reasoningSupported of [false, true]) {
    const screen = mountCommands(async () => [model, reasoning], true, reasoningSupported);
    screen.render();
    await flush();
    const entries = list(screen.render());
    assert.deepEqual(entries.props.data, [model, reasoning]);
    entries.props.renderItem({ item: model }).props.onPress();
    assert.deepEqual(screen.selected, ["/model"]);
    const row = entries.props.renderItem({ item: reasoning });
    assert.equal(row.props.disabled, !reasoningSupported);
    row.props.onPress();
    assert.deepEqual(screen.selected, reasoningSupported ? ["/model", "/reasoning"] : ["/model"]);
    assert.ok(list(screen.render()), "选择器命令不展开参数输入页");
  }
});

test("目录中的停止和技能保留已有 App 能力，新建会话根据原生能力启用", async () => {
  const reset = command("new", { supported: false, aliases: ["reset"], args_hint: "[name]" });
  const entries = [command("stop", { supported: false }), command("skills", { supported: false }), reset];
  const screen = mountCommands(async () => entries);
  screen.render();
  await flush();
  assert.deepEqual(list(screen.render()).props.data, entries);
  assert.deepEqual(screen.search("reset").props.data, [reset], "仅按目录提供的别名搜索");
  screen.search("");
  for (const entry of entries.slice(0, 2)) {
    const row = list(screen.render()).props.renderItem({ item: entry });
    assert.equal(row.props.disabled, false);
    row.props.onPress();
    assert.ok(list(screen.render()), "已有 App 操作直接执行，不打开参数页");
  }
  assert.deepEqual(screen.selected, ["/stop", "/skills"]);
  assert.equal(list(screen.render()).props.renderItem({ item: reset }).props.disabled, true);
  const nativeReset = { ...reset, supported: true };
  const enabled = mountCommands(async () => [nativeReset]);
  enabled.render();
  await flush();
  list(enabled.render()).props.renderItem({ item: nativeReset }).props.onPress();
  assert.equal(enabled.render().props.title, "/new");
  nodes(enabled.render()).find((node) => node.type === "Field").props.onChangeText("新的会话名称");
  nodes(enabled.render()).find((node) => node.props.title === "执行").props.onPress();
  assert.deepEqual(enabled.selected, ["/new 新的会话名称"]);
});

test("技能子命令进入参数页，无参数保留浏览入口且不假装支持未开放的原生参数", async () => {
  for (const supported of [false, true]) {
    const entry = command("skills", { supported, subcommands: ["pending", "approve"], unavailable_reason: "当前连接未开放技能审批。" });
    const screen = mountCommands(async () => [entry]);
    screen.render();
    await flush();
    list(screen.render()).props.renderItem({ item: entry }).props.onPress();
    assert.equal(screen.render().props.title, "/skills");
    nodes(screen.render()).find((node) => node.props.title === "执行").props.onPress();
    assert.deepEqual(screen.selected, ["/skills"]);
    nodes(screen.render()).find((node) => node.type === "Field").props.onChangeText("approve request");
    const execute = nodes(screen.render()).find((node) => node.props.title === "执行");
    assert.equal(execute.props.disabled, !supported);
    execute.props.onPress();
    assert.deepEqual(screen.selected, supported ? ["/skills", "/skills approve request"] : ["/skills"]);
    if (!supported) assert.match(text(screen.render()), /当前连接未开放技能审批/);
  }
});
