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

async function mountSkills(skills) {
  const state = [];
  const effects = [];
  const selected = [];
  let stateCursor = 0;
  let effectCursor = 0;
  let requests = 0;
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
        effects[index] = deps;
        effect();
      },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { FlatList: "FlatList", Pressable: "Pressable", Text: "Text", View: "View", ActivityIndicator: "ActivityIndicator",
      StyleSheet: { create: (styles) => styles, hairlineWidth: 1 } },
    "react-native-reanimated": { __esModule: true, default: { View: "Animated.View" } },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "@hermes-mobile/protocol": { reasoningEfforts: [] },
    "../ui/haptics": { haptic() {} },
    "../ui/motion": {},
    "../ui/page-header": { PageHeader: "PageHeader" },
    "../ui/text": {},
    "../ui/theme": { Action: "Action", Field: "Field", Icon: "Icon", Notice: "Notice",
      useTheme: () => ({ colors: { tint: "tint", accent: "accent" }, styles: {} }) },
  };
  new Function("exports", "require", source)(exports, (name) => {
    assert.ok(name in modules, name);
    return modules[name];
  });
  const menu = exports.ComposerMenu({ kind: "skills", id: "topic", onSkill: (skill) => selected.push(skill),
    call: async (path) => { assert.equal(path, "/topics/topic/skills"); requests++; return skills; } });
  const component = nodes(menu).find((node) => node.props.path === "/topics/topic");
  function render() {
    stateCursor = effectCursor = 0;
    return component.type(component.props);
  }
  render();
  await Promise.resolve();
  return {
    render, selected,
    get requests() { return requests; },
    search(query) {
      nodes(render()).find((node) => node.type === "Field").props.onChangeText(query);
      return nodes(render()).find((node) => node.type === "FlatList");
    },
  };
}

test("技能名和描述任一包含关键词即可匹配，忽略大小写和两端空白", async () => {
  const skills = [
    { name: "MCP-helper", description: "连接服务" },
    { name: "toolbox", description: "Manage mCp servers" },
    { name: "calendar", description: "读取日历和会议" },
    { name: "other", category: "mcp" },
  ];
  const ui = await mountSkills(skills);
  assert.deepEqual(ui.search(" McP ").props.data, skills.slice(0, 2));
  assert.deepEqual(ui.search("日历").props.data, [skills[2]]);
  assert.deepEqual(ui.search("").props.data, skills);
  assert.deepEqual(ui.search("   ").props.data, skills);
  const missing = ui.search("不存在");
  assert.deepEqual(missing.props.data, []);
  assert.equal(text(missing.props.ListEmptyComponent), "暂无匹配的技能");
  assert.equal(ui.requests, 1, "输入关键词不重新请求技能列表");
});

test("正则特殊字符按字面匹配，空描述和空技能列表可搜索", async () => {
  const literal = { name: "tool.[a]+(b)?\\$^*|", description: "" };
  const ui = await mountSkills([literal, { name: "toolXab" }]);
  for (const query of [".", "[a]", "+", "(b)", "?", "\\", "$", "^", "*", "|"]) {
    assert.deepEqual(ui.search(query).props.data, [literal], query);
  }
  const empty = await mountSkills([]);
  assert.deepEqual(empty.search("anything").props.data, []);
  assert.deepEqual(empty.search("").props.data, []);
});

test("技能名和描述的全部命中都高亮，保留原文大小写和中文", async () => {
  const skill = { name: "MCP-mcp", description: "用 McP 连接 mCp 服务" };
  const ui = await mountSkills([skill]);
  const list = ui.search("mcp");
  const row = list.props.renderItem({ item: skill });
  const highlights = nodes(row).filter((node) => node.type === "Text"
    && Object.assign({}, ...[node.props.style].flat()).backgroundColor);
  assert.deepEqual(highlights.map(text), ["MCP", "mcp", "McP", "mCp"]);
  assert.equal(text(row), skill.name + skill.description);
});

test("搜索框位于列表底部，键盘打开时选择技能仍回传原对象", async () => {
  const skill = { name: "writer", description: "写作" };
  const ui = await mountSkills([skill]);
  const tree = nodes(ui.render());
  const listIndex = tree.findIndex((node) => node.type === "FlatList");
  const fieldIndex = tree.findIndex((node) => node.type === "Field");
  assert.ok(fieldIndex > listIndex);
  assert.equal(tree[fieldIndex].props.accessibilityLabel, "搜索技能名称或描述");
  assert.equal(tree[fieldIndex].props.placeholder, "搜索技能名称或描述");
  const list = ui.search("写作");
  assert.equal(list.props.keyboardShouldPersistTaps, "handled");
  list.props.renderItem({ item: list.props.data[0] }).props.onPress();
  assert.equal(ui.selected[0], skill);
});
