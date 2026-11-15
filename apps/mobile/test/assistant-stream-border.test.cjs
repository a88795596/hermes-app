const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const ts = require("typescript");

function mount() {
  let reduced = false, focused = true, callback, cleanup, previous;
  const animations = [];
  const motion = { value: 0, setValue(value) { this.value = value; }, interpolate: (options) => options };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    react: { useCallback: (fn) => fn },
    "expo-router": { useFocusEffect: (fn) => { callback = fn; } },
    "react-native-safe-area-context": { useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }) },
    "../ui/motion": { useReduceMotion: () => reduced },
    "react-native": {
      View: "View", Image: "Image", Easing: { linear: "linear" },
      useAnimatedValue: () => motion,
      useWindowDimensions: () => ({ width: 390, height: 844 }),
      Animated: {
        View: "Animated.View", Value: function () { return motion; }, loop: (animation) => animation,
        timing(value, options) {
          const animation = { value, options, starts: 0, stops: 0,
            start() { this.starts++; }, stop() { this.stops++; } };
          animations.push(animation);
          return animation;
        },
      },
    },
  };
  const exported = {};
  const source = ts.transpileModule(readFileSync(require.resolve("../src/chat/assistant-stream-border.tsx"), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("exports", "require", source)(exported, (name) => {
    if (name.endsWith(".png")) {
      assert.ok(existsSync(resolve(__dirname, "../src/chat", name)), `Bundled texture exists: ${name}`);
      return name;
    }
    assert.ok(name in modules, name);
    return modules[name];
  });
  return {
    animations, motion,
    render(nextReduced = reduced, nextFocused = focused) {
      reduced = nextReduced;
      focused = nextFocused;
      const tree = exported.AssistantStreamBorder();
      const deps = `${reduced}:${focused}`;
      if (deps !== previous) {
        cleanup?.();
        cleanup = focused ? callback() : undefined;
        previous = deps;
      }
      return tree;
    },
    unmount() { cleanup?.(); },
  };
}

test("流光复用四边纹理和四角柔光，覆盖安全区但不拦截触摸或读屏", () => {
  const screen = mount();
  const tree = screen.render();
  assert.equal(tree.props.pointerEvents, "none");
  assert.equal(tree.props.accessible, false);
  assert.equal(tree.props.accessibilityElementsHidden, true);
  assert.equal(tree.props.importantForAccessibility, "no-hide-descendants");
  assert.equal(tree.props.style.top, -59);
  assert.equal(tree.props.style.bottom, -34);
  const edges = tree.props.children.slice(0, 4);
  assert.deepEqual(edges.map((edge) => edge.props.side), ["top", "right", "bottom", "left"]);
  for (const edge of edges) {
    const track = edge.type(edge.props).props.children;
    const vertical = ["right", "left"].includes(edge.props.side);
    const forward = ["top", "right"].includes(edge.props.side);
    const shift = track.props.style.transform[0][vertical ? "translateY" : "translateX"];
    assert.deepEqual(shift.outputRange, forward ? [-384, 0] : [0, -384]);
    assert.ok(track.props.children.length * 384 >= edge.props.length + 384, "平移后仍覆盖整条边");
    for (const tile of track.props.children) assert.ok(tile.props.source.endsWith(`${edge.props.side}.png`));
  }
  assert.equal(tree.props.children.slice(4).length, 4);
  for (const corner of tree.props.children.slice(4)) assert.ok(corner.props.source.endsWith("-corner.png"));
  assert.deepEqual(screen.animations[0].options, {
    toValue: 1, duration: 6000, easing: "linear", useNativeDriver: true, isInteraction: false,
  });
  screen.unmount();
});

test("减少动态效果保留静态边框，失焦和卸载停止循环，重新进入恢复", () => {
  const screen = mount();
  assert.ok(screen.render(true));
  assert.equal(screen.animations.length, 0);
  screen.render(false);
  assert.equal(screen.animations[0].starts, 1);
  screen.render(true);
  assert.equal(screen.animations[0].stops, 1);
  assert.equal(screen.motion.value, 0);
  screen.render(false);
  screen.render(false, false);
  assert.equal(screen.animations[1].stops, 1);
  screen.render(false, true);
  assert.equal(screen.animations[2].starts, 1);
  screen.unmount();
  assert.equal(screen.animations[2].stops, 1);
});
