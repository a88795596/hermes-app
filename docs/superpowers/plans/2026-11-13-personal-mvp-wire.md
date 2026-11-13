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
| GET /topics | `Topic[]` |
| POST /topics | `{request_id,profile_id,title}` → `Topic`，幂等 202 |
| GET /topics/:id | `{topic:Topic,messages:Message[],controls:Control[]}` |
| POST /topics/:id/submissions | `{submission_id,text}` → `Message` 用户气泡，幂等 202 |
| POST /topics/:id/interrupt | `{request_id,submission_id}` → `{status:"accepted"}`，幂等 202 |
| POST /topics/:id/model-requests | `{request_id}` 请求目录，`{request_id,provider,model,confirm?}` 选择模型。幂等 202 |
| GET /topics/:id/model-requests/:requestId | 查询模型请求的 `pending`、`ok`、`error` 或 `unknown` 状态。成功时返回目录、选择结果或 Hermes 确认提示 |
| POST /controls/:id/responses | `{response_id,answer}` → `{status:"responding"}`，幂等 202 |
| GET /inbox | `InboxItem[]` |
| PUT/DELETE /devices/current/push-registration | PUT 提交 `{token}` 注册 Expo 推送令牌，DELETE 移除，均返回 204 |
| POST /ws-tickets | `{ticket:string}`，短时单次 |
| GET /events?ticket=… | WS，服务端仅发 `{type:"changed",topic_id?:string}` 和连接就绪变更。移动端重新拉取受影响数据。握手 URL 不写日志。 |

话题 `Topic` 的结构为 `{topic_id,profile_id,title,status:"creating"|"ready"|"error",error?:string}`。配置档案 `Profile` 的结构为 `{profile_id,label}`。消息 `Message` 的结构为 `{message_id,role:"user"|"assistant",text,status:"accepted"|"queued"|"streaming"|"final"|"failed"|"unknown"|"cancelled",submission_id?:string,error?:string}`。交互 `Control` 的结构为 `{control_id,kind:"approval"|"clarify",prompt,choices:string[],status:"pending"|"responding"|"closed"|"unknown",submission_id?,multi_select?,answer?,error?}`。收件箱条目 `InboxItem` 的结构为 `{inbox_id,text,created_at}`。

## BFF 与连接器

连接器发起 WebSocket `/internal/connector/v1/events`，握手使用 `Authorization: Bearer <CONNECTOR_TOKEN>`。云端发送的命令结构为 `{type:"command",command_id,topic_id,profile_ref,session_id?,kind,body}`，其中 `session_id` 是绑定的 Hermes 会话 ID。所有使用已绑定会话的命令均须传入该字段。

- `create` 的请求体为 `{request_id}`。
- `submit` 的请求体为 `{submission_id,text}`。
- `interrupt` 的请求体为 `{submission_id}`。连接器核对该提交仍在运行后，按当前已验证的活动代次调用。
- `respond` 的请求体为 `{control_id,response_id,answer}`。澄清支持文本、复选标签数组的 JSON 字符串和空字符串跳过。连接器按上游请求类型转换。
- `model_options` 的请求体为 `{}`。`select_model` 的请求体为 `{provider,model,confirm?}`。两者的成功回执携带 `model_result`。
- `watch` 的请求体为 `{}`，使用独立的临时 `command_id`。重连时同步每个已绑定话题。连接器先登记作用域，再恢复上游。BFF 忽略 `watch` 的结果，且不将临时命令写入命令表。

连接器返回 `{type:"command_result",command_id,status:"ok"|"error"|"unknown",session_id?,admission_id?,error?,control_status?}`。创建成功带 `session_id`，提交已接纳带 `admission_id`，确认交互关闭时带 `control_status`。BFF 持久化普通写命令的结果后，返回 `{type:"ack",id:command_id}`。重复命令只返回既有结果或 `unknown`，并沿用原 ID。无法确认交互响应时使用 `unknown`。连接关闭后，BFF 重派仍未结的原命令。

连接器异步帧含 `event_id`，话题相关的异步帧还含 `topic_id`。BFF 持久化后返回 `{type:"ack",id:event_id}`。

- `{type:"message",event_id,topic_id,message_id,submission_id?,text,status:"streaming"|"final"}`，同一响应使用稳定的 `message_id`，`text` 为当前完整的累计文本。`final` 优先于迟到的 `streaming` 更新。
- `{type:"submission",event_id,topic_id,submission_id,status:"queued"|"streaming"|"final"|"failed"|"cancelled"|"unknown",error?}`，更新原用户气泡执行状态，禁止复活已知终态。
- `{type:"control",event_id,topic_id,control_id,kind,prompt,choices,status,submission_id?,multi_select?}`。连接器按话题映射上游请求 ID。BFF 收到明确的成功回执后才投影已提交的答案。
- `{type:"delivery",event_id,delivery_id,profile_ref,text}` 投递到单账户收件箱，BFF 按 ID 去重。`delivery_id` 可直接用作 `event_id`。

连接器使用环境变量 `BFF_URL` 和 `CONNECTOR_TOKEN`，可选 `HERMES_BIN` 和 `CONNECTOR_DB_PATH`。开发容器 `hermes-dev` 的 8642 端口使用 HTTP Runs。设置 `HERMES_API_URL=http://127.0.0.1:8642` 和 `HERMES_API_KEY` 启用该模式。BFF 使用环境变量 `DATABASE_URL`、`APP_PAIRING_TOKEN` 和 `CONNECTOR_TOKEN`，可选 `PORT`（3000）、`HOST`（127.0.0.1）、`HERMES_PROFILES`（`default`）和 `EXPO_ACCESS_TOKEN`。隔离开发可用本地 HTTP，远程连接使用 HTTPS／WSS。
