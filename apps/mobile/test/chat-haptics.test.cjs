const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

function mount(file, name, props, speech, reduceMotion = true) {
  const values = [], effects = [], feedback = [], alerts = [];
  const dimensions = { width: 390, height: 844 };
  let cursor = 0;
  let requestSequence = 0;
  const jsx = (type, props, key) => type?.name === "ConversationTranscript" ? type(props) : ({ type, props, key });
  const exported = {};
  const source = ts.transpileModule(readFileSync(require.resolve(`../src/chat/${file}.tsx`), "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("exports", "require", source)(exported, (dependency) => {
    switch (dependency) {
      case "react/jsx-runtime": return { jsx, jsxs: jsx, Fragment: "Fragment" };
      case "react": return {
        useState(initial) {
          const index = cursor++;
          if (!(index in values)) values[index] = initial;
          return [values[index], (next) => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
        },
        useRef(current) { const index = cursor++; return values[index] ??= { current }; },
        useEffect(effect, deps) { const index = cursor++; if (!values[index] || !deps || deps.some((v, i) => v !== values[index][i])) effects.push(effect); values[index] = deps ?? []; },
        useImperativeHandle(ref, create) { if (typeof ref === "function") ref(create()); else if (ref) ref.current = create(); },
        useCallback: (callback) => callback,
        useEffectEvent: (callback) => callback,
      };
      case "react-native": return {
        ActivityIndicator: "ActivityIndicator", FlatList: "FlatList", Modal: "Modal", Pressable: "Pressable",
        Text: "Text", View: "View", ScrollView: "ScrollView", KeyboardAvoidingView: "KeyboardAvoidingView", RefreshControl: "RefreshControl",
        StyleSheet: { create: (styles) => styles, hairlineWidth: 1 }, Platform: { OS: "ios" },
        Keyboard: { dismiss() {} }, useWindowDimensions: () => dimensions,
      };
      case "react-native-reanimated": return { default: { View: "Animated.View" } };
      case "react-native-safe-area-context": return { SafeAreaView: "SafeAreaView", useSafeAreaInsets: () => ({ top: 0 }) };
      case "expo-crypto": return { randomUUID: () => `request-${++requestSequence}` };
      case "expo-web-browser": return { openBrowserAsync: async () => {}, WebBrowserPresentationStyle: { PAGE_SHEET: "pageSheet" } };
      case "@hermes-mobile/protocol": return { MAX_ATTACHMENTS: 5, reasoningEfforts: ["low", "high"] };
      case "../ui/overlay": return { OverlayModal: "Modal" };
      case "../ui/haptics": return { haptic: (kind) => feedback.push(kind) };
      case "../ui/alerts": return { useAlert: () => ({ alert: (title, message, buttons, options) => alerts.push({ title, message, buttons, options }) }) };
      case "../ui/motion": return { motion: {}, useReduceMotion: () => reduceMotion };
      case "../ui/text": return { profileLabel: (profile) => typeof profile === "string" ? profile : profile.alias || profile.label };
      case "../ui/page-header": return { PageHeader: "PageHeader" };
      case "../ui/theme": return {
        useTheme: () => ({ colors: {}, styles: {} }), Action: "Action", Card: "Card", CloseButton: "CloseButton",
        EmptyState: "EmptyState", Field: "Field", Icon: "Icon", Notice: "Notice",
      };
      case "./composer-menu": return {
        reasoningLabels: {}, AttachmentMenu: "AttachmentMenu", ComposerMenu: "ComposerMenu", ReasoningMenu: "ReasoningMenu",
        ComposerSheet: "ComposerSheet", PickerRow: "PickerRow",
      };
      case "./model-picker": return { ModelPicker: "ModelPicker" };
      case "./settings-drawer": return { SettingsDrawer: "SettingsDrawer" };
      case "./answer-markdown": return { AnswerMarkdown: "AnswerMarkdown" };
      case "./assistant-stream-border": return { AssistantStreamBorder: "AssistantStreamBorder" };
      case "./message-attachments": return { MessageAttachments: "MessageAttachments" };
      case "./native-command": return { NativeCommandSheet: "NativeCommandSheet" };
      case "./attachments": return { pickAttachments: async () => [] };
      case "./use-speech-input": return { useSpeechInput: (_id, _enabled, draft) => speech ?? {
        available: false, state: "idle", busy: false, start: async () => {}, stop: async () => draft,
      } };
      default: throw new Error(`Unexpected dependency: ${dependency}`);
    }
  });
  const render = (nextProps) => { Object.assign(props, nextProps); cursor = 0; return exported[name](props); };
  return { render, feedback, effects, dimensions, alerts, renderChild(predicate) {
    const child = find(render(), predicate);
    return child?.type(child.props);
  } };
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node?.props) return;
  if (predicate(node)) return node;
  return find([node.props.children, node.props.leading, node.props.trailing, node.props.back], predicate);
}
const flush = () => new Promise(setImmediate);
const findSend = (tree) => find(tree, (node) => node.props.accessibilityLabel === "发送");
const findList = (tree) => find(tree, (node) => node.type === "FlatList");

test("底部选择框的返回、标题和关闭共用顶栏，忙碌时保留关闭保护", () => {
  let closed = 0;
  const back = { type: "Back", props: {} };
  for (const busy of [true, false]) {
    const sheet = mount("composer-menu", "ComposerSheet", {
      title: "选择模型", subtitle: "当前配置档案", back, busy, onClose: () => closed++,
    }).render();
    const header = find(sheet, (node) => node.type === "PageHeader");
    assert.equal(header.props.title, "选择模型");
    assert.equal(header.props.leading, back);
    assert.equal(header.props.trailing.props.disabled, busy);
    assert.ok(find(sheet, (node) => node.props.children === "当前配置档案"));
    sheet.props.onRequestClose();
  }
  assert.equal(closed, 1);
});

