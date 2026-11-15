import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function run(t, platform, args = [], env = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hermes-release-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "apps/mobile"), { recursive: true });
  mkdirSync(join(root, "bin"));
  const source = new URL("../mobile-release.mjs", import.meta.url);
  if (existsSync(source)) copyFileSync(source, join(root, "scripts/mobile-release.mjs"));
  writeFileSync(join(root, "apps/mobile/.env.local"), "EXPO_PUBLIC_HOT_UPDATER_BASE_URL=https://updates.example.com\nEXPO_PUBLIC_HOT_UPDATER_API_KEY=private-client-fixture\n");
  writeFileSync(join(root, "apps/mobile/app.json"), JSON.stringify({ expo: { android: { package: "com.hermesmobile.app" }, ios: { bundleIdentifier: "hermes.cashcat.cn" } } }));
  const log = join(root, "calls.jsonl");
  // Only native tools and build subprocesses are replaced; run the actual command script.
  const tool = `#!${process.execPath}
import {appendFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS, JSON.stringify({name,args,cwd:process.cwd(),clientKey:process.env.EXPO_PUBLIC_HOT_UPDATER_API_KEY})+'\\n');
if (process.env.FAIL_STEP && args.includes(process.env.FAIL_STEP)) process.exit(9);
if (name === 'pnpm' && args.some(arg => arg.startsWith('--registry'))) process.exit(8);
if (name === 'adb' && args.includes('devices')) console.log('List of devices attached\\n'+(process.env.ANDROID_DEVICES ?? 'phone-one device usb:1 model:Phone')+'\\n');
if (name === 'adb' && args.includes('start')) console.log(process.env.ANDROID_LAUNCH ?? 'Status: ok\\nActivity: com.hermesmobile.app/.MainActivity');
if (name === 'xcrun' && args.includes('list')) console.log(JSON.stringify({result:{devices:[
 {identifier:'simulator',hardwareProperties:{reality:'simulated',platform:'iOS',udid:'simulator'},connectionProperties:{tunnelState:'connected'}},
 {identifier:'offline',hardwareProperties:{reality:'physical',platform:'iOS',udid:'offline'},connectionProperties:{tunnelState:'unavailable'}},
 {identifier:'iphone-one',hardwareProperties:{reality:'physical',platform:'iOS',udid:'iphone-one'},connectionProperties:{tunnelState:'connected'}}
]}}));
if (name === 'pnpm' && args.includes('build')) {
 if (!args.includes('--local')) process.exit(8);
 const output = args[args.indexOf('--output')+1];
 writeFileSync(output,'signed IPA fixture');
}
if (name === 'ditto') { const dir=join(args.at(-1),'Payload','Hermes.app'); mkdirSync(dir,{recursive:true}); }
`;
  for (const name of ["adb", "xcrun", "pnpm", "ditto", "codesign"]) writeFileSync(join(root, "bin", name), tool, { mode: 0o755 });
  const result = spawnSync(process.execPath, [join(root, "scripts/mobile-release.mjs"), platform, ...args], {
    cwd: tmpdir(), encoding: "utf8", env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, CALLS: log,
      JAVA_HOME: "/fixture/jdk17", ...env },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [];
  return { ...result, calls, root };
}

test("Android 从项目目录生成原生工程，再对唯一真机执行 Release 编译安装", (t) => {
  const result = run(t, "android");
  assert.equal(result.status, 0, result.stderr);
  const builds = result.calls.filter(call => call.name === "pnpm");
  assert.deepEqual(builds.map(call => call.args), [
    ["setup:speech", "--platform", "android"],
    ["exec", "expo", "prebuild", "--platform", "android", "--no-install"],
    ["exec", "expo", "run:android", "--variant", "release", "--device", "phone-one", "--no-bundler"],
  ]);
  assert.ok(builds.every(call => call.cwd === join(result.root, "apps/mobile")));
  assert.ok(builds.every(call => call.clientKey === "private-client-fixture"));
  assert.deepEqual(result.calls.at(-1).args, ["-s", "phone-one", "shell", "am", "start", "-W", "-S", "-n", "com.hermesmobile.app/.MainActivity"]);
  assert.doesNotMatch(result.stdout + result.stderr, /private-client-fixture/);
});

