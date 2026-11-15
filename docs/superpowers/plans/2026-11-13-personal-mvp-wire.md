# Hermes 移动端个人版联调约定

首个可运行版本沿用 iOS／Android → Fastify BFF ← 出站连接器 → Hermes 网关。PostgreSQL 持久化云端数据，手机 SQLite 保存缓存与待发文本，连接器的 SQLite 保存命令结果。个人版 BFF 使用单账户和管理员配对令牌，按设备发放和撤销不透明会话凭据。移动端通过 WSS 接收变更通知，再通过 HTTP 拉取完整话题。应用回到前台或 WebSocket 重新连接时也会补拉。

以下 TypeScript 类型由 `@hermes-mobile/protocol` 导出，所有字段使用下划线命名法。UUID 由发起方生成并保持不变。上游标识按不透明字符串原样保存。

## 移动端 HTTP 接口

统一前缀 `/mobile/v1`。成功 `{data,request_id,server_time}`，错误 `{error:{code,message,retryable},request_id}`。除配对外用 `Authorization: Bearer <token>`。

| 请求 | 请求体或响应数据 |
| --- | --- |
| POST /pairings/redeem | `{pairing_token,device_name}` → `{token,device_id}` |
| DELETE /auth/session | 撤销自己的凭据，204 |
| GET /profiles | `Profile[]`，通过 BFF 的 `HERMES_PROFILES` 配置。值为逗号分隔的真实配置档案名称，默认为 `default` |
| GET /status | `{connector_online:boolean}` |
| GET /topics | `Topic[]` 按 `updated_at` 倒序。默认仅返回未归档话题，`?include_archived=true` 返回全部。 |
| POST /topics | `{request_id,profile_id,title?}` → `Topic`，幂等 202。省略标题时先显示首条消息的预览，再同步 Hermes 原生标题。 |
| GET /topics/:id | `{topic:Topic,messages:Message[],controls:Control[]}` |
| PUT /topics/:id/archive | `{archived:boolean}` → `Topic`。重复设置同一状态安全，保留原会话和消息。 |
| POST /topics/:id/submissions | `{submission_id,text,attachments?:{name,mime,size,content_base64}[]}` → `Message` 用户气泡，幂等 202。有附件时可传空正文。 |
| POST /topics/:id/interrupt | `{request_id,submission_id}` → `{status:"accepted"}`，幂等 202 |
| POST /topics/:id/model-requests | `{request_id}` 请求目录，`{request_id,provider,model,confirm?}` 选择模型。幂等 202 |
| GET /topics/:id/model-requests/:requestId | 查询模型请求的 `pending`、`ok`、`error` 或 `unknown` 状态。成功时返回目录、选择结果或 Hermes 确认提示 |
| POST /topics/:id/reasoning-requests | `{request_id,effort}` 切换思考强度；`effort:null` 恢复默认。幂等 202 |
| GET /topics/:id/reasoning-requests/:requestId | 查询切换的 `pending`、`ok`、`error` 或 `unknown` 状态 |
| POST /controls/:id/responses | `{response_id,answer}` → `{status:"responding"}`，幂等 202 |
| GET /inbox | `InboxItem[]` |
| GET/HEAD /attachments/:id | 已被可见消息或收件箱引用的文件字节，需要设备令牌。支持单个 `Range: bytes=…`，返回 206 或不可满足时的 416。 |
| PUT/DELETE /devices/current/push-registration | PUT 提交 `{token}` 注册 Expo 推送令牌，DELETE 移除，均返回 204 |
| POST /ws-tickets | `{ticket:string}`，短时单次 |
| GET /events?ticket=… | WS，服务端仅发 `{type:"changed",topic_id?:string}` 和连接就绪变更。移动端重新拉取受影响数据。握手 URL 不写日志。 |