function conversation(enqueue, draft = "测试消息", { messages = [], workspace = {}, speech, reduceMotion, ...props } = {}) {
  return mount("conversation", "Conversation", {
    id: "topic", topic: { status: "ready" }, draft, attachments: [], session: {},
    workspace: { ready: true, network: "online", connector_online: true, reasoning_supported: true, profiles: [], pending: [],
      detail: { messages }, enqueue, ...workspace },
    onDraftChange() {}, onAttachmentsChange() {},
    ...props,
  }, speech, reduceMotion);
}

test("无限会话录音和弹层阻止切页，输入栏独立于分页消息区", () => {
  for (const busy of [true, false]) {
    const blocked = [];
    const app = conversation(async () => {}, "", { onSwitchBlockedChange: (value) => blocked.push(value),
      renderTranscript: () => ({ type: "Pager", props: { children: "消息区" } }),
      speech: { available: true, state: busy ? "recording" : "idle", busy } });
    const tree = app.render();
    const pager = find(tree, (node) => node.type === "Pager");
    assert.ok(pager);
    app.effects.splice(0).forEach((effect) => effect());
    assert.equal(blocked.at(-1), busy);
    assert.equal(find(pager, (node) => node.props.accessibilityLabel === "消息"), undefined);
    assert.ok(find(tree, (node) => node.props.accessibilityLabel === "消息"));
    app.render({ settingsOpen: true });
    app.effects.splice(0).forEach((effect) => effect());
    assert.equal(blocked.at(-1), true);
  }
});

test("落页后重置输入焦点和高度，保留目标 Profile 的文字附件草稿", () => {
  const screen = conversation(async () => {}, "原草稿", {
    renderTranscript: () => ({ type: "Pager", props: {} }),
    onDraftChange: () => assert.fail("切页不能清空文字"),
    onAttachmentsChange: () => assert.fail("切页不能移除附件"),
  });
  let field = find(screen.render(), (node) => node.type === "Field");
  screen.effects.splice(0).forEach((effect) => effect());
  field.props.onFocus();
  screen.render({ id: "research", draft: "研究草稿", attachments: [{ name: "报告.pdf", mime: "application/pdf" }] });
  screen.effects.splice(0).forEach((effect) => effect());
  const tree = screen.render();
  field = find(tree, (node) => node.type === "Field");
  assert.equal(field.key, "research");
  assert.equal(field.props.value, "研究草稿");
  assert.equal(field.props.style.at(-1).height, 44);
  assert.ok(find(tree, (node) => node.props.children === "报告.pdf"));
  assert.equal(findSend(screen.render({ paging: true })).props.disabled, true);
});

test("失败的无限会话可确认归档恢复，不改写草稿和待发消息", async () => {
  const archived = [];
  const screen = conversation(async () => assert.fail("不能发送失败会话"), "保留草稿", {
    topic: { status: "error", error: "创建结果待确认" },
    onDraftChange: () => assert.fail("恢复不丢弃旧草稿"),
    workspace: { streamTopic: { id: "topic", profileId: "daily" },
      setTopicArchived: async (...args) => archived.push(args) },
  });
  find(screen.render(), (node) => node.props.title === "恢复会话").props.onPress();
  assert.equal(archived.length, 0, "不自动重建结果待确认的会话");
  assert.match(screen.alerts[0].message, /历史记录、草稿和待发消息/);
  screen.alerts[0].buttons.find((button) => button.text === "恢复").onPress();
  await flush();
  assert.deepEqual(archived, [["topic", true]]);
  assert.equal(find(screen.render({ topic: { status: "ready" } }), (node) => node.props.title === "恢复会话"), undefined);
  const regular = conversation(async () => {}, "", { topic: { status: "error" } });
  assert.equal(find(regular.render(), (node) => node.props.title === "恢复会话"), undefined);
});

test("原生命令单独执行，保留菜单外草稿且不进入模型消息队列", async () => {
  const screen = conversation(async () => assert.fail("命令不能进入消息队列"), "保留草稿", {
    onDraftChange: () => assert.fail("菜单命令不改写草稿"),
  });
  find(screen.render(), (node) => node.props.icon === "command").props.onPress();
  await flush();
  const menu = find(screen.render(), (node) => node.type === "ComposerMenu");
  menu.props.onCommand("/restart");
  menu.props.onCommand("/restart");
  const sheet = find(screen.render(), (node) => node.type === "NativeCommandSheet");
  assert.equal(sheet.props.command, "/restart");
  assert.equal(sheet.props.requestId, "request-1", "重复点击不能生成第二个执行请求");
});

test("菜单与直接输入 new 都使用原生命令，别名交中间层解析", async () => {
  const screen = conversation(async () => assert.fail("命令不能进入消息队列"), "保留草稿", {
    onDraftChange: () => assert.fail("菜单新建不改写旧草稿"),
  });
  find(screen.render(), (node) => node.props.icon === "command").props.onPress();
  await flush();
  await find(screen.render(), (node) => node.type === "ComposerMenu").props.onCommand("/new");
  assert.equal(find(screen.render(), (node) => node.type === "NativeCommandSheet").props.command, "/new");
  for (const command of ["/new", "/reset", "/new 命名会话"]) {
    const typed = conversation(async () => assert.fail("命令不能进入消息队列"), command);
    findSend(typed.render()).props.onPress();
    await flush();
    assert.equal(find(typed.render(), (node) => node.type === "NativeCommandSheet").props.command, command);
  }
});

