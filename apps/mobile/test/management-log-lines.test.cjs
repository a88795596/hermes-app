const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

test("日志行高亮级别，同时保留可选择的原文、完整时间戳及非标准行", () => {
  const lines = [
    "08:30:01 INFO  agent    Hermes 已启动",
    "2026-11-13 12:00:00,012 ERROR [worker] gateway.run: Sync 模块执行失败\r\n",
    "    Traceback (most recent call last):",
  ];
  const jsx = (type, props) => ({ type, props });
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: { useState: (initial) => [initial] },
    "react-native": { View: "View", Text: "Text", StyleSheet: { create: (styles) => styles } },
    "../chat/composer-menu": { ComposerSheet: "ComposerSheet" },
    "../ui/haptics": {},
    "../ui/theme": {
      Action: "Action", useTheme: () => ({ colors: {}, styles: {} }),
    },
    "./shared": {
      ActionState: "ActionState", DataState: "DataState", ManagementHeader: "ManagementHeader", ManagementLayout: "ManagementLayout",
      useManagementData: () => ({ data: { file: "agent", level: "INFO", lines } }),
      useManagementAction: () => ({}),
    },
  };
  const exports = {};
  const source = ts.transpileModule(readFileSync(require.resolve("../src/manage/logs.tsx"), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("exports", "require", source)(exports, (name) => modules[name]);

  function* findRows(node) {
    if (Array.isArray(node)) {
      for (const child of node) yield* findRows(child);
    } else if (node?.props && "line" in node.props) yield node.type(node.props).props.children;
    else if (node?.props) yield* findRows(node.props.children);
  }

  function text(node) {
    if (Array.isArray(node)) return node.map(text).join("");
    return typeof node === "string" ? node : text(node.props.children);
  }

  const rows = [...findRows(exports.Logs({ call: async () => {} }))];
  assert.deepEqual(rows.map(text), lines.map((line) => line.replace(/\r?\n$/u, "")));
  assert.ok(rows.every((row) => row.props.selectable));
  assert.equal(rows[0].props.children.props.children[1].props.children, "INFO");
  assert.equal(rows[1].props.children.props.children[1].props.children, "ERROR");
  assert.equal(rows[2].props.children, lines[2]);
});
