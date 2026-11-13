# Mobile 与 Connector 契约基线

设计提案。字段与状态用于工作包交接。W00 将本基线与 [v2 原规格](../../reference/hermes-expo-engineering-spec-v2.md) §3、§5–10、§13、§15 核对成可执行 schema 和共享 fixtures。参见 [双平台技术设计](./2026-11-13-hermes-mobile-design.md) 与 [并行开发工作包](../plans/2026-11-13-hermes-mobile-parallel-plan.md)。

## 编码、权限和兼容

- 应用 ID 使用 UUID。Hermes profile/session/admission/prompt/epoch 是 opaque，按上游实际类型无损保存。Mobile 和 Connector wire 的 64 位 sequence、版本和 generation 用规范十进制字符串，进入 Hermes 整数参数前做无损转换和边界校验。时间为 UTC RFC3339。
- BFF 从凭据派生 account/user/device，按授权目录将 profile UUID 映射到 backend 和真实 Profile。手机输入的路径参数、通知定位和 body 均须重验授权。跨 scope 或不可见资源统一 404，已知服务级权限不足为 403。
- 写端点严格校验字段。响应允许新增可选字段。影响状态的未知 enum 或事件进入修复或最低版本提示，客户端保留已提交的同步位置；仅显式标注且 schema 能识别的非关键扩展可跳过。
- 对幂等字段用请求体业务 ID 和 `Idempotency-Key` 的同值校验，`X-Request-ID` 用于链路追踪。校验后的语义负载用 RFC 8785 JCS 和 SHA-256，数组顺序有意义，trace 与传输字段不入 hash。应用内先校验禁止非规范数、孤立 surrogate 和不支持的字段，DTO 明确每个可选字段的 null/省略语义，向量覆盖 TS/Python 跨语言。 [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)
- 同操作同 ID/同 hash 返回持久收据，同 ID/不同 hash 返回 409。既有收据重放仍须验权，先查既有收据再检查新写入的版本、时效及状态约束。撤权后不返回旧收据；没有同一授权作用域的请求无法通过收据枚举资源。

## Mobile API v1

前缀 `/mobile/v1`。成功体 `{data, request_id, server_time}`，分页再加 `next_cursor, has_more`，204 为空。错误体 `{error:{code,message,retryable,details?},request_id}`。错误细节只含已授权且安全的字段。

| 域和 owner | 端点与最小交接 |
| --- | --- |
| 身份 W02 | `POST /pairings/redeem` 交换一次性 grant；`POST /auth/refresh` 按设备家族轮换；`DELETE /auth/session` 撤销当前设备会话；`GET /devices`、`DELETE /devices/{id}` 管理设备。配对 grant 的发放另走管理员入口。 |
| 目录、Topic W02 | `GET /profiles`、`GET /capabilities?profile_id=…`；`GET/POST /topics`、`GET /topics/{id}`。创建含 `request_id,profile_id,title,kind,preset_id`；202 返回 Topic 和 creating 状态，绑定建立后进入 ready。 |
| 聊天 W05 | `GET /topics/{id}/messages` 稳定 message_order 分页，`GET /messages/{id}` 修复完整投影；`POST /topics/{id}/submissions` 创建提交；`GET /submissions/{id}` 查权威已知状态；`POST /topics/{id}/actions`、`GET /actions/{request_id}` 查询队列与会话动作。 |
| 同步 W04 | `GET /sync?cursor=…`；`POST /sync/snapshots`，`GET /sync/snapshots/{id}`，`GET /sync/snapshots/{id}/rows`，`POST /sync/snapshots/{id}/complete`；`POST /ws-tickets`、`GET /events` 升级 WS。 |
| 控制 W06 | `GET /controls`、`GET /controls/{id}`；`POST /controls/{id}/responses` 提交 `response_id,expected_version,execution_generation,answer` 并返回 202 responding；`GET /control-responses/{id}` 查确认。逐题锁定与完整回答是分开的 action discriminator。 |
| 媒体 W07 | `POST /uploads`、`GET/DELETE /uploads/{id}`、`POST /uploads/{id}/parts/authorize`、`POST /uploads/{id}/complete`；`GET /attachments/{id}`、`POST /attachments/{id}/download-grant`；`POST /attachments/{id}/transcriptions`、`GET /transcriptions/{id}`、`POST /messages/{id}/speech`、`GET /speech/{id}`。 |
| Inbox 与通知 W08 | `GET /inbox`、`GET /inbox/{id}`、`PUT /topics/{id}/read-cursor`、`POST/DELETE /devices/{id}/push-registration`、`POST /notifications/{id}/opened`。显式打开、前台同步、业务已读分别更新。 |
| 协作与导出 W10 | `PUT /topics/{id}/preferences`、`POST /topics/{id}/reactions`、`GET /search`、`POST /topics/{id}/exports`、`GET /exports/{id}`、`GET /presets`、`POST /topics/{id}/preset`、`GET /topics/{id}/members`、`PUT/DELETE /topics/{id}/members/{user_id}`、`POST /topics/{id}/room-messages`。群消息请求含 `room_message_id,text,attachment_ids,reply_to_message_id,invoke_agent`，返回 `message_id` 与可选 `submission_id`。 |