test("菜单与直接输入 stop 复用原生 interrupt，并显示停止结果", async () => {
  for (const typed of [false, true]) {
    const calls = [];
    let synced = 0;
    const screen = conversation(async () => assert.fail("停止不能作为消息发送"), typed ? "/stop" : "保留草稿", {
      messages: [{ message_id: "message", submission_id: "active-turn", role: "user", status: "streaming", text: "处理中" }],
      workspace: { call: async (...args) => calls.push(args), syncWorkspace: async () => synced++ },
    });
    if (typed) findSend(screen.render()).props.onPress();
    else {
      find(screen.render(), (node) => node.props.icon === "command").props.onPress();
      await flush();
      await find(screen.render(), (node) => node.type === "ComposerMenu").props.onCommand("/stop");
    }
    await flush();
    assert.deepEqual(calls, [["/topics/topic/interrupt", { method: "POST", body: { request_id: "request-1", submission_id: "active-turn" } }]]);
    assert.equal(synced, 1);
    assert.ok(find(screen.render(), (node) => node.props.children === "已请求停止回复。"));
    assert.equal(find(screen.render(), (node) => node.type === "NativeCommandSheet"), undefined);
  }
  const idle = conversation(async () => assert.fail("停止不能作为消息发送"), "/stop");
  findSend(idle.render()).props.onPress();
  await flush();
  assert.ok(find(idle.render(), (node) => node.props.children === "当前没有正在生成的回复。"));
});

test("无参数技能、模型与思考命令保留选择器，带参数原样交给中间层", async () => {
  for (const [command, type] of [["/skills", "ComposerMenu"], ["/model", "ModelPicker"], ["/reasoning", "ReasoningMenu"]]) {
    const screen = conversation(async () => assert.fail("命令不能进入消息队列"), command);
    findSend(screen.render()).props.onPress();
    await flush();
    const picker = find(screen.render(), (node) => node.type === type);
    assert.ok(picker);
    if (command === "/skills") assert.equal(picker.props.kind, "skills");
    assert.equal(find(screen.render(), (node) => node.type === "NativeCommandSheet"), undefined);
  }
  for (const command of ["/skills search text", "/model model-name --provider provider --global", "/reasoning high --global", "/reasoning show"] ) {
    const screen = conversation(async () => assert.fail("命令不能进入消息队列"), command);
    findSend(screen.render()).props.onPress();
    await flush();
    assert.equal(find(screen.render(), (node) => node.type === "NativeCommandSheet").props.command, command);
  }
});

test("直接输入命令保留完整参数，未知命令也不能当普通提示词发送", async () => {
  for (const command of ["/ReStArT", '/title   中文 "原样"  ', "/unknown-command 参数", "/123 参数"]) {
    const drafts = [];
    const screen = conversation(async () => assert.fail("命令不能作为普通消息发送"), command, {
      onDraftChange: (value) => drafts.push(value),
    });
    findSend(screen.render()).props.onPress();
    await flush();
    const sheet = find(screen.render(), (node) => node.type === "NativeCommandSheet");
    assert.equal(sheet.props.command, command);
    assert.deepEqual(drafts, [""]);
  }
  assert.equal(findSend(conversation(async () => {}, "/restart", { workspace: { network: "offline" } }).render()).props.disabled, true);
});

test("命令不能夹带附件，文件路径仍作为普通消息发送", async () => {
  const queued = [];
  const screen = conversation(async (item) => queued.push(item), "/restart", {
    attachments: [{ name: "notes.txt", mime: "text/plain", size: 1, content_base64: "YQ==" }],
    workspace: { attachments_supported: true },
  });
  findSend(screen.render()).props.onPress();
  await flush();
  assert.deepEqual(queued, []);
  assert.ok(find(screen.render(), (node) => node.type === "Notice" && /命令不能附带文件/.test(node.props.children)));
  const path = conversation(async (item) => queued.push(item), "/Users/me/project");
  findSend(path.render()).props.onPress();
  await flush();
  assert.equal(queued[0].text, "/Users/me/project");
});

test("命令结果显示原生输出，网络失败后只查询同一个执行请求", async () => {
  const calls = [];
  let close = 0;
  const screen = mount("native-command", "NativeCommandSheet", {
    command: "/restart", requestId: "same-request", onClose: () => close++,
    onRequest: async (...args) => {
      calls.push(args);
      if (calls.length === 1) throw new Error("连接已断开");
      return { status: "ok", native_result: { output: "正在等待 2 个任务结束，然后重启。" } };
    },
  });
  assert.equal(screen.render().props.busy, true);
  screen.effects.forEach((effect) => effect());
  await flush();
  const retry = find(screen.render(), (node) => node.props.title === "查看结果");
  retry.props.onPress();
  retry.props.onPress();
  await flush();
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [["same-request", "/restart"], ["same-request", "/restart"]]);
  assert.equal(find(screen.render(), (node) => node.type === "AnswerMarkdown").props.text, "正在等待 2 个任务结束，然后重启。");
  assert.equal(screen.render().props.busy, false);
  assert.deepEqual(screen.feedback, ["warning"], "收到原生响应不等于重启已完成");
  screen.render().props.onClose();
  assert.equal(close, 1);
});

test("原生命令明确拒绝或结果未知时不自动创建新请求", async () => {
  for (const status of ["error", "unknown"]) {
    const calls = [];
    const screen = mount("native-command", "NativeCommandSheet", {
      command: "/undo", requestId: "request", onClose() {},
      onRequest: async (...args) => { calls.push(args); return { status, error: "当前会话不支持此命令。" }; },
    });
    screen.render();
    screen.effects.forEach((effect) => effect());
    await flush();
    assert.equal(calls.length, 1);
    assert.ok(find(screen.render(), (node) => node.type === "Notice" && node.props.children === "当前会话不支持此命令。"));
    const query = find(screen.render(), (node) => node.props.title === "查看结果");
    if (status === "error") assert.equal(query, undefined);
    else {
      assert.ok(query, "结果未知时可以手动查询同一个请求");
      query.props.onPress();
      query.props.onPress();
      await flush();
      assert.deepEqual(calls.map((args) => args.slice(0, 2)), [["request", "/undo"], ["request", "/undo"]]);
    }
  }
});

