const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

const source = ts.transpileModule(readFileSync(require.resolve("../src/manage/cron.tsx"), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
}).outputText;

function mountTasks(jobs, call = assert.fail, { busy = false, loading = false, reload = () => {} } = {}) {
  const values = [];
  let cursor = 0;
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: {
      useMemo: (compute) => compute(),
      useState(initial) {
        const index = cursor++;
        if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
        return [values[index], (next) => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
      },
    },
    "react-native": { StyleSheet: { create: (styles) => styles, hairlineWidth: 1 }, Pressable: "Pressable", Text: "Text", View: "View" },
    "../ui/haptics": { haptic() {} },
    "../ui/text": { formatDateTime: String },
    "../ui/theme": { Action: "Action", EmptyState: "EmptyState", Icon: "Icon", useTheme: () => ({ styles: {}, colors: {} }) },
    "./shared": {
      ManagementLayout: "ManagementLayout", ManagementHeader: "ManagementHeader", FormHeader: "FormHeader",
      Row: "Row", EditField: "EditField",
      useManagementContext: () => ({ label: "日常助手" }),
      useManagementAction: () => ({ busy, run: (task) => task() }),
      useManagementData: (_, operation) => ({ data: operation === "cron.list" ? jobs : { runs: [] }, loading, reload }),
    },
  };
  new Function("exports", "require", source)(exports, (name) => modules[name]);
  return () => {
    cursor = 0;
    return exports.ScheduledTasks({ call });
  };
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node?.props) return;
  if (predicate(node)) return node;
  return find(node.props.children, predicate);
}

test("定时列表展示 Hermes 提供的计划文案，查看记录后可逐级返回", () => {
  const render = mountTasks([{ id: "brief", name: "晨间简报", enabled: true,
    schedule: { kind: "cron", expr: "0 8 * * *" }, schedule_display: "每天 08:00" }]);
  const list = render();
  assert.equal(list.type, "ManagementLayout");
  const row = find(list, (node) => node.type === "Row" && node.props.title === "晨间简报");
  assert.equal(row.props.subtitle, "每天 08:00");
  row.props.onPress();

  const detail = render();
  assert.equal(detail.props.header.props.title, "晨间简报");
  find(detail, (node) => node.props.title === "运行记录").props.onPress();
  const historyScreen = render();
  assert.equal(historyScreen.type.name, "RunHistory");
  const history = historyScreen.type(historyScreen.props);
  assert.equal(history.props.header.props.title, "运行记录");
  history.props.header.props.onBack();
  assert.equal(render().props.header.props.title, "晨间简报");
  render().props.header.props.onBack();
  assert.equal(render().props.header.props.title, "定时任务");
});

test("任务详情图标操作保留刷新、编辑和忙碌禁用保护", () => {
  for (const busy of [false, true]) {
    let refreshes = 0;
    const render = mountTasks([{ id: "brief", name: "晨间简报", enabled: true }], assert.fail, { busy, reload: () => refreshes++ });
    find(render(), (node) => node.type === "Row" && node.props.title === "晨间简报").props.onPress();
    const actions = render().props.header.props.trailing;
    const refresh = find(actions, (node) => node.props.accessibilityLabel === "刷新任务");
    const edit = find(actions, (node) => node.props.accessibilityLabel === "编辑任务");
    assert.equal(refresh.props.disabled, busy);
    assert.equal(edit.props.disabled, busy);
    refresh.props.onPress();
    edit.props.onPress();
    assert.equal(refreshes, busy ? 0 : 1);
    assert.equal(render().type === "ManagementLayout", busy);
  }
});

test("固定表单操作栏在填写计划后可提交原生投递目标", () => {
  const requests = [];
  const render = mountTasks([], (operation, input) => requests.push({ operation, input }));
  find(render(), (node) => node.props.title === "新建任务").props.onPress();
  const renderForm = () => {
    const form = render();
    return form.type(form.props);
  };
  const blank = renderForm();
  assert.equal(blank.props.header.type, "FormHeader");
  assert.equal(blank.props.header.props.disabled, true);
  find(blank, (node) => node.type === "EditField" && node.props.label === "执行计划").props.onChangeText(" every 2h ");
  find(blank, (node) => node.type === "EditField" && node.props.label === "投递目标").props.onChangeText(" origin ");
  const toolbar = renderForm().props.header;
  assert.equal(toolbar.props.disabled, false);
  toolbar.props.onSave();
  assert.deepEqual(requests, [{ operation: "cron.create", input: { schedule: "every 2h", deliver: "origin" } }]);
});