核心提交请求和 202 数据体示例（示例身份为合成值）：

```json
{
  "submission_id": "10000000-0000-4000-8000-000000000004",
  "binding_revision": "1",
  "text": "请总结讨论",
  "attachment_ids": [],
  "reply_to_message_id": null,
  "mode": "normal",
  "expires_at": "2026-11-14T03:00:00Z"
}
```

```json
{
  "submission_id": "10000000-0000-4000-8000-000000000004",
  "status": "accepted",
  "message_id": "10000000-0000-4000-8000-000000000006",
  "entity_version": "1",
  "admission_id": null
}
```

提交状态按已知事实推进。App 的 `local_pending` 是待上传意图。BFF commit 产生 `accepted`，离线可为 `waiting_connector`，分发后为 `dispatching`，上游回执与状态再映射 `admitted / queued / running / waiting_control / completed / failed / cancelled / expired / unknown`。通知依赖 `final_message_available`。已知过期只影响尚未执行的意图；已发且无回执进入对账。绑定变化要求新决策，重试不把旧输入送进新会话。

适配器识别 `prompt.submit` 的 `{voice_stopped:true}` 无接纳分支。对应提交以确定未执行的终态及原因收束，保留本地输入与会话变更证据，禁止填造 admission 或自动重发。

`actions` 用以 `kind` 区分的 union。运行中 interrupt/steer 携带预期 generation，队列取消或替换使用从已授权 submission 找到的 admission，替换产生新 submission。reset/branch/model/reasoning/preset 用绑定和上游 revision 校验。当前上游普通 submit 统一进入队列，`normal`/`queue` 仅在实际证明有不同语义时对用户暴露不同操作。队列项在 cancel 竞态中已开始时，只有已验证的 queue-only 操作可称“撤回排队”；需要停正在运行的输入时由用户按当前代次选择停止。

错误分支由 code 驱动。401 `AUTH_EXPIRED` single-flight 刷新后使用原 ID，`DEVICE_REVOKED` 结束连接并锁定该设备会话。409 `IDEMPOTENCY_CONFLICT / VERSION_CONFLICT / BINDING_CHANGED / EXECUTION_CHANGED / CONTROL_ALREADY_HANDLED / REFRESH_IN_PROGRESS` 分别进入终止自动重试、拉新状态或重放既有刷新意图。410 `CONTROL_EXPIRED / CURSOR_EXPIRED / SNAPSHOT_EXPIRED` 关闭交互或重建快照。422 用 `VALIDATION_FAILED / ATTACHMENT_NOT_READY` 提示字段或等待校验，429 遵守 Retry-After，503 区分 backend 离线与能力未开通。

## 移动同步和设备接口

投影 feed 事件统一为 `{schema_version,event_id,feed_epoch,sequence,kind,profile_id,topic_id,entity_id,entity_version,payload}`。profile/topic 仅在适用事件出现。注册表覆盖 `topic.upsert/deleted`、`submission.upsert`、`message.upsert/text.delta/final`、`tool.upsert`、`control.upsert/closed`、`inbox.upsert`、`read.updated`、`attachment.upsert`、`capabilities.changed`。完整投影按 entity_version 替换，tombstone 防旧数据复活。增量需要 `base_version` 和 `offset_utf16` 同时匹配，禁止切断 surrogate pair。缺口与推进 cursor 在同一 SQLite 事务持久写入 repair job，修复用完整 message 按版本安装，迟到 delta 不能覆盖 final。