test("只按 Hermes 原生确认显示允许选项，确认与重查保留各自的请求编号", async () => {
  for (const [approval, title] of [["once", "仅本次"], ["always", "始终允许"]]) {
    const calls = [];
    const screen = mount("native-command", "NativeCommandSheet", {
      command: "/undo 2", requestId: "initial-request", onClose() {},
      onRequest: async (...args) => {
        calls.push(args);
        if (calls.length === 1) return { status: "ok", native_result: { confirmation: "undo", output: "Hermes 原生确认提示" } };
        if (calls.length === 2) throw new Error("连接中断");
        return { status: "ok", native_result: { output: "已撤回两轮。" } };
      },
    });
    screen.render();
    screen.effects.forEach((effect) => effect());
    await flush();
    assert.equal(calls.length, 1, "显示原生确认不能自行批准执行");
    assert.equal(find(screen.render(), (node) => node.type === "AnswerMarkdown").props.text, "Hermes 原生确认提示");
    assert.ok(find(screen.render(), (node) => node.props.title === "取消"));
    const approve = find(screen.render(), (node) => node.props.title === title);
    assert.ok(approve);
    approve.props.onPress();
    approve.props.onPress();
    await flush();
    assert.equal(calls.length, 2);
    assert.notEqual(calls[1][0], calls[0][0], "批准是新请求，不能复用只返回确认提示的旧编号");
    assert.equal(find(screen.render(), (node) => node.props.title === title), undefined);
    approve.props.onPress();
    await flush();
    assert.equal(calls.length, 2, "过期确认按钮不能创建另一个执行请求");
    const retry = find(screen.render(), (node) => node.props.title === "查看结果");
    retry.props.onPress();
    retry.props.onPress();
    await flush();
    assert.deepEqual(calls.map(([id, command, _signal, choice]) => [id, command, choice]), [
      ["initial-request", "/undo 2", undefined], ["request-1", "/undo 2", approval], ["request-1", "/undo 2", approval],
    ]);
    assert.equal(find(screen.render(), (node) => node.type === "AnswerMarkdown").props.text, "已撤回两轮。");
  }
});

test("取消原生确认只关闭结果页，普通结果不自行增加确认流程", async () => {
  for (const confirmation of ["new", undefined]) {
    let calls = 0, closed = 0;
    const screen = mount("native-command", "NativeCommandSheet", {
      command: "/new", requestId: "request", onClose: () => closed++,
      onRequest: async () => { calls++; return { status: "ok", native_result: { output: "原生输出", ...(confirmation && { confirmation }) } }; },
    });
    screen.render();
    screen.effects.forEach((effect) => effect());
    await flush();
    const cancel = find(screen.render(), (node) => node.props.title === "取消");
    if (confirmation) {
      assert.ok(cancel);
      cancel.props.onPress();
      assert.equal(closed, 1);
    } else {
      assert.equal(cancel, undefined);
      assert.equal(find(screen.render(), (node) => node.props.title === "仅本次"), undefined);
      assert.equal(find(screen.render(), (node) => node.props.title === "始终允许"), undefined);
    }
    assert.equal(calls, 1);
  }
});

test("会话将原生命令确认选择传入工作区请求", async () => {
  const calls = [];
  const screen = conversation(async () => assert.fail("命令不能进入消息队列"), "/new", {
    workspace: { requestNativeCommand: async (...args) => { calls.push(args); return { status: "ok", native_result: { output: "已新建" } }; } },
  });
  findSend(screen.render()).props.onPress();
  await flush();
  const signal = new AbortController().signal;
  await find(screen.render(), (node) => node.type === "NativeCommandSheet").props.onRequest("approved-id", "/new", signal, "once");
  assert.deepEqual(calls, [["topic", "approved-id", "/new", signal, "once"]]);
});

test("语音按钮独立位于输入框外侧右边，点击开始与停止都不发送消息", async () => {
  let started = 0, stopped = 0;
  const drafts = [];
  const speech = { available: true, state: "idle", busy: false,
    start: async () => { started++; }, stop: async () => { stopped++; return "已有草稿 语音"; } };
  const screen = conversation(async () => assert.fail("麦克风按钮不能发送消息"), "", {
    speech, onDraftChange: (text) => drafts.push(text),
  });
  const tree = screen.render();
  assert.equal(find(tree, (node) => node.type === "AssistantStreamBorder"), undefined);
  const mic = find(tree, (node) => node.props.accessibilityLabel === "开始语音输入");
  assert.ok(mic, "可用设备显示语音入口");
  const row = find(tree, (node) => Array.isArray(node.props.children)
    && node.props.children.some((child) => child?.props?.accessibilityLabel === "消息"));
  const labels = row.props.children.map((child) => child?.props?.accessibilityLabel).filter(Boolean);
  assert.deepEqual(labels, ["添加附件", "消息", "发送"]);
  const controls = find(tree, (node) => Array.isArray(node.props.children) && node.props.children.includes(row));
  const speechSlot = find(tree, (node) => node.props.children === mic);
  assert.deepEqual(controls.props.children, [row, speechSlot], "语音按钮在输入框边框外，独立排列在右侧");
  mic.props.onPress();
  await flush();
  assert.equal(started, 1);
  for (const state of ["starting", "recording"]) {
    speech.state = state;
    speech.busy = true;
    const tree = screen.render({ draft: "实时识别文字" });
    const border = find(tree, (node) => node.type === "AssistantStreamBorder");
    assert.equal(border?.props.variant, state === "recording" ? "composer" : undefined, "仅实际录音时显示输入框流光");
    if (border) {
      const row = find(tree, (node) => Array.isArray(node.props.children) && node.props.children.includes(border));
      assert.ok(row.props.children.some((child) => child?.props?.accessibilityLabel === "消息"), "流光限于输入框内");
    }
    const stop = find(tree, (node) => node.props.accessibilityLabel === "停止语音输入");
    const slot = find(tree, (node) => node.props.children === stop);
    assert.equal(slot.props.accessibilityElementsHidden, false, "识别出文字后仍保留停止入口");
    assert.equal(slot.props.pointerEvents, "auto");
    assert.equal(Object.assign({}, ...slot.props.style).width, 44);
    assert.equal(stop.props.disabled, false, "等待权限时也能停止");
    assert.equal(stop.props.accessibilityState.selected, true);
    assert.equal(find(tree, (node) => node.props.accessibilityLabel === "消息").props.editable, false);
    assert.equal(find(tree, (node) => node.props.icon === "skill").props.disabled, true);
    assert.equal(find(tree, (node) => node.props.icon === "command").props.disabled, true, "命令中的技能入口也不能改写录音草稿");
    stop.props.onPress();
    await flush();
  }
  assert.equal(stopped, 2);
  assert.deepEqual(drafts, [], "停止按钮不清空已有草稿");
  speech.state = "stopping";
  assert.equal(find(screen.render(), (node) => node.props.accessibilityLabel === "停止语音输入").props.disabled, true);
  assert.equal(find(screen.render(), (node) => node.type === "AssistantStreamBorder"), undefined);
  speech.state = "idle";
  speech.busy = false;
  assert.equal(find(screen.render(), (node) => node.type === "AssistantStreamBorder"), undefined);
  assert.equal(find(screen.render(), (node) => node.props.accessibilityLabel === "消息").props.editable, true);
  assert.equal(find(conversation(async () => {}).render(), (node) => node.props.accessibilityLabel === "开始语音输入"), undefined);
});

