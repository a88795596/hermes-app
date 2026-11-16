import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const deployScript = fileURLToPath(new URL("../ota-deploy.mjs", import.meta.url));

test("热更新发布把 --message 同时传给打包环境和发布命令", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hermes-ota-message-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakePnpm = join(dir, "pnpm");
  const capture = join(dir, "capture.json");
  writeFileSync(fakePnpm, `#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(process.env.HERMES_OTA_TEST_CAPTURE, JSON.stringify({ args: process.argv.slice(2), message: process.env.EXPO_PUBLIC_HERMES_UPDATE_MESSAGE }));\n`);
  chmodSync(fakePnpm, 0o755);
  const result = spawnSync(process.execPath, [deployScript, "--message", "修复会话显示", "-p", "ios"], {
    encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HERMES_OTA_TEST_CAPTURE: capture },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), {
    args: ["exec", "hot-updater", "deploy", "--channel", "preview", "--message", "修复会话显示", "-p", "ios"],
    message: "修复会话显示",
  });
});