App 取得约 30 秒一次性 WS 票据，子协议携带票据，代理不记握手秘密。BFF 校验并消费后返回 hello，App 以 opaque cursor subscribe。BFF 按数据库补拉再 tail；batch 含 `from_sequence,to_sequence,next_cursor,events`。App 的 writer 提交投影、幂等记录、修复记录与 cursor 后 ACK。服务端只接受该连接曾发出的 cursor；WS ACK 与业务已读各自有自己的写路径。ACL、设备撤销和 access expiry 在服务端主动终止连接。

快照基于一致 DB 视图和 feed watermark，页绑定 account/user/ACL/epoch 和有效期。发布时与清理器共用保留锁并复核 watermark 之后的最早可读 seq，pin 保留到客户端完成交接或过期。App 一次切换完成的缓存 generation，先读 HTTP 增量，再进入 WS。取消/过期的快照保留旧授权缓存与待发数据；已收到撤权的 scope 须立即锁定或清理，禁读旧快照。快照声明各 Topic 的近历史覆盖窗口，较旧内容通过分页获取。

| 本地接口 | 消费者与行为 |
| --- | --- |
| `HistoryRepository.watch(scope, window)` 与 `commitHistoryPage(scope,page)` | Chat 只读 SQLite 观察流；分页按来源 scope/版本落盘。 |
| `SyncEngine.applyFeedBatch(batch)` 与 `replaceSnapshot(snapshotId)` | DB writer 维护投影及持久游标，返回已经提交的 ACK 游标。 |
| `SubmissionService.enqueue(scope,draftVersion)`、`reconcile(submissionId)`、`cancelUndispatched(submissionId)` | Composer 通过 service 提交意图；事务核对并只清当前草稿版本，已发未确认先对账。 |
| `ControlService.respond(controlId,response)` 与 `refresh(controlId)` | UI 按最新版本展示；返回 202 时卡片仍处 responding。 |
| `UploadManager.prepare(localUri,scope)`、`resume(uploadId)`、`abandon(uploadId)` | UI 监听分片和校验状态；URI 只在设备与对应原生桥内流转。 |
| `NotificationRouter.capture(intent)` 与 `resolveAfterAuth()` | 接受结构化 intent，持久去重、校验当前 account 和资源后才导航。 |

`Scope` 包含 account/backend/profile/topic UUID。TS 类型由 W00 导出，App 内 UI 订阅和结果类型由各 owner 冻结。App 数据表按 W04/W05 的 SQLite 迁移，跨 feature 写操作统一进入同一 writer。首轮建议 WS 心跳 25 秒、75 秒无响应时重连，full jitter 1–30 秒，feed 保留 7 天，snapshot 有效 10 分钟，HTTP 每批最多 200 条或 512 KiB，WS 每批最多 100 条或 256 KiB，未 ACK 缓冲 512 条或 2 MiB。大实体通过受授权引用拉取，不能绕过单帧上限。

原生 share-in 桥与主 App 的交接对象为 `ShareManifestV1 {v:1,import_id,created_at,items:[{item_id,kind,text?,relative_path?,display_name?,declared_mime?,size_bytes?}]}`。文件项只接受暂存根下生成的相对引用，文本项带受限文本。原生端先完成复制和限额检查，再原子发布 manifest。主 App 验证版本、文件实体和实际大小后以 `import_id` 幂等导入。用户选择账户和 Topic 后由账户 writer 生成草稿，成功或主动丢弃后释放源暂存。过期、文件缺失与导入成功分别记录。manifest 和草稿均无发送权限，提交仍由用户确认。

通知 intent 的跨端定位数据为 `{notification_id,action,inbox_item_id?,control_id?,profile_id?,topic_id?}`。待解析记录带过期时间，在身份与资源复核前只可显示通用提示。设备同步、打开事件和业务已读分别提交；离线打开仍需当前账户和可用的本地授权依据。

## Connector v1 与 Gateway 适配

Connector 用机器凭据经 HTTPS `POST /internal/connector/v1/ws-tickets` 换取 backend-scoped 单次短期票据，再连接 `/internal/connector/v1/events`。同一连接由 `hello` 登记 backend、connector、实例、版本和能力。BFF 校验 hello 与已认证作用域，通过 `lease_granted / lease_renew` 持续绑定 generation，默认 60 秒租期、20 秒续租。凭据撤销主动关闭连接并停止续租。以 `{v:1,type,body}` 区分 frame。命令的业务字段是 `command_id,backend_id,profile_id,topic_id,lease_generation,expires_at,kind,body`。控制、对账、建 Topic、提交和 staging 按 kind 严格校验。Connector 从可信绑定和服务端冻结策略生成上游参数。

