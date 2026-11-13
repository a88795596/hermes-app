# Hermes Mobile Implementation Plan

> **For agentic workers:** Use the assigned work package, its contract fixtures, and its acceptance cases. Use superpowers:subagent-driven-development or superpowers:executing-plans when implementing the package.

**Goal** — 让多个 agent 在独立工作区并行实现和验收 Hermes Mobile 的 iOS、Android、BFF、Connector 与主动投递能力。

**Architecture** — App 通过独立 Mobile API 写入，通过持久 feed 同步。Connector 主动出站，隔离 Hermes canonical Gateway、本地 staging 和投递插件。

**Tech Stack** — pnpm、TypeScript、Expo SDK 58、React Native 0.88、Fastify 5、PostgreSQL、S3 兼容存储、SQLite 与 Python。

**Spec** — [双平台技术设计](../specs/2026-11-13-hermes-mobile-design.md) · [Mobile 与 Connector 契约基线](../specs/2026-11-13-hermes-mobile-contracts.md) · [v2 验收用例原文 AT-01–30](../../reference/hermes-expo-engineering-spec-v2.md#182-必测用例)。

## 全局约束

- iOS 与 Android 同阶段交付核心功能并提交各自真机证据。无 GMS 通知能力单独验收。
- `packages/protocol` 维护对外 DTO/schema，`packages/hermes-adapter` 维护固定 Hermes 版本的上游输入。App 只消费 Mobile 契约。
- Hermes host 票据、文件路径和主机权限留在 Connector。HTTPS/WSS、SQLite durable ACK、租户复合外键、同业务 ID 的重试是跨模块约束。
- 先验证失败用例再实现，真实 PostgreSQL、SQLite、对象存储、隔离 Hermes 和真机按表验收。夹具联调与真实联调分别记录。
- 设计交接起点是现有 pnpm 骨架。现有命令为 `pnpm typecheck` 和 `pnpm test`，其中现有自动测试是 BFF health。各工作包随实现增加所列测试入口并验证根命令能发现它们。

## 可并行依赖

| 开工条件 | 能并行开工 | 合入条件 |
| --- | --- | --- |
| 设计审阅后 | **W00 契约**；**W01** 准备双端开发构建、隔离 Hermes 与最小原生验证 | W00-core 先发布；W01 真实链路使用发布的核心 DTO 和测试端口。 |
| W00-core | **W02 BFF 身份与 Topic**、**W03 Connector**、**W04 feed**、**W05 App/聊天**、**W06 控制** 分别按 fixtures 实现 | W02/W03 接真实授信与绑定；W04 接 W02 权限及 W05 投影；W05 接 W02/W03/W04；W06 接 W03/W04 真实控制。 |
| W00 对应领域契约 + W01 该项探测 | **W07 媒体**、**W08 Inbox/通知**、**W09 投递**、**W10 协作/分享** 可按已定端口独立开发 | W07 接 W02/W03；W08 接 W02/W04；W09 接 W03/W08；W10 接 W05/W06/W07 和 W02 成员权限。 |
| 前述模块集成 | **W11 发布与恢复** | Gate C 覆盖项与恢复演练全部有证据。 |
| W11 | **W12 验收和迁移** | Gate D 与单 job canary 通过后按授权切换。 |

W00-core 最小冻结面包括 Auth、Profile/Capability、Topic/Binding、Submission、Message/Tool、Control、Feed、Connector Command/Ack/Result 和测试用 provider port。扩展领域各自提交增量 fixtures；只在相关 schema 被 W00 发布后开始真实接口联调。W01 用隔离验证 harness/fixture transport 确认上游和原生关键路径，与正式服务的功能集成在各工作包验收。功能团队可在基线之上使用夹具开发，生产入口按实测 capability 启用。

### 文件所有权与交接

| 共享面 | 唯一写入者 | 其他 agent 的交接方式 |
| --- | --- | --- |
| `packages/protocol` exports、schema、fixtures | W00 | 提交兼容性说明、输入/输出、错误和回归向量，owner 合入后更新消费者。 |
| `packages/hermes-adapter` 及 pinned 上游输入 | W03 | W01/W06/W07/W09 提供脱敏最小 trace，W03 统一加解析与 capability 检查。 |
| `services/bff/migrations` 编号与 `src/app.ts` 组合入口 | W02，之后交给集成 owner | 各域在工作包中提供迁移草稿和应用入口 diff；先发布基表/外键，再排迁移顺序与路由注册。 |
| `apps/mobile/src/db` 迁移序列和 writer | W04 | 各域提供 SQL、最小迁移与事务用例；集成经同一 writer。 |
| App 根布局、`app.json`、config plugins、原生模块注册 | W01 构建 owner | 路由在各域目录实现；组合、entitlement、manifest 和 native dependency 由构建 owner 合入。 |
| 根依赖与锁文件 | 集成 owner | 工作包声明最小依赖改动，集成时集中更新 lockfile。 |
| `tests/contracts`、`tests/integration`、`tests/faults` 与环境 | 集成 owner 协调，各 AT 有主 owner | 使用分配的独立 profile/schema/bucket 前缀；发布固定输入、命令和报告。 |

分支由集成 owner 从同一已审阅的初始化基线分出，每个 agent 在独立工作区只改其授权目录。新增路由按 feature 划分。共用文件变更交对应 owner 串行合入。跨模块 API 变化先更新契约和兼容向量，再更新消费者。每包交接包含产物路径、契约/fixture 版本、复现命令、测试输出及仍阻塞的 capability。

每包使用 v2 §18.2 的 AT 场景作为测试输入与通过标准。按其建议路径或本仓库已用的同域路径落测试。纯 TS 与 service 测试接入各包 `test` 并由根 `pnpm test` 发现。真实依赖测试和双平台真机脚本随工作包发布，记录所需依赖、命令和退出条件。W09 独立在 Python 项目提供 `python -m unittest discover -s tests` 入口，集成报告单列结果。

## 工作包

### W00 公开契约和夹具

写入 `packages/protocol/src/{common,mobile-v1,connector-v1}`、`packages/protocol/fixtures`、`tests/contracts` 和 `docs/adr`。接收本设计、v2 字段表和 pin 版上游差异；发布运行时 schema、TS 导出、版本化 fixtures 及兼容矩阵。其它 agent 以这些公共类型和夹具联调。

- [ ] 先加入拒绝用例：跨 scope、同 ID 不同内容、无法表示的上游整数、未知关键事件和非法 UTF-16 边界。用 TS/Python 校验相同 JCS+SHA-256 向量。
- [ ] 锁定 core schema、错误码和状态迁移，写兼容规则及版本变更条目。发布两个传输的健康主链路样本和每个域的有效/无效输入。
- [ ] 验收 `pnpm --filter @hermes-mobile/protocol test` 通过，固定样本可被 BFF、Connector、App 复用。该命令随本包实现。

### W01 双平台构建和上游可行性

写入 `apps/mobile/app.json`、`apps/mobile/plugins` 构建组合、`apps/mobile/tests/mobile`、`docs/release-evidence/w01.md`；独立验证 harness 使用合成数据和隔离 Hermes。交付 iOS 与 Android 的 development build 及能力矩阵，W03/W06/W07/W08/W09 消费证据。

- [ ] 对齐 Node 基线并记录 iOS/Android 构建参数。用隔离 harness 在两端探测配对票据往返、流式帧和重连、通知点击、图片、SQLCipher 及分享 manifest 交接。正式配对、离线恢复、通知导航和草稿由其工作包在集成后各自提交真机证据。
- [ ] 隔离 Gateway 验证同身份重复 create/submit、相同标题不同 Topic、发送回执丢失、历史身份、两个 Profile、两路控制、图片 MIME/容量、文件引用、Cron 独立投递。
- [ ] 证据记录 build ID、OS、机型、实际网络、Hermes commit、能力和 fixture 版本。产物标注通过、失败或缺条件。无 GMS 尚无指定机型时保留厂商验证项，聊天和 Inbox 仍有验收路径。

### W02 BFF 配对、授权与 Topic

写入 `services/bff/src/auth`、`application/topics`、`repositories`、`migrations`、`apps/mobile/src/auth`、`apps/mobile/src/app/pair.tsx`。消费 W00 auth/topic schema，向 W03–W10 提供 `resolvePrincipal`、`authorizeScope`、`resolveActiveBinding`、设备撤销信号和 Topic 创建事务。向 W04 提供已验证的 account 与设备会话状态，由 W04 根据账户库密钥和策略解锁或锁定数据库。

- [ ] 真实 PostgreSQL 写 AT-01/04/18/19，覆盖复合 FK、同名 Profile、提交幂等、refresh 竞态/丢回执及 revoke。
- [ ] 实现账号/设备迁移、配对、refresh、授权目录与 creating→ready 的绑定事务。双端实现 origin 确认、SecureStore 会话包与刷新意图、single-flight、撤权与注销，接入 W04 账户库状态。初始资料和机器授信经管理员路径处理。
- [ ] 验收同主体重放得到同收据，撤权后旧 WS、旧凭据与新下载请求被拦截。W04/W07 对接后重跑跨模块撤权测试。

### W03 Connector、BFF Connector 端与 Hermes Adapter

写入 `services/connector/src/{transport,adapter,spool,recovery,lease,policy}`、`services/bff/src/connector`、`packages/hermes-adapter`。消费 W00 wire、W02 绑定和 W01 上游证据。发布 command/ingest 端口和经过验证的 Connector 能力。

- [ ] 写 AT-05/06/16/17，覆盖命令发送窗口、principal 变化、取消竞态、双实例失租，加入同标题 create 和未知上游状态向量。
- [ ] 实现出站握手、租约、本机锁、durable ACK、重放与快照、显式 Profile 路由、staging port、只读对账与 fail-closed capability。
- [ ] 验收崩溃重启后原 command/submission 不重复执行，旧 owner 未退出时禁止自动转移写入。用隔离 Gateway 重跑。

### W04 提交有序的 Feed、Snapshot 与设备同步

写入 `services/bff/src/sync`、`apps/mobile/src/{sync,db}`、跨端 sync tests。消费 W00 event/WS、W02 ACL 和各域投影记录。发布 `appendFeed` 事务端口、opaque cursor、snapshot/pin、`SyncEngine`、单 writer 与只读历史端口。

- [ ] 写 AT-07/08/09/10/12，覆盖事务提交倒序、snapshot 分页撤权和清理竞态、设备强杀、重启修复。
- [ ] 实现 DB head 锁、commit-ordered feed、保留 pin、HTTP/WS 交接和原子 generation 切换。
- [ ] 验收设备断线后从最后 durable cursor 恢复，游标进度与已读独立，staging 快照崩溃后草稿仍在。

### W05 双平台聊天、提交和会话动作

写入 `services/bff/src/application/chat`、`apps/mobile/src/{chat,outbox}`、聊天与会话 routes。消费 W00 DTO、W02 授权、W03 命令、W04 历史与 writer，发布 `SubmissionService`、消息/工具投影及动作收据。

- [ ] 写 AT-02/03/10/11，验证多个 Topic、接纳 ACK 丢失、draft version、emoji/重复 interim/迟到 delta。
- [ ] 实现列表/聊天、冻结草稿、提交出站队列、流式 Markdown/工具块、状态提示、命令菜单和受 capability 约束的会话控制。
- [ ] 验收双端网络恢复后保持原发送身份与本地顺序，工具/最终内容可核对，页面切换不停止执行。

### W06 两路审批和澄清

写入 `services/bff/src/application/controls`、`apps/mobile/src/controls` 和 controls route。消费 W03 两路上游 adapter 和 W04 feed，发布控制卡、响应收据和对账入口。

- [ ] 写 AT-13/14/15，模拟两设备相反选择、响应写出后断线、已过期与 generation 变化。
- [ ] 实现单次 claim CAS、逐题/跳过与完整提交、关闭但归因不明，以及可信客户端处置入口。
- [ ] 验收 202 时 UI 为 responding，只有上游证据才能显示答案被采用，过期动作无法进入新运行。

### W07 媒体、语音与暂存

写入 `services/bff/src/media`、`services/connector/src/staging`、`apps/mobile/src/media` 和媒体 migrations 草稿。消费 W02 授权、W03 session/staging port、W04 writer 和 W01 平台/上游上限。

- [ ] 写 AT-20/21，覆盖分片中断、伪 MIME、路径穿越/symlink、跨 Profile、错授权、录音崩溃和 STT 失败。
- [ ] 实现 multipart、校验和 GC、授权 Range、可信 Hermes 引用、原音持久、STT/TTS 与重试。
- [ ] 验收真实对象存储及 Hermes 工具可读；双端分享出、原音恢复和音视频播放分别提交结果。

### W08 Inbox、已读和 Push

写入 `services/bff/src/notifications`、`apps/mobile/src/notifications`、通知 worker 与原生 provider 实现。消费 W02 鉴权、W04 feed、W05 final 状态和 W01 真机通道结论。

- [ ] 写 AT-23/24/26，覆盖冷启动监听竞态、Push 失败与结果可读、权限拒绝/强停/GMS 差异。
- [ ] 实现持久 Inbox、单调已读、设备 token 注册/轮换、outbox 和 provider receipts。
- [ ] 验收 iOS APNs 链、Android FCM 链和所需厂商通道各自证据，push provider 接纳与设备收到分别统计。

### W09 主动投递插件与 Connector 转发

写入 `plugins/hermes-mobile-delivery`、`services/connector/src/delivery`。消费 W03 transport/spool、W08 Inbox port 和 W01 插件探测。发布稳定 delivery 接纳收据。

- [ ] 写 AT-25，验证插件持久化前后崩溃、未知上游身份、同文两次、同执行多产物和重试。
- [ ] 实现受控目标映射、插件 spool/Connector 本机 ACK、BFF 幂等入 Inbox 与可观察的 limited 分支。
- [ ] 验收未打开 Topic 仍能收到主动结果，恢复只补投递，未知投递保留可对账状态。

### W10 系统分享、协作与剩余交互

写入 `apps/mobile/modules/share-in`、`apps/mobile/src/share`、`services/bff/src/application/collaboration`、相关 routes 和 migrations 草稿。消费 W02 ACL、W05 聊天、W06 控制、W07 媒体。

- [ ] 写 AT-22/27/29，覆盖冷启动/多文件/URI 过期、@ 重放与成员移除、双端读屏和大字体。
- [ ] 实现安全分享入/出、联系人/位置、引用/回应、搜索/导出、GIF/贴纸降级、群聊与 preset。入口使用服务端 capability，群数据有独立授权。
- [ ] 验收同一 @ 只发一次、离线撤权后重连清理缓存、导出复核权限、分享未经确认只存在草稿。

### W11 部署、可靠性和安全回归

写入 `deploy`、`runbooks`、可观测性与恢复演练。消费已集成服务和双端构建。产出复现环境、备份验证、告警与回滚手册。

- [ ] 写 AT-28/30，模拟从备份恢复时仍有未结命令、权威终态先于历史投影。
- [ ] 验证 TLS、秘密与日志隔离、对象和 DB 恢复、配额、通知回收、数据库升级/回滚、连接转移和性能。
- [ ] 按 v2 目标测接纳 p95 ≤500 ms、上游文字到可见 p95 ≤300 ms、本地万条历史首屏 p95 ≤1 s、≤1000 事件的常规网络十秒恢复。报告基准机、网络和瓶颈。

### W12 功能签收和按项迁移

写入 `docs/release-evidence` 与迁移清单。消费 W01–W11 真实报告，交付每项能力的实现进度和实际可用性。

- [ ] 对照验收表逐项核对两端及必需后端环境，区分已通过、缺证据、失败和设备受限。安全交互、无 GMS 和 Cron limited 作为各自能力的签收条件。
- [ ] 演练单个 Cron job 的双路结果对账、回滚及用户确认后的切换。按可归因投递证据推进。
- [ ] 产品签收使用功能、失败测试、构建与运行证据，核心发布和全量替代各有状态。

## 验收责任

| 用例 | 主 owner | 验证点 |
| --- | --- | --- |
| AT-01、04、18、19 | W02 | 租户隔离、幂等冲突、refresh 丢响应/并发/重启、撤权。W04/W07/W08 联责 AT-19。 |
| AT-05、06、16、17 | W03 | admission 崩溃窗口、principal 改变、取消竞态、双 writer。 |
| AT-07、08、09、12 | W04 | feed 提交序、snapshot 切面/清理、持久 repair。 |
| AT-02、03、10、11 | W05 | 多 Topic、HTTP ACK 丢失、设备 DB 强杀/满盘、delta 边界。W04 联责 AT-10/11。 |
| AT-13、14、15 | W06 | 相反答案抢占、响应无回执、代次/过期围栏。 |
| AT-20、21 | W07 | 对象/文件授权与恢复、原音/STT 故障。 |
| AT-23、24、26 | W08 | 冷启动、Push 失败与持久结果、设备通道矩阵。 |
| AT-25 | W09 | 主动投递的去重和 limited 场景。 |
| AT-22、27、29 | W10 | 系统分享、群消息触发和成员撤权、无障碍。 |
| AT-28、30 | W11 | 恢复后先对账、final_pending 修复。 |

集成 owner 在每项报告记录主/协作 owner、复现命令、fixture 版本、双端适用性、运行环境、证据链接与结论。Gate A 需要 iOS/Android 真机和隔离 Hermes 的关键路径证据。Gate B 签收双端核心聊天、控制及恢复。Gate C 签收完整功能矩阵和目标厂商设备范围。Gate D 签收生产网络、撤权、恢复、回滚及迁移授权。

## Review Focus

- 带相同标题的两个独立 Topic 应建立不同 Hermes 绑定，旧 create 回执丢失则同 request 恢复原绑定。W03 加隔离回归。
- 无 admission_id 的恢复窗口必须校验 principal/绑定/负载和期限，超窗保持 unknown。W03 纳入 AT-05/06。
- WebSocket ACK 之后重启能读到已应用状态，撤权不能继续下载旧 snapshot。W04 与 W02 纳入 AT-08/10/19。
- 另一客户端或 timeout 关闭 server-request 时，本设备未获答案采用证据，应展示结束且结果不明。W06 纳入 AT-14。
- 上游 staging 只允许实测 MIME/目录，App OS 提供的临时 URI 只在本机打开。W07/W10 纳入 AT-20/22。
- 同一 Cron 执行多次合法投递和两次同文运行必须保留各自结果。W09 纳入 AT-25。
