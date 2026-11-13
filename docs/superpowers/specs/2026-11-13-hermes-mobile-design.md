# Hermes Mobile 双平台技术设计

2026-11-13 · 设计提案

Hermes Mobile 为 iOS 和 Android 提供个人优先的 Hermes 客户端。首个可用版本在两端交付多 Profile、独立 Topic、可靠聊天、流式与工具状态、审批与澄清、离线恢复。后续在两端验收媒体、系统分享、通知与主动投递、搜索导出、群聊与技能等能力。工作包可以独立开发，产品入口由服务端能力和本机能力共同决定。

实施时配套阅读 [Mobile 与 Connector 契约基线](./2026-11-13-hermes-mobile-contracts.md) 和 [并行开发工作包](../plans/2026-11-13-hermes-mobile-parallel-plan.md)。[工程设计规格书 v2](../../reference/hermes-expo-engineering-spec-v2.md) 原文随仓保留，作为业务范围、字段字典和 AT 场景的固定参考。两份新设计中的显式决策优先于 v2 的对应工程建议。公开接口以 W00 产出的 schema 和固定夹具为发布基线。遇到上游运行结果与设计的差异，由契约 owner 更新差异记录和 fixture，再启用对应能力。

## 架构与数据归属

    iOS / Android（Expo Router、每账户 SQLite）
      → HTTPS 写入与查询 / WSS 增量 → Fastify BFF（API + DB workers）
                                              ├ PostgreSQL（业务、投影、feed、outbox）
                                              └ 私有 S3 兼容存储（媒体对象）
      Hermes 主机的 Node Connector → 主动出站 WSS ─┘
           ├ 本机 SQLite spool / 文件暂存
           ├ 本机票据 → Hermes canonical Gateway
           └ 读取 Python 投递插件的本地 spool

| 候选 | 适用性 |
| --- | --- |
| Expo 直连 Hermes | 组件较少。移动设备需要持有 Gateway 身份，设备级撤权、离线 feed 和对象授权需要在 Hermes 一侧另外解决。 |
| BFF 调用公网 Hermes HTTP/WS | 手机只持有应用凭据。Hermes 主机仍须对云侧可达，Desktop HTTP 与本地专用接口会进入公网信任面。 |
| BFF + 主动出站 Connector | 沿用 v2 选型。BFF 管理设备与数据投影，Hermes 主机保留本地票据与文件边界。增加一段可重放传输和本机 spool。 |

Hermes 权威保存执行、admission 与会话历史。BFF 权威保存账号、授权、Topic、Inbox、已读、回应和移动端投影。App 的 SQLite 是设备内历史、同步位置、草稿和未提交输入的唯一读写来源。Connector spool 权威保存尚未送达 BFF 的脱敏事件与本地命令进度。React Query 缓存目录和 capabilities，Zustand 管临时交互。BFF 与 Connector 通过应用契约交互，共享包保持运行环境无关。