话题 `Topic` 的结构为 `{topic_id,profile_id,title,status:"creating"|"ready"|"error",error?:string}`。配置档案 `Profile` 的结构为 `{profile_id,label}`。消息 `Message` 的结构为 `{message_id,role:"user"|"assistant",text,status:"accepted"|"queued"|"streaming"|"final"|"failed"|"unknown"|"cancelled",submission_id?:string,error?:string}`。交互 `Control` 的结构为 `{control_id,kind:"approval"|"clarify",prompt,choices:string[],status:"pending"|"responding"|"closed"|"unknown",submission_id?,multi_select?,answer?,error?}`。收件箱条目 `InboxItem` 的结构为 `{inbox_id,profile_id,title,text,created_at}`。旧版服务端或移动端缓存可能缺少 `profile_id`、`title`；新版响应从已保存的配置档案补齐 `profile_id`，无标题时从正文首个非空行生成简短标题，原始 `text` 不变。

话题包含 ISO 8601 格式的 `created_at`、`updated_at` 与布尔值 `archived`，旧缓存可能缺少这些字段。归档状态的变化不计入 `updated_at`。话题可附带已确认的 `reasoning_effort`（缺省时使用 Hermes 的默认设置），或 `reasoning_status:"pending"|"unknown"`。

`GET /status` 同时返回当前连接器是否声明 `reasoning_supported` 和 `attachments_supported`。消息与收件箱的 `attachments` 仅含 `{name,mime,size,attachment_id?}` 元数据。Hermes 发送的文件必须包含 `attachment_id`，历史用户上传的附件可缺省该字段。有附件时正文可为空，收件箱的自动标题和推送预览回退到首个附件名。

## Hermes 文件上传

连接器或投递插件调用 `PUT /internal/attachments/v1/:id`，`id` 为稳定 UUID，使用连接器令牌或独立的收件箱投递令牌。JSON 请求体为 `{profile_ref,name,mime,size,content_base64}`，单个文件最多 50 MiB。服务端校验名称、MIME、内容长度与严格 base64 编码；图片支持 JPEG、PNG、GIF 和 WebP 签名。成功返回 `{data:{attachment_id,name,mime,size},request_id,server_time}`。相同 ID 的相同文件可安全重试，不同内容、元数据或配置档案返回 409。

上传成功后把返回的元数据加入 assistant message 或 `POST /internal/inbox/v1/deliveries` 的可选 `attachments`，每条最多 10 个。消息入库时验证引用确实存在且属于同一配置档案。上传字节存入独立持久表，WebSocket 仅发送引用。未被消息引用的文件不能由手机下载；当前不自动清理文件。反向代理须转发上传路径并允许约 67 MiB 的 JSON 请求。

`POST /internal/inbox/v1/deliveries` 的可选 `session_id` 指定同一 `profile_ref` 下已绑定的 Hermes 会话，按 `^[A-Za-z0-9][A-Za-z0-9_.-]{0,511}$` 校验。有 ID 时保存 `assistant/final` 消息并更新话题，无 ID 时保留收件箱及推送行为。不存在、未就绪或跨档案的目标返回 404，不回退收件箱。去重记录包含目标会话，相同 `delivery_id` 改投其他目标返回 409。会话投递不关联用户 submission，也不改动正在执行的回复。

## BFF 与连接器

连接器发起 WebSocket `/internal/connector/v1/events`，握手使用 `Authorization: Bearer <CONNECTOR_TOKEN>`。云端发送的命令结构为 `{type:"command",command_id,topic_id,profile_ref,session_id?,kind,body}`，其中 `session_id` 是绑定的 Hermes 会话 ID。所有使用已绑定会话的命令均须传入该字段。

