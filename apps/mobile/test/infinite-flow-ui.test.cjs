const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

const source = ts.transpileModule(readFileSync(require.resolve("../src/workspace-screen.tsx"), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
}).outputText;

function mount({ enabled = false, section = "topics", params = {}, profiles } = {}) {
  const events = [], values = [];
  let cursor = 0;
  const jsx = (type, props, key) => ({ type, props, key });
  const context = {
    section, profileId: "daily", session: {}, drafts: { stream: "未发送的草稿" }, draftAttachments: {},
    archiveInFlight: { current: false },
    workspace: {
      infiniteFlow: enabled, ready: true, preferencesSaving: false, pending: [], network: "online", connector_online: true,
      topics: [], inbox: [], profiles: profiles ?? [{ profile_id: "daily", label: "日常助手" }, { profile_id: "research", label: "研究助手" }],
      streamTopic: enabled ? { id: "stream", profileId: "daily" } : undefined,
      streamTopics: { daily: { id: "stream", profileId: "daily" }, research: { id: "research-stream", profileId: "research" } },
      topicDetails: { stream: { topic: { topic_id: "stream", profile_id: "daily" }, messages: ["日常消息"] },
        "research-stream": { topic: { topic_id: "research-stream", profile_id: "research" }, messages: ["研究消息"] } },
      async setInfiniteFlow(value) { events.push(["mode", value]); context.workspace.infiniteFlow = value; },
    },
    setSection(value) { events.push(["section", value]); context.section = value; },
    setProfileId(value) { events.push(["profile", value]); context.profileId = value; },
    setError(value) { context.error = value; },
    setDrafts() {}, setDraftAttachments() {}, setInboxItem() {}, setInboxProfileId() {},
  };
  const components = (...names) => Object.fromEntries(names.map((name) => [name, name]));
  const modules = {
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    react: {
      useState(initial) { const slot = cursor++; if (!(slot in values)) values[slot] = initial;
        return [values[slot], (next) => { values[slot] = typeof next === "function" ? next(values[slot]) : next; }]; },
      useRef(current) { return values[cursor++] ??= { current }; },
      useCallback: (callback) => callback, useEffect() {},
    },
    "expo-crypto": { randomUUID: () => "new-id" },
    "expo-router": { useLocalSearchParams: () => params, useFocusEffect() {},
      useNavigation: () => ({ getState: () => ({ routes: [], index: 0 }) }),
      useRouter: () => ({ canDismiss: () => false, back: () => events.push(["back"]),
        push: (route) => events.push(["push", route]), replace: (route) => events.push(["replace", route]) }) },
    "react-native": { ...components("Pressable", "ScrollView", "RefreshControl", "Text", "View", "ActivityIndicator"),
      BackHandler: {}, Keyboard: { dismiss() {} }, Platform: { OS: "web", select: (values) => values.web ?? values.default },
      StyleSheet: { create: (value) => value, hairlineWidth: 1 } },
    "react-native-reanimated": { default: { Text: "Animated.Text", View: "Animated.View" } },
    "react-native-safe-area-context": components("SafeAreaView"),
    "@hermes-mobile/protocol": { DEFAULT_TOPIC_TITLE: "新会话", topicTitlePreview: (value) => value },
    "./chat/conversation": components("Conversation", "ConversationTranscript"),
    "./profiles/pager": components("ProfilePager"),
    "./chat/composer-menu": components("ComposerSheet", "PickerRow"),
    "./chat/topic-list": components("TopicList"),
    "./chat/assistant-stream-border": components("AssistantStreamBorder"),
    "./inbox/inbox": components("InboxList", "InboxDetail"),
    "./manage": components("ManagementMenu", "ManagementScreen"),
    "./manage/shared": components("Group", "Row", "Toggle"),
    "./notifications": { pushAvailable: false },
    "./profiles/avatar": components("ProfileAvatar"),
    "./profiles/settings": components("ProfileSettings"),
    "./profiles/selection": { selectProfile: (profiles, id) => profiles.find((profile) => profile.profile_id === id) ?? profiles[0] },
    "./ui/alerts": { useAlert: () => ({ alert() {} }) },
    "./ui/haptics": { haptic() {} },
    "./ui/motion": { useReduceMotion: () => true, motion: {} },
    "./ui/page-header": components("PageHeader"),
    "./ui/text": { profileLabel: (value) => value.label, formatDateTime: String },
    "./ui/theme": { ...components("Action", "Card", "CloseButton", "EmptyState", "Icon", "Notice", "SectionLabel"),
      useTheme: () => ({ colors: {}, styles: {} }) },
    "./updates": { currentUpdate: {} },
    "./workspace-context": { useWorkspaceContext: () => context },
  };
  const exported = {};
  new Function("exports", "require", source)(exported, (name) => {
    assert.ok(name in modules, name); return modules[name];
  });
  return { context, events, render() { cursor = 0; const root = exported.default(); return root.props.children.type(); } };
}

