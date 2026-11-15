const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const test = require("node:test");
const ts = require("typescript");

function loadModule(name, dependencies) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(require.resolve(`../src/chat/${name}.ts`), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("exports", "require", source)(exports, (name) => dependencies[name] ?? require(name));
  return exports;
}

const content = loadModule("attachment-content", {});
const session = { origin: "https://mobile.example", token: "private-device-token" };
const item = { attachment_id: "733ab797-95fd-42ea-b514-63c2b11413ac", name: "report.md", mime: "text/markdown", size: 5 };
const signal = () => new AbortController().signal;

function runtime(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "hermes-attachment-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // Expo's native filesystem is unavailable in Node; keep real disk writes and renames.
  class File {
    constructor(directory, name) { this.uri = pathToFileURL(join(directory, name)).href; }
    get exists() { return fs.existsSync(fileURLToPath(this.uri)); }
    get size() { return fs.statSync(fileURLToPath(this.uri)).size; }
    create() { fs.closeSync(fs.openSync(fileURLToPath(this.uri), "wx")); }
    open() {
      const handle = fs.openSync(fileURLToPath(this.uri), "w");
      return { writeBytes: async (chunk) => { fs.writeSync(handle, chunk); }, close: () => fs.closeSync(handle) };
    }
    delete() { fs.unlinkSync(fileURLToPath(this.uri)); }
    async text() { return fs.readFileSync(fileURLToPath(this.uri), "utf8"); }
    async move(destination, options) {
      if (destination.exists && !options?.overwrite) throw new Error("Destination exists");
      fs.renameSync(fileURLToPath(this.uri), fileURLToPath(destination.uri));
      this.uri = destination.uri;
    }
  }
  const state = { requests: 0, respond: async () => new Response("hello") };
  const dependencies = {
    "expo-crypto": { randomUUID, CryptoDigestAlgorithm: { SHA256: "sha256" },
      digestStringAsync: async (algorithm, value) => createHash(algorithm).update(value).digest("hex") },
    "expo-file-system": { File, FileMode: { WriteOnly: "write" }, Paths: { cache: directory } },
    "expo/fetch": { fetch: async (url, options) => {
      state.requests++;
      assert.equal(options.redirect, "error");
      assert.ok(options.headers.Authorization.startsWith("Bearer "));
      return state.respond(url, options);
    } },
    "./attachment-content": content,
  };
  return { state, directory, reload: () => loadModule("load-attachment", dependencies).loadAttachment };
}

test("所有附件类型下载后保留磁盘缓存，释放预览和重启后可断网打开", async (t) => {
  const { state, reload } = runtime(t);
  const load = reload();
  const saved = [];
  for (const [name, mime] of [["photo.png", "image/png"], ["voice.mp3", "audio/mpeg"],
    ["movie.mp4", "video/mp4"], ["page.html", "text/html"], ["report.md", "text/markdown"], ["data.zip", "application/zip"]]) {
    const attachment = { ...item, attachment_id: randomUUID(), name, mime };
    const first = await load(session, attachment, signal());
    assert.equal(await first.text(), "hello");
    first.dispose();
    saved.push({ attachment, uri: first.uri });
  }
  assert.equal(state.requests, saved.length);
  state.respond = async () => { throw new Error("offline"); };
  const restarted = reload();
  for (const { attachment, uri } of saved) {
    const cached = await restarted(session, attachment, signal());
    assert.equal(cached.uri, uri);
    assert.equal(await cached.text(), "hello");
    cached.dispose();
  }
  assert.equal(state.requests, saved.length);
});

test("同名附件、不同服务器和配对凭证使用隔离缓存", async (t) => {
  const { state, reload } = runtime(t);
  const load = reload();
  const uris = new Set();
  for (const [paired, attachment] of [[session, item], [session, { ...item, attachment_id: randomUUID() }],
    [{ ...session, origin: "https://other.example" }, item], [{ ...session, token: "other-token" }, item]]) {
    const result = await load(paired, attachment, signal());
    assert.equal(await result.text(), "hello");
    assert.ok(!result.uri.includes(paired.token));
    uris.add(result.uri);
  }
  assert.equal(uris.size, 4);
  assert.equal(state.requests, 4);
});

test("缺失或损坏的缓存重新下载，缓存命中仍校验附件元数据", async (t) => {
  const { state, reload } = runtime(t);
  const load = reload();
  const first = await load(session, item, signal());
  fs.writeFileSync(fileURLToPath(first.uri), "bad");
  const repaired = await load(session, item, signal());
  assert.equal(await repaired.text(), "hello");
  assert.equal(repaired.uri, first.uri);
  fs.unlinkSync(fileURLToPath(repaired.uri));
  assert.equal(await (await load(session, item, signal())).text(), "hello");
  assert.equal(state.requests, 3);
  await assert.rejects(load(session, { ...item, size: 0 }, signal()));
  await assert.rejects(load(session, { ...item, attachment_id: "../secret" }, signal()));
  assert.equal(state.requests, 3);
});

test("错误响应和不完整下载不留下缓存，失败后可以重试", async (t) => {
  const { state, directory, reload } = runtime(t);
  const load = reload();
  for (const response of [new Response("hello", { status: 401 }), new Response("abc"),
    new Response("abcdef"), new Response("hello", { headers: { "Content-Length": "6" } })]) {
    state.respond = async () => response;
    await assert.rejects(load(session, item, signal()));
    assert.deepEqual(fs.readdirSync(directory), []);
  }
  state.respond = async () => new Response("hello");
  assert.equal(await (await load(session, item, signal())).text(), "hello");
  state.respond = async () => { throw new Error("offline"); };
  assert.equal(await (await load(session, item, signal())).text(), "hello");
  assert.equal(state.requests, 5);
});

test("并发打开共用下载，退出一个预览不取消其他预览或已完成缓存", async (t) => {
  const { state, reload } = runtime(t);
  const load = reload();
  let finish;
  const ready = new Promise((resolve) => { finish = resolve; });
  state.respond = async (_url, options) => {
    await ready;
    options.signal.throwIfAborted();
    return new Response("hello");
  };
  const controller = new AbortController();
  const results = Promise.allSettled([load(session, item, controller.signal), load(session, item, signal())]);
  await new Promise(setImmediate);
  controller.abort();
  finish();
  const [canceled, completed] = await results;
  assert.equal(canceled.status, "rejected");
  assert.equal(canceled.reason.name, "AbortError");
  assert.equal(completed.status, "fulfilled");
  assert.equal(await completed.value.text(), "hello");
  completed.value.dispose();
  assert.equal(await (await load(session, item, signal())).text(), "hello");
  assert.equal(state.requests, 1);
});

test("已经取消的打开请求不发起下载", async (t) => {
  const { state, reload } = runtime(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(reload()(session, item, controller.signal), { name: "AbortError" });
  assert.equal(state.requests, 0);
});