| 方向与 frame type | 关联键与持久化条件 |
| --- | --- |
| BFF → Connector `command` | `command_id` 在所有传输重试中不变，hash 绑定业务 body、目标与 kind，租约字段不参与语义 hash。 |
| Connector → BFF `command_ack` | 本机 SQLite commit 后 ACK `connector_stored`，同 ID、同 hash 可重放。失租时停止写指令，已经存储的命令由合法新会话重新核对分发权限。 |
| Connector → BFF `command_result` | 结果通过 `command_id` 对账，区分已接纳、明确拒绝、已写出未确认、执行不明。允许先记录 sent_unconfirmed 再晋级，BFF 以结果版本做单调更新。 |
| Connector → BFF `ingest_batch` / `delivery_batch` | 每项固定 `ingest_id` 或 `delivery_id`、payload hash 和可信来源。上游事件在有稳定 seq 时以 backend/profile/session/replay_epoch/seq 二次去重。 |
| BFF → Connector `command_result_ack` / `ingest_ack` / `delivery_ack` | BFF commit 后逐项回原 ID、已接收版本/摘要或显式拒绝原因。不能凭最大 UUID 代替 ACK。只有已确认条目可回收。 |

本机写调用前检查租约、有效期、binding、策略和上游身份。已知 admission 通过 `prompt.receipt` 对账。未知 admission 时，只有隔离联调证明当前版本的精确重放、retention 与调用边界，且原 principal、目标、冻结参数、附件证据及有效期均可核对，才在允许窗口内重放同一次提交。超窗、作用域变化或结论不充分保留 `unknown`，从 transcript 与可信执行信息继续只读核对。新 submission ID 仅来自用户新意图。

Canonical 交互以 `prompt_id`、generation 和所属 scope 定位；`approval.respond` 需上游 approve 权，`clarify.respond` 需 respond 权。Server request 用原 JSON-RPC request id，`clarify.lock` 仅在版本支持且题目 qid 已验证时发送。null 是跳过，取消是独立结果，多选由 adapter 按实测编码。socket 成功写入后为 `sent_unconfirmed`；若只收到关闭事件且无法证明本回答被采用，卡片结束为 `closed_unknown`，保留响应结果不明。另一客户端选择、超时、上一代响应各有独立证据。未知宿主请求按 allowlist 拒绝，secret/sudo/vault 数据禁止进入普通 spool 或 Push。

上游 `method=event` 中的 `params.type` 才是事件类型。空文本 delta 可用于边界，`interim` 和 `complete` 用稳定段/turn 关联。工具事件缺 success 时展示未确认状态。Connector 每次重连核对 owner、按 epoch/cursor 补拉并 resume，恢复中 live frames 先持久化或有界暂存，不能悄悄丢掉影响终态的事件。恢复不完整时以 transcript、open requests 与 receipt 修复投影。

## 模块交接端口

以下为 W00-core 的签名提案。参数和返回对象随领域 DTO 一起冻结，持久化端口接收调用方事务，避免嵌套提交与跨模块循环依赖。

| 提供方 | 端口 | 调用方与保证 |
| --- | --- | --- |
| W02 | `resolvePrincipal(credentials) → Principal`、`authorizeScope(tx,principal,scope,permission) → Grant`、`resolveActiveBinding(tx,scope) → Binding` | 路由、worker 和鉴权测试共用。Grant 带 ACL revision。Binding 带 revision、上游 owner/session 及策略引用。 |
| W02 / W04 | `restoreSession() → SessionState`、`openAccountStore(session) → StoreState` | App 根布局先消费恢复状态，再决定是否开放账户缓存。仍可使用的本地会话和网络请求凭据有效性分别表达。退出/撤权会锁定对应账户库。 |
| W03 | `enqueueCommand(tx,command) → CommandRef`、`applyConnectorIngress(frame) → IngressAck` | W02/W05/W06/W07 调用 enqueue；Connector 路由调用 ingress。Ingress 由组合入口注入投影处理器，处理器返回 feed 项与 Inbox 来源，BFF commit 后返回 ACK。 |
| W04 | `appendFeed(tx,lockedHeads,events) → FeedWatermark`、`applyFeedBatch(batch) → ApplyResult` | BFF 在已锁定 head 的业务事务写事件；App 持久应用结果明确可 ACK 的 cursor、需修复实体或拒绝原因。 |
| W07 | `authorizeMedia(scope,attachmentId,purpose) → MediaGrant`、`stageAttachment(command) → StagingReceipt` | App 仅持有用途受限的授权和可用性，Connector 独占上游引用与文件路径。 |
| W08/W09 | `storeInboxItem(tx,source,target,contentRef) → InboxReceipt`、`pullDeliveries(limit) → DeliveryBatch`、`ackDeliveries(receipts) → AckResult` | W08 同事务写 Inbox、feed、可选 Push outbox。W09 插件经权限受限 Unix socket 提供拉取及幂等 ACK，Connector 只在收到 BFF 持久回执后 ACK 插件。插件 ACK 后才能回收。 |