test("输入任意文字后语音按钮淡出并释放空位，清空后恢复且遵循减少动态效果设置", () => {
  for (const reduceMotion of [false, true]) {
    let started = 0;
    const speech = { available: true, state: "idle", busy: false, start: () => { started++; }, stop: async () => "" };
    const screen = conversation(async () => {}, "", { speech, reduceMotion });
    for (const draft of ["", "你好", " ", "\n", "", "再次输入", ""]) {
      const tree = screen.render({ draft });
      const mic = find(tree, (node) => node.props.accessibilityLabel === "开始语音输入");
      const slot = find(tree, (node) => node.props.children === mic);
      const style = Object.assign({}, ...slot.props.style);
      const visible = draft.length === 0;
      assert.equal(style.width + style.marginLeft, visible ? 52 : 0, "隐藏时同时收回按钮与间距");
      assert.equal(style.opacity, visible ? 1 : 0);
      assert.deepEqual(style.transform, [{ translateX: visible ? 0 : 8 }]);
      assert.equal(style.transitionDuration, reduceMotion ? 0 : 360);
      assert.equal(style.transitionTimingFunction, "ease-in-out");
      assert.equal(slot.props.pointerEvents, visible ? "auto" : "none");
      assert.equal(slot.props.accessibilityElementsHidden, !visible);
      assert.equal(slot.props.importantForAccessibility, visible ? "auto" : "no-hide-descendants");
      assert.equal(mic.props.disabled, !visible);
      assert.equal(mic.props.accessibilityState.disabled, !visible);
      if (!visible) mic.props.onPress();
      const controls = find(tree, (node) => Array.isArray(node.props.children) && node.props.children.includes(slot));
      assert.equal(controls.props.style.gap ?? 0, 0, "父容器不能残留按钮间距");
    }
    assert.equal(started, 0, "不可见的按钮不能开始录音");
  }
});

test("不支持语音的设备不保留语音按钮占位", () => {
  const tree = conversation(async () => {}, "").render();
  const row = find(tree, (node) => Array.isArray(node.props.children)
    && node.props.children.some((child) => child?.props?.accessibilityLabel === "消息"));
  const controls = find(tree, (node) => Array.isArray(node.props.children) && node.props.children.includes(row));
  assert.deepEqual(controls.props.children.filter(Boolean), [row]);
  assert.equal(controls.props.style.gap ?? 0, 0);
});

test("录音中发送等待最后转写，快速重复点击只提交一份完整草稿", async () => {
  const queued = [], drafts = [];
  let finish, stopped = 0;
  const ending = new Promise((resolve) => { finish = resolve; });
  const speech = { available: true, state: "recording", busy: true, start: async () => {},
    stop: () => { stopped++; return ending; } };
  const screen = conversation(async (item) => queued.push(item), "已有草稿 识别到一半", {
    speech, onDraftChange: (text) => drafts.push(text),
  });
  const send = findSend(screen.render());
  send.props.onPress();
  send.props.onPress();
  await flush();
  assert.equal(stopped, 1);
  assert.deepEqual(queued, []);
  assert.deepEqual(drafts, []);
  assert.equal(findSend(screen.render()).props.disabled, true);
  finish("已有草稿 识别到最后一句");
  await flush();
  assert.equal(queued.length, 1);
  assert.equal(queued[0].text, "已有草稿 识别到最后一句");
  assert.deepEqual(drafts, [""]);
});

test("尚无实时文字时也能发送来结束录音，空结果或会话失效不会提交或清空草稿", async () => {
  for (const final of ["最后一句", "", null]) {
    const queued = [], drafts = [];
    const speech = { available: true, state: "recording", busy: true, start: async () => {}, stop: async () => final };
    const screen = conversation(async (item) => queued.push(item), "", { speech, onDraftChange: (text) => drafts.push(text) });
    const send = findSend(screen.render());
    assert.equal(send.props.disabled, false);
    send.props.onPress();
    await flush();
    assert.deepEqual(queued.map((item) => item.text), final ? [final] : []);
    assert.deepEqual(drafts, final ? [""] : []);
  }
});

