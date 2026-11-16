# Hermes 移动端投递插件

插件提供 [Bark 推送](#bark-推送)和 Hermes 移动端投递渠道，支持收件箱与指定聊天会话。将 `plugin.yaml`、`__init__.py` 和 `src/` 复制到负责发送的 Hermes 配置档案下的 `plugins/hermes-mobile-delivery` 目录。默认路径为 `~/.hermes/plugins/hermes-mobile-delivery`。在该配置档案下运行 `hermes plugins enable hermes-mobile-delivery`。

## 原生命令目录与执行

连接器通过 Hermes API Server 的 `POST /api/platforms/hermes_mobile/events` 调用已连接的平台插件，使用与聊天 API 相同的 Bearer 凭证。插件复用 API Server 的原生密钥解析（包括 `extra.key` 和多档案 secret scope），不使用投递令牌代替 API 凭证。请求的 `profile_ref` 必须同时匹配插件实例所属档案和实际运行数据目录；无法匹配时拒绝请求，不回退到默认档案。

目录请求为 `{"kind":"catalog","profile_ref":"default"}`，返回 `{"commands":[...]}`。每项来自正在运行的 Hermes `COMMAND_REGISTRY`，并按原生网关可用性筛选，包含 `name`、`description`、`category`、`aliases`、可选 `args_hint`、可选 `subcommands`、`supported` 和可选 `unavailable_reason`。原生升级增删命令后，重新查询即可取得新目录；参数提示与二级页面选项均来自此目录。

执行请求示例：

```json
{
  "kind": "execute",
  "profile_ref": "default",
  "request_id": "e184243a-a270-41ff-a695-38f0d6c5099b",
  "session_id": "mobile_0184a946-ec94-4aaf-bdca-9c7afaa37eb0",
  "command": "/commands 2"
}
```

插件目前兼容以下原生命令，别名与参数仍交给 Hermes 的解析器和处理程序：

- 原生格式化：`/help`、`/commands`、`/version`、`/profile`、`/bundles`。
- 当前 API 会话：`/status`、`/usage`、`/title`、`/context`、`/diff`、`/undo`、`/new`（包括原生 `/reset` 别名）、`/compress`。
- 当前配置档案：`/personality`、`/memory`、`/skills` 的原生待审写入管理、`/insights`。命令仍受原生配置可用性控制；App 的技能选择器保持独立入口。
- 网关控制：`/restart`。

会话命令使用既有 API `SessionDB` 的临时视图调用原生处理程序，不新建影子聊天，也不向网关路由目录登记另一套会话。`/undo` 使用原生软删除并返回实际 `rewound_turns`；`/compress` 保留原生参数、预览、模型锁和压缩逻辑，确实旋转会话时返回 `session_id`；`/new` 调用原生重置逻辑并返回 `reset:true` 和新 `session_id`。这些字段位于 `native_result`。连接器按旧绑定原子更新新 ID，并在重置时清理本地模型与思考覆盖。App 保留已有聊天记录用于查看历史；模型后续上下文采用原生撤回、压缩或重置后的内容。

`/new` 和 `/undo` 保留原生破坏性命令确认。需要确认时只返回 `native_result.confirmation`，尚未修改历史；App 显示仅本次、始终允许和取消。确认后以新 `request_id` 提交相同命令及 `approval:"once"` 或 `approval:"always"`，由原生确认回调完成执行和永久偏好保存。`/new` 与原生网关一致，可能先停止正在运行的回复再显示确认；取消保留历史，但不恢复已停止的运行。

`/personality` 等档案命令在目标 `HERMES_HOME` 下运行原版 Hermes 处理程序，避免多档案共用进程的模块级路径写入默认档案。连接器在每轮发送前调用私有 `{"kind":"runtime","profile_ref":"default","session_id":"..."}`，读取原生系统提示加载器返回的 `{"system_prompt":"..."}` 并合并到 API instructions，因此人格更改会影响后续回复。尚未提供此能力的旧插件保留原有聊天；一旦确认该档案支持运行配置读取，连接器会持久记录此能力，此后的读取故障会阻止发送，不静默丢弃人格。这份运行配置只留在 Hermes 主机与连接器之间。

`/restart` 通过 `BasePlatformAdapter.handle_message()` 进入真正的网关命令分发，保留原生排空、去重、权限检查和重启通知，不调用强制重启 HTTP 接口。它使用独立控制来源，回复目标仍是请求中的移动端会话。会话与档案兼容命令也遵守原生 `command:<name>` 钩子的拒绝与接管结果；同名命令参数改写会重新校验，跨命令改写会提示重新提交，以免回执类型与实际副作用不一致。`/goal` 尚未接通 API 回合的持续执行生命周期，不会仅写目标状态就声称支持。其余命令由连接器依据原生能力进一步支持；不支持的命令不会作为普通提示词发送给模型。

入站身份固定为 `mobile-api`。平台使用原生 `authorization_is_upstream` 契约，将配对设备及档案授权交给 BFF，并在此校验 API Server 凭证；原生 slash 管理权限仍生效。如果配置了 `platforms.hermes_mobile.extra.allow_admin_from`，需要在其中显式包含 `mobile-api` 才能授予管理员命令权限。插件不会自动修改权限配置。

执行前在私有 SQLite 中持久登记 `request_id`。相同编号只返回原回执，不再次执行；编号与另一条命令、确认选项、档案或会话冲突时拒绝。命令最多 8 KiB，接受大小写命令名，不接受多个前导斜杠、换行或其他控制字符。收到原生处理结果才返回 `{"ok":true,"output":"原生输出"}`；重启必须收到与请求编号及会话匹配的原生回复，这不表示重启已经完成。明确拒绝返回 `{"ok":false,"status":"error","error":"原因"}`；发出后十秒没有确认、进程重启或回执无法保存时返回 `status:"unknown"`，不得自动换编号重试。

耗时会话和档案命令由独立任务继续处理并持久化最终回执，查询使用 `{"kind":"result","profile_ref":"default","request_id":"原UUID","session_id":"原会话ID"}`。查询不会触发执行；登记尚未可见或进程中断留下的未确认记录仍返回 `unknown`。连接器对未确认的历史修改持续保留会话写入阻塞并查询原请求，收到最终回执后才更新绑定并恢复发送。插件同时检查原生 API 活跃运行，撤回、重置和压缩不会与已知活跃回复并行；压缩等后台工作使用原生 API 工作登记，优雅重启会等到结果与回执保存完成。原生 `/restart` 的晚到回复及新进程启动通知继续走现有会话投递渠道。缺少原生权限检查的旧版运行时仍可查询目录，但拒绝执行命令。

## Bark 推送

在 Hermes 配置档案的 `.env` 或进程环境中设置 `BARK_KEY`。从 Bark App 复制的推送地址中，服务器地址填入 `BARK_URL`，设备 Key 填入 `BARK_KEY`。`BARK_URL` 省略时使用官方服务 `https://api.day.app`。定时任务使用 `bark` 作为投递目标时，设置 `BARK_HOME_CHANNEL=1`。如果 Hermes 网关正在运行，重启以加载配置。

```dotenv
BARK_KEY=替换为设备Key
# BARK_URL=https://bark.example.com
BARK_HOME_CHANNEL=1
```

```sh
hermes send --to bark '早报已生成'
hermes send --to bark '{"title":"早报","subtitle":"今日摘要","markdown":"**早报已生成**","group":"日报","level":"timeSensitive","url":"https://example.com/report"}'
```

纯文本作为通知正文。以 `{` 开头的消息按 JSON 对象解析，字段值随 `POST /push` 传给 Bark。未指定 `level` 时默认使用 `timeSensitive`（时间敏感），显式指定的级别会保留。支持官方全部推送字段，包括 `image`、`soundUrl`、`ciphertext`、`iv`、`id` 和 `delete`。`device_key` 和 `device_keys` 由 `BARK_KEY` 生成，多个设备 Key 用英文逗号分隔。`BARK_HOME_CHANNEL` 的 `1` 是 Hermes 内部目标编号。 [Bark 参数文档](https://bark.day.app/#/params)

定时任务也可直接使用 `bark:1` 作为投递目标，此时可省略 `BARK_HOME_CHANNEL`。如果要从任务输出发送 JSON，在 Hermes 的 `config.yaml` 中设置 `cron.wrap_response: false`，让任务输出完整的 JSON 对象。部分设备投递失败时，Hermes 网关可能重试整批推送。

## 移动端收件箱

`hermes_mobile` 平台通过 HTTP 向应用后端（BFF）投递文本和文件。Hermes 插件和 BFF 可以运行在不同容器或主机，只需能通过网络访问投递 API。App 可在消息中查看图片，播放音视频，预览 Markdown 和 HTML 文件。

1. 在 BFF 环境中设置 `INBOX_DELIVERY_TOKEN`。可用 `openssl rand -hex 32` 单独生成令牌。如果使用 Compose，将它写入项目的 `.env`，然后运行 `docker compose up -d --build --wait` 应用配置。
2. 在 Hermes 配置档案的 `.env` 中填入下面三项。`HERMES_MOBILE_INBOX_TOKEN` 使用与 BFF 的 `INBOX_DELIVERY_TOKEN` 相同的值。使用具名配置档案时，将 `HERMES_MOBILE_PROFILE` 设为其准确名称，并把该名称加入 BFF 的 `HERMES_PROFILES`。如果 Hermes 网关正在运行，重启以加载配置。

   ```dotenv
   HERMES_MOBILE_HOME_CHANNEL=1
   HERMES_MOBILE_INBOX_URL=https://mobile.example.com/internal/inbox/v1/deliveries
   HERMES_MOBILE_INBOX_TOKEN=替换为投递令牌
   ```

跨主机使用 HTTPS，并在反向代理转发 `/internal/inbox/v1/deliveries`、`/internal/attachments/v1/` 和 `/internal/profiles/v1/avatar`。文件上传使用同一个 BFF 域名和投递令牌，反向代理需允许至少 70 MiB 的 JSON 请求体。如果 BFF 在同一受信任的容器网络中独立运行，将其 `HOST` 设为 `0.0.0.0`，插件可用 `http://bff:4317/internal/inbox/v1/deliveries`，其中 `bff` 为 BFF 的服务名，端口与 BFF 的 `PORT` 一致。

运行 `hermes send --to hermes_mobile "来自 Hermes 的测试消息"` 测试收件箱投递，或将定时任务的投递目标设为 `hermes_mobile`。已配置的收件箱默认目标也可写作 `hermes_mobile:1`。

指定会话时使用与 Telegram 相同的 `平台:目标ID` 格式：

```sh
hermes send --to hermes_mobile:<session-id> "文件已生成"
hermes mobile-send --to hermes_mobile:<session-id> --file /tmp/report.md
```

请将 `<session-id>` 替换为该配置档案下已绑定到 App 会话的 Hermes 会话 ID（不是 App 的话题 UUID），执行时不要保留尖括号。目标 ID 允许字母、数字、下划线、点和连字符，首位必须是字母或数字，最多 512 字符；不支持额外的线程 ID。目标会话必须已就绪；不存在或属于其他配置档案时拒绝投递，不回退到收件箱。文件和正文会作为一条助手消息出现在该会话列表中，纯附件消息也会显示。会话投递沿用聊天同步，不产生收件箱记录或收件箱系统推送。

连接器在每轮聊天通过 Hermes 原生的 `api_text`（Canonical）或 `instructions`（HTTP Runs）传入当前会话的投递目标，提示 Agent 优先投递到当前会话，并保留原始用户消息。命令示例显式带上当前 `--profile`，避免终端默认档案改变投递归属。用户明确要求收件箱时使用 `hermes_mobile`。已有的 `mobile_*` HTTP 会话中，`mobile-send` 省略 `--to` 也会从 Hermes 的当前会话环境选择目标；普通终端和定时任务默认收件箱。Canonical 会话使用连接器提供的显式 `--to hermes_mobile:<session-id>`，避免把其他本地 Hermes 会话误认为移动端会话。

原生 `hermes send`、`send_message` 和定时任务的字母会话 ID 使用 Hermes 的平台目标解析扩展；较旧版本缺少该扩展时，使用 `hermes mobile-send --to hermes_mobile:<session-id>`。

### 发送文件

插件提供 `mobile-send` 命令，正文可省略，`--file` 可重复指定：

```sh
hermes mobile-send --file /tmp/chart.png
hermes mobile-send "日报已生成" --file /tmp/report.md --file /tmp/report.html
hermes mobile-send --file /tmp/recording.m4a --file /tmp/demo.mp4
hermes --profile work mobile-send --file /tmp/report.md
hermes mobile-send --to hermes_mobile --file /tmp/report.md
```

显式 `--to hermes_mobile` 始终投递到收件箱，即使在聊天会话中执行。

每条消息最多 10 个文件，单个文件不超过 50 MiB；文件必须非空、不是符号链接，并通过 Hermes 原生的媒体路径安全检查。图片、音视频和文档保留原始字节，不转码。远程图片 URL 需要先下载为本地文件再投递。

支持 `StandaloneSendPolicy` 的新版原版 Hermes 也可以使用原生媒体命令：

```sh
hermes send --to hermes_mobile 'MEDIA:/tmp/chart.png'
hermes send --to hermes_mobile '日报已生成 MEDIA:/tmp/report.md'
```

较旧的 Hermes 会在调用自定义平台插件前拒绝或丢弃媒体，遇到此情况使用上面的 `hermes mobile-send --file ...`。`hermes send --file` 的含义是读取消息正文，不是上传附件。插件不修改 Hermes 源码。网关原生图片、视频、语音和文档发送方法都已接入，定时任务向插件直接发送的 `MEDIA:` 内容使用 Hermes 自带解析器识别。

## 设置移动端头像

插件通过 Hermes 原生插件接口注册 `hermes_mobile_set_profile_avatar` 工具。安装或升级后重启 Hermes 会话或网关，让 Agent 加载工具。调用示例：

```json
{
  "profile_ref": "work",
  "image_path": "/tmp/avatar.png"
}
```

`profile_ref` 使用 BFF `HERMES_PROFILES` 允许名单中的原始配置档案名称，不是 App 中的别名或 UUID。头像仅更新 Hermes 移动端渠道，不改变别名、首页默认档案或其他渠道。App 刷新配置档案后显示新头像。图片必须是通过 Hermes 原生媒体路径安全检查的本地 JPEG、PNG、GIF 或 WebP 文件，不允许符号链接，最大 2 MiB；远程 URL 需先保存为本地图片。

工具复用 `HERMES_MOBILE_INBOX_URL` 的主机和 `HERMES_MOBILE_INBOX_TOKEN`，向 `PUT /internal/profiles/v1/avatar` 发送 `{ "profile_ref": "work", "avatar": { "name": "avatar.png", "mime": "image/png", "size": 123, "content_base64": "..." } }`。成功响应为 `200`，`data` 包含更新后的 `Profile`（`profile_id`、`label`、`avatar_url` 等）。服务端校验令牌、允许名单、图片类型和大小。工具仅在收到有效成功回执后返回 `success: true`；失败不会进入消息投递队列，修正后可重新调用。

## 投递 API

`POST /internal/inbox/v1/deliveries` 接受 `Authorization: Bearer <投递令牌>` 和 `Content-Type: application/json`。正文包含 UUID `delivery_id`、BFF 允许的 `profile_ref` 和最多 128 KiB 的 UTF-8 文本 `text`，可选 `title` 为最多 256 字节的非空 UTF-8 标题。可选 `attachments` 包含最多 10 个已上传文件的引用；有文件时 `text` 可以为空。可选 `session_id` 按上述目标 ID 规则校验，指定时投递到同一 `profile_ref` 下已绑定的会话；省略时投递收件箱。`title` 只用于收件箱标题。

```json
{
  "delivery_id": "e184243a-a270-41ff-a695-38f0d6c5099b",
  "profile_ref": "default",
  "title": "任务完成",
  "text": "定时任务已完成"
}
```

文件先通过 `PUT /internal/attachments/v1/<附件 UUID>` 上传到同一个 BFF，使用相同鉴权和 JSON 内容类型。正文为 `{ "profile_ref": "default", "name": "report.md", "mime": "text/markdown", "size": 3, "content_base64": "YWJj" }`。成功响应中的 `data` 是 `{ "attachment_id": "附件 UUID", "name": "report.md", "mime": "text/markdown", "size": 3 }`，随后放进投递请求的 `attachments` 数组。插件验证上传回执与本地快照一致后才投递消息。

省略 `title` 时，BFF 生成标题；完整 `text` 保留在消息中。移动端列表显示标题和两行正文，详情显示完整内容与文件。收件箱响应同时包含所属 `profile_id`，历史记录也会补齐标题和配置档案，无须迁移队列。

BFF 在同一个事务中保存收件箱消息和通知任务，或保存指定会话的助手消息，然后返回 `204 No Content`。重发同一个投递 ID、目标和相同内容也会返回 `204`，内容或目标冲突则返回 `409 / IDEMPOTENCY_CONFLICT`。鉴权失败返回 `401`。未配置投递令牌或配置档案未加入允许名单时返回 `404`。指定会话不存在或属于其他档案时返回 `404 / DELIVERY_TARGET_NOT_FOUND`，同档案会话尚未就绪时返回 `409 / DELIVERY_TARGET_NOT_READY`。请求内容校验失败返回 `422`。

Hermes 先把消息、目标会话和附件字节一起持久化，再通过 API 投递。即使源文件后来被删除或当前聊天发生变化，重试仍使用原快照和原目标。网关运行时会自动补投待确认的消息。独立运行 `hermes send` 或 `hermes mobile-send` 会立即尝试投递这条消息。响应中的 `delivery_status` 区分 `queued`（已入队）、`retryable`（等待重试）、`auth_blocked`（鉴权暂停）、`delivered`（已送达）和 `failed`（已隔离）。`success: true` 对前三种状态只表示持久化接收，不能当作送达；`failed` 返回 `success: false` 并保留投递 ID。启动 Hermes 网关会继续投递可调度的消息。每次重试沿用同一投递 ID 和附件 UUID，收到消息投递的 `204` 后才移除本地记录及附件快照。

### 查询和恢复投递

不存在的目标、幂等冲突和内容校验失败会进入 `failed`，后面的正常消息可以继续发送。会话尚未就绪、连接中断、`408`、`429`、`5xx` 和旧版服务无法区分原因的 `404` 使用持久化退避：首次等待 5 秒，之后翻倍，最长 300 秒；累计 10 轮可重试失败后隔离，保留原记录供显式重试。每轮中的每个 HTTP 请求最多尝试 3 次。每轮只领取已到重试时间的记录，失败项不会一直占据前 20 条。

`401/403` 将当前配置档案暂停 300 秒，再尝试恢复；暂停期间新消息仍可入队。鉴权失败不耗尽单条消息的自动重试次数，也不会把整个档案的积压标记为永久失败。修改凭证后，可以显式重试一条记录解除该档案的暂停。

```sh
hermes mobile-queue list
hermes mobile-queue list --id <delivery-id>
hermes mobile-queue retry <delivery-id>
hermes mobile-queue cancel <delivery-id>
hermes --profile work mobile-queue list
```

命令仅操作当前配置档案，以 JSON 输出状态、原目标、正文、附件元数据、尝试次数、时间和最近 HTTP 状态/错误码；附件内容不会输出。`retry` 重新排队并重置尝试次数，沿用原 ID、原目标和附件快照，不立即发送。`cancel` 停止后续投递，保留正文、原目标、错误证据及附件快照；取消后不能再次重试。租约内正在投递的记录不能重试或取消；进程异常后等待租约到期即可处理。取消不会撤回服务端已经接收的消息。失败和取消记录不会自动清理，仍占用本地存储。

队列默认放在 Hermes 配置档案数据目录下的 `mobile-delivery/queue.sqlite3`。可通过 `HERMES_MOBILE_SPOOL_PATH` 指定 Hermes 容器内的绝对路径。队列目录和文件仅供运行 Hermes 的用户访问。Docker 部署将队列保存在 Hermes 自己的持久卷即可。

原有队列可直接升级，插件保留旧投递表结构，新增关联表保存会话目标和调度状态；旧记录仍投递收件箱。升级时先确保新版 BFF 可用，暂停定向消息生产，停止所有仍运行旧代码的 Gateway/消费者，再更新插件及相关运行环境并重启 Gateway。确认消费者已加载新版后，恢复定向发送。只替换磁盘上的插件或 reload handlers 不代表长驻消费者已换版。旧消费者不识别会话目标和失败状态，混用会导致误投或重新处理隔离项；仍有附件、会话投递或隔离记录时不要降级插件。

## 从共享队列升级

升级插件时可在 Hermes 配置中保留原有的 `HERMES_MOBILE_SPOOL_PATH`。如果 Hermes 也迁移到新容器，先停止旧版插件和连接器，再把原队列放到 Hermes 的持久卷中。新版插件会沿用原投递 ID 继续发送本档案的记录。新版 BFF 也兼容旧版连接器的投递帧，可以先用旧版连接器清空队列。升级连接器后，可以移除它的投递队列挂载、`HERMES_MOBILE_SPOOL_PATH` 和 `HERMES_MOBILE_PYTHON`。
