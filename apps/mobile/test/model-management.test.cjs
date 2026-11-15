const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

test("从模型目录选取后回填编辑表单，只有点击顶栏保存才写入 Hermes", async () => {
  const state = new Map();
  let component, cursor, pending;
  const jsx = (type, props) => ({ type, props });
  const fixtures = {
    "model.list": { main: { provider: "openai", model: "gpt-5.1" }, tasks: [] },
    "model.options": [{ slug: "anthropic", name: "Anthropic", models: ["claude-sonnet"], authenticated: true }],
  };
  const modules = {
    react: { useState(initial) {
      const values = state.get(component);
      const index = cursor++;
      if (!(index in values)) values[index] = initial;
      return [values[index], (next) => { values[index] = next; }];
    } },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": {
      Text: "Text", View: "View", Modal: "Modal", KeyboardAvoidingView: "KeyboardAvoidingView",
      Keyboard: { dismiss() {} }, Platform: { OS: "ios" },
      StyleSheet: { create: (styles) => styles },
    },
    "react-native-safe-area-context": { SafeAreaView: "SafeAreaView" },
    "../ui/haptics": { haptic() {} },
    "../ui/motion": { useReduceMotion: () => true },
    "../ui/page-header": { PageHeader: "PageHeader" },
    "../ui/theme": { Action: "Action", Field: "Field", Icon: "Icon", CloseButton: "CloseButton",
      useTheme: () => ({ colors: {}, styles: {} }) },
    "./shared": {
      ActionState: "ActionState", DataState: "DataState", EditField: "EditField", Group: "Group", Row: "Row",
      FormHeader: "FormHeader", ManagementHeader: "ManagementHeader", ManagementLayout: "ManagementLayout",
      useManagementContext: () => ({ label: "日常助手" }),
      useManagementData: (_call, operation) => ({ data: fixtures[operation], reload: async () => {} }),
      useManagementAction: () => ({ run: (action) => { pending = action(); return pending; } }),
    },
  };
  const exports = {};
  const source = ts.transpileModule(readFileSync(require.resolve("../src/manage/models.tsx"), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("exports", "require", source)(exports, (name) => modules[name]);

  function render(node) {
    component = node.type;
    cursor = 0;
    if (!state.has(component)) state.set(component, []);
    return component(node.props);
  }

  function find(node, predicate) {
    if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
    if (!node?.props) return;
    if (predicate(node)) return node;
    return find(node.props.children, predicate);
  }

  const writes = [];
  const root = jsx(exports.Models, { call: async (operation, input) => { writes.push([operation, input]); return { ok: true }; } });
  find(render(root), (node) => node.props.title === "默认模型" && node.props.onPress).props.onPress();
  const editor = () => render(render(root));
  find(editor(), (node) => node.props.title === "浏览模型").props.onPress();
  const catalogNode = find(editor(), (node) => typeof node.type === "function" && node.props.onChoose);
  const catalog = () => render(catalogNode);
  assert.equal(catalog().type, "Modal");
  find(catalog(), (node) => node.props.title === "Anthropic").props.onPress();
  find(catalog(), (node) => node.props.title === "claude-sonnet").props.onPress();
  const draft = editor();
  assert.equal(find(draft, (node) => node.props.label === "服务商").props.value, "anthropic");
  assert.equal(find(draft, (node) => node.props.label === "模型 ID").props.value, "claude-sonnet");
  assert.deepEqual(writes, []);
  draft.props.header.props.onSave();
  await pending;
  assert.deepEqual(writes, [["model.set", { scope: "main", task: undefined, provider: "anthropic", model: "claude-sonnet" }]]);
});