test("发送使用最终语音文本识别 model 命令，排队失败保留草稿", async () => {
  const speech = { available: true, state: "recording", busy: true, start: async () => {}, stop: async () => "/model" };
  const drafts = [];
  const screen = conversation(async () => assert.fail("model 命令不进入消息队列"), "/mo", {
    speech, onDraftChange: (text) => drafts.push(text),
  });
  findSend(screen.render()).props.onPress();
  await flush();
  assert.ok(find(screen.render(), (node) => node.type === "ModelPicker"));
  assert.deepEqual(drafts, [""]);
  const failed = conversation(async () => { throw new Error("disk full"); }, "已有草稿", {
    speech: { ...speech, stop: async () => "已有草稿 最后一句" }, onDraftChange: () => assert.fail("失败不能清空草稿"),
  });
  findSend(failed.render()).props.onPress();
  await flush();
  assert.ok(find(failed.render(), (node) => node.type === "Notice" && node.props.children === "disk full"));
});

test("其他页面刷新不会启动会话详情的下拉刷新控件", () => {
  const screen = conversation(async () => {}, "", { workspace: { refreshing: true } });
  const control = find(screen.render(), (node) => node.type === "ScrollView").props.refreshControl;
  assert.equal(control.props.refreshing, false);
});

test("详情自己的下拉刷新等待请求结束，成功和失败都会收起指示器", async () => {
  for (const fails of [false, true]) {
    let finish;
    const pending = new Promise((resolve, reject) => { finish = () => fails ? reject(new Error("刷新失败")) : resolve(); });
    void pending.catch(() => {});
    const screen = conversation(async () => {}, "", { workspace: { refreshing: false, refresh: () => pending } });
    const control = () => find(screen.render(), (node) => node.type === "ScrollView").props.refreshControl;
    const result = control().props.onRefresh();
    try {
      assert.equal(control().props.refreshing, true, "请求未结束时保持本页刷新指示器");
    } finally {
      finish();
      await Promise.resolve(result).catch(() => {});
      await flush();
    }
    assert.equal(control().props.refreshing, false, "请求结束后清理本页刷新指示器");
  }
});

const activeMessage = { message_id: "original", role: "user", text: "整理报告", status: "streaming", submission_id: "active-turn" };

test("执行中与空闲时始终使用同一个发送入口，不由前端选择插话目标", async () => {
  for (const status of ["streaming", "final"]) {
    const queued = [], drafts = [];
    const screen = conversation(async (item) => { queued.push(item); }, " 加上预算 ", {
      messages: [{ ...activeMessage, status }], onDraftChange: (value) => drafts.push(value),
    });
    const tree = screen.render();
    assert.equal(find(tree, (node) => node.props.title === "插话"), undefined);
    const send = findSend(tree);
    assert.ok(send, "发送入口不随运行状态改变");
    assert.equal(send.props.disabled, false);
    send.props.onPress();
    send.props.onPress();
    await flush();
    assert.equal(queued.length, 1);
    assert.deepEqual(Object.keys(queued[0]).sort(), ["created_at", "submission_id", "text", "topic_id"]);
    assert.equal(queued[0].text, "加上预算");
    assert.deepEqual(drafts, [""]);
    assert.deepEqual(screen.feedback, ["medium"]);
  }
});

test("执行中仍允许离线保存和发送附件，不要求客户端知道插话能力", async () => {
  for (const options of [
    { workspace: { connector_online: false, network: "offline" } },
    { workspace: { attachments_supported: true }, attachments: [{ name: "报告.pdf", mime: "application/pdf", size: 10 }] },
  ]) {
    const queued = [];
    const screen = conversation(async (item) => queued.push(item), "补充要求", { messages: [activeMessage], ...options });
    const send = findSend(screen.render());
    assert.ok(send);
    assert.equal(send.props.disabled, false);
    send.props.onPress();
    await flush();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].target_submission_id, undefined);
    assert.deepEqual(queued[0].attachments, options.attachments);
  }
});

test("发送触感确认点击，消息只保存到本地队列时不宣告送达", async () => {
  let queued = 0;
  const screen = conversation(async () => { queued++; });
  const send = findSend(screen.render());
  send.props.onPress();
  await flush();
  assert.equal(queued, 1);
  assert.deepEqual(screen.feedback, ["medium"]);
});

test("本地消息保存失败提示错误，禁用的发送不触发触感", async () => {
  const failed = conversation(async () => { throw new Error("disk full"); });
  findSend(failed.render()).props.onPress();
  await flush();
  assert.deepEqual(failed.feedback, ["medium", "error"]);
  const disabled = conversation(async () => assert.fail("empty message must not enqueue"), "");
  findSend(disabled.render()).props.onPress();
  await flush();
  assert.deepEqual(disabled.feedback, []);
});

test("已完成的过程收起后只保留标题，展开仍能查看全部记录", () => {
  const messages = [{ message_id: "reply", role: "assistant", text: "已整理。", status: "final", process: [
    { kind: "reasoning", text: "先按紧急程度整理。" },
    { kind: "tool", id: "tool", name: "读取笔记", status: "running" },
  ] }];
  const screen = conversation(async () => {}, "", { messages });
  const render = () => screen.renderChild((node) => node.props.steps === messages[0].process);
  const header = (tree) => find(tree, (node) => node.props.accessibilityRole === "button");
  for (const expanded of [false, true, false]) {
    const tree = render();
    assert.ok(tree, "完成后仍保留可展开的过程标题");
    assert.equal(header(tree).props.accessibilityState.expanded, expanded);
    assert.equal(Boolean(find(tree, (node) => node.props.children === "先按紧急程度整理。")), expanded);
    assert.equal(Boolean(find(tree, (node) => node.props.children === "读取笔记 · 结果未确认")), expanded);
    assert.equal(Boolean(find(tree, (node) => node.type === "ScrollView")), expanded);
    header(tree).props.onPress();
  }
  assert.equal(find(screen.render(), (node) => node.type === "AnswerMarkdown").props.text, "已整理。");
  assert.deepEqual(screen.feedback, ["selection", "selection", "selection"]);
});

