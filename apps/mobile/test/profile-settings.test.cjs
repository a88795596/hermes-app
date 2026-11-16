const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function load(name, dependencies) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(require.resolve(`../src/profiles/${name}`), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("exports", "require", source)(exports, (name) => {
    assert.ok(name in dependencies, name);
    return dependencies[name];
  });
  return exports;
}

const jsx = (type, props) => ({ type, props });
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return tree?.props ? [tree, ...nodes(tree.props.children)] : [];
}
const byType = (tree, type) => nodes(tree).find((node) => node.type === type);
const action = (tree, title) => nodes(tree).find((node) => node.type === "Action" && node.props.title === title);
const tick = () => new Promise(setImmediate);

function runtime() {
  let hooks;
  let cursor = 0;
  const useState = (initial) => {
    const state = hooks;
    const index = cursor++;
    if (!(index in state)) state[index] = initial;
    return [state[index], (value) => { state[index] = value; }];
  };
  const deps = {
    "react": { useState, useRef: (initial) => useState({ current: initial })[0] },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { ScrollView: "ScrollView", View: "View", Text: "Text", StyleSheet: { create: (value) => value } },
    "expo-image": { Image: "Image" },
    "@hermes-mobile/protocol": { MAX_PROFILE_ALIAS_LENGTH: 64 },
    "../chat/composer-menu": { ComposerSheet: "ComposerSheet", PickerRow: "PickerRow" },
    "../manage/shared": { EditField: "EditField", Toggle: "Toggle" },
    "../ui/haptics": { haptic() {} },
    "../ui/text": { profileLabel: (value) => typeof value === "string" ? value : value.alias ?? value.label },
    "../ui/theme": { Action: "Action", EmptyState: "EmptyState", Notice: "Notice", useTheme: () => ({ colors: {}, styles: {} }) },
    "./avatar": { ProfileAvatar: "ProfileAvatar" },
    "./pick-avatar": { pickProfileAvatar: async () => undefined },
  };
  const { ProfileSettings } = load("settings.tsx", deps);
  function mount(Component, props) {
    const state = [];
    return { render() { hooks = state; cursor = 0; return Component(props); } };
  }
  const profile = { profile_id: "work", label: "work", alias: "工作助手", avatar_url: "/avatar", is_default: false };
  const saves = [];
  let save = async (...args) => { saves.push(args); };
  const list = mount(ProfileSettings, { profiles: [profile], session: {}, onSave: (...args) => save(...args) });
  byType(list.render(), "PickerRow").props.onPress();
  const editorNode = nodes(list.render()).find((node) => typeof node.type === "function");
  const editor = mount(editorNode.type, editorNode.props);
  return { list, editor, profile, saves, deps, setSave: (next) => { save = next; } };
}

test("配置档案列表显示别名、头像及共享首页默认标记", () => {
  const { list, profile } = runtime();
  profile.is_default = true;
  const row = byType(list.render(), "PickerRow");
  assert.equal(row.props.title, "工作助手 · 首页默认");
  assert.equal(row.props.leading.type, "ProfileAvatar");
  assert.equal(row.props.leading.props.profile, profile);
});

test("仅改别名时不覆盖插件头像或其他设备更改的首页默认项", async () => {
  const { editor, saves } = runtime();
  assert.equal(action(editor.render(), "保存").props.disabled, true);
  byType(editor.render(), "EditField").props.onChangeText("  小助手  ");
  action(editor.render(), "保存").props.onPress();
  await tick();
  assert.deepEqual(saves, [["work", { alias: "小助手" }]]);
});

test("清空别名、移除头像和设为默认均作为显式变更保存", async () => {
  const { editor, saves } = runtime();
  byType(editor.render(), "EditField").props.onChangeText("");
  byType(editor.render(), "Toggle").props.onChange(true);
  action(editor.render(), "移除头像").props.onPress();
  action(editor.render(), "保存").props.onPress();
  await tick();
  assert.deepEqual(saves, [["work", { alias: null, avatar: null, is_default: true }]]);
});

test("取消图片选择不产生变更，上传失败保留编辑内容并允许重试", async () => {
  const { editor, setSave, saves } = runtime();
  action(editor.render(), "上传头像").props.onPress();
  await tick();
  assert.equal(action(editor.render(), "保存").props.disabled, true);
  byType(editor.render(), "EditField").props.onChangeText("新别名");
  let reject;
  setSave(() => new Promise((_resolve, fail) => { reject = fail; }));
  const button = action(editor.render(), "保存");
  button.props.onPress();
  button.props.onPress();
  assert.equal(byType(editor.render(), "ComposerSheet").props.busy, true);
  reject(new Error("服务器离线"));
  await tick();
  assert.equal(byType(editor.render(), "Notice").props.children, "服务器离线");
  assert.equal(byType(editor.render(), "EditField").props.value, "新别名");
  setSave(async (...args) => saves.push(args));
  action(editor.render(), "保存").props.onPress();
  await tick();
  assert.deepEqual(saves, [["work", { alias: "新别名" }]]);
});

