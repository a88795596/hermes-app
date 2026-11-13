# Hermes 移动端双平台技术设计

2026-11-13 · 设计提案

Hermes 移动端为 iOS 和 Android 提供个人优先的 Hermes 客户端。首个可用版本在两端交付多配置档案、独立话题、可靠聊天、流式与工具状态、审批与澄清、离线恢复。后续在两端验收媒体、系统分享、通知与主动投递、搜索导出、群聊与技能等能力。工作包可以独立开发，产品入口由服务端能力和本机能力共同决定。

实施时配套阅读 [移动端与连接器契约基线](./2026-11-13-hermes-mobile-contracts.md) 和 [并行开发工作包](../plans/2026-11-13-hermes-mobile-parallel-plan.md)。[工程设计规格书 v2](../../reference/hermes-expo-engineering-spec-v2.md) 原文随仓保留，作为业务范围、字段字典和 AT 场景的固定参考。两份新设计中的显式决策优先于 v2 的对应工程建议。公开接口以 W00 产出的结构定义和固定夹具为发布基线。遇到上游运行结果与设计的差异，由契约负责人更新差异记录和测试夹具，再启用对应能力。

## 架构与数据归属

    iOS / Android（Expo Router、每账户 SQLite）
      → HTTPS 写入与查询 / WSS 增量 → Fastify BFF（API + 数据库工作进程）
                                              ├ PostgreSQL（业务、投影、事件流、发件队列）
                                              └ 私有 S3 兼容存储（媒体对象）
      Hermes 主机的 Node 连接器 → 主动出站 WSS ─┘
           ├ 本地 SQLite 队列 / 文件暂存
           ├ 本机票据 → Hermes Canonical Gateway
           └ 读取 Python 投递插件的本地队列

| 候选 | 适用性 |
| --- | --- |
| Expo 直连 Hermes | 组件较少。移动设备需要持有网关身份，设备级撤权、离线事件流和对象授权需要在 Hermes 一侧另外解决。 |
| BFF 调用公网 Hermes HTTP/WS | 手机只持有应用凭据。Hermes 主机仍须对云侧可达，桌面端 HTTP 与本地专用接口会进入公网信任面。 |
| BFF + 主动出站连接器 | 沿用 v2 选型。BFF 管理设备与数据投影，Hermes 主机保留本地票据与文件边界。增加一段可重放传输和本地队列。 |

Hermes 权威保存执行、接纳与会话历史。BFF 权威保存账号、授权、话题、收件箱、已读、回应和移动端投影。应用的 SQLite 是设备内历史、同步位置、草稿和未提交输入的唯一读写来源。连接器本地队列权威保存尚未送达 BFF 的脱敏事件与本地命令进度。React Query 缓存目录和能力，Zustand 管临时交互。BFF 与连接器通过应用契约交互，共享包保持运行环境无关。