test("收起的过程跟随最新流式 item，展开后新 item 仍保留完整列表", () => {
  const message = { message_id: "reply", role: "assistant", text: "", status: "streaming", process: [
    { kind: "tool", id: "tool", name: "读取笔记", status: "running" },
  ] };
  const screen = conversation(async () => {}, "", { messages: [message] });
  const render = () => screen.renderChild((node) => node.props.steps === message.process);
  assert.ok(find(render(), (node) => node.props.children === "读取笔记 · 执行中…"));
  message.process = [...message.process, { kind: "reasoning", text: "根据笔记整理\n保留完整的第二行。" }];
  let tree = render();
  assert.equal(find(tree, (node) => node.props.children === "读取笔记 · 执行中…"), undefined);
  const latest = find(tree, (node) => node.props.children === "根据笔记整理\n保留完整的第二行。");
  assert.ok(latest);
  assert.equal(latest.props.numberOfLines, undefined);
  message.status = "final";
  tree = render();
  assert.equal(find(tree, (node) => node.props.children === "根据笔记整理\n保留完整的第二行。"), undefined);
  assert.equal(find(tree, (node) => node.type === "ScrollView"), undefined);
  message.status = "streaming";
  tree = render();
  find(tree, (node) => node.props.accessibilityRole === "button").props.onPress();
  message.process = [...message.process, { kind: "tool", id: "save", name: "保存笔记", status: "succeeded" }];
  tree = render();
  for (const text of ["读取笔记 · 执行中…", "根据笔记整理\n保留完整的第二行。", "保存笔记 · 已完成"]) {
    assert.ok(find(tree, (node) => node.props.children === text));
  }
  message.status = "final";
  tree = render();
  assert.equal(find(tree, (node) => node.props.accessibilityRole === "button").props.accessibilityState.expanded, true);
  assert.ok(find(tree, (node) => node.props.children === "保存笔记 · 已完成"));
});

test("展开的过程高度限制为当前屏幕三分之一，完整记录支持内部滚动", () => {
  const steps = Array.from({ length: 20 }, (_, index) => ({ kind: "reasoning", text: `思考记录 ${index + 1}` }));
  const message = { message_id: "reply", role: "assistant", text: "", status: "streaming", process: steps };
  const screen = conversation(async () => {}, "", { messages: [message] });
  const render = () => screen.renderChild((node) => node.props.steps === steps);
  let tree = render();
  assert.equal(Object.assign({}, ...tree.props.style).maxHeight, undefined);
  find(tree, (node) => node.props.accessibilityRole === "button").props.onPress();
  for (const [height, maxHeight] of [[900, 300], [600, 200]]) {
    screen.dimensions.height = height;
    tree = render();
    assert.equal(Object.assign({}, ...tree.props.style).maxHeight, maxHeight);
    const content = find(tree, (node) => node.type === "ScrollView");
    assert.ok(content, "超出高度的过程必须可以滚动");
    assert.equal(content.props.nestedScrollEnabled, true);
    assert.equal(content.props.scrollEnabled, true);
    assert.equal(find(content, (node) => node.props.accessibilityRole === "button"), undefined, "标题保留在滚动区域外");
    assert.ok(find(content, (node) => node.props.children === "思考记录 1"));
    assert.ok(find(content, (node) => node.props.children === "思考记录 20"));
  }
});

test("纯附件回复保留文件，没有过程的回复不显示空模块", () => {
  const attachments = [{ attachment_id: "file", name: "报告.pdf", mime: "application/pdf", size: 10 }];
  const messages = [{ message_id: "delivery", role: "assistant", text: "", status: "final", attachments }];
  const screen = conversation(async () => {}, "", { messages }).render();
  assert.deepEqual(find(screen, (node) => node.type === "MessageAttachments")?.props.items, attachments);
  assert.equal(find(screen, (node) => Array.isArray(node.props.steps)), undefined);
});

async function selectModel(result, { aborted = false, currentModel = "old", global = false, onSelected = () => {} } = {}) {
  const screen = mount("model-picker", "ModelPicker", {
    enabled: true, onClose() {}, onSelected,
    onRequest: async (_id, selection) => selection ? result : {
      status: "ok", model_result: { type: "catalog", catalog: { provider: "p", model: currentModel, providers: [{ id: "p", name: "Provider", models: ["new"] }] } },
    },
  });
  screen.render();
  const cleanup = screen.effects.map((effect) => effect());
  await flush();
  assert.deepEqual(screen.feedback, [], "catalog loading stays silent");
  let list = findList(screen.render());
  list.props.renderItem({ item: list.props.data[0] }).props.onPress();
  list = findList(screen.render());
  list.props.renderItem({ item: list.props.data[0] }).props.onPress();
  find(screen.render(), (node) => node.props.title === (global ? "设为默认模型" : "仅当前会话")).props.onPress();
  if (aborted) cleanup.forEach((dispose) => dispose?.());
  await flush();
  return screen.feedback;
}

test("仅已生效的模型切换提示成功，排队与取消请求保持静默", async () => {
  const selection = { provider: "p", model: "new" };
  assert.deepEqual(await selectModel({ status: "ok", model_result: { type: "selected", selection } }), ["success"]);
  assert.deepEqual(await selectModel({ status: "ok", model_result: { type: "deferred", selection } }), []);
  assert.deepEqual(await selectModel({ status: "ok", model_result: { type: "selected", selection } }, { aborted: true }), []);
  assert.deepEqual(await selectModel({ status: "ok", model_result: { type: "selected", selection } }, { currentModel: "new" }), []);
});

test("旧服务端未回执 Global 时不宣告默认模型保存成功", async () => {
  const feedback = await selectModel({ status: "ok", model_result: {
    type: "selected", selection: { provider: "p", model: "new" },
  } }, { global: true, onSelected: () => assert.fail("缺少默认模型保存回执不能报成功") });
  assert.deepEqual(feedback, ["warning"]);
});