test("头像请求只向本服务器的该档案头像接口附加凭证", () => {
  const { profileAvatarSource } = load("avatar.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx }, "expo-image": {}, "react": {}, "react-native": {},
    "../ui/text": {}, "../ui/theme": {},
  });
  const session = { origin: "https://mobile.example", token: "device-secret" };
  const profile = { profile_id: "work", label: "work", avatar_url: "/mobile/v1/profiles/work/avatar?v=one" };
  assert.deepEqual(profileAvatarSource(profile, session), {
    uri: "https://mobile.example/mobile/v1/profiles/work/avatar?v=one", headers: { Authorization: "Bearer device-secret" },
  });
  for (const avatar_url of ["https://evil.example/mobile/v1/profiles/work/avatar", "//evil.example/avatar", "/mobile/v1/profiles/other/avatar", "data:image/png;base64,AAAA", "https://user:pass@mobile.example/mobile/v1/profiles/work/avatar"]) {
    assert.equal(profileAvatarSource({ ...profile, avatar_url }, session), undefined);
  }
});

test("头像加载失败回退首字，刷新档案后重试同一张头像", () => {
  let failed;
  const { ProfileAvatar } = load("avatar.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx }, "expo-image": { Image: "Image" },
    "react": { useMemo: (make) => make(), useState: () => [failed, (value) => { failed = value; }] },
    "react-native": { Text: "Text", View: "View" },
    "../ui/text": { profileLabel: () => "工作助手" }, "../ui/theme": { useTheme: () => ({ colors: {} }) },
  });
  const session = { origin: "https://mobile.example", token: "device-secret" };
  const profile = { profile_id: "work", label: "work", avatar_url: "/mobile/v1/profiles/work/avatar?v=one" };
  byType(ProfileAvatar({ profile, session }), "Image").props.onError();
  assert.equal(byType(ProfileAvatar({ profile, session }), "Image"), undefined);
  assert.ok(byType(ProfileAvatar({ profile: { ...profile }, session }), "Image"));
});

test("头像同时使用内存和磁盘缓存，版本地址变化后读取新头像", () => {
  const { ProfileAvatar } = load("avatar.tsx", {
    "react/jsx-runtime": { jsx, jsxs: jsx }, "expo-image": { Image: "Image" },
    "react": { useMemo: (make) => make(), useState: () => [undefined, () => {}] },
    "react-native": { Text: "Text", View: "View" },
    "../ui/text": { profileLabel: () => "工作助手" }, "../ui/theme": { useTheme: () => ({ colors: {} }) },
  });
  const session = { origin: "https://mobile.example", token: "device-secret" };
  const profile = { profile_id: "work", label: "work", avatar_url: "/mobile/v1/profiles/work/avatar?v=one" };
  const first = byType(ProfileAvatar({ profile, session }), "Image");
  assert.equal(first.props.cachePolicy, "memory-disk");
  const updated = byType(ProfileAvatar({ profile: { ...profile, avatar_url: "/mobile/v1/profiles/work/avatar?v=two" }, session }), "Image");
  assert.equal(updated.props.source.uri, "https://mobile.example/mobile/v1/profiles/work/avatar?v=two");
  assert.notEqual(updated.props.recyclingKey, first.props.recyclingKey);
});

test("头像选择校验实际大小和格式并清理临时文件", async () => {
  let assets;
  let deleted = 0;
  const { pickProfileAvatar } = load("pick-avatar.ts", {
    "expo-file-system": { File: class { delete() { deleted++; } } },
    "expo-image-picker": { UIImagePickerPreferredAssetRepresentationMode: {}, launchImageLibraryAsync: async (options) => {
      assert.equal(options.allowsEditing, true);
      assert.deepEqual(options.aspect, [1, 1]);
      return { assets };
    } },
    "react-native": { Platform: { OS: "ios" } },
    "@hermes-mobile/protocol": { MAX_PROFILE_AVATAR_BYTES: 2 * 1024 * 1024 },
  });
  assert.equal(await pickProfileAvatar(), undefined);
  assets = [{ uri: "file:///temp/photo.jpg", base64: Buffer.from("jpeg bytes").toString("base64") }];
  assert.deepEqual(await pickProfileAvatar(), { name: "头像.jpg", mime: "image/jpeg", size: 10, content_base64: assets[0].base64 });
  assets[0].base64 = Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64");
  await assert.rejects(pickProfileAvatar(), /2 MB/);
  assets[0].base64 = "invalid?";
  await assert.rejects(pickProfileAvatar(), /无法读取/);
  assert.equal(deleted, 3);
});
