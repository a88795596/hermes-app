const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

const source = ts.transpileModule(readFileSync(require.resolve("../src/chat/load-attachment.web.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;

function loadModule() {
  const exports = {};
  new Function("exports", "require", source)(exports, (name) => {
    if (name === "./attachment-content") return {
      attachmentUrl: () => "https://mobile.example/mobile/v1/attachments/id",
      readAttachment: async (response, _size, write) => write(new Uint8Array(await response.arrayBuffer())),
    };
    return require(name);
  });
  return exports;
}

test("Web 附件使用浏览器下载原文件名，下载后释放对象地址", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalTimeout = globalThis.setTimeout;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    globalThis.setTimeout = originalTimeout;
  });
  const events = [];
  let cleanup;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer private-device-token");
    return new Response("hello");
  };
  URL.createObjectURL = () => "blob:received-file";
  URL.revokeObjectURL = (uri) => events.push(["revoke", uri]);
  globalThis.setTimeout = (callback) => { cleanup = callback; return 1; };
  const anchor = { style: {}, click() { events.push(["click", this.href, this.download]); }, remove() { events.push(["remove"]); } };
  globalThis.document = { createElement: () => anchor, body: { appendChild: () => events.push(["append"]) } };

  const { saveAttachment } = loadModule();
  assert.equal(await saveAttachment({ origin: "https://mobile.example", token: "private-device-token" },
    { attachment_id: "id", name: "中文报告.pdf", mime: "application/pdf", size: 5 }), "downloaded");
  assert.deepEqual(events, [["append"], ["click", "blob:received-file", "中文报告.pdf"], ["remove"]]);
  cleanup();
  assert.deepEqual(events.at(-1), ["revoke", "blob:received-file"]);
});
