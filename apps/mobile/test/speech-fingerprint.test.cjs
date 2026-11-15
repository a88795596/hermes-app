const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

test("语音原生实现和模型版本进入对应平台指纹，下载产物不影响兼容性", (t) => {
  const root = mkdtempSync(join(tmpdir(), "hermes-speech-fingerprint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configUrl = pathToFileURL(require.resolve("../hot-updater.config.ts")).href;
  const hotUpdaterUrl = pathToFileURL(require.resolve("hot-updater")).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
    import { createRequire } from "node:module";
    import { dirname, join } from "node:path";
    const require = createRequire(${JSON.stringify(hotUpdaterUrl)});
    const { createInterfaceFingerprint } = require("@hot-updater/cli-tools");
    const { default: configure } = await import(${JSON.stringify(configUrl)});
    const options = configure(null).fingerprint;
    const root = process.cwd();
    const mobile = join(root, "apps/mobile");
    function write(path, contents) {
      mkdirSync(dirname(join(mobile, path)), { recursive: true });
      writeFileSync(join(mobile, path), contents);
    }
    write("package.json", JSON.stringify({ name: "fingerprint-fixture", private: true }));
    write("app.json", JSON.stringify({ expo: { name: "Hermes", slug: "hermes" } }));
    write("app.config.js", "module.exports = ({ config }) => config;");
    write("eas.json", JSON.stringify({ build: { preview: { distribution: "internal" } } }));
    const sources = [
      ["modules/speech-recognition/ios/SpeechRecognitionRuntime.swift", "ios"],
      ["modules/speech-recognition/HermesSpeechRecognition.podspec", "ios"],
      ["modules/speech-recognition/android/src/main/java/expo/modules/hermesspeech/HermesSpeechRecognitionModule.kt", "android"],
      ["modules/speech-recognition/android/build.gradle", "android"],
      ["modules/speech-recognition/android/consumer-rules.pro", "android"],
      ["modules/speech-recognition/index.ts", "both"],
      ["modules/speech-recognition/expo-module.config.json", "both"],
      ["../../scripts/setup-speech-recognition.py", "both"],
    ];
    for (const [path] of sources) write(path, "original native contract or pinned model");
    // Expo reports this local module as an empty registry version; extraSources must protect its actual code.
    const nativeInterface = { runtime: "fixture-native-runtime", dependencies: [{ name: "speech-recognition", version: "" }] };
    async function hashes() {
      const platforms = ["ios", "android"];
      const values = await Promise.all(platforms.map(async (platform) =>
        (await createInterfaceFingerprint(mobile, { ...options, platform }, nativeInterface)).hash));
      return Object.fromEntries(platforms.map((platform, index) => [platform, values[index]]));
    }
    const baseline = await hashes();
    for (const [path, affected] of sources) {
      const original = readFileSync(join(mobile, path));
      write(path, "changed native contract or pinned model");
      const changed = await hashes();
      for (const platform of ["ios", "android"]) {
        if (affected === "both" || affected === platform)
          assert.notEqual(changed[platform], baseline[platform], path + " must change " + platform + " fingerprint");
        else assert.equal(changed[platform], baseline[platform], path + " must leave " + platform + " fingerprint unchanged");
      }
      write(path, original);
    }
    write("modules/speech-recognition/vendor/model/encoder.int8.onnx", "downloaded model fixture");
    write("modules/speech-recognition/vendor/android/sherpa-onnx.aar", "downloaded Android runtime fixture");
    write("modules/speech-recognition/vendor/frameworks/SherpaOnnxC.xcframework/Info.plist", "downloaded iOS runtime fixture");
    assert.deepEqual(await hashes(), baseline, "preparing pinned vendor assets must not change either fingerprint");
  `], { cwd: root, encoding: "utf8", env: { ...process.env,
    HOT_UPDATER_BASE_URL: "https://updates.example.com", HOT_UPDATER_ADMIN_TOKEN: "",
  } });
  assert.equal(result.status, 0, result.stderr);
});
