import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("插件合并后的原生配置保留麦克风权限，禁止后台录音", () => {
  const result = spawnSync("pnpm", ["--filter", "@hermes-mobile/mobile", "exec", "expo", "config", "--type", "introspect", "--json"], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const mods = JSON.parse(result.stdout)._internal.modResults;
  assert.match(mods.ios.infoPlist.NSMicrophoneUsageDescription, /设备/);
  assert.ok(!mods.ios.infoPlist.UIBackgroundModes?.includes("audio"));
  const permissions = mods.android.manifest.manifest["uses-permission"];
  assert.ok(permissions.some(({ $: value }) => value["android:name"] === "android.permission.RECORD_AUDIO"
    && value["tools:node"] !== "remove"));
  assert.ok(!permissions.some(({ $: value }) => value["android:name"] === "android.permission.FOREGROUND_SERVICE_MICROPHONE"
    && value["tools:node"] !== "remove"));
});
