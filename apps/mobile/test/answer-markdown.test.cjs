const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { registerHooks } = require("node:module");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ts = require("typescript");

const component = pathToFileURL(require.resolve("../src/chat/answer-markdown.tsx"));
const themeModule = new URL("../src/ui/theme.tsx", component);
// Render the actual component through React Native Web in Node's test runner.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === component.href && specifier === "../ui/theme") {
      return { url: themeModule.href, shortCircuit: true };
    }
    return nextResolve(specifier === "react-native" ? "react-native-web" : specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === themeModule.href) {
      return { format: "commonjs", shortCircuit: true, source: "exports.useTheme = () => ({ colors: {} });" };
    }
    if (url !== component.href) return nextLoad(url, context);
    const source = ts.transpileModule(readFileSync(component, "utf8"), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    return { format: "commonjs", shortCircuit: true, source };
  },
});
const { AnswerMarkdown } = require("../src/chat/answer-markdown.tsx");
hooks.deregister();

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
