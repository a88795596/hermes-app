const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function load(path) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(require.resolve(path), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("exports", source)(exports);
  return exports;
}
const { selectProfile } = load("../src/profiles/selection.ts");
const { profileLabel } = load("../src/ui/text.ts");
const first = { profile_id: "first", label: "default" };
const second = { profile_id: "second", label: "work", alias: "工作助手", is_default: true };

test("首页启动选择共享默认档案，临时切换优先，失效选择安全回退", () => {
  assert.equal(selectProfile([first, second]), second);
  assert.equal(selectProfile([first, second], "first"), first);
  assert.equal(selectProfile([first, second], "removed"), second);
  assert.equal(selectProfile([first]), first);
  assert.equal(selectProfile([]), undefined);
});

test("所有档案展示优先别名，真实名称保留，旧版本目录仍可显示", () => {
  assert.equal(profileLabel(second), "工作助手");
  assert.equal(profileLabel(first), "默认");
  assert.equal(profileLabel({ ...second, alias: "default" }), "default");
  assert.equal(profileLabel({ ...second, alias: "" }), "work");
  assert.equal(profileLabel("default"), "默认");
  assert.equal(second.label, "work");
});
