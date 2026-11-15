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
    if (context.parentURL?.startsWith(sourceRoot) && ["../ui/overlay", "../ui/alerts"].includes(specifier)) {
      return { url: "inbox-test:overlay", shortCircuit: true };
    }
    if (["expo-symbols", "expo-web-browser", "expo-haptics", "expo-screen-orientation", "react-native-safe-area-context", "react-native-reanimated"].includes(specifier)) {
      return { url: `inbox-test:${specifier}`, shortCircuit: true };
    }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".")) {
      for (const extension of [".web.tsx", ".web.ts", ".tsx", ".ts"]) {
        const url = new URL(specifier + extension, context.parentURL);
        if (existsSync(url)) return { url: url.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier === "react-native" ? "react-native-web" : specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "inbox-test:overlay") {
      return { format: "commonjs", shortCircuit: true, source: "exports.OverlayModal = require('react-native-web').Modal; exports.useAlert = () => ({ alert() {} });" };
    }
    if (url === "inbox-test:expo-screen-orientation") {
      return { format: "commonjs", shortCircuit: true, source: "exports.OrientationLock = {}; exports.lockAsync = async () => {};" };
    }
    if (url === "inbox-test:expo-haptics") {
      return { format: "commonjs", shortCircuit: true, source: "exports.AndroidHaptics = {}; exports.NotificationFeedbackType = {};" };
    }
    if (url === "inbox-test:expo-symbols") {
      return { format: "commonjs", shortCircuit: true, source: "exports.SymbolView = () => null;" };
    }
    if (url === "inbox-test:react-native-safe-area-context") {
      return { format: "commonjs", shortCircuit: true, source: "exports.SafeAreaView = require('react-native-web').View;" };
    }
    if (url === "inbox-test:react-native-reanimated") {
      return { format: "commonjs", shortCircuit: true, source: "exports.cubicBezier = () => undefined;" };
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

test("纯附件消息列出文件并为五类内容提供预览或播放入口", () => {
  const attachments = [
    ["图片.png", "image/png"], ["语音.m4a", "audio/mp4"], ["视频.mp4", "video/mp4"],
    ["报告.md", "text/markdown"], ["页面.html", "text/html"],
  ].map(([name, mime], index) => ({ name, mime, size: 100, attachment_id: `733ab797-95fd-42ea-b514-63c2b11413a${index}` }));
  const item = { ...items[0], title: undefined, text: "", attachments };
  const html = renderToStaticMarkup(createElement(InboxDetail, {
    item, profiles, session: { origin: "https://mobile.example", token: "private-token" }, onBack() {},
  }));
  for (const name of ["图片.png", "语音.m4a", "视频.mp4", "报告.md", "页面.html"]) assert.ok(html.includes(name));
  assert.match(html, /打开音频：语音.m4a/);
  assert.match(html, /打开视频：视频.mp4/);
  assert.match(html, /打开预览：报告.md/);
  assert.match(html, /打开预览：页面.html/);
  assert.doesNotMatch(html, /private-token/);
  assert.ok(renderList({ items: [item] }).includes("语音.m4a"));
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

test("收件箱的两行摘要提取 Markdown 显示文字，保留代码与原样标点", () => {
  const text = [
    "## 重点", "", "- 09:30 **产品_需求**", "- [打开清单](https://example.com/preview)",
    "- `**原样**` 已保留 \\*星号\\*", "", "```ts", "flag__name = 1", "```",
  ].join("\n");
  const html = renderList({ items: [{ ...items[0], text }] });
  assert.match(html, /-webkit-line-clamp:2[^>]*>重点 09:30 产品_需求 打开清单 \*\*原样\*\* 已保留 \*星号\* flag__name = 1</u);
  assert.doesNotMatch(html, /https:\/\/example\.com\/preview/u);
});

test("旧缓存没有标题或档案时仍可在全部中阅读原文", () => {
  const legacy = { inbox_id: "legacy", text: "\n## 旧消息标题\n原文不能丢失", created_at: "2026-11-14T02:00:00Z" };
  const html = renderList({ items: [legacy] });
  assert.match(html, /aria-label="旧消息标题，未标注档案/);
  assert.match(html, /原文不能丢失/);
  assert.doesNotMatch(renderList({ items: [legacy], profileId: "work" }), /原文不能丢失/);
});

test("详情标题只在顶部导航显示一次，正文、档案和接收时间完整保留", () => {
  const text = ["## 正文小节", "", "这是一段较长的消息正文。".repeat(80), "", "**最后一段内容**", "", "[查看文档](https://example.com/docs)"].join("\n");
  const html = renderToStaticMarkup(createElement(InboxDetail, {
    item: { ...items[2], text }, profiles, session: { origin: "https://mobile.example", token: "private-token" }, onBack() {},
  }));
  assert.match(html, /aria-label="返回收件箱"/);
  assert.match(html, /aria-label="最新报告"/);
  assert.equal([...html.matchAll(/>最新报告</g)].length, 1);
  assert.match(html, /<h2[^>]*>[\s\S]*正文小节[\s\S]*<\/h2>/);
  assert.equal([...html.matchAll(/这是一段较长的消息正文。/g)].length, 80);
  assert.match(html, /最后一段内容/);
  assert.match(html, /href="https:\/\/example.com\/docs"/);
  assert.match(html, />工作</);
  assert.match(html, /2026年11月14日 11:00:00/);
  assert.doesNotMatch(html, /-webkit-line-clamp/);
});