test("Android 启动失败时不因 adb 退出码为零而报告成功", (t) => {
  const result = run(t, "android", [], { ANDROID_LAUNCH: "Error: Activity not started, unable to resolve Intent" });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /安装和启动完成/);
});

test("Android 多设备时要求明确选择，不会静默安装到错误手机或模拟器", (t) => {
  const env = { ANDROID_DEVICES: "phone-one device usb:1\nphone-two device usb:2\nemulator-5554 device" };
  const ambiguous = run(t, "android", [], env);
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /--device/);
  assert.ok(!ambiguous.calls.some(call => call.name === "pnpm"));
  const selected = run(t, "android", ["--device", "phone-two"], env);
  assert.equal(selected.status, 0, selected.stderr);
  assert.ok(selected.calls.at(-1).args.includes("phone-two"));
  const emulator = run(t, "android", ["--device", "emulator-5554"], env);
  assert.notEqual(emulator.status, 0);
  assert.ok(!emulator.calls.some(call => call.name === "pnpm"));
});

test("iOS 使用本地 Ad Hoc 构建产物，验证签名后安装并启动选中的真机", (t) => {
  const result = run(t, "ios");
  assert.equal(result.status, 0, result.stderr);
  const build = result.calls.find(call => call.name === "pnpm" && call.args.includes("build"));
  const fingerprint = result.calls.find(call => call.args.includes("fingerprint"));
  const speech = result.calls.find(call => call.name === "pnpm" && call.args.includes("setup:speech"));
  assert.ok(speech && result.calls.indexOf(speech) < result.calls.indexOf(fingerprint), "准备离线语音资源后才生成原生指纹与构建归档");
  assert.deepEqual(speech.args, ["setup:speech", "--platform", "ios"]);
  assert.ok(fingerprint && result.calls.indexOf(fingerprint) < result.calls.indexOf(build));
  assert.deepEqual(fingerprint.args, ["exec", "hot-updater", "fingerprint", "create"]);
  assert.ok(build.args.includes("--local"));
  assert.equal(build.args[build.args.indexOf("--profile") + 1], "preview");
  assert.ok(build.args.includes("--freeze-credentials"));
  assert.ok(build.args.includes("--non-interactive"));
  assert.equal(build.clientKey, "private-client-fixture");
  const install = result.calls.find(call => call.args.includes("install"));
  assert.equal(install.args[install.args.indexOf("--device") + 1], "iphone-one");
  assert.ok(install.args.at(-1).startsWith(join(result.root, ".data/builds/ios-")));
  assert.ok(result.calls.findIndex(call => call.name === "codesign") < result.calls.indexOf(install));
  assert.deepEqual(result.calls.at(-1).args, ["devicectl", "device", "process", "launch", "--device", "iphone-one", "--terminate-existing", "hermes.cashcat.cn"]);
});

test("语音资源准备失败后不继续原生指纹、构建或安装", (t) => {
  for (const platform of ["ios", "android"]) {
    const result = run(t, platform, [], { FAIL_STEP: "setup:speech" });
    assert.notEqual(result.status, 0);
    assert.ok(result.calls.some(call => call.args.includes("setup:speech")));
    assert.ok(!result.calls.some(call => call.args.some(arg => ["fingerprint", "build", "prebuild", "run:android", "install", "launch"].includes(arg))));
  }
});

test("iOS 构建失败后不安装遗留产物", (t) => {
  const result = run(t, "ios", [], { FAIL_STEP: "build" });
  assert.notEqual(result.status, 0);
  assert.ok(result.calls.some(call => call.args.includes("build")));
  assert.ok(!result.calls.some(call => call.args.includes("install") || call.args.includes("launch")));
});

test("设备安装失败时停止，不报告启动成功", (t) => {
  const result = run(t, "ios", [], { FAIL_STEP: "install" });
  assert.notEqual(result.status, 0);
  assert.ok(result.calls.some(call => call.args.includes("install")));
  assert.ok(!result.calls.some(call => call.args.includes("launch")));
});
