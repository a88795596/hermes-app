import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("语音资源按构建平台准备，两个平台共用中文模型与许可", () => {
  const script = fileURLToPath(new URL("../setup-speech-recognition.py", import.meta.url));
  const result = spawnSync("python3", ["-c", `
import runpy, sys
assets = runpy.run_path(sys.argv[1])["asset_names"]
ios, android, all_assets = map(set, (assets("ios"), assets("android"), assets("all")))
assert "android/sherpa-onnx.aar" in android and "android/sherpa-onnx.aar" not in ios
assert "frameworks/SherpaOnnxC.xcframework/Info.plist" in ios
assert not any(name.startswith("frameworks/") for name in android)
for path in ("model/encoder.int8.onnx", "model/decoder.onnx", "model/joiner.int8.onnx", "model/tokens.txt", "licenses/sherpa-onnx-LICENSE"):
    assert path in ios and path in android, path
assert ios | android == all_assets
`, script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("资源准备的路径与校验检查不依赖已下载模型", () => {
  const result = spawnSync("python3", [fileURLToPath(new URL("../setup-speech-recognition.py", import.meta.url)), "--self-test"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
