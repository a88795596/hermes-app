const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { registerHooks } = require("node:module");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const ts = require("typescript");

const target = pathToFileURL(require("node:path").resolve(__dirname, "../src/chat/attachment-content.ts"));
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url !== target.href) return nextLoad(url, context);
    return { format: "commonjs", shortCircuit: true, source: ts.transpileModule(readFileSync(target, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText };
  },
});
const content = require(target.pathname);
hooks.deregister();

test("附件按 MIME 与文档后缀选择图片、播放器和文档预览", () => {
  for (const [name, mime, expected] of [
    ["photo.png", "image/png", "image"], ["voice.ogg", "audio/ogg", "audio"],
    ["movie.mp4", "video/mp4", "video"], ["REPORT.MD", "application/octet-stream", "markdown"],
    ["page.htm", "text/plain", "html"], ["report", "text/markdown", "markdown"],
    ["index", "text/html", "html"], ["data.zip", "application/zip", "file"],
    ["voice.m4a", "application/octet-stream", "audio"], ["clip.mov", "application/octet-stream", "video"],
  ]) assert.equal(content.attachmentKind({ name, mime }), expected);
});

test("下载地址仅来自已配对的服务器，拒绝任意路径和超大尺寸", () => {
  const session = { origin: "https://mobile.example", token: "private" };
  const item = { attachment_id: "733ab797-95fd-42ea-b514-63c2b11413ac", size: 5 };
  assert.equal(content.attachmentUrl(session, item), "https://mobile.example/mobile/v1/attachments/733ab797-95fd-42ea-b514-63c2b11413ac");
  for (const attachment_id of [undefined, "https://evil.test/file", "../auth/session", "id?token=private"]) {
    assert.throws(() => content.attachmentUrl(session, { ...item, attachment_id }));
  }
  for (const size of [0, -1, 50 * 1024 * 1024 + 1, NaN]) assert.throws(() => content.attachmentUrl(session, { ...item, size }));
});

test("逐块下载验证长度，并拒绝错误响应、截断与超长内容", async () => {
  const bytes = [];
  await content.readAttachment(new Response("hello"), 5, async (chunk) => bytes.push(...chunk));
  assert.equal(Buffer.from(bytes).toString(), "hello");
  for (const response of [new Response("abc"), new Response("abcdef"), new Response("hello", { status: 401 }),
    new Response("hello", { headers: { "Content-Length": "6" } })]) {
    await assert.rejects(content.readAttachment(response, 5, async () => {}));
  }
});
