const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

const source = ts.transpileModule(readFileSync(require.resolve("../src/app/[page].tsx"), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
}).outputText;
const Redirect = Symbol("Redirect");
const WorkspaceScreen = Symbol("WorkspaceScreen");

function renderPage(params, inboxItem) {
  const exports = {};
  runInNewContext(source, {
    exports,
    require(name) {
      if (name === "expo-router") return { Redirect, useLocalSearchParams: () => params };
      if (name === "../workspace-context") return { useWorkspaceContext: () => ({ inboxItem }) };
      if (name === "../workspace-screen") return { __esModule: true, default: WorkspaceScreen };
      if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props: { ...props } }) };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return exports.default();
}

test("有效二级页面和指定会话交给共享页面渲染", () => {
  for (const params of [{ page: "manage" }, { page: "cron" }, { page: "version" }, { page: "conversation", topicId: "topic-1" }]) {
    assert.equal(renderPage(params).type, WorkspaceScreen);
  }
});

test("未知或重复页面参数返回首页", () => {
  for (const page of [undefined, "missing", ["manage", "cron"]]) {
    assert.deepEqual(renderPage({ page }), { type: Redirect, props: { href: "/" } });
  }
});

test("没有有效会话标识时返回首页", () => {
  for (const topicId of [undefined, "", ["topic-1", "topic-2"]]) {
    assert.deepEqual(renderPage({ page: "conversation", topicId }), { type: Redirect, props: { href: "/" } });
  }
});

test("收件箱详情需要已选中的消息", () => {
  assert.deepEqual(renderPage({ page: "inbox-item" }), { type: Redirect, props: { href: "/" } });
  const item = { inbox_id: "inbox-1", text: "消息正文", created_at: "2026-11-15T00:00:00Z" };
  assert.equal(renderPage({ page: "inbox-item" }, item).type, WorkspaceScreen);
});
