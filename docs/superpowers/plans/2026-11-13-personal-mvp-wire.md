# Hermes Mobile 个人版联调约定

首个可运行版本沿用 iOS／Android → Fastify BFF ← 出站 Connector → Hermes Gateway。PostgreSQL 持久化云端数据，手机 SQLite 保存缓存与待发文本，Connector SQLite 保存命令结果。用户自用的 BFF 使用单账户与管理员配对口令，逐设备生成及撤销不透明会话凭据。移动同步先用 WSS 通知变更 + HTTP 补拉完整 Topic，应用回前台和 WS 重连时也执行补拉。

以下 TS 类型由 `@hermes-mobile/protocol` 导出，所有字段使用 snake_case。UUID 由发起方生成并保持不变。上游标识是 opaque string。

## Mobile HTTP

统一前缀 `/mobile/v1`。成功 `{data,request_id,server_time}`，错误 `{error:{code,message,retryable},request_id}`。除配对外用 `Authorization: Bearer <token>`。

| 请求 | body / data |
| --- | --- |
| POST /pairings/redeem | `{pairing_token,device_name}` → `{token,device_id}` |
| DELETE /auth/session | 撤销自己的凭据，204 |
| GET /profiles | `Profile[]`，默认 Profile 由 BFF 的 `HERMES_PROFILES` 配置，逗号分隔的真实 profile ref，默认 `default` |
| GET /status | `{connector_online:boolean}` |
| GET /topics | `Topic[]` |
| POST /topics | `{request_id,profile_id,title}` → `Topic`，幂等 202 |
| GET /topics/:id | `{topic:Topic,messages:Message[],controls:Control[]}` |
| POST /topics/:id/submissions | `{submission_id,text}` → `Message` 用户气泡，幂等 202 |
| POST /topics/:id/interrupt | `{request_id,submission_id}` → `{status:"accepted"}`，幂等 202 |
| POST /controls/:id/responses | `{response_id,answer}` → `{status:"responding"}`，幂等 202 |
| GET /inbox | `InboxItem[]` |
| PUT/DELETE /devices/current/push-registration | PUT `{token}` 注册 Expo Push token，DELETE 移除，204 |
| POST /ws-tickets | `{ticket:string}`，短时单次 |
| GET /events?ticket=… | WS，服务端仅发 `{type:"changed",topic_id?:string}` 和连接就绪变更。移动端重新拉取受影响数据。握手 URL 不写日志。 |

Topic `{topic_id,profile_id,title,status:"creating"|"ready"|"error",error?:string}`。Profile `{profile_id,label}`。Message `{message_id,role:"user"|"assistant",text,status:"accepted"|"queued"|"streaming"|"final"|"failed"|"unknown"|"cancelled",submission_id?:string,error?:string}`。Control `{control_id,kind:"approval"|"clarify",prompt,choices:string[],status:"pending"|"responding"|"closed"|"unknown"}`。InboxItem `{inbox_id,text,created_at}`。

## BFF 与 Connector

WS `/internal/connector/v1/events` 由 Connector 发起，握手 `Authorization: Bearer <CONNECTOR_TOKEN>`。云端发送以下命令 `{type:"command",command_id,topic_id,profile_ref,session_id?,kind,body}`，其中 session_id 是绑定的 Hermes ID。所有使用已绑定会话的命令均含 session_id。

- `create` body 为 `{request_id}`。
- `submit` body 为 `{submission_id,text}`。
- `interrupt` body 为 `{submission_id}`，Connector 核对该提交仍在运行后，按当前已验证的活动代次调用。
- `respond` body 为 `{control_id,response_id,answer}`。
- `watch` body 为 `{}`，使用独立 command_id（临时，不写入 BFF 命令表），WS 重连时同步每个已绑定 Topic。Connector 先登记 scope，再恢复上游。BFF 忽略 watch 结果。

Connector 返回 `{type:"command_result",command_id,status:"ok"|"error"|"unknown",session_id?,admission_id?,error?,control_status?}`。创建成功带 session_id，提交已接纳带 admission_id，控制如能确认关闭带 control_status。普通写命令的结果由 BFF 持久化后回 `{type:"ack",id:command_id}`。重复命令只回存量结果或 unknown，禁止换 ID 重做。控制响应确认不足时使用 unknown。BFF 当前连接关闭后重派仍未结的原命令。

Connector 异步帧全部含 `event_id,topic_id`。BFF 持久接收后回 `{type:"ack",id:event_id}`：

- `{type:"message",event_id,topic_id,message_id,submission_id?,text,status:"streaming"|"final"}`，同一响应使用稳定 message_id，text 为完整当前累计文本。final 优先于迟到 streaming。
- `{type:"submission",event_id,topic_id,submission_id,status:"queued"|"streaming"|"final"|"failed"|"cancelled"|"unknown",error?}`，更新原用户气泡执行状态，禁止复活已知终态。
- `{type:"control",event_id,topic_id,control_id,kind,prompt,choices,status}`，公开形状同 Mobile Control。审批身份仅由 Connector 映射到真实上游 ID。
- `{type:"delivery",event_id,delivery_id,profile_ref,text}`，无 topic_id，投递到单账户 Inbox，BFF 按 ID 去重。以 delivery_id 同作 event_id 即可。

Connector 端环境 `BFF_URL`、`CONNECTOR_TOKEN`、可选 `HERMES_BIN`、`CONNECTOR_DB_PATH`。开发容器 `hermes-dev` 的 8642 端口使用 HTTP Runs。设置 `HERMES_API_URL=http://127.0.0.1:8642` 和 `HERMES_API_KEY` 启用该模式。BFF 端环境 `DATABASE_URL`、`APP_PAIRING_TOKEN`、`CONNECTOR_TOKEN`、可选 `PORT`（3000）、`HOST`（127.0.0.1）、`HERMES_PROFILES`（default）、`EXPO_ACCESS_TOKEN`。隔离开发可用本地 HTTP，远程用 HTTPS/WSS。
