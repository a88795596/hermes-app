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
    constructor(directory, name) {
      this.uri = name === undefined ? directory : pathToFileURL(join(directory.uri ? fileURLToPath(directory.uri) : directory, name)).href;
    }
    get name() { return require("node:path").basename(fileURLToPath(this.uri)); }
    get exists() { return fs.existsSync(fileURLToPath(this.uri)); }
    get size() { return fs.statSync(fileURLToPath(this.uri)).size; }
    create() { fs.closeSync(fs.openSync(fileURLToPath(this.uri), "wx")); }
    open(mode) {
      const path = fileURLToPath(this.uri);
      const handle = fs.openSync(path, mode === "read" ? "r" : "w");
      return {
        readBytes: async (length) => {
          const bytes = Buffer.alloc(length);
          return bytes.subarray(0, fs.readSync(handle, bytes));
        },
        writeBytes: async (chunk) => {
          if (state.writeError && this.uri.startsWith(state.pickedDirectory.uri)) throw new Error("write failed");
          fs.writeSync(handle, chunk);
        },
        close: () => fs.closeSync(handle),
      };
    }
    delete() { fs.unlinkSync(fileURLToPath(this.uri)); }
    async text() { return fs.readFileSync(fileURLToPath(this.uri), "utf8"); }
    async move(destination, options) {
      if (destination.exists && !options?.overwrite) throw new Error("Destination exists");
      fs.renameSync(fileURLToPath(this.uri), fileURLToPath(destination.uri));
      this.uri = destination.uri;
    }
    async copy(destination, options) {
      if (destination.uri.startsWith(state.pickedDirectory.uri)) throw new Error("SAF copy rejected");
      if (destination.exists && !options?.overwrite) throw new Error("Destination exists");
      fs.copyFileSync(fileURLToPath(this.uri), fileURLToPath(destination.uri));
    }
  }
  class Directory {
    constructor(parent, name) { this.uri = pathToFileURL(join(parent.uri ? fileURLToPath(parent.uri) : parent, name ?? "")).href; }
    static async pickDirectoryAsync() {
      state.pickerCalls++;
      if (state.pickerError) throw state.pickerError;
      fs.mkdirSync(fileURLToPath(state.pickedDirectory.uri), { recursive: true });
      return state.pickedDirectory;
    }
    create() { fs.mkdirSync(fileURLToPath(this.uri)); }
    delete() { fs.rmSync(fileURLToPath(this.uri), { recursive: true }); }
    list() { return fs.readdirSync(fileURLToPath(this.uri)).map((name) => new File(this, name)); }
    createFile(name) { const file = new File(this, name); fs.closeSync(fs.openSync(fileURLToPath(file.uri), "wx")); return file; }
  }
  const state = {
    requests: 0, respond: async () => new Response("hello"), pickerCalls: 0,
    pickedDirectory: new Directory(directory, "saved"), pickerError: undefined, writeError: false,
    permissions: [], assets: [], granted: true, albumError: false,
  };
  const dependencies = {
    "expo-crypto": { randomUUID, CryptoDigestAlgorithm: { SHA256: "sha256" },
      digestStringAsync: async (algorithm, value) => createHash(algorithm).update(value).digest("hex") },
    "expo-file-system": { Directory, File, FileMode: { ReadOnly: "read", WriteOnly: "write" }, Paths: { cache: directory } },
    "expo-media-library": { requestPermissionsAsync: async (...args) => {
      state.permissions.push(args);
      return { granted: state.granted };
    }, Asset: { create: async (uri) => {
      if (state.albumError) throw new Error("unsupported format");
      state.assets.push({ name: require("node:path").basename(fileURLToPath(uri)), content: fs.readFileSync(fileURLToPath(uri), "utf8") });
    } } },
    "expo/fetch": { fetch: async (url, options) => {
      state.requests++;
      assert.equal(options.redirect, "error");
      assert.ok(options.headers.Authorization.startsWith("Bearer "));
      return state.respond(url, options);
    } },
    "./attachment-content": content,
  };
  return { state, directory, reload: () => loadModule("load-attachment", dependencies).loadAttachment,
    save: () => loadModule("load-attachment", dependencies).saveAttachment };
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