test("模型风险确认与明确失败使用对应提示，自动加载失败不振动", async () => {
  assert.deepEqual(await selectModel({ status: "ok", model_result: { type: "confirmation", confirm: "token", message: "费用变化" } }), ["warning"]);
  assert.deepEqual(await selectModel({ status: "error", error: "切换失败" }), ["error"]);
  assert.deepEqual(await selectModel({ status: "unknown", error: "结果待确认" }), ["warning"]);
  const screen = mount("model-picker", "ModelPicker", {
    enabled: true, onClose() {}, onSelected() {}, onRequest: async () => { throw new Error("offline"); },
  });
  screen.render();
  screen.effects.forEach((effect) => effect());
  await flush();
  assert.deepEqual(screen.feedback, []);
});

test("选定模型后先确认范围，仅设为默认时发送 Global，取消不提交", async () => {
  for (const global of [false, true, undefined]) {
    const writes = [], selected = [];
    const screen = mount("model-picker", "ModelPicker", {
      enabled: true, profileLabel: "日常助手", onClose() {},
      onSelected: (...args) => selected.push(args),
      onRequest: async (_id, selection) => {
        if (!selection) return { status: "ok", model_result: { type: "catalog", catalog: {
          provider: "p", model: "old", providers: [{ id: "p", name: "Provider", models: ["new"] }],
        } } };
        writes.push(selection);
        return { status: "ok", model_result: { type: "selected", global: selection.global, selection: { provider: "p", model: "new" } } };
      },
    });
    screen.render();
    screen.effects.forEach((effect) => effect());
    await flush();
    for (let i = 0; i < 2; i++) {
      const list = findList(screen.render());
      list.props.renderItem({ item: list.props.data[0] }).props.onPress();
    }
    assert.deepEqual(writes, [], "选择模型不能跳过范围确认直接修改配置");
    assert.ok(find(screen.render(), (node) => node.type === "Text"
      && JSON.stringify(node.props.children).includes("日常助手")));
    if (global === undefined) {
      find(screen.render(), (node) => node.props.accessibilityLabel === "返回模型列表").props.onPress();
      assert.ok(findList(screen.render()), "取消范围选择后回到模型列表");
      assert.deepEqual(writes, []);
    } else {
      find(screen.render(), (node) => node.props.title === (global ? "设为默认模型" : "仅当前会话")).props.onPress();
      await flush();
      assert.deepEqual(writes, [{ provider: "p", model: "new", global }]);
      assert.equal(selected[0][1], global);
    }
  }
});

test("默认模型的费用确认和网络重试保留 Global 与原请求编号", async () => {
  const writes = [], selected = [];
  const props = {
    enabled: true, onClose() {}, onSelected: (...args) => selected.push(args),
    onRequest: async (id, selection) => {
      if (!selection) return { status: "ok", model_result: { type: "catalog", catalog: {
        provider: "p", model: "old", providers: [{ id: "p", name: "Provider", models: ["new"] }],
      } } };
      writes.push({ id, ...selection });
      if (writes.length === 1) return { status: "ok", model_result: {
        type: "confirmation", confirm: "expense-token", message: "费用变化",
      } };
      if (writes.length === 2) throw new Error("网络中断");
      return { status: "ok", model_result: { type: "selected", global: true, selection: { provider: "p", model: "new" } } };
    },
  };
  const screen = mount("model-picker", "ModelPicker", props);
  screen.render();
  screen.effects.forEach((effect) => effect());
  await flush();
  for (let i = 0; i < 2; i++) {
    const list = findList(screen.render());
    list.props.renderItem({ item: list.props.data[0] }).props.onPress();
  }
  find(screen.render(), (node) => node.props.title === "设为默认模型").props.onPress();
  await flush();
  assert.deepEqual(selected, []);
  find(screen.render(), (node) => node.props.title === "确认切换").props.onPress();
  await flush();
  assert.deepEqual(selected, []);
  assert.equal(find(screen.render(), (node) => node.props.title === "确认切换").props.disabled, true);
  props.enabled = false;
  find(screen.render(), (node) => node.props.title === "重新查询请求状态").props.onPress();
  await flush();
  assert.ok(writes.every((selection) => selection.global === true));
  assert.deepEqual(writes[1], writes[2], "重试必须使用带相同确认凭证的原请求");
  assert.equal(writes[1].confirm, "expense-token");
  assert.equal(selected[0][1], true);
});

test("思考强度只在确认完成后提示成功，取消后不触发反馈", async () => {
  for (const [result, expected, aborted, effort = "low"] of [
    [{ status: "ok" }, ["success"], false],
    [{ status: "error", error: "切换失败" }, ["error"], false],
    [{ status: "unknown", error: "结果待确认" }, ["warning"], false],
    [{ status: "ok" }, [], true],
    [{ status: "ok" }, [], false, "high"],
  ]) {
    const screen = mount("composer-menu", "ReasoningMenu", {
      effort, onClose() {}, onRequest: async () => result,
    });
    const tree = screen.render();
    const cleanup = screen.effects.map((effect) => effect());
    find(tree, (node) => node.props.title === "高").props.onPress();
    if (aborted) cleanup.forEach((dispose) => dispose?.());
    await flush();
    assert.deepEqual(screen.feedback, expected);
  }
});

test("思考强度请求超时后只允许查询同一档位的请求", async () => {
  const requests = [];
  const props = {
    effort: "low", onClose() {},
    async onRequest(id, effort) {
      requests.push({ id, effort });
      if (requests.length === 1) throw new Error("Hermes 尚未确认请求");
      return { status: "ok" };
    },
  };
  const screen = mount("composer-menu", "ReasoningMenu", props);
  const row = (title) => find(screen.render(), (node) => node.props.title === title).props;
  row("高").onPress();
  await flush();
  props.status = "pending";
  assert.equal(row("低").disabled, true);
  assert.equal(row("高").disabled, false);
  row("高").onPress();
  await flush();
  assert.deepEqual(requests, [{ id: "request-1", effort: "high" }, { id: "request-1", effort: "high" }]);
});
