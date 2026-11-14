const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

const source = ts.transpileModule(readFileSync(require.resolve("../src/updates.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const configured = { EXPO_PUBLIC_HOT_UPDATER_BASE_URL: "https://updates.example.com/", EXPO_PUBLIC_HOT_UPDATER_API_KEY: "client-key" };
const builtinId = "017f22e2-79b0-7000-8000-000000000000";
const bundleId = "017f22e2-79b0-7cc3-98c4-dc0c0c07398f";

function loadUpdates({ env = configured, dev = false, init = () => ({}) } = {}) {
  const exports = {};
  const warnings = [];
  const loaded = [];
  new Function("exports", "require", "process", "__DEV__", "console", source)(exports, (name) => {
    loaded.push(name);
    return { HotUpdater: { init: (options) => ({
      getManifest: () => ({ bundleId: builtinId, assets: {} }),
      getMinBundleId: () => builtinId,
      ...init(options),
    }) } };
  }, { env }, dev, { warn: (...args) => warnings.push(args) });
  return { ...exports, warnings, loaded };
}

test("开发和未启用热更新时不加载原生模块", async () => {
  for (const options of [{ env: {} }, { dev: true }]) {
    const runtime = loadUpdates(options);
    await runtime.prepareUpdate();
    assert.deepEqual(runtime.loaded, []);
    assert.deepEqual(runtime.warnings, []);
  }
});

test("版本信息固定为启动时的更新包 ID 和构建时间，下载新包不会提前改变显示", async () => {
  let selectedBundle = bundleId;
  const runtime = loadUpdates({ init: () => ({
    getManifest: () => ({ bundleId: selectedBundle, assets: {} }),
    getBundleId: () => "017f22e2-89b0-7cc3-98c4-dc0c0c07398f",
    async checkForUpdate() {
      return { async updateBundle() { selectedBundle = "017f22e2-99b0-7cc3-98c4-dc0c0c07398f"; return true; } };
    },
  }) });
  const expected = { id: bundleId, builtAt: 1645557742000 };
  assert.deepEqual(runtime.currentUpdate, expected);
  await runtime.prepareUpdate();
  assert.deepEqual(runtime.currentUpdate, expected);
});

test("内置包使用原生构建时间，开发与未启用状态不伪造时间", () => {
  assert.deepEqual(loadUpdates().currentUpdate, { id: "内置版本", builtAt: 1645557742000 });
  assert.deepEqual(loadUpdates({ dev: true }).currentUpdate, { id: "开发版本", builtAt: undefined });
  assert.deepEqual(loadUpdates({ env: {} }).currentUpdate, { id: "未启用", builtAt: undefined });
  assert.deepEqual(loadUpdates({ init() { throw new Error("missing native module"); } }).currentUpdate,
    { id: "不可用", builtAt: undefined });
});

test("不认识的更新包 ID 保留原值，构建时间显示为未知", () => {
  for (const id of ["legacy-bundle", "017f22e2-79b0-4cc3-98c4-dc0c0c07398f", "017f22e2-79b0-7cc3-98c4-dc0c0c07398f-invalid"]) {
    const runtime = loadUpdates({ init: () => ({ getManifest: () => ({ bundleId: id, assets: {} }) }) });
    assert.deepEqual(runtime.currentUpdate, { id, builtAt: undefined });
  }
});

test("启动按原生指纹检查，下载成功后留待下次启动，不重载聊天", async () => {
  const calls = [];
  const runtime = loadUpdates({ init(options) {
    calls.push(options);
    return {
      async checkForUpdate(options) {
        calls.push(options);
        return { async updateBundle() { calls.push("download"); return true; } };
      },
      async reload() { assert.fail("后台更新不能打断当前会话"); },
    };
  } });
  await runtime.prepareUpdate();
  assert.equal(calls[0].baseURL, "https://updates.example.com");
  assert.deepEqual(calls[0].requestHeaders, { "x-api-key": "client-key" });
  assert.deepEqual(calls.slice(1), [{ updateStrategy: "fingerprint" }, "download"]);
  assert.deepEqual(runtime.warnings, []);
});

test("没有更新时停止；初始化、网络和下载失败均不阻断应用", async () => {
  const cases = [
    { init() { return { async checkForUpdate() { return null; } }; }, warnings: 0 },
    { init() { throw new Error("missing native module"); }, warnings: 1 },
    { init() { return { async checkForUpdate() { throw new Error("offline"); } }; }, warnings: 1 },
    { init() { return { async checkForUpdate() { return { async updateBundle() { return false; } }; } }; }, warnings: 1 },
    { init() { return { async checkForUpdate() { return { async updateBundle() { throw new Error("download failed"); } }; } }; }, warnings: 1 },
  ];
  for (const { init, warnings } of cases) {
    const runtime = loadUpdates({ init });
    await runtime.prepareUpdate();
    assert.equal(runtime.warnings.length, warnings);
  }
});

test("原生构建拒绝不完整配置和不安全的更新地址", () => {
  const configure = require("../app.config.js");
  const config = { name: "Hermes 移动端" };
  const old = { ...process.env };
  try {
    delete process.env.EXPO_PUBLIC_HOT_UPDATER_BASE_URL;
    delete process.env.EXPO_PUBLIC_HOT_UPDATER_API_KEY;
    assert.equal(configure({ config }), config);
    process.env.EXPO_PUBLIC_HOT_UPDATER_BASE_URL = configured.EXPO_PUBLIC_HOT_UPDATER_BASE_URL;
    assert.throws(() => configure({ config }), /必须同时配置/);
    process.env.EXPO_PUBLIC_HOT_UPDATER_API_KEY = configured.EXPO_PUBLIC_HOT_UPDATER_API_KEY;
    assert.equal(configure({ config }), config);
    for (const address of ["http://updates.example.com", "https://user:secret@updates.example.com", "https://updates.example.com?token=secret", "https://updates.example.com#fragment"]) {
      process.env.EXPO_PUBLIC_HOT_UPDATER_BASE_URL = address;
      assert.throws(() => configure({ config }), /HTTPS 地址/);
    }
  } finally {
    process.env = old;
  }
});