运行基线沿用 pnpm 工作区、Expo SDK 58 / RN 0.88、Fastify 5 和 TypeScript。W01 将 Node 最低版本对齐 Expo SDK 58 的 22.13.x，并锁定可复现的双平台工具链。现有根清单声明 Node ≥20.19.0，须在该工作包更新。服务端第一版采用单 BFF 部署、独立工作进程入口、一个后端一个连接器写入器，PostgreSQL 同时承载事务和队列。开发构建支持 SDK 58 的 iOS 16.4+ 与 Android 7+ 基线，实际发布范围按目标机型和原生依赖验证。 [Expo SDK 58 版本矩阵](https://docs.expo.dev/versions/v58.0.0/)

## Hermes 桌面端 API 源码证据

本轮静态参考是用户提供的 `hermes-agent/apps/desktop` 所在的代码检出版本，HEAD 为 `4806965d18c3e61dd8c5e6c396b1f6425dc924ea`。v2 引用的 `3bcd071226d3d605a2bb3b4f3933e7d583e189d6` 不在本地浅克隆对象中。下面的路径均相对于 Hermes 仓库根。目标 Hermes 安装版本、权限与端到端行为由 W01 另行记录。

| 领域 | 本地源码锚点 | 移动端实现 |
| --- | --- | --- |
| 接入和能力 | `hermes_cli/subcommands/gateway.py:133`，`apps/desktop/src/api/canonical-protocol.ts:12`，`apps/desktop/src/api/client.ts:590`，`gateway/session_controls.py:556`，`apps/shared/src/json-rpc-channel.ts:568` | 连接器对正在运行的网关执行 `hermes gateway attach --json`，每次拨号取新票据，使用返回的 URL 和子协议。分别核验标准协议来源、`runtime.describe` 和 `client.capabilities`。生产运行禁用 `--start` 和 `--recover`。 |
| 配置档案和会话创建 | `apps/desktop/src/api/client.ts:645`，`apps/desktop/src/api/canonical-protocol.ts:548`，`gateway/session_policy.py:83`、`:669`，`gateway/session_controls.py:482` | 显式携带已批准的所有者和配置档案。桌面端创建用 `gui`，当前契约无 `mobile`。W01 首选验证上游面向第三方的 `source=tool` 与显式工具白名单。该来源的会话可能对上游选择器隐藏，BFF 用自己的话题目录与绑定按 ID 验证历史和控制。创建使用稳定 `request_id`，标题首先存 BFF，避免 `session.create(title)` 按标题采用已有会话。确需同步标题时用经过验证的写操作。 |
| 绑定与事件恢复 | `apps/desktop/src/api/client.ts:530`，`gateway/session_controls.py:631`、`:777`，`gateway/session_events.py:75`、`:114`，`apps/shared/src/json-rpc-gateway.ts:625` | 写操作先在套接字上完成接入。重连按 `session.events.since` → `session.resume` → 合并实时帧处理。缺口、纪元变更或截断使用快照与历史修复，有限回放只覆盖已保留窗口。 |
| 接纳与执行控制 | `gateway/session_controls.py:239`、`:796`、`:856`、`:901`，`hermes_state_runtime.py:130`，`gateway/session_busy_controls.py:13`，`apps/desktop/src/api/canonical-protocol.ts:684` | 用 `prompt.submit` 原 ID，已知 `admission_id` 才调 `prompt.receipt`。精确重放按认证主体、目标和正文对账。当前标准协议的普通提交 进入同一队列，另有 `voice_stopped` 无接纳分支。停止、替换队列项、插话和变更分别按上游代次和修订版本 与能力判定。 |
| 审批与澄清 | `apps/desktop/src/api/client.ts:41`，`apps/desktop/src/api/canonical-protocol.ts:565`，`gateway/session_server_requests.py:149`、`:171`、`:202` | 标准协议提示使用 `approval.respond` / `clarify.respond`。服务端请求用同 JSON-RPC ID 响应，`request.cancel(reason=resolved)` 只证明请求关闭，载荷不提供被采用的答案。 |
| 历史和桌面端 HTTP | `gateway/session_stored_reads.py:59`，`apps/desktop/src/api/sessions.ts:452`、`:649`，`apps/desktop/src/api/client.ts:686`、`:753`，`apps/desktop/electron/preload.ts:358` | 连接器优先验证 `session.transcript`。桌面端的 HTTP 分页偏移量、Electron IPC、SSH 和浏览器桥不构成移动端 API。移动端历史按稳定 `message_order` 分页，BFF 只向已授权范围返回历史。 |
| 文件与图片 | `gateway/session_ingress_media.py:122`、`:140`，`gateway/session_images.py:8`，`gateway/session_ancillary.py:137`，`apps/desktop/src/lib/browser-uploads.ts:255` | 当前 `prompt.submit.attachments` 接受受限图片 MIME 且路径须在上游指定图片暂存目录。连接器将校验后的对象经受控暂存 RPC 或已验证桥转成上游引用。普通文件另走 `file.attach` 验证受限路径、大小和返回引用。 |
| 定时任务与主动投递 | `apps/desktop/src/api/cron.ts:69`、`:120`，`hermes_cli/plugins_context.py:218`、`:585`，`cron/execution_identity.py:17`，`cron/delivery_queue.py:328` | 桌面端定时任务管理走按配置档案隔离的 HTTP 接口。当前上游有注册平台和获取当前定时任务执行身份的插件 API。W01/W09 需要证明实际队列、直投及附件路径可取得同一稳定投递身份。 |

上游契约读取入口是 `apps/shared/src/gateway-contract.openrpc.json`、`tui_gateway/contracts/` 和相应所有者侧处理函数。共享的 Node 客户端独立于渲染进程（`apps/shared/src/node/gateway-client.ts`）供比较；连接器默认仅实现本项目所需的适配子集。W00 保存上游提交、OpenRPC 摘要、已审查的局部补充结构定义、授权隔离的脱敏测试夹具与测试向量。桌面测试证明的只是其路径，移动端开关由自己的端到端测试推动。

## 模块设计

### 协议包与 Hermes 适配器

`packages/protocol/src/mobile-v1` 拥有 HTTP DTO、事件、错误和同步帧；`connector-v1` 拥有业务命令、事件与投递帧；`common` 拥有 UUID、版本、时间和信封结构定义。协议源同时产出运行时校验和 TS 类型。建议使用 Zod 4，边界统一 `safeParse`，HTTP 只在路由边界解析一次。移动与连接器数据可独立演进。 [Zod 解析与类型推断](https://zod.dev/basics)

`packages/hermes-adapter/src` 拥有 `pinned-contract`、`validators` 与 `normalize`。它校验上游数据，用稳定上游引用映射消息、工具、控制及权限证据。运行时适配不引入 Electron、React Native 或操作系统状态。建立连接、取票、重连、文件与数据库 I/O 由连接器注入。能力记录包含已验证的能力、方法和有效限制。新上游版本以新测试夹具和双端联调升级。

### BFF 身份、授权与运行模型

| 目录 | 设计和交付边界 |
| --- | --- |
| `services/bff/src/auth` | 管理员生成单次高熵授权，应用确认 HTTPS 源地址，兑换事务创建设备记录与凭据族。每设备并发请求共用一次凭据刷新，旧密钥 + 原 `refresh_request_id` 在 60 秒重放窗口取同一加密响应；不同 ID 返回冲突，超窗重用按策略仅撤销该凭据族。应用在 SecureStore 持久凭据包与意图。初始配对丢回执按撤销旧注册、新授权流程处理。 |
| `src/domain`、`src/application/topics`、`src/repositories` | 配置档案列表来自授权目录。话题是稳定逻辑资源，绑定有修订版本且同一时刻只有一条生效。重置或交接时使用新修订版本隔离旧命令。提交和动作入库前重验 ACL、绑定、附件、幂等键与负载哈希。提交事务一起写用户气泡、命令队列与事件流。 |
| `src/connector` | 验证连接器机器身份及后端和配置档案授权。管理员为已批准后端发放高熵机器密钥，BFF 保存其哈希，连接器存于系统秘密存储。凭据轮换和撤销与手机设备体系分开。命令领取、存储确认、结果回传分别持久化。事件按入库 ID、哈希和上游去重键写入。失租后该连接禁止新写命令。旧代次的已持久事件待当前合法身份对账后接收。 |
| `src/sync` | 用户级事件流头部在事务内串行分配序号。快照用一致事务生成不可变页，保留窗口元数据与增量保留标记。收件人/ACL 变化令分页和订阅失效。WS 压力超过限额时提示转 HTTP 补拉，广播仅用于唤醒持久事件流查询。 |
| `src/application/controls` | 先锁事件流头部，后对交互行 CAS。校验交互类型、可选项、截止时间、版本、绑定与代次，生成唯一的响应与命令。敏感交互先检查本应用安全能力和最近认证。对于现阶段需要可信客户端的交互，应用只显示受限状态和处置入口。 |
| `src/media` | 私有分片上传、校验作业和对象引用。短期授权只允许指定分片，服务端核实大小、文件签名、SHA-256 与内容策略后设置为 `ready`。默认用 BFF 授权代理和 Range 读敏感对象，并在撤权时中止已知活跃流。生命周期同时检查引用、待处理提交与执行不明项。 |
| `src/notifications`、`src/workers` | 结果可读或待办有效时同事务写收件箱、事件流和推送任务队列。工作进程短事务领取，事务外发送，随后核对本次发送标识后保存结果。设备注册按提供方、环境、应用 ID 和设备分域。推送负载仅放通用文案、稳定通知 ID 与定位 ID。 |
| `src/application/collaboration` | 搜索只索引可见内容并返回覆盖范围，导出生成可撤权的短期制品。回应设目标状态。引用按稳定消息 ID 解析，受授权且长度受限的摘要以用户输入上下文传给模型。群成员和触发授权单独建模，唯一群消息触发键使一次合法 @ 最多生成一个提交。群内上下文只取该群授权内容。预置按版本管理，生效条件按当前绑定和上游能力复核。 |

路由负责传输与校验，应用服务负责用例和事务，存储层只处理存储。HTTP 路由和工作进程共用同一应用服务。租户内外键带 `account_id`，同一资源跨后端、配置档案和话题的引用带足够复合范围。ACL 读出候选接收者后，按稳定用户 ID 顺序锁事件流头部，复核 ACL，再锁业务行。事务内只执行 DB 操作。终态先于完整投影时记录 `final_pending`，修复完整后发布可读结果。

### 连接器与 Python 投递插件

| 目录 | 设计和交付边界 |
| --- | --- |
| `services/connector/src/transport`、`lease` | 连接器出站注册，TLS 上使用受限机器凭据，短期连接票据按后端绑定。每后端一个本机独占锁和 BFF 租约。到期即停发上游写及控制响应。换主先证明旧实例停止、重新核验认证主体、对账未决命令；云端租约代次只对 BFF 有约束力。 |
| `src/adapter`、`recovery` | 每组后端、配置档案和会话各有一条恢复队列，重新接入、发现能力并验证归属后才恢复分发。上游序号和 `replay_epoch` 与应用事件流独立。合并回放和实时帧缓冲，快照必须覆盖执行状态、待处理交互和历史水位。 |
| `src/spool` | 本机 WAL SQLite 持久化 `commands`、`event_spool`、`session_checkpoints`、`staged_files` 与投递接收进度。持久化后才回 `connector_stored`，发送前记写入状态，等 BFF 确认已持久化后再回收。磁盘不足时暂停新接纳并对外报告降级状态。 |
| `src/staging` | 应用附件 UUID → BFF 限用途授权 → 专用目录下载、校验、原子发布 → 按版本验证的 Hermes 入口。图片通过 `image.attach_bytes` 的实测上限和 MIME 获取上游暂存引用。普通文件验证 `file.attach` 或受限媒体桥，取得可信上下文引用后才交给执行。发送前持久化最终上游参数和引用，重试从该记录恢复。Docker/SSH 工具执行域单独验证可读性。拒绝任意路径、URL、符号链接 和超额载荷。 |
| `src/delivery` 与 `plugins/hermes-mobile-delivery` | 插件注册 Hermes 投递目标，解析受信的配置档案和路由，落盘正文和媒体引用后返回本地接纳。插件独占自己的 SQLite 本地队列。连接器经 Unix 套接字分批拉取并确认，由插件事务更新自身队列。按目标、生产者和稳定投递身份去重；缺源身份时用首次落盘生成的 UUID，标 `delivery_reconciliation=limited`。 |

网关归一化输出只保留移动端必要字段。原生票据绑定同一操作系统用户，W01 验证连接器以经过批准的本机所有者身份取票；BFF 用户和设备授权仍由 BFF 执行。连接器记录可核验的主机/上游认证主体和策略摘要，以保留的提交身份和冻结负载对账。定时任务投递失败只补投递。源身份不足时保留同文多次合法发送，并把接收前崩溃和跨上游重调的边界暴露给诊断。上游需要变更时单独形成提案。

### Expo 应用

| 目录 | 设计和交付边界 |
| --- | --- |
| `apps/mobile/src/app` | 路由入口 `pair.tsx`、`(tabs)/sessions.tsx`、`(tabs)/controls.tsx`、`(tabs)/inbox.tsx`、`(tabs)/settings.tsx`、`chat/[topicId].tsx`、`topics/[topicId]/settings.tsx`、`compose/media.tsx`、`share/import.tsx`。每个页面由授权目录和本地记录解析完整作用域；后台事件只更新本地投影。 |
| `src/auth`、`src/db` | W02 负责双端配对 UI、凭据保存、刷新和会话恢复，W04 负责解锁账户库与文件目录。认证和数据库解锁分别报告状态。数据库用独立写入器、WAL 和外键。同步写入、游标、草稿与发件队列在单事务内完成。生产构建检查 SQLCipher 的 `cipher_version` 并证明错钥无法打开。密钥丢失后展示不可恢复草稿的影响，由显式恢复流程重建。 |
| `src/sync`、`src/outbox` | SyncEngine 是事件流唯一消费者。先暂存快照全页，原子切换代次，保留草稿、上传与发件队列；再补 HTTP 和订阅。出站先持久原 ID、冻结负载和哈希 和草稿版本，拿到确认后再合并气泡。断网/后台恢复分开显示传输、同步和后端状态。 |
| `src/chat`、`src/controls` | HistoryRepository 提供窗口化历史和稳定消息键。流式以块增量更新，距底部较远时保留锚点。Markdown 禁原始 HTML、未受信外链和自动加载远程图片。审批选择来自服务端，支持逐题/跳过、多设备冲突、失效刷新。离线审批可保存草稿，联网后重查并要求用户确认。 |
| `src/media`、`src/share` | 原音保存在应用持久目录，文件落地后登记草稿，启动扫描修复半完成记录。上传可查询缺片并续传，STT 结果与原音独立，TTS 结果为附件。分享入库仅创建草稿，主应用鉴权后选择作用域并提交。导出走系统分享面板。联系人/位置采用单次选择、最小字段与用户确认。 |
| `src/notifications` | 监听与初始通知响应先写同一设备私有的小型待解析队列，只含定位 ID 和过期时间。按 `notification_id+action` 去重，绑定并复核账户、目标权限、收件箱与交互状态，等路由就绪后才导航，消费记录进账户库。撤权时清理对应待处理项。拒绝通知时仍可同步收件箱。 |

### iOS 与 Android 原生实现

| 能力 | iOS | Android |
| --- | --- | --- |
| 构建 | SDK 58 开发构建，预览与生产分别签名，验证权限配置。 | 同一 Expo 工程生成 Android 开发构建，按渠道管理签名、applicationId 与 SDK。 |
| 系统分享接收 | Swift 分享扩展通过App Group 持久写清单和暂存文件；用户回到主应用时读取。主应用是唯一持有 Hermes 移动端会话的进程。 | Kotlin 意图桥接处理 `ACTION_SEND` / `ACTION_SEND_MULTIPLE`，在授权有效时复制 `content://` 数据到私有目录，验证类型、数量和大小。 |
| 推送 | 首轮建议 Expo 推送 → APNs，记录 APNs 环境。生产若网络验收要求可切直连 APNs。 | 有 GMS 首轮建议 Expo 推送 → FCM。无 GMS 保持聊天与收件箱，根据实际机型引入厂商 SDK，未验证设备明确后台提醒不可用。 |
| 权限和媒体 | 文档/照片选择、录音、麦克风权限和 VoiceOver。冷启动先恢复授权再处理深链接。 | Android 通知通道、权限请求和令牌轮换；区分系统回收、从最近任务划走与强行停止。验收照片/文件选择、录音、TalkBack 和 Android 系统返回。 |
| 本地保护 | SecureStore + 实测 SQLCipher，App Group 分享暂存单独验证文件保护与回收。 | SecureStore + 实测 SQLCipher，验证应用私有目录、设备备份恢复后的密钥行为与缓存清理。 |

原生桥在 `apps/mobile/modules/share-in` 和按机型添加的 `modules/vendor-push`，配置统一由 `apps/mobile/plugins` 和应用配置负责人管理。iOS 分享扩展写入原子清单后结束，无需强制启动宿主。系统推送是低延迟提醒，后台挂起或强停时用下次启动从收件箱补齐。原生改动升 `runtimeVersion` 并重建两个平台。每个平台分别保存设备、操作系统、网络、构建 ID 与证据，模拟器覆盖 UI，真机覆盖系统能力。 [Expo 开发构建](https://docs.expo.dev/develop/development-builds/introduction/) · [Expo SDK 58 通知](https://docs.expo.dev/versions/v58.0.0/sdk/notifications/) · [Expo SDK 58 SQLite](https://docs.expo.dev/versions/v58.0.0/sdk/sqlite/) · [Apple App Groups](https://developer.apple.com/documentation/xcode/configuring-app-groups) · [Android 接收分享](https://developer.android.com/develop/ui/compose/sharing/receive) · [FCM Android 要求](https://firebase.google.com/docs/cloud-messaging/android/get-started)

### 部署、运维和证据

`deploy/` 提供 同一版本的 BFF API 和工作进程各自入口、私网 PostgreSQL、私有存储桶、TLS 反向代理、严格日志与 WS 升级配置。连接器用受控服务账号运行在 Hermes 主机，限制数据目录权限与磁盘配额。后台出站需要分别验证手机到 BFF、手机到媒体服务、推送通道与 Hermes 到模型/工具的网络。密钥采用部署密钥存储。诊断只返回脱敏版本、状态和请求 ID；日志禁止票据、原始命令结果和个人内容。

`runbooks/` 覆盖 DB/对象备份与恢复、撤权、上游兼容、连接器停写与交接、逐个迁移定时任务、发布和回滚。恢复顺序为停写、恢复与验证、切换鉴权和事件流纪元、对账未决、证明旧写入器已退出、恢复写入。数据库采用先扩展、后收缩的迁移方式，应用原生运行时、协议与上游适配器分别版本化。监控覆盖 API 接纳、事件流延迟、本地队列磁盘使用量、`unknown`、`final_pending` 与提供方发送尝试，记录实际设备打开与读取状态。

## 依赖真实环境的决策

| 决策 | 本方案默认 | 启用或签收条件 |
| --- | --- | --- |
| iOS / Android 内测 | 首轮各一台真机，Android 验证有 GMS；按目标用户补无 GMS | W01 记录机型、网络、签名与安装渠道，选择实际需要覆盖的厂商。 |
| Hermes 创建与工具 | 首选试验 `source=tool`，逐配置档案验证；创建标题保存在 BFF | 安全预置、历史、两类控制、压缩与所有者身份在重连时复核均有证据后才启用新建话题。 |
| 高风险交互 | 引导到已授权可信客户端；单独的移动安全表面视范围确认 | 生产支持安全输入或验收方接受有证据的等价接力路径，才能签收相应能力。 |
| 定时任务投递身份 | 可证明稳定身份时按执行和投递粒度去重；其他路径标记为 `limited` | 用同一执行重试、多片/多目标、同文独立执行与插件崩溃证明身份粒度和持久接纳。 |
| 正式分发和生产网络 | 先内部开发构建或预览构建；数据库和对象服务地区以双端实测选择 | 使用真实个人内容前完成 SQLCipher、授权和备份恢复；切换定时任务投递目标按 W12 单项确认。 |