test("图片和视频保存到相册，使用原名并仅申请写入权限", async (t) => {
  const { state, directory, save } = runtime(t);
  for (const [name, mime, permission] of [["照片.jpg", "image/jpeg", "photo"], ["片段.mp4", "video/mp4", "video"]]) {
    assert.equal(await save()(session, { ...item, attachment_id: randomUUID(), name, mime }), "album");
    assert.deepEqual(state.permissions.at(-1), [true, [permission]]);
  }
  assert.deepEqual(state.assets, [{ name: "照片.jpg", content: "hello" }, { name: "片段.mp4", content: "hello" }]);
  assert.equal(state.pickerCalls, 0);
  assert.equal(fs.readdirSync(directory).filter((name) => name.startsWith("export-")).length, 0);
});

test("普通文件由用户选择目录保存，同名文件不覆盖", async (t) => {
  const { state, save } = runtime(t);
  fs.mkdirSync(fileURLToPath(state.pickedDirectory.uri));
  fs.writeFileSync(join(fileURLToPath(state.pickedDirectory.uri), "报告.pdf"), "old");
  assert.equal(await save()(session, { ...item, name: "报告.pdf", mime: "application/pdf" }), "files");
  assert.equal(fs.readFileSync(join(fileURLToPath(state.pickedDirectory.uri), "报告.pdf"), "utf8"), "old");
  assert.equal(fs.readFileSync(join(fileURLToPath(state.pickedDirectory.uri), "报告 (1).pdf"), "utf8"), "hello");
  assert.equal(state.pickerCalls, 1);
});

test("取消目录选择不下载；相册权限拒绝或格式不支持时仍可保存到文件", async (t) => {
  const { state, save } = runtime(t);
  state.pickerError = new Error("The file picker was cancelled by the user");
  assert.equal(await save()(session, { ...item, name: "notes.txt", mime: "text/plain" }), "cancelled");
  assert.equal(state.requests, 0);
  state.pickerError = undefined;
  state.granted = false;
  assert.equal(await save()(session, { ...item, name: "图片.png", mime: "image/png" }), "files");
  state.granted = true;
  state.albumError = true;
  assert.equal(await save()(session, { ...item, attachment_id: randomUUID(), name: "图像.webp", mime: "image/webp" }), "files");
  assert.equal(fs.readFileSync(join(fileURLToPath(state.pickedDirectory.uri), "图片.png"), "utf8"), "hello");
  assert.equal(fs.readFileSync(join(fileURLToPath(state.pickedDirectory.uri), "图像.webp"), "utf8"), "hello");
});

test("文件写入失败时清除新建的空文件并保留下载缓存", async (t) => {
  const { state, save, directory } = runtime(t);
  state.writeError = true;
  await assert.rejects(save()(session, { ...item, name: "notes.txt", mime: "text/plain" }), /write failed/);
  assert.deepEqual(fs.readdirSync(fileURLToPath(state.pickedDirectory.uri)), []);
  assert.equal(fs.readdirSync(directory).filter((name) => name.startsWith("received-")).length, 1);
});

test("附件记录无效时不申请相册权限、打开文件夹或发起下载", async (t) => {
  const { state, save } = runtime(t);
  await assert.rejects(save()(session, { ...item, attachment_id: "../bad", name: "photo.jpg", mime: "image/jpeg" }), /附件信息无效/);
  assert.equal(state.pickerCalls, 0);
  assert.deepEqual(state.permissions, []);
  assert.equal(fs.existsSync(fileURLToPath(state.pickedDirectory.uri)), false);
  assert.equal(state.requests, 0);
});
