const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync, rmSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
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
      getBundleId: () => builtinId,
      isUpdateDownloaded: () => false,
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

test("版本显示发布命令的公开包 ID，时间取构建产物；下载新包不会提前改变显示", async () => {
  let selectedBundle = bundleId;
  const runtime = loadUpdates({ init: () => ({
    getManifest: () => ({ bundleId: selectedBundle, assets: {} }),
    getBundleId: () => "017f22e2-89b0-7cc3-98c4-dc0c0c07398f",
    async checkForUpdate() {
      return { async updateBundle() { selectedBundle = "017f22e2-99b0-7cc3-98c4-dc0c0c07398f"; return true; } };
    },
  }) });
  const expected = { id: "017f22e2-89b0-7cc3-98c4-dc0c0c07398f", builtAt: 1645557742000 };
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
    const runtime = loadUpdates({ init: () => ({ getManifest: () => ({ bundleId: id, assets: {} }), getBundleId: () => id }) });
    assert.deepEqual(runtime.currentUpdate, { id, builtAt: undefined });
  }
});

test("双平台发布共享同一个数据库与存储配置，保留原生构建无需管理令牌的能力", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "hermes-ota-config-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const configUrl = pathToFileURL(require.resolve("../hot-updater.config.ts")).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    const { default: configure } = await import(${JSON.stringify(configUrl)});
    const ios = configure({ platform: "ios", channel: "preview" });
    const android = configure({ platform: "android", channel: "preview" });
    assert.equal(ios.database, android.database);
    assert.equal(ios.storage, android.storage);
    assert.equal(configure(null).updateStrategy, "fingerprint");
  `], { cwd, encoding: "utf8", env: { ...process.env,
    EXPO_PUBLIC_HOT_UPDATER_BASE_URL: "https://updates.example.com", EXPO_PUBLIC_HOT_UPDATER_API_KEY: "fixture-client-key",
    HOT_UPDATER_BASE_URL: "https://updates.example.com", HOT_UPDATER_ADMIN_TOKEN: "",
  } });
  assert.equal(result.status, 0, result.stderr);
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

test("手动检查先确认 Message、发布时间和 ID，确认后才下载且不重载", async () => {
  let downloads = 0;
  const runtime = loadUpdates({ init: () => ({
    async checkForUpdate(options) {
      assert.equal(options.updateStrategy, "fingerprint");
      return { id: bundleId, message: "修复会话显示", async updateBundle() { downloads++; return true; } };
    },
    reload() { assert.fail("不能重载当前会话"); },
  }) });
  const result = await runtime.checkUpdateManually(async (update) => {
    assert.deepEqual(update, { id: bundleId, message: "修复会话显示", publishedAt: 1645557742000 });
    assert.equal(downloads, 0);
    return true;
  });
  assert.equal(downloads, 1);
  assert.equal(result, "热更新已下载，下次启动 App 时生效。");
});

test("取消仅跳过本次手动下载，后续自动更新和手动重试仍可下载", async () => {
  let checks = 0;
  let downloads = 0;
  const runtime = loadUpdates({ init: () => ({
    async checkForUpdate() {
      checks++;
      return { id: bundleId, message: null, async updateBundle() { downloads++; return true; } };
    },
  }) });
  assert.equal(await runtime.checkUpdateManually(async (update) => {
    assert.equal(update.message, null);
    return false;
  }), undefined);
  assert.equal(downloads, 0);
  await runtime.prepareUpdate();
  assert.equal(downloads, 1);
  await runtime.checkUpdateManually(async () => true);
  assert.equal(downloads, 2);
  assert.equal(checks, 3);
});

test("手动检查等待启动下载结束，已下载版本提示下次启动生效", async () => {
  let finishDownload;
  let downloaded = false;
  let checks = 0;
  const runtime = loadUpdates({ init: () => ({
    isUpdateDownloaded: () => downloaded,
    async checkForUpdate() {
      checks++;
      if (checks > 1) return null;
      return { updateBundle: () => new Promise((resolve) => {
        finishDownload = () => { downloaded = true; resolve(true); };
      }) };
    },
  }) });
  const automatic = runtime.prepareUpdate();
  await Promise.resolve();
  const manual = runtime.checkUpdateManually(() => assert.fail("已经下载，不应再次询问"));
  await Promise.resolve();
  assert.equal(checks, 1);
  finishDownload();
  await automatic;
  assert.equal(await manual, "热更新已下载，下次启动 App 时生效。");
  assert.equal(checks, 2);
});

test("手动检查区分没有更新、未启用和 SDK 回调报告的检查失败", async () => {
  const confirm = () => assert.fail("没有可确认的更新");
  assert.equal(await loadUpdates({ env: {} }).checkUpdateManually(confirm), "当前版本未启用热更新。");
  assert.equal(await loadUpdates({ init: () => ({ checkForUpdate: async () => null }) }).checkUpdateManually(confirm), "当前已是最新版本。");
  for (const checkForUpdate of [
    async () => { throw new Error("offline"); },
    async (options) => { options.onError(new Error("offline")); return null; },
  ]) {
    await assert.rejects(loadUpdates({ init: () => ({ checkForUpdate }) }).checkUpdateManually(confirm), /检查热更新失败/);
  }
});

test("无时间的版本仍可确认，下载失败和过期目录均提示重试", async () => {
  for (const download of [async () => false, async () => { throw new Error("stale catalog"); }]) {
    const runtime = loadUpdates({ init: () => ({
      async checkForUpdate() { return { id: "legacy-bundle", message: null, updateBundle: download }; },
    }) });
    await assert.rejects(runtime.checkUpdateManually(async (update) => {
      assert.deepEqual(update, { id: "legacy-bundle", message: null, publishedAt: undefined });
      return true;
    }), /热更新下载失败/);
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
