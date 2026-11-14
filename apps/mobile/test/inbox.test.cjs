const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { registerHooks } = require("node:module");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ts = require("typescript");

const sourceRoot = pathToFileURL(require.resolve("../src/inbox/inbox.tsx")).href.replace(/inbox\/inbox\.tsx$/, "");
// Render the actual inbox, shared controls, and Markdown through React Native Web.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (["expo-symbols", "expo-web-browser"].includes(specifier)) {
      return { url: `inbox-test:${specifier}`, shortCircuit: true };
    }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".")) {
      for (const extension of [".tsx", ".ts"]) {
        const url = new URL(specifier + extension, context.parentURL);
        if (existsSync(url)) return { url: url.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier === "react-native" ? "react-native-web" : specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "inbox-test:expo-symbols") {
      return { format: "commonjs", shortCircuit: true, source: "exports.SymbolView = () => null;" };
    }
    if (url === "inbox-test:expo-web-browser") {
      return { format: "commonjs", shortCircuit: true,
        source: "exports.openBrowserAsync = async () => {}; exports.WebBrowserPresentationStyle = { PAGE_SHEET: 'pageSheet' };" };
    }
    if (!url.startsWith(sourceRoot)) return nextLoad(url, context);
    const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    return { format: "commonjs", shortCircuit: true, source };
  },
});
const { InboxList, InboxDetail } = require("../src/inbox/inbox.tsx");
hooks.deregister();

process.env.TZ = "Asia/Shanghai";
const profiles = [{ profile_id: "default", label: "default" }, { profile_id: "work", label: "工作" }];
const items = [
  { inbox_id: "old", profile_id: "work", title: "昨天报告", text: "昨天的完整正文", created_at: "2026-11-13T02:00:00Z" },
  { inbox_id: "early", profile_id: "default", title: "早间提醒", text: "第一行\n第二行\n第三行", created_at: "2026-11-14T01:00:00Z" },
  { inbox_id: "latest", profile_id: "work", title: "最新报告", text: "完整报告内容".repeat(40), created_at: "2026-11-14T03:00:00Z" },
];
const renderList = (props = {}) => renderToStaticMarkup(createElement(InboxList, {
  items, profiles, ready: true, onProfile() {}, onOpen() {}, ...props,
}));

test("收件箱默认全部在最左，按会话时间分组并在组内从新到旧排列", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-14T04:00:00Z") });
  const html = renderList({ items: [...items,
    { ...items[0], inbox_id: "week", title: "本周消息", created_at: "2026-11-10T02:00:00Z" },
    { ...items[0], inbox_id: "month", title: "本月消息", created_at: "2026-10-20T02:00:00Z" },
    { ...items[0], inbox_id: "older", title: "更早消息", created_at: "2026-09-20T02:00:00Z" },
  ] });
  assert.match(html, /aria-pressed="true"[^>]*>[\s\S]*?全部/);
  assert.ok(html.indexOf(">全部<") < html.indexOf(">默认<"));
  assert.ok(html.indexOf(">默认<") < html.indexOf(">工作<"));
  assert.ok(html.indexOf(">今天<") < html.indexOf("最新报告"));
  assert.ok(html.indexOf("最新报告") < html.indexOf("早间提醒"));
  assert.ok(html.indexOf("早间提醒") < html.indexOf(">昨天<"));
  assert.ok(html.indexOf(">昨天<") < html.indexOf("昨天报告"));
  assert.ok(html.indexOf("昨天报告") < html.indexOf(">7天内<"));
  assert.ok(html.indexOf(">7天内<") < html.indexOf("本周消息"));
  assert.ok(html.indexOf("本周消息") < html.indexOf(">一个月内<"));
  assert.ok(html.indexOf(">一个月内<") < html.indexOf("本月消息"));
  assert.ok(html.indexOf("本月消息") < html.indexOf(">一个月前<"));
  assert.ok(html.indexOf(">一个月前<") < html.indexOf("更早消息"));
  assert.equal([...html.matchAll(/aria-label="[^\"]+，(?:工作|默认)，/g)].length, 6);
  assert.match(html, /-webkit-line-clamp:2[^>]*>第一行 第二行 第三行</);
  assert.match(html, /aria-label="早间提醒，默认，[^"]+，第一行 第二行 第三行"/);
});

test("按档案只显示匹配消息，空档案仍可切换回全部", () => {
  const html = renderList({ profileId: "work" });
  assert.match(html, /最新报告/);
  assert.match(html, /昨天报告/);
  assert.doesNotMatch(html, /早间提醒/);
  const empty = renderList({ profileId: "missing" });
  assert.match(empty, /此档案暂无消息/);
  assert.match(empty, />全部</);
  assert.doesNotMatch(empty, /最新报告|早间提醒|昨天报告/);
});

test("旧缓存没有标题或档案时仍可在全部中阅读原文", () => {
  const legacy = { inbox_id: "legacy", text: "\n## 旧消息标题\n原文不能丢失", created_at: "2026-11-14T02:00:00Z" };
  const html = renderList({ items: [legacy] });
  assert.match(html, /aria-label="旧消息标题，未标注档案/);
  assert.match(html, /原文不能丢失/);
  assert.doesNotMatch(renderList({ items: [legacy], profileId: "work" }), /原文不能丢失/);
});

test("详情直接展示标题、完整 Markdown 正文、档案和接收时间，不再显示顶部导航栏", () => {
  const text = ["## 正文小节", "", "这是一段较长的消息正文。".repeat(80), "", "**最后一段内容**", "", "[查看文档](https://example.com/docs)"].join("\n");
  const html = renderToStaticMarkup(createElement(InboxDetail, { item: { ...items[2], text }, profiles }));
  assert.doesNotMatch(html, /返回收件箱|消息详情/);
  assert.match(html, />最新报告</);
  assert.match(html, /<h2[^>]*>[\s\S]*正文小节[\s\S]*<\/h2>/);
  assert.equal([...html.matchAll(/这是一段较长的消息正文。/g)].length, 80);
  assert.match(html, /最后一段内容/);
  assert.match(html, /href="https:\/\/example.com\/docs"/);
  assert.match(html, />工作</);
  assert.match(html, /2026年11月14日 11:00:00/);
  assert.doesNotMatch(html, /-webkit-line-clamp/);
});
