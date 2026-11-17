# 无限会话流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 实现已确认的第二版无限会话流，默认关闭，开启后每个 Profile 保留一条持续会话并统一设置入口。

**Architecture:** 复用 useWorkspace 的配对隔离 SQLite 缓存、幂等创建与消息队列；在首页直接渲染 Conversation，不增加自动跳转路由。扩展现有 SettingsDrawer 接纳导航和应用设置，复用已安装的手势库。

**Tech Stack:** Expo / React Native / TypeScript，pnpm 10.14，Node.js 24。

**Spec:** output/infinite-conversation-flow/README.md（第二版；用户已批准开始实现）

## Global Constraints

- 无限会话流默认关闭；关闭后恢复普通会话列表。
- 开启后不显示会话列表、新建按钮或底部 Tab；头像取代返回，左右滑动切换 Profile。
- 全中文 UI，复用当前主题与控件，不新增依赖，不修改 Hermes 源码。
- 不删除历史、草稿或待发送消息；本轮不发布 OTA 或安装原生包。

## Review Focus

- 冷启动与存储失败：默认关闭，设置成功落盘后才切换。
- 切换 Profile、重启、关闭再开启：会话稳定复用且消息不跨 Profile。
- 离线、创建失败和并发刷新：同一幂等 ID 重试，不重复创建。
- 设置与收件箱导航、通知历史消息：入口和返回路径可达。
- 手势与垂直滚动、输入、横向内容冲突：限定有效横划，保留头像选择替代入口。

### Task 1: 持久化开关与持续会话

**Files:** apps/mobile/src/sync/use-workspace.ts、workspace-context.tsx；apps/mobile/test/message-outbox.test.cjs。

**Interfaces:** useWorkspace 的第四参数为可选 `{ profileId?: string }`，仅首页聊天启用；返回 `infiniteFlow`、`setInfiniteFlow(enabled)`、`streamTopic`、`preferencesSaving`。streamTopic 为 `{ id, profileId }`。

- [x] 先补默认关闭、存储恢复与失败、Profile 隔离、并发创建和离线重试测试并确认失败。
- [x] 在配对隔离 cache 持久化开关与各 Profile 的 ID；复用 prepareTopic，保护保存/退出竞态。
- [x] 在 context 传入当前首页 Profile；运行 `node --test apps/mobile/test/message-outbox.test.cjs`，预期全部通过。

### Task 2: 首页聊天与统一设置中心

**Files:** apps/mobile/src/workspace-screen.tsx、chat/settings-drawer.tsx、chat/conversation.tsx；apps/mobile/test/chat-settings.test.cjs、新增 workspace-screen 测试。

**Interfaces:** SettingsDrawer 和 Conversation 接收 `settingsNavigation` / `applicationSettings` ReactNode；沿用 onCloseSettings。

- [x] 补设置导航动作、默认开关、开启后隐藏列表/Tab、新首页头像与模式关闭返回测试，确认失败。
- [x] 复用 Toggle/Row/ProfileAvatar，集中全局与会话设置；所有无 Tab 页面提供返回入口。
- [x] 运行相关 mobile 测试及 typecheck，预期通过。

### Task 3: Profile 手势与完整验证

**Files:** apps/mobile/src/chat/conversation.tsx、profiles/selection.ts、对应测试和 docs。

**Interfaces:** Conversation 的 `onSwitchProfile(direction: -1 | 1)`；滑动左向选择下一项，右向选择上一项，不越界。

- [x] 补方向、边界、单 Profile 和输入状态保护测试，确认失败。
- [x] 通过安装的手势库接入横划，保留头像点击选择及无障碍切换入口。
- [x] 运行 `pnpm typecheck`、`pnpm test`、`pnpm --filter @hermes-mobile/mobile lint`，预期通过；检查可用 UI 运行环境。
- [x] 完成独立代码审查，处理影响正确性的反馈；记录验证结果及真实设备验证边界。

## Execution notes

- 使用现有隔离 worktree 与 codex/infinite-conversation-flow 分支。
- 用户已明确授权开始实现，直接执行，不重复请求实施批准。
- 实现完成后，用户于 2026-11-17 追加授权：合并到 main 并推送。本轮不发布 OTA。