同一业务事务由入口用例按顺序调用端口。各域接口测试注入 fixture 实现，最终组合根提供真实实现。W08/W09 先使用 Inbox fixture，W05/W06 对暂未启用的能力用明确 capability 结果覆盖。

投递身份优先使用上游稳定 delivery ID，或使用能证明稳定的 `execution_id + target + part_identity`。BFF 将其放在 account/backend/profile/producer 作用域下去重。若上游只提供 execution ID，但同一执行可产生多个无法稳定区分的产物，使用插件落盘 UUID 并标 limited。稳定键下不同 payload hash 进入冲突队列，保留原接纳收据供对账。

能力响应按功能项携带 `state,reason,policy_revision` 与适用的限额。公开状态为 `available | disabled_by_policy | unavailable_upstream | requires_native_build | pending_validation`。实际入口再与设备本地 capability 求交集。工程看板单独使用 `not_started | implemented | verified`。

## 持久化和验收夹具

PostgreSQL 物理模型按以下 ownership 分配。跨工作包只引用已发布的 key/interface，由迁移 owner 统一编号与接入。

| Owner | 表与关键约束 |
| --- | --- |
| W02 | accounts/users/devices/auth families/refresh/pairing、backends/profiles/grants、topics/bindings、audit/tombstones。租户复合外键，单活绑定，设备撤销令 ACL/feed 版本失效。 |
| W03 | connector_leases、connector_ingest、command_outbox。backend 单租约与 generation；command/ingest 唯一和 hash 冲突检测。 |
| W04 | feed_heads、user_events、sync_snapshots/rows/pins。以用户/epoch/seq 唯一，commit-ordered head，快照页不可变。 |
| W05 | submissions、messages、message_blocks、mutation_receipts、final repair jobs。用户意图一个 ID 对应一条 user message，Topic message_order 唯一。 |
| W06 | controls、control_responses。upstream scope+request+generation 唯一，CAS 保证一次 claim。 |
| W07 | attachments、uploads/parts/refs、staging_receipts、transcription/speech jobs。跨 Profile 写入须检查授权与 binding，独立对象和 staging 生命周期。 |
| W08/W09 | inbox_items、read_cursors、push_registrations/outbox/attempts、device_open_events、delivery_receipts。业务来源、provider attempt、设备打开各自有键。 |
| W10 | topic_members/preferences、reactions、export_jobs、presets/revisions、topic_policy_bindings、room_messages/trigger receipts。成员权限更新与受影响 feed epoch 同事务。 |

SQLite 的 sync_state、cache_generations、processed_events、repair_jobs、可见实体投影由 W04 发布。W05 接入 drafts/outbox 与消息索引，W07 接入 local_uploads，W08 接入 notification_intents 和 local_read_cursors，W10 接入 share_imports。表级约束和迁移顺序以真实 DB 回归为准。

媒体默认上限为每请求 JSON 256 KiB、文本 64 KiB UTF-8、最多 10 附件、普通对象 100 MiB、8 MiB 分片、手机并发 2。有效值取服务端、设备、存储与已验证上游的交集。上传会话与普通未发意图默认 24 小时。图片/文件仅在隔离测试证明目标 runtime 可读后开通；STT/TTS 分开公布能力。

W00 在 `packages/protocol/fixtures/` 提供 valid/invalid、状态序列、跨语言 hash、close code 和最小主链路。W03 在 `packages/hermes-adapter/fixtures/` 提供合成或脱敏的 pin 版 upstream event/request/response、两路控制、未知 admission、replay 缺口和 owner 变化。fixture 不含真实凭据、用户内容或本机路径。测试报告同时记录 Mobile/Connector wire 版本、Hermes commit/权限、adapter 版本、App runtimeVersion 与 fixture revision。
