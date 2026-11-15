const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { registerHooks } = require("node:module");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ts = require("typescript");

const chat = pathToFileURL(`${require("node:path").resolve(__dirname, "../src/chat")}/`);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(chat.href) && specifier === "react-native-webview") {
      return { url: "html-test:webview", shortCircuit: true };
    }
    if (context.parentURL?.startsWith(chat.href) && specifier === "./html-document") {
      return { url: new URL("html-document.ts", chat).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "html-test:webview") return { format: "commonjs", shortCircuit: true, source: "exports.WebView = (props) => { globalThis.previewWebView = props; return null; };" };
    if (!url.startsWith(chat.href) || !/\.tsx?$/.test(url)) return nextLoad(url, context);
    return {
      format: "commonjs", shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      }).outputText,
    };
  },
});
const { buildPreviewHtml } = require("../src/chat/html-document.ts");
const { HtmlPreview } = require("../src/chat/html-preview.web.tsx");
const { HtmlPreview: NativePreview } = require("../src/chat/html-preview.tsx");
hooks.deregister();

test("HTML 预览在不可信正文之前限制外部资源、fetch、文件、表单和子页面", () => {
  const source = '<!doctype html><html><head><base href="https://example.com"><script src="https://example.com/a.js"></script></head><body><button onclick="this.textContent=42">运行</button></body></html>';
  const preview = buildPreviewHtml(source, "交互.html");
  const policy = preview.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)[1];
  for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "img-src data: blob:", "media-src data: blob:", "font-src data: blob:"]) {
    assert.ok(policy.split("; ").includes(directive), directive);
  }
  assert.ok(preview.indexOf("Content-Security-Policy") < preview.indexOf("<iframe"));
  assert.match(preview, /<iframe[^>]*sandbox="allow-scripts"/);
  assert.doesNotMatch(preview, /allow-same-origin|allow-popups|allow-top-navigation|allow-forms/);
  assert.match(preview, /onclick=&quot;this.textContent=42&quot;/);
});

test("文件名和 HTML 不能逃出内层沙箱或覆盖外层安全策略", () => {
  const source = '"></iframe><script>parent.document.body.textContent="escaped"</script>';
  const preview = buildPreviewHtml(source, '"><script>alert(1)</script>');
  assert.equal([...preview.matchAll(/<iframe\b/g)].length, 1);
  assert.equal([...preview.matchAll(/<\/iframe>/g)].length, 1);
  assert.doesNotMatch(preview, /<script>|parent\.document[^&]*<\/script>/);
  assert.match(preview, /&lt;script&gt;parent\.document/);
});

test("Web 渲染器不授予同源、跳转、弹窗、下载或设备权限", () => {
  const output = renderToStaticMarkup(createElement(HtmlPreview, { html: "<h1>报告</h1>", name: "报告.html" }));
  assert.match(output, /<iframe/);
  assert.match(output, /sandbox="allow-scripts"/);
  assert.match(output, /referrerPolicy="no-referrer"/);
  assert.match(output, /title="报告.html"/);
  assert.match(output, /srcDoc="/);
  assert.doesNotMatch(output, /allow-same-origin|allow-popups|allow-top-navigation|allow-downloads|allow-forms|src="https?:/);
});

test("原生预览拒绝导航、文件访问、共享登录状态和消息桥", () => {
  renderToStaticMarkup(createElement(NativePreview, { html: "<h1>报告</h1>", name: "报告.html" }));
  const props = globalThis.previewWebView;
  assert.equal(props.onMessage, undefined);
  assert.equal(props.incognito, true);
  for (const property of ["allowFileAccess", "allowFileAccessFromFileURLs", "allowUniversalAccessFromFileURLs", "allowContentAccess", "sharedCookiesEnabled", "thirdPartyCookiesEnabled", "domStorageEnabled", "javaScriptCanOpenWindowsAutomatically"]) {
    assert.equal(props[property], false, property);
  }
  assert.equal(props.mediaCapturePermissionGrantType, "deny");
  assert.deepEqual(props.originWhitelist, ["*"]);
  for (const url of ["https://example.com", "file:///private/file", "content://media/1", "javascript:alert(1)", "hermes://pair", "data:text/html,test"]) {
    assert.equal(props.onShouldStartLoadWithRequest({ url }), false, url);
  }
  assert.equal(props.onShouldStartLoadWithRequest({ url: "about:blank" }), true);
  assert.equal(props.onShouldStartLoadWithRequest({ url: "about:srcdoc" }), true);
});
