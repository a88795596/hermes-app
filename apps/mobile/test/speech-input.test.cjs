const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mount({ draft = "已有草稿", native = true, platform = "ios", start, stop } = {}) {
  const values = [], effects = [], cleanup = [], listeners = new Map(), calls = [], drafts = [];
  let cursor = 0, dirty = false, current, topic = "topic", enabled = true, appState, blur, sequence = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  const react = {
    useState(initial) {
      const slot = cursor++;
      if (!(slot in values)) values[slot] = typeof initial === "function" ? initial() : initial;
      return [values[slot], (value) => {
        values[slot] = typeof value === "function" ? value(values[slot]) : value;
        dirty = true;
      }];
    },
    useRef(value) { return values[cursor++] ??= { current: value }; },
    useCallback(callback, deps) {
      const slot = cursor++;
      if (!same(values[slot]?.deps, deps)) values[slot] = { deps, callback };
      return values[slot].callback;
    },
    useEffect(effect, deps) {
      const slot = cursor++;
      if (!same(values[slot], deps)) {
        values[slot] = deps;
        effects.push(() => { cleanup[slot]?.(); cleanup[slot] = effect(); });
      }
    },
  };
  react.useLayoutEffect = react.useEffect;
  const speech = {
    isAvailable: () => true,
    addListener(event, listener) { listeners.set(event, listener); return { remove: () => listeners.delete(event) }; },
    start: async (id) => { calls.push(["start", id]); await start?.(id); },
    stop: async (id) => { calls.push(["stop", id]); return await stop?.(id) ?? ""; },
    cancel: async (id) => { calls.push(["cancel", id]); },
  };
  const source = ts.transpileModule(readFileSync(require.resolve("../src/chat/use-speech-input.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exported = {};
  new Function("exports", "require", source)(exported, (name) => {
    if (name === "react") return react;
    if (name === "expo-crypto") return { randomUUID: () => `recording-${++sequence}` };
    if (name === "expo-router") return { useFocusEffect: (callback) => react.useEffect(() => { blur = callback(); return blur; }, [callback]) };
    if (name === "react-native") return { Platform: { OS: platform }, AppState: { addEventListener: (_event, listener) => {
      appState = listener; return { remove() {} };
    } } };
    if (name === "../../modules/speech-recognition") return { __esModule: true, default: native ? speech : null };
    throw new Error(`Unexpected dependency: ${name}`);
  });
  const updateDraft = (text) => { draft = text; drafts.push(text); dirty = true; };
  const render = () => {
    dirty = false;
    cursor = 0;
    current = exported.useSpeechInput(topic, enabled, draft, updateDraft);
    effects.splice(0).forEach((effect) => effect());
  };
  const settle = async () => {
    for (let quiet = 0, turns = 0; quiet < 2 && turns < 30; turns++) {
      await new Promise(setImmediate);
      if (dirty) { render(); quiet = 0; } else quiet++;
    }
    assert.equal(dirty, false, "speech state should settle");
  };
  render();
  return {
    get current() { if (dirty) render(); return current; },
    get draft() { return draft; }, calls, drafts, settle,
    emit: (event, value) => listeners.get(event)?.(value),
    async background() { appState("background"); await settle(); },
    async blur() { blur?.(); await settle(); },
    async select(id, value) { topic = id; draft = value; render(); await settle(); },
    async enable(value) { enabled = value; render(); await settle(); },
    edit(value) { draft = value; render(); },
    close() { cleanup.forEach((dispose) => dispose?.()); },
  };
}

test("累计转写替换当前语音段，停止后再录音保留已有草稿", async (t) => {
  const app = mount(); t.after(app.close);
  await app.current.start();
  app.emit("result", { id: "recording-1", text: "你好", isFinal: false });
  await app.settle();
  assert.equal(app.draft, "已有草稿 你好");
  app.emit("result", { id: "recording-1", text: "你好世界", isFinal: false });
  await app.settle();
  assert.equal(app.draft, "已有草稿 你好世界");
  assert.equal(await app.current.stop(), "已有草稿 你好世界");
  await app.settle();
  assert.equal(app.current.busy, false);
  await app.current.start();
  app.emit("result", { id: "recording-2", text: "继续", isFinal: false });
  await app.settle();
  assert.equal(app.draft, "已有草稿 你好世界 继续");
});

test("发送等待原生最终文字，不依赖 final 事件先于 Promise", async (t) => {
  const final = deferred();
  const app = mount({ draft: "", stop: () => final.promise }); t.after(app.close);
  await app.current.start();
  app.emit("result", { id: "recording-1", text: "最后", isFinal: false });
  await app.settle();
  const first = app.current.stop(), second = app.current.stop();
  await app.settle();
  assert.equal(app.current.state, "stopping");
  assert.equal(app.calls.filter(([kind]) => kind === "stop").length, 1);
  app.emit("status", { id: "recording-1", state: "idle" });
  final.resolve("最后一句");
  assert.equal(await first, "最后一句");
  assert.equal(await second, "最后一句");
  await app.settle();
  assert.equal(app.draft, "最后一句");
  app.edit("");
  app.emit("result", { id: "recording-1", text: "迟到结果", isFinal: true });
  await app.settle();
  assert.equal(app.draft, "", "发送后旧结果不能写回草稿");
});

test("权限等待时再次点击取消启动，后到授权不会重新录音", async (t) => {
  const permission = deferred();
  const app = mount({ start: () => permission.promise }); t.after(app.close);
  const pending = app.current.start();
  await app.current.start();
  assert.equal(app.current.state, "starting");
  assert.equal(await app.current.stop(), "已有草稿");
  permission.resolve(); await pending; await app.settle();
  assert.deepEqual(app.calls, [["start", "recording-1"], ["cancel", "recording-1"]]);
  assert.equal(app.current.busy, false);
});

test("切换话题使等待中的发送失效，旧结果不能覆盖新话题草稿", async (t) => {
  const final = deferred();
  const app = mount({ stop: () => final.promise }); t.after(app.close);
  await app.current.start();
  const pending = app.current.stop();
  await app.select("other", "另一条草稿");
  final.resolve("旧会话尾音");
  assert.equal(await pending, null);
  app.emit("result", { id: "recording-1", text: "旧结果", isFinal: true });
  await app.settle();
  assert.equal(app.draft, "另一条草稿");
  assert.equal(app.current.busy, false);
});

test("权限失败保留草稿并允许再次启动", async (t) => {
  let denied = true;
  const app = mount({ start: () => { if (denied) throw new Error("麦克风权限被拒绝"); } }); t.after(app.close);
  await app.current.start(); await app.settle();
  assert.equal(app.draft, "已有草稿");
  assert.match(app.current.error, /麦克风权限/);
  assert.equal(app.current.busy, false);
  denied = false;
  await app.current.start(); await app.settle();
  assert.equal(app.current.state, "recording");
  assert.equal(app.current.error, undefined);
});

test("原生停止失败时保留已识别文字，阻止本次发送", async (t) => {
  const app = mount({ stop: () => { throw new Error("识别被中断"); } }); t.after(app.close);
  await app.current.start();
  app.emit("result", { id: "recording-1", text: "保留这句", isFinal: false });
  await app.settle();
  assert.equal(await app.current.stop(), null);
  await app.settle();
  assert.equal(app.draft, "已有草稿 保留这句");
  assert.match(app.current.error, /识别被中断/);
  assert.equal(app.current.busy, false);
  assert.ok(app.calls.some(([kind]) => kind === "cancel"));
});

test("后台和离开页面停止麦克风，销毁后忽略晚到的文字", async () => {
  for (const leave of ["background", "blur"]) {
    const app = mount({ stop: () => "最后一段" });
    await app.current.start();
    await app[leave]();
    assert.equal(app.current.busy, false);
    assert.equal(app.draft, "已有草稿 最后一段");
    assert.equal(app.calls.filter(([kind]) => kind === "stop").length, 1);
    app.close();
    app.emit("result", { id: "recording-1", text: "迟到结果", isFinal: true });
    assert.equal(app.draft, "已有草稿 最后一段");
  }
});

test("没有原生模块的旧包和不可写会话保持普通文字输入", async (t) => {
  for (const native of [false, true]) {
    const app = mount({ native }); t.after(app.close);
    if (native) await app.enable(false);
    await app.current.start();
    assert.equal(app.current.available, native);
    assert.equal(app.current.busy, false);
    assert.equal(await app.current.stop(), "已有草稿");
    assert.deepEqual(app.calls, []);
  }
});

test("空识别结果不改变原草稿的空格和换行", async (t) => {
  for (const draft of ["已有草稿", "已有草稿\n", ""]) {
    const app = mount({ draft }); t.after(app.close);
    await app.current.start();
    app.emit("result", { id: "recording-1", text: "", isFinal: true });
    await app.current.stop(); await app.settle();
    assert.equal(app.draft, draft);
  }
});

test("原生音频中断保留最后结果，并取消已在等待的发送", async (t) => {
  const final = deferred();
  const app = mount({ stop: () => final.promise }); t.after(app.close);
  await app.current.start();
  const pending = app.current.stop();
  app.emit("result", { id: "recording-1", text: "中断前的文字", isFinal: true });
  app.emit("error", { id: "recording-1", message: "系统音频中断" });
  app.emit("status", { id: "recording-1", state: "idle" });
  final.resolve("中断前的文字");
  assert.equal(await pending, null);
  await app.settle();
  assert.equal(app.draft, "已有草稿 中断前的文字");
  assert.match(app.current.error, /系统音频中断/);
  assert.equal(app.current.busy, false);
  assert.equal(await app.current.stop(), app.draft, "用户重新明确发送时可使用保留的文字");
});

test("发送等待尾音时离开页面，不在背后的旧会话发出消息", async (t) => {
  const final = deferred();
  const app = mount({ stop: () => final.promise }); t.after(app.close);
  await app.current.start();
  const pending = app.current.stop();
  await app.blur();
  final.resolve("保留草稿");
  assert.equal(await pending, null);
  await app.settle();
  assert.equal(app.draft, "已有草稿 保留草稿");
});

test("Android 权限弹窗的短暂后台事件不取消首次语音授权", async (t) => {
  const permission = deferred();
  const app = mount({ platform: "android", start: () => permission.promise }); t.after(app.close);
  const pending = app.current.start();
  await app.background();
  assert.deepEqual(app.calls, [["start", "recording-1"]]);
  assert.equal(app.current.state, "starting");
  permission.resolve(); await pending; await app.settle();
  assert.equal(app.current.state, "recording");
  await app.background();
  assert.equal(app.current.busy, false, "录音已经开始后进入后台必须停止");
});