运行基线沿用 pnpm workspace、Expo SDK 58 / RN 0.88、Fastify 5 和 TypeScript。W01 将 Node 最低版本对齐 Expo SDK 58 的 22.13.x，并锁定可复现的双平台工具链。现有根 manifest 声明 Node ≥20.19.0，须在该工作包更新。服务端第一版采用单 BFF 部署、独立 worker 入口、一个 backend 一个 Connector writer，PostgreSQL 同时承载事务和队列。开发构建支持 SDK 58 的 iOS 16.4+ 与 Android 7+ 基线，实际发布范围按目标机型和原生依赖验证。 [Expo SDK 58 版本矩阵](https://docs.expo.dev/versions/v58.0.0/)

## Hermes Desktop API 源码证据

本轮静态参考是用户提供的 `hermes-agent/apps/desktop` 所属 checkout，HEAD 为 `4806965d18c3e61dd8c5e6c396b1f6425dc924ea`。v2 引用的 `3bcd071226d3d605a2bb3b4f3933e7d583e189d6` 不在本地浅克隆对象中。下面的路径均相对于 Hermes 仓库根。目标 Hermes 安装版本、权限与端到端行为由 W01 另行记录。

| 领域 | 本地源码锚点 | Mobile 实现 |
| --- | --- | --- |
| 接入和能力 | `hermes_cli/subcommands/gateway.py:133`，`apps/desktop/src/api/canonical-protocol.ts:12`，`apps/desktop/src/api/client.ts:590`，`gateway/session_controls.py:556`，`apps/shared/src/json-rpc-channel.ts:568` | Connector 对已运行 owner 执行 `hermes gateway attach --json`，每次拨号取新票据，使用返回的 URL 和子协议。分别核验 canonical provenance、`runtime.describe` 和 `client.capabilities`。生产运行禁用 `--start` 和 `--recover`。 |
| Profile 和会话创建 | `apps/desktop/src/api/client.ts:645`，`apps/desktop/src/api/canonical-protocol.ts:548`，`gateway/session_policy.py:83`、`:669`，`gateway/session_controls.py:482` | 显式携带已批准的 owner/Profile。Desktop 创建用 `gui`，当前契约无 `mobile`。W01 首选验证上游面向第三方的 `source=tool` 与显式工具白名单。该来源的会话可能对上游选择器隐藏，BFF 用自己的 Topic 目录与绑定按 ID 验证历史和控制。创建使用稳定 `request_id`，标题首先存 BFF，避免 `session.create(title)` 按标题采用已有会话。确需同步标题时用已验证的 mutation。 |
| 绑定与事件恢复 | `apps/desktop/src/api/client.ts:530`，`gateway/session_controls.py:631`、`:777`，`gateway/session_events.py:75`、`:114`，`apps/shared/src/json-rpc-gateway.ts:625` | 写操作在实际 socket 上先 attach。重连按 `session.events.since` → `session.resume` → 合并实时帧处理。缺口、epoch 变更或截断使用快照与历史修复，有限回放只覆盖已保留窗口。 |
| 接纳与执行控制 | `gateway/session_controls.py:239`、`:796`、`:856`、`:901`，`hermes_state_runtime.py:130`，`gateway/session_busy_controls.py:13`，`apps/desktop/src/api/canonical-protocol.ts:684` | 用 `prompt.submit` 原 ID，已知 `admission_id` 才调 `prompt.receipt`。精确重放按 principal、目标和正文对账。当前 Canonical 普通 submit 进入同一队列，另有 `voice_stopped` 无接纳分支。停止、替换队列项、插话和变更分别按上游 generation/revision 与能力判定。 |
| 审批与澄清 | `apps/desktop/src/api/client.ts:41`，`apps/desktop/src/api/canonical-protocol.ts:565`，`gateway/session_server_requests.py:149`、`:171`、`:202` | Canonical prompt 走 `approval.respond` / `clarify.respond`。Server request 用同 JSON-RPC ID 响应，`request.cancel(reason=resolved)` 只证明请求关闭，载荷不提供被采用的答案。 |
| 历史和 Desktop HTTP | `gateway/session_stored_reads.py:59`，`apps/desktop/src/api/sessions.ts:452`、`:649`，`apps/desktop/src/api/client.ts:686`、`:753`，`apps/desktop/electron/preload.ts:358` | Connector 优先验证 `session.transcript`。Desktop 的 HTTP offset、Electron IPC、SSH 和浏览器桥不构成 Mobile API。Mobile 历史按稳定 `message_order` 分页，BFF 只向已授权范围返回历史。 |
| 文件与图片 | `gateway/session_ingress_media.py:122`、`:140`，`gateway/session_images.py:8`，`gateway/session_ancillary.py:137`，`apps/desktop/src/lib/browser-uploads.ts:255` | 当前 `prompt.submit.attachments` 接受受限图片 MIME 且路径须在上游指定图片 staging 目录。Connector 将校验后的对象经受控 staging RPC 或已验证桥转成上游引用。普通文件另走 `file.attach` 验证受限路径、大小和返回引用。 |
| Cron 与主动投递 | `apps/desktop/src/api/cron.ts:69`、`:120`，`hermes_cli/plugins_context.py:218`、`:585`，`cron/execution_identity.py:17`，`cron/delivery_queue.py:328` | Desktop Cron 管理走 profile-scoped HTTP。当前上游有注册平台和获取当前 Cron 执行身份的插件 API。W01/W09 需要证明实际队列、直投及附件路径可取得同一稳定投递身份。 |

上游契约读取入口是 `apps/shared/src/gateway-contract.openrpc.json`、`tui_gateway/contracts/` 和相应 owner handler。共享的 renderer-free Node client（`apps/shared/src/node/gateway-client.ts`）供比较；Connector 默认仅实现本项目所需的适配子集。W00 保存上游 commit、OpenRPC 摘要、已审查的局部补充 schema、授权隔离的脱敏 fixtures 与测试向量。桌面测试证明的只是其路径，移动端开关由自己的端到端测试推动。

## 模块设计

### 协议包与 Hermes Adapter

`packages/protocol/src/mobile-v1` 拥有 HTTP DTO、事件、错误和同步帧；`connector-v1` 拥有业务命令、事件与投递帧；`common` 拥有 UUID、版本、时间和 envelope schema。协议源同时产出运行时校验和 TS 类型。建议使用 Zod 4，边界统一 `safeParse`，HTTP 只在路由边界解析一次。移动与 Connector 数据可独立演进。 [Zod 解析与类型推断](https://zod.dev/basics)

`packages/hermes-adapter/src` 拥有 `pinned-contract`、`validators` 与 `normalize`。它校验上游数据，用稳定上游引用映射消息、工具、控制及权限证据。运行时适配不引入 Electron、React Native 或 OS 状态。Connect、取票、重连、文件与 DB I/O 由 Connector 注入。能力记录包含已验证的能力、方法和有效限制。新上游版本以新 fixtures 和双端联调升级。

### BFF 身份、授权与运行模型

| 目录 | 设计和交付边界 |
| --- | --- |
| `services/bff/src/auth` | 管理员生成单次高熵 grant，App 确认 HTTPS origin，兑换事务创建 device/family。每设备 single-flight refresh，旧 secret + 原 `refresh_request_id` 在 60 秒重放窗口取同一加密响应；不同 ID 返回冲突，超窗重用按策略仅撤销该 family。App 在 SecureStore 持久凭据包与意图。初始配对丢回执按撤销旧注册、新 grant 流程处理。 |
| `src/domain`、`src/application/topics`、`src/repositories` | Profile 列表来自授权目录。Topic 是稳定逻辑资源，绑定有 revision 且同一时刻只有一条生效。reset/handoff 通过新 revision 围住旧命令。Submission/Action 入库前重验 ACL、binding、附件、幂等键与 payload hash。提交事务一起写用户气泡、command outbox 与 feed。 |
| `src/connector` | 验证 Connector 机器身份和 backend/profile 授权。管理员为已批准 backend 发放高熵机器 secret，BFF 保存其 hash，Connector 存于系统秘密存储。凭据轮换和撤销与手机设备体系分开。命令领取、存储 ACK、结果回传分别持久化。Ingest 按 ingest ID + hash 和上游去重键入库。失租后该连接禁止新写命令。旧 generation 的已持久事件待当前合法身份对账后接收。 |
| `src/sync` | 用户级 feed head 在事务内串行分配 sequence。Snapshot 用一致事务生成不可变页，保留窗口元数据与增量 pin。收件人/ACL 变化令分页和订阅失效。WS 压力超过限额时提示转 HTTP 补拉，广播仅用于唤醒持久 feed 查询。 |
| `src/application/controls` | 先锁 feed head，后对 control 行 CAS。校验 kind、可选项、截止时间、版本、binding 与 generation，生成唯一 response/command。敏感交互先检查本应用安全能力和最近认证。对于现阶段需要可信客户端的交互，App 只显示受限状态和处置入口。 |
| `src/media` | 私有 multipart 上传、校验作业和对象引用。短期授权只允许指定分片，服务端核实大小、magic、SHA-256 与内容策略后置 ready。默认用 BFF 授权代理和 Range 读敏感对象，并在撤权时中止已知活跃流。生命周期同时检查 refs、pending submission 与执行不明项。 |
| `src/notifications`、`src/workers` | 结果可读或待办有效时同事务写 Inbox、feed 和 Push outbox。Worker 短事务领取，事务外发送，随后按 attempt fence 保存结果。设备注册按 provider、environment、app_id、device 分域。Push payload 仅放通用文案、稳定通知 ID 与定位 ID。 |
| `src/application/collaboration` | Search 只索引可见内容并返回覆盖范围，导出生成可撤权的短期制品。回应设目标状态。引用按稳定消息 ID 解析，受授权且长度受限的摘要以用户输入上下文传给模型。群成员和触发授权单独建模，唯一群消息触发键使一次合法 @ 最多生成一个 submission。群内上下文只取该群授权内容。Preset 版本化，生效条件按当前 binding 和上游能力复核。 |

路由负责传输与校验，应用服务负责用例和事务，repository 只处理存储。HTTP 路由和 worker 共用同一应用服务。租户内外键带 `account_id`，同一资源跨 backend/profile/topic 的引用带足够复合范围。ACL 读出候选接收者后，按稳定 user ID 顺序锁 feed head，复核 ACL，再锁业务行。事务内只执行 DB 操作。终态先于完整投影时记录 `final_pending`，修复完整后发布可读结果。

### Connector 与 Python 投递插件

| 目录 | 设计和交付边界 |
| --- | --- |
| `services/connector/src/transport`、`lease` | Connector 出站注册，TLS 上使用受限机器凭据，短期连接票据按 backend 绑定。每 backend 一个本机独占锁和 BFF lease。到期即停发上游写及控制响应。换主先证明旧实例停止、重新核验 principal、对账未决命令；云 lease generation 只对 BFF 有约束力。 |
| `src/adapter`、`recovery` | 每个 backend/profile/session 一条恢复队列，重新 attach、发现能力和验证归属后才恢复 dispatch。上游 seq/replay_epoch 与 App feed 独立。合并回放和 live buffer，snapshot 必须覆盖 execution、pending controls 和历史水位。 |
| `src/spool` | 本机 WAL SQLite 持久化 `commands`、`event_spool`、`session_checkpoints`、`staged_files` 与投递接收进度。持久化后才回 `connector_stored`，发送前记写入状态，等 BFF 持久 ACK 后再 GC。磁盘不足时暂停新接纳并对外报告 degraded。 |
| `src/staging` | App attachment UUID → BFF 限用途 grant → 专用目录下载、校验、原子发布 → 按版本验证的 Hermes 入口。图片通过 `image.attach_bytes` 的实测上限和 MIME 获取上游 staging 引用。普通文件验证 `file.attach` 或受限媒体桥，取得可信上下文引用后才交给执行。发送前持久化最终上游参数和引用，重试从该记录恢复。Docker/SSH 工具执行域单独验证可读性。拒绝任意路径、URL、symlink 和超额载荷。 |
| `src/delivery` 与 `plugins/hermes-mobile-delivery` | 插件注册 Hermes 投递目标，解析受信 profile/route，落盘正文和媒体引用后返回本地接纳。插件独占自己的 SQLite spool。Connector 经 Unix socket 取批与回 ACK，由插件事务更新自身队列。按目标、生产者和稳定投递身份去重；缺源身份时用首次落盘生成的 UUID，标 `delivery_reconciliation=limited`。 |

Gateway 归一化输出只保留移动端必要字段。原生票据绑定同一 OS 用户，W01 验证 Connector 以经过批准的本机 owner 身份取票；BFF 用户和设备授权仍由 BFF 执行。Connector 记录可核验的主机/上游 principal 和策略摘要，以保留的提交身份和冻结负载对账。Cron 投递失败只补投递。源身份不足时保留同文多次合法发送，并把接收前崩溃和跨上游重调的边界暴露给诊断。上游需要变更时单独形成提案。

### Expo App

| 目录 | 设计和交付边界 |
| --- | --- |
| `apps/mobile/src/app` | Router 入口 `pair.tsx`、`(tabs)/sessions.tsx`、`(tabs)/controls.tsx`、`(tabs)/inbox.tsx`、`(tabs)/settings.tsx`、`chat/[topicId].tsx`、`topics/[topicId]/settings.tsx`、`compose/media.tsx`、`share/import.tsx`。每个页面由授权目录和本地记录解析完整 scope；后台事件只更新本地投影。 |
| `src/auth`、`src/db` | W02 负责双端配对 UI、凭据保存、刷新和会话恢复，W04 负责解锁账户库与文件目录。认证和数据库解锁分别报告状态。数据库用独立 writer、WAL 和外键。同步写入、游标、草稿与 outbox 在单事务内完成。生产构建检查 SQLCipher 的 `cipher_version` 并证明错钥无法打开。密钥丢失后展示不可恢复草稿的影响，由显式恢复流程重建。 |
| `src/sync`、`src/outbox` | SyncEngine 是 feed 唯一消费者。先 staging snapshot 全页，原子切换 generation，保留草稿、上传与 outbox；再补 HTTP 和订阅。出站先持久原 ID、冻结 payload/hash 和草稿版本，拿到确认后再合并气泡。断网/后台恢复分开显示 transport、sync、backend 状态。 |
| `src/chat`、`src/controls` | HistoryRepository 提供窗口化历史和稳定消息 key。流式以块增量更新，距底部较远时保留锚点。Markdown 禁原始 HTML、未受信外链和自动加载远程图片。审批选择来自服务端，支持逐题/跳过、多设备冲突、失效刷新。离线审批可保存草稿，联网后重查并要求用户确认。 |
| `src/media`、`src/share` | 原音保存在应用持久目录，文件落地后登记草稿，启动扫描修复半完成记录。上传可查询缺片并续传，STT 结果与原音独立，TTS 结果为附件。分享入库仅创建草稿，主 App 鉴权后选择 scope 并提交。导出走系统分享面板。联系人/位置采用单次选择、最小字段与用户确认。 |
| `src/notifications` | 监听与 initial response 先写同一设备私有的小型待解析队列，只含定位 ID 和过期时间。按 `notification_id+action` 去重，绑定并复核 account、目标权限、Inbox/control 实际状态且 Router ready 后才导航，消费记录进账户库。撤权时清理对应待处理项。拒绝通知时仍可同步 Inbox。 |

### iOS 与 Android 原生实现

| 能力 | iOS | Android |
| --- | --- | --- |
| 构建 | SDK 58 development build，预览与生产分别签名，验证 entitlements。 | 同一 Expo 工程生成 Android development build，按渠道管理签名、applicationId 与 SDK。 |
| 系统分享接收 | Swift Share Extension 通过 App Group 持久写 manifest 和暂存文件；用户回到主 App 时读取。主 App 是唯一持有 Hermes Mobile 会话的进程。 | Kotlin intent bridge 处理 `ACTION_SEND` / `ACTION_SEND_MULTIPLE`，在授权有效时复制 `content://` 数据到私有目录，验证类型、数量和大小。 |
| 推送 | 首轮建议 Expo Push → APNs，记录 APNs 环境。生产若网络验收要求可切直连 APNs。 | 有 GMS 首轮建议 Expo Push → FCM。无 GMS 保持聊天与 Inbox，根据实际机型引入厂商 SDK，未验证设备明确后台提醒不可用。 |
| 权限和媒体 | 文档/照片选择、录音、麦克风权限和 VoiceOver。冷启动先恢复授权再处理深链接。 | Android 通知 channel、权限请求和 token 轮换；区分系统回收、从最近任务划走与 force-stop。验收照片/文件选择、录音、TalkBack 和 Android 系统返回。 |
| 本地保护 | SecureStore + 实测 SQLCipher，App Group 分享暂存单独验证文件保护与回收。 | SecureStore + 实测 SQLCipher，验证 app 私有目录、设备备份恢复后的 key 行为与缓存清理。 |

原生桥在 `apps/mobile/modules/share-in` 和按机型添加的 `modules/vendor-push`，配置统一由 `apps/mobile/plugins` 和 app config owner 管理。iOS Extension 写入原子 manifest 后结束，无需强制启动宿主。系统推送是低延迟提醒，后台挂起或强停时用下次启动从 Inbox 补齐。原生改动升 `runtimeVersion` 并重建两个平台。每个平台分别保存设备、OS、网络、build ID 与证据，模拟器覆盖 UI，真机覆盖系统能力。 [Expo development builds](https://docs.expo.dev/develop/development-builds/introduction/) · [Expo SDK 58 通知](https://docs.expo.dev/versions/v58.0.0/sdk/notifications/) · [Expo SDK 58 SQLite](https://docs.expo.dev/versions/v58.0.0/sdk/sqlite/) · [Apple App Groups](https://developer.apple.com/documentation/xcode/configuring-app-groups) · [Android Sharesheet 接收](https://developer.android.com/develop/ui/compose/sharing/receive) · [FCM Android 要求](https://firebase.google.com/docs/cloud-messaging/android/get-started)

### 部署、运维和证据

`deploy/` 提供 BFF API/worker 同版本不同入口、私网 PostgreSQL、私有 bucket、TLS 反向代理、严格日志与 WS 升级配置。Connector 用受控服务账号运行在 Hermes 主机，限制数据目录权限与磁盘配额。后台出站需要分别验证手机到 BFF、手机到媒体服务、Push 通道与 Hermes 到模型/工具的网络。密钥采用部署密钥存储。诊断只返回脱敏版本、状态和 request ID；日志禁止票据、原始命令结果和个人内容。

`runbooks/` 覆盖 DB/对象备份与恢复、撤权、上游兼容、Connector 停写与交接、Cron 按 job 迁移、发布和回滚。恢复顺序为停写、恢复与验证、切 auth/feed epoch、对账未决、证明旧 writer 已退出、恢复写入。DB 用 expand/contract 迁移，App native runtime、协议与上游 adapter 分别版本化。监控覆盖 API 接纳、feed lag、spool 磁盘、unknown、final_pending 与 provider attempt，记录实际设备打开与读取状态。

## 依赖真实环境的决策

| 决策 | 本方案默认 | 启用或签收条件 |
| --- | --- | --- |
| iOS / Android 内测 | 首轮各一台真机，Android 验证有 GMS；按目标用户补无 GMS | W01 记录机型、网络、签名与安装渠道，选择实际需要覆盖的厂商。 |
| Hermes 创建与工具 | 首选试验 `source=tool`，逐 Profile 验证；创建标题保存在 BFF | 安全预置、历史、两类控制、压缩与 owner 再拨均有证据后才启用新建 Topic。 |
| 高风险交互 | 引导到已授权可信客户端；单独的移动安全表面视范围确认 | 生产支持安全输入或验收方接受有证据的等价接力路径，才能签收相应能力。 |
| Cron 投递身份 | 可证明稳定身份时按执行和投递粒度去重；其他路径标 limited | 用同一执行重试、多片/多目标、同文独立执行与插件崩溃证明身份粒度和持久接纳。 |
| 正式分发和生产网络 | 先内部 development/preview；数据库和对象服务地区以双端实测选择 | 使用真实个人内容前完成 SQLCipher、授权和备份恢复；切 Cron 目的地按 W12 单项确认。 |
