import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

test("EAS 归档包含离线语音资源，并排除密钥、缓存和生成的原生工程", (t) => {
  const rules = new URL("../../.easignore", import.meta.url);
  assert.ok(existsSync(rules), "离线语音资源需要随 EAS 本地构建归档进入临时工程");
  const root = mkdtempSync(join(tmpdir(), "hermes-speech-archive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(spawnSync("git", ["init", "--quiet", root]).status, 0);
  writeFileSync(join(root, ".gitignore"), readFileSync(rules));
  const inputs = [
    ["apps/mobile/modules/speech-recognition/vendor/model/encoder.int8.onnx", false],
    ["apps/mobile/modules/speech-recognition/vendor/frameworks/SherpaOnnxC.xcframework/Info.plist", false],
    ["apps/mobile/modules/speech-recognition/vendor/android/sherpa-onnx.aar", false],
    ["apps/mobile/modules/speech-recognition/ios/StreamingRecognizer.swift", false],
    ["apps/mobile/modules/speech-recognition/android/build/generated/classes.jar", true],
    ["scripts/setup-speech-recognition.py", false],
    ["apps/mobile/.env.local", true],
    [".env", true],
    ["apps/mobile/credentials.p12", true],
    ["apps/mobile/ios/Pods/fixture", true],
    ["apps/mobile/android/app/fixture", true],
    ["apps/mobile/node_modules/fixture/index.js", true],
    [".data/credentials.json", true],
    [".codegraph/cache.db", true],
  ];
  for (const [path, ignored] of inputs) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "fixture");
    const result = spawnSync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "-q", path], { cwd: root });
    assert.equal(result.status, ignored ? 0 : 1, path);
  }
});
