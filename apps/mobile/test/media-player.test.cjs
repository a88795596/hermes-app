const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { registerHooks } = require("node:module");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { createElement } = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ts = require("typescript");

const base = pathToFileURL(`${require("node:path").resolve(__dirname, "../src")}/`);
const native = new URL("chat/media-player.tsx", base);
const web = new URL("chat/media-player.web.tsx", base);
const reactPath = require.resolve("react");
const mocks = new Map([
  ["react", `const React = require("react"); module.exports = { ...React,
    useEffect: (effect, deps) => { globalThis.mediaTest.effects.push(effect); React.useEffect(effect, deps); },
    useState: (initial) => { const state = React.useState(initial); const slot = globalThis.mediaTest.stateCount++; return [state[0], (value) => { globalThis.mediaTest.updates.push({ slot, value }); state[1](value); }]; }
  };`],
  ["react-native", `const native = require(${JSON.stringify(require.resolve("react-native-web"))}); module.exports = { ...native, AppState: {
    currentState: "active", addEventListener: (_, listener) => { globalThis.mediaTest.appStateChange = listener; return { remove() {} }; }
  } };`],
  ["../ui/theme", `const React = require("react");
    exports.useTheme = () => ({ colors: {}, styles: {} });
    exports.Notice = ({ children }) => React.createElement("p", null, children);
    exports.Action = (props) => { globalThis.mediaTest.actions.push(props); return React.createElement("button", { disabled: props.disabled }, props.title); };`],
  ["expo-audio", `exports.useAudioPlayer = (uri) => { globalThis.mediaTest.uri = uri; return globalThis.mediaTest.player; };
    exports.useAudioPlayerStatus = () => globalThis.mediaTest.status;
    exports.setAudioModeAsync = async (mode) => { globalThis.mediaTest.mode = mode; await globalThis.mediaTest.waitForMode?.(); };`],
  ["expo-video", `const React = require("react");
    exports.useVideoPlayer = (uri, setup) => { globalThis.mediaTest.uri = uri; setup(globalThis.mediaTest.player); return globalThis.mediaTest.player; };
    exports.VideoView = (props) => { globalThis.mediaTest.video = props; return React.createElement("video", { controls: props.nativeControls }); };`],
  ["expo", `exports.useEvent = (player, event, initial) => initial;`],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith("media-test:") && specifier === "react") return nextResolve(reactPath, context);
    if ([native.href, web.href].includes(context.parentURL) && mocks.has(specifier)) {
      return { url: `media-test:${specifier}`, shortCircuit: true };
    }
    return nextResolve(specifier === "react-native" ? "react-native-web" : specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("media-test:")) return { format: "commonjs", source: mocks.get(url.slice(11)), shortCircuit: true };
    if (![native.href, web.href].includes(url)) return nextLoad(url, context);
    return { format: "commonjs", shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText };
  },
});
const { MediaPlayer: NativePlayer } = require("../src/chat/media-player.tsx");
const { MediaPlayer: WebPlayer } = require("../src/chat/media-player.web.tsx");
hooks.deregister();

function render(Component, kind, uri, status = {}) {
  const calls = [];
  globalThis.mediaTest = {
    actions: [], effects: [], stateCount: 0, updates: [],
    status: { isLoaded: true, currentTime: 65, duration: 125, playing: false, error: null, ...status },
    player: { status: "readyToPlay", play: () => calls.push("play"), pause: () => calls.push("pause"), seekTo: async (seconds) => calls.push(["seek", seconds]) },
  };
  const html = renderToStaticMarkup(createElement(Component, { kind, uri, name: "录音.m4a" }));
  return { html, calls, state: globalThis.mediaTest };
}

test("音频显示进度并在播放结束后从头重播，不自动播放", async () => {
  const { html, calls, state } = render(NativePlayer, "audio", "file:///cache/voice.m4a", { didJustFinish: true });
  assert.match(html, /1:05[\s\S]*2:05/);
  assert.deepEqual(calls, []);
  await state.actions.find((action) => /播放/.test(action.title)).onPress();
  assert.deepEqual(calls, [["seek", 0], "play"]);
  assert.equal(state.mode.playsInSilentMode, true);
  assert.equal(state.mode.shouldPlayInBackground, false);
});

test("音频暂停和播放失败状态可操作", async () => {
  const playing = render(NativePlayer, "audio", "file:///cache/voice.m4a", { playing: true });
  await playing.state.actions.find((action) => action.title === "暂停").onPress();
  assert.deepEqual(playing.calls, ["pause"]);
  const failed = render(NativePlayer, "audio", "file:///cache/voice.m4a", { error: "decode failure", isLoaded: false });
  assert.match(failed.html, /无法播放/);
  assert.ok(failed.state.actions.some((action) => action.title === "重试"));
});

test("音频在准备播放时进入后台会暂停，并结束按钮等待状态", async () => {
  const { state, calls } = render(NativePlayer, "audio", "file:///cache/voice.m4a");
  const cleanup = state.effects.map((effect) => effect());
  let finishMode;
  state.waitForMode = () => new Promise((resolve) => { finishMode = resolve; });
  const pending = state.actions.find((action) => action.title === "播放").onPress();
  state.appStateChange("background");
  finishMode();
  await pending;
  assert.deepEqual(calls, ["pause"]);
  assert.deepEqual(state.updates.filter((update) => update.slot === 2).map((update) => update.value), [true, false]);
  state.appStateChange("active");
  cleanup.forEach((dispose) => dispose?.());
});

test("视频使用原生控制且关闭后台和外部播放", () => {
  const { calls, state } = render(NativePlayer, "video", "file:///cache/video.mp4");
  assert.equal(state.video.nativeControls, true);
  assert.equal(state.player.staysActiveInBackground, false);
  assert.equal(state.player.allowsExternalPlayback, false);
  assert.deepEqual(calls, []);
});

test("Web 媒体只加载 blob 并由用户启动播放", () => {
  for (const kind of ["audio", "video"]) {
    const { html } = render(WebPlayer, kind, "blob:https://app.example/id");
    assert.match(html, new RegExp(`<${kind}\\b`));
    assert.match(html, /controls=""/);
    assert.match(html, /preload="metadata"/);
    assert.doesNotMatch(html, /autoPlay/);
  }
  for (const Component of [NativePlayer, WebPlayer]) {
    const { html, state } = render(Component, "audio", "https://private.example/voice?token=secret");
    assert.doesNotMatch(html, /private\.example|<audio\b|<video\b/);
    assert.equal(state.uri, undefined);
  }
});