function find(node, predicate) {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!node?.props) return;
  if (predicate(node)) return node;
  return find([node.props.children, node.props.leading, node.props.trailing, node.props.title,
    node.props.settingsNavigation, node.props.applicationSettings], predicate);
}

test("关闭模式保留普通会话列表入口，设置中提供默认关闭的开关", async () => {
  const normal = mount();
  assert.ok(find(normal.render(), (node) => node.props.accessibilityLabel === "新建会话"));
  assert.ok(find(normal.render(), (node) => node.props.accessibilityRole === "tablist"));
  const settings = mount({ section: "settings" });
  const toggle = find(settings.render(), (node) => node.type === "Toggle" && node.props.label === "无限会话流");
  assert.ok(toggle);
  assert.equal(toggle.props.value, false);
  await toggle.props.onChange(true);
  await new Promise(setImmediate);
  assert.deepEqual(settings.events, [["mode", true], ["section", "topics"]]);
});

test("开启模式首页直接显示持续会话与 Profile 头像，底部无 Tab 且无新建", async () => {
  const app = mount({ enabled: true });
  const tree = app.render();
  const chat = find(tree, (node) => node.type === "Conversation");
  assert.ok(chat);
  assert.equal(chat.props.id, "stream");
  assert.equal(chat.props.newProfileId, "daily");
  assert.equal(chat.props.draft, "未发送的草稿");
  assert.ok(find(tree, (node) => node.type === "ProfileAvatar"));
  assert.equal(find(tree, (node) => node.props.accessibilityRole === "tablist"), undefined);
  assert.equal(find(tree, (node) => node.props.accessibilityLabel === "新建会话"), undefined);
  find(chat.props.settingsNavigation, (node) => node.props.title === "收件箱").props.onPress();
  assert.deepEqual(app.events, [["section", "inbox"]]);
  const toggle = find(chat.props.applicationSettings, (node) => node.type === "Toggle");
  await toggle.props.onChange(false);
  await new Promise(setImmediate);
  assert.equal(app.context.workspace.infiniteFlow, false);
  assert.equal(app.context.section, "topics");
});

test("无限模式收件箱和设置保留返回聊天路径，加载时也不闪现列表和新建按钮", () => {
  for (const section of ["inbox", "settings"]) {
    const app = mount({ enabled: true, section });
    const tree = app.render();
    assert.equal(find(tree, (node) => node.props.accessibilityRole === "tablist"), undefined);
    const header = find(tree, (node) => node.type === "PageHeader");
    const back = header.props.leading ?? header.props.trailing;
    assert.ok(back);
    back.props.onPress();
    assert.deepEqual(app.events, [["section", "topics"]]);
  }
  const loading = mount({ enabled: true, profiles: [] });
  loading.context.workspace.streamTopic = undefined;
  const tree = loading.render();
  assert.equal(find(tree, (node) => node.type === "TopicList"), undefined);
  assert.equal(find(tree, (node) => node.props.accessibilityLabel === "新建会话"), undefined);
  assert.ok(find(tree, (node) => node.props.accessibilityLabel === "设置中心"));
});

test("仅消息区分页，各页按 Profile 绑定数据，落页后更换顶部和固定输入草稿", () => {
  const app = mount({ enabled: true });
  let chat = find(app.render(), (node) => node.type === "Conversation");
  const pager = chat.props.renderTranscript({ ref: "scroll-ref" });
  assert.equal(pager.type, "ProfilePager");
  assert.equal(pager.props.profileId, "daily");
  const [daily, research] = pager.props.children;
  assert.deepEqual(daily.props.children.props.workspace.detail.messages, ["日常消息"]);
  assert.deepEqual(research.props.children.props.workspace.detail.messages, ["研究消息"]);
  assert.equal(daily.props.children.props.ref, "scroll-ref");
  assert.equal(research.props.children.props.ref, undefined);
  assert.equal(research.props.pointerEvents, "none");
  assert.equal(research.props["aria-hidden"], true);
  assert.equal(find(pager, (node) => node.props.accessibilityLabel === "消息"), undefined);
  pager.props.onSelect("research");
  app.context.workspace.streamTopic = app.context.workspace.streamTopics.research;
  app.context.drafts["research-stream"] = "研究草稿";
  const next = find(app.render(), (node) => node.type === "Conversation");
  assert.equal(next.key, chat.key, "Profile 切换不能重挂载整个 Pager");
  assert.equal(next.props.draft, "研究草稿");
  assert.ok(find(app.render(), (node) => node.props.children === "研究助手"));
  app.context.workspace.streamTopic = undefined;
  assert.ok(find(app.render(), (node) => node.type === "Conversation"), "分配新会话期间不能卸载 Pager");
});