- `create` 的请求体为 `{request_id}`。
- `submit` 的请求体为 `{submission_id,text,attachments?:{name,mime,size,sha256}[]}`。含附件的命令只发给声明 `X-Hermes-Mobile-Attachments: 1` 的连接器。连接器通过机器令牌调用 `GET /internal/connector/v1/submissions/:id/attachments/:position`（序号从 1 开始）获取原始字节并校验摘要。BFF 保存连接器命令结果后清理暂存字节。
- `interrupt` 的请求体为 `{submission_id}`。连接器核对该提交仍在运行后，按当前已验证的活动代次调用。
- `respond` 的请求体为 `{control_id,response_id,answer}`。澄清支持文本、复选标签数组的 JSON 字符串和空字符串跳过。连接器按上游请求类型转换。
- `model_options` 的请求体为 `{}`。`select_model` 的请求体为 `{provider,model,confirm?}`。两者的成功回执携带 `model_result`。
- `select_reasoning` 的请求体为 `{effort}`，仅发给声明 `X-Hermes-Mobile-Reasoning: 1` 的连接器。
- `watch` 的请求体为 `{}`，使用独立的临时 `command_id`。重连时同步每个已绑定话题。连接器先登记作用域，再恢复上游。BFF 忽略 `watch` 的结果，且不将临时命令写入命令表。

连接器返回 `{type:"command_result",command_id,status:"ok"|"error"|"unknown",session_id?,admission_id?,error?,control_status?}`。创建成功带 `session_id`，提交已接纳带 `admission_id`，确认交互关闭时带 `control_status`。BFF 持久化普通写命令的结果后，返回 `{type:"ack",id:command_id}`。重复命令只返回既有结果或 `unknown`，并沿用原 ID。无法确认交互响应时使用 `unknown`。连接关闭后，BFF 重派仍未结的原命令。

连接器异步帧含 `event_id`，话题相关的异步帧还含 `topic_id`。BFF 持久化后返回 `{type:"ack",id:event_id}`。

- `{type:"topic_title",event_id,topic_id,session_id,title}` 同步绑定会话的原生标题。BFF 只更新自动命名的话题。
- `{type:"message",event_id,topic_id,message_id,submission_id?,text,attachments?,status:"streaming"|"final"}`，同一响应使用稳定的 `message_id`，`text` 为当前完整的累计文本。`final` 优先于迟到的 `streaming` 更新。省略 `attachments` 时保留该回复已保存的文件；显式空数组清空引用。
- `{type:"submission",event_id,topic_id,submission_id,status:"queued"|"streaming"|"final"|"failed"|"cancelled"|"unknown",error?}`，更新原用户气泡执行状态，禁止复活已知终态。
- `{type:"control",event_id,topic_id,control_id,kind,prompt,choices,status,submission_id?,multi_select?}`。连接器按话题映射上游请求 ID。BFF 收到明确的成功回执后才投影已提交的答案。
- `{type:"delivery",event_id,delivery_id,profile_ref,session_id?,title?,text,attachments?}` 供旧版连接器清空升级前的队列，可选标题最多 256 个 UTF-8 字节。可选会话 ID 与 HTTP 投递使用相同校验和路由。新版插件使用 `POST /internal/inbox/v1/deliveries`，HTTP 和旧连接器共用投递 ID 去重。 [投递 API](../../../plugins/hermes-mobile-delivery/README.md#投递-api)

连接器使用环境变量 `BFF_URL` 和 `CONNECTOR_TOKEN`，可选 `HERMES_BIN` 和 `CONNECTOR_DB_PATH`。容器部署使用 `HERMES_WEBAPP_URL` 和 `HERMES_DASHBOARD_SESSION_TOKEN` 换取原版 WebSocket 票据。已有 HTTP Runs 会话通过 `HERMES_API_URL` 和 `HERMES_API_KEY` 继续使用。BFF 使用环境变量 `DATABASE_URL`、`APP_PAIRING_TOKEN` 和 `CONNECTOR_TOKEN`，可选 `PORT`（3000）、`HOST`（127.0.0.1）、`HERMES_PROFILES`（`default`）和 `EXPO_ACCESS_TOKEN`。隔离开发可用本地 HTTP，远程连接使用 HTTPS／WSS。
