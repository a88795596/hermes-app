const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { registerHooks } = require("node:module");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { StyleSheet } = require("react-native-web");
const ts = require("typescript");

const component = pathToFileURL(require.resolve("../src/chat/answer-markdown.tsx"));
const tableComponent = new URL("markdown-table.tsx", component);
const pagingContext = new URL("../profiles/paging-context.ts", component);
const themeModule = new URL("../src/ui/theme.tsx", component);
const markdownModule = require.resolve("react-native-markdown-renderer");
// Render the actual component through React Native Web in Node's test runner.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === component.href && specifier === "react-native-markdown-renderer") {
      return { url: "markdown-test:renderer", shortCircuit: true };
    }
    if ([component.href, tableComponent.href].includes(context.parentURL) && specifier === "../ui/theme") {
      return { url: themeModule.href, shortCircuit: true };
    }
    if (context.parentURL === component.href && specifier === "./markdown-table") {
      return { url: tableComponent.href, shortCircuit: true };
    }
    if (context.parentURL === tableComponent.href && specifier === "../profiles/paging-context") {
      return { url: pagingContext.href, shortCircuit: true };
    }
    if (context.parentURL === tableComponent.href
      && ["expo-screen-orientation", "react-native-safe-area-context", "../ui/haptics", "../ui/page-header", "../ui/overlay", "../ui/alerts"].includes(specifier)) {
      return { url: "markdown-test:fullscreen", shortCircuit: true };
    }
    return nextResolve(["react-native", "react-native-gesture-handler"].includes(specifier) ? "react-native-web" : specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "markdown-test:renderer") return { format: "commonjs", shortCircuit: true, source: `
      const markdown = require(${JSON.stringify(markdownModule)});
      module.exports = { ...markdown, __esModule: true, default(props) {
        const tree = markdown.default(props); globalThis.renderedMarkdownTree = tree; return tree;
      } };` };
    if (url === themeModule.href) {
      return { format: "commonjs", shortCircuit: true, source: `exports.useTheme = () => ({ colors: {
        foreground: "#352820", edge: "#DDD0C2", tint: "#EBDDD0", secondary: "#EFE5DA", accent: "#86553B", muted: "#735F50",
      }, styles: {} }); exports.Icon = () => null;` };
    }
    if (url === "markdown-test:fullscreen") return { format: "commonjs", shortCircuit: true, source: "exports.useAlert = () => ({ alert() {} });" };
    if (![component.href, tableComponent.href, pagingContext.href].includes(url)) return nextLoad(url, context);
    const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    return { format: "commonjs", shortCircuit: true, source };
  },
});
const { AnswerMarkdown } = require("../src/chat/answer-markdown.tsx");
hooks.deregister();

test("流式追加正文时保留表格组件身份，避免已打开的全屏表格被卸载", () => {
  function tablePath(node) {
    if (!node?.props) return;
    if (node.type?.name === "MarkdownTable") return [node.key];
    for (const child of [node.props.children].flat()) {
      const path = tablePath(child);
      if (path) return [node.key, ...path];
    }
  }
  const table = "| 指数 | 点数 |\n| --- | ---: |\n| 上证指数 | 3634.35 |";
  for (const text of [table, table.split("\n").map((line) => `> ${line}`).join("\n"),
    `- 指数分析\n\n${table.split("\n").map((line) => `  ${line}`).join("\n")}`]) {
    renderToStaticMarkup(createElement(AnswerMarkdown, { text, onOpenLink() {} }));
    const first = tablePath(globalThis.renderedMarkdownTree);
    renderToStaticMarkup(createElement(AnswerMarkdown, { text: `${text}\n\n继续分析`, onOpenLink() {} }));
    assert.ok(first);
    assert.deepEqual(tablePath(globalThis.renderedMarkdownTree), first);
  }
});

test("指数表格应用圆角、网格和数字对齐，单元格最小宽度为100并提供放大入口", () => {
  const text = [
    "| 指数 | 周五收盘 | 全周涨跌 | 周五涨跌 |",
    "| --- | ---: | ---: | ---: |",
    "| 上证指数 | 3634.35点 | -0.41% | -0.59% |",
    "| 深证成指 | 10968.79点 | -1.85% | -2.05% |",
  ].join("\n");
  const html = renderToStaticMarkup(createElement(AnswerMarkdown, { text, onOpenLink() {} }));
  const classes = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap(([, value]) => value.split(" ")));
  const css = [...StyleSheet.getSheet().textContent.matchAll(/\.([\w-]+)\{([^}]+)\}/g)]
    .filter(([, name]) => classes.has(name)).map(([, , rule]) => rule).join("\n")
    + [...html.matchAll(/style="([^"]+)"/g)].map(([, value]) => value).join("\n");

  assert.match(css, /background-color:rgba\(235,221,208,1\.00\)/);
  assert.match(css, /background-color:rgba\(239,229,218,1\.00\)/);
  assert.match(css, /border-bottom-width:1px/);
  assert.match(css, /border-right-width:1px/);
  assert.match(css, /border-left-width:1px/);
  assert.match(css, /border-bottom-color:rgba\(221,208,194,1\.00\)/);
  assert.match(css, /padding-left:10px/);
  assert.match(css, /font-weight:700/);
  assert.match(html, /text-align:right/);
  assert.match(css, /overflow-x:auto/);
  assert.match(css, /min-width:100px/);
  assert.match(css, /border-top-left-radius:12px/);
  assert.match(css, /border-bottom-right-radius:12px/);
  assert.match(html, /width:400px/);
  assert.match(html, /aria-label="放大表格"/);
});
test("Hermes 回答渲染 Markdown，并将外部图片和链接限制为用户主动打开", () => {
  const text = [
    "## 检查结果", "", "> 运行 `pnpm test`。", "",
    "| 项目 | 结果 |", "| --- | --- |", "| 类型检查 | 通过 |", "",
    "[文档](https://example.com/doc) [本地网页](http://127.0.0.1:8080/docs?from=chat#intro)", "",
    "直接网址 http://example.com/status，代码 `https://example.com/command` [本地应用](customapp://test)", "",
    "[独立链接](https://example.com/standalone)", "",
    "[![图片](https://example.com/tracker.png)](https://example.com/details)", "",
    "<script>alert(1)</script>",
  ].join("\n");
  const html = renderToStaticMarkup(createElement(AnswerMarkdown, { text, onOpenLink() {} }));

  assert.match(html, /<h2[^>]*>[\s\S]*检查结果[\s\S]*<\/h2>/);
  assert.match(html, /类型检查[\s\S]*通过/);
  assert.match(html, /href="https:\/\/example\.com\/doc"/);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:8080\/docs\?from=chat#intro"/);
  assert.match(html, /href="http:\/\/example\.com\/status"/);
  assert.match(html, /<a href="https:\/\/example\.com\/standalone"[^>]*role="link"/);
  assert.equal([...html.matchAll(/<a\b/g)].length, 5);
  assert.match(html, /href="https:\/\/example\.com\/details"/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /href="customapp:|<img\b|tracker\.png|<script>/);
});
