const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function mountHeader(props) {
  const values = [];
  let cursor = 0;
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  const source = ts.transpileModule(readFileSync(require.resolve("../src/ui/page-header.tsx"), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("exports", "require", source)(exports, (name) => {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "react") return {
      useState(initial) {
        const index = cursor++;
        if (!(index in values)) values[index] = initial;
        return [values[index], (value) => { values[index] = value; }];
      },
    };
    if (name === "react-native") return { StyleSheet: { create: (styles) => styles }, Text: "Text", View: "View" };
    if (name === "./theme") return { useTheme: () => ({ colors: {}, styles: {} }) };
    throw new Error(`Unexpected dependency: ${name}`);
  });
  return () => { cursor = 0; return exports.PageHeader(props); };
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node?.props) return;
  if (predicate(node)) return node;
  return find(node.props.children, predicate);
}
const flatten = (style) => Object.assign({}, ...[style].flat(Infinity));

test("左右操作宽度变化时标题保持页面居中，长标题单行且保留完整无障碍名称", () => {
  const title = "一个需要截尾显示的很长页面标题";
  const leading = { type: "Control", props: { name: "返回" } };
  const trailing = { type: "Control", props: { name: "保存中…" } };
  const render = mountHeader({ title, leading, trailing });
  const side = (child) => find(render(), (node) => node.props.children === child && node.props.onLayout);
  const titleArea = () => find(render(), (node) => {
    const style = flatten(node.props.style);
    return typeof style.left === "number" && typeof style.right === "number";
  });
  const measure = (child, width) => side(child).props.onLayout({ nativeEvent: { layout: { width } } });

  for (const [left, right] of [[48, 104], [88, 48], [0, 0]]) {
    measure(leading, left);
    measure(trailing, right);
    const { left: insetLeft, right: insetRight } = flatten(titleArea().props.style);
    assert.equal(insetLeft, Math.max(48, left, right) + 32);
    assert.equal(insetLeft, insetRight, "较宽一侧需要在两边留出同样的空间");
  }
  const label = find(render(), (node) => node.type === "Text" && node.props.accessibilityRole === "header");
  assert.equal(label.props.children, title);
  assert.equal(label.props.accessibilityLabel, title);
  assert.equal(label.props.numberOfLines, 1);
  assert.equal(flatten(label.props.style).textAlign, "center");
});
