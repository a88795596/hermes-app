# Profile 消息流跟手分页

**目标：** 使用已安装的 `@expo/ui/community/pager-view` 实现仅中间消息流区域的跟手分页。滑动落定后顶部渐变切换。底部输入栏固定，切换后重置焦点和高度、收起键盘，各 Profile 的文字和附件草稿保留。

**实现：** 单一 useWorkspace 保持同步所有权，保留各 Profile 的会话映射和详情缓存；相邻页只预读已有会话，不创建远端 session。提取现有消息流组件，保留消息、审批、附件、通知定位与滚动状态。固定输入栏继续由 Conversation 管理。原生使用 Expo UI，Web 使用分页 ScrollView。

**范围：** 不新增依赖、不改变默认关闭、不删除草稿或历史。不发布 OTA。

## Task 1：多页数据

- [x] 为相邻页缓存读取、无额外创建、Profile 数据隔离添加失败回归测试。
- [x] 维护按 topic ID 的详情与按 Profile 的会话映射，预读已有相邻页。
- [x] 运行 message-outbox 回归测试。

## Task 2：分页与固定输入栏

- [x] 添加分页完成后才提交选择、程序切换、禁用与边界测试。
- [x] 提取消息流，接入 Expo UI PagerView 与 Web 替代实现；输入栏保持在分页容器外。
- [x] 顶部落页后渐变，Profile 切换重置输入框与焦点，保留草稿；保护表格横滚。
- [x] 更新消息定位、设置、录音与 UI 测试，运行相关回归。

## Task 3：验证

- [x] 运行 pnpm typecheck、pnpm test、mobile lint。
- [x] 检查可用原生验证环境，验证跟手拖动与上下栏固定；记录设备限制。
- [x] 按 executing-plans 技能执行一次独立最终审查并处理实质问题。

## Review Focus

多页数据不能串 Profile；预读不能创建远端 session；拖动取消不更换 Profile；只有落页时变更顶部和输入；录音/菜单不误切；表格横滚与消息纵滚不翻页；通知定位、待发队列和归档恢复保持原行为。

## 执行决定

- 用户明确选择 Expo UI 并补充交互，直接实施，不再请求方案确认。
- 复用现有 Codex worktree，分支 codex/profile-pager，基于 586003d。
- 使用 writing-plans / executing-plans 流程，先回归测试再改实现。

## 验证结果

- `pnpm typecheck`、`pnpm --filter @hermes-mobile/mobile lint` 均通过。
- `pnpm test`：406 通过、13 个依赖数据库的用例跳过；其中 Mobile 254 通过。
- iOS 18.6「Hermes Mobile QA」模拟器：重新构建当前开发客户端成功；验证中间消息区跟手移动、落页后顶部切换、取消短拖、表格横滚、纵向拖动不切 Profile、头像跨页选择、切回保留多行草稿并收起键盘和恢复输入高度。
- 一次独立审查发现的程序切页被打断、旧 iOS 无落页事件、Web 按住半页误提交均已用回归测试复现并修复；没有遗留审查问题。
- iOS 18+ 与 Android 使用 Expo UI；iOS 16.4/17 与 Web 复用系统 ScrollView 分页，并在松手及页面对齐后提交选择。保持现有最低系统版本，不新增依赖。
- Android 和 iOS 16.4/17 未进行设备交互验收；旧系统分支与触摸停顿行为由自动化回归覆盖。
- 本次仅本地分支实现与验证，没有合并 main、push 或发布 OTA。
