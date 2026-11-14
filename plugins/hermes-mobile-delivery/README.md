# Hermes 移动端投递插件

插件提供 [Bark 推送](#bark-推送)和 Hermes 移动端收件箱两个渠道。将 `plugin.yaml`、`__init__.py` 和 `src/` 复制到负责发送的 Hermes 配置档案下的 `plugins/hermes-mobile-delivery` 目录。默认路径为 `~/.hermes/plugins/hermes-mobile-delivery`。在该配置档案下运行 `hermes plugins enable hermes-mobile-delivery`。

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

`hermes_mobile` 平台通过 HTTP 向应用后端（BFF）投递纯文本。Hermes 插件和 BFF 可以运行在不同容器或主机，只需能通过网络访问投递 API。

1. 在 BFF 环境中设置 `INBOX_DELIVERY_TOKEN`。可用 `openssl rand -hex 32` 单独生成令牌。如果使用 Compose，将它写入项目的 `.env`，然后运行 `docker compose up -d --build --wait` 应用配置。
2. 在 Hermes 配置档案的 `.env` 中填入下面三项。`HERMES_MOBILE_INBOX_TOKEN` 使用与 BFF 的 `INBOX_DELIVERY_TOKEN` 相同的值。使用具名配置档案时，将 `HERMES_MOBILE_PROFILE` 设为其准确名称，并把该名称加入 BFF 的 `HERMES_PROFILES`。如果 Hermes 网关正在运行，重启以加载配置。

   ```dotenv
   HERMES_MOBILE_HOME_CHANNEL=1
   HERMES_MOBILE_INBOX_URL=https://mobile.example.com/internal/inbox/v1/deliveries
   HERMES_MOBILE_INBOX_TOKEN=替换为投递令牌
   ```

跨主机使用 HTTPS，并在反向代理转发 `/internal/inbox/v1/deliveries`。如果 BFF 在同一受信任的容器网络中独立运行，将其 `HOST` 设为 `0.0.0.0`，插件可用 `http://bff:4317/internal/inbox/v1/deliveries`，其中 `bff` 为 BFF 的服务名，端口与 BFF 的 `PORT` 一致。

运行 `hermes send --to hermes_mobile "来自 Hermes 的测试消息"` 测试投递，或将定时任务的投递目标设为 `hermes_mobile`。已配置的默认目标也可写作 `hermes_mobile:1`。插件拒绝其他投递目标和会话串 ID。

## 投递 API

`POST /internal/inbox/v1/deliveries` 接受 `Authorization: Bearer <投递令牌>` 和 `Content-Type: application/json`。正文包含 UUID `delivery_id`、BFF 允许的 `profile_ref` 和最多 128 KiB 的 UTF-8 文本 `text`。

```json
{
  "delivery_id": "e184243a-a270-41ff-a695-38f0d6c5099b",
  "profile_ref": "default",
  "text": "定时任务已完成"
}
```

BFF 在同一个事务中保存收件箱消息和通知任务，然后返回 `204 No Content`。重发同一个投递 ID 和相同内容也会返回 `204`，内容冲突则返回 `409`。鉴权失败返回 `401`。未配置投递令牌或配置档案未加入允许名单时返回 `404`。请求内容校验失败返回 `422`。

Hermes 先接受并保存消息，再通过 API 投递。网关运行时会自动补投待确认的消息。独立运行 `hermes send` 会立即尝试投递这条消息，也可能在消息仍处于队列时返回成功。启动 Hermes 网关会继续投递队列中的消息。每次重试沿用同一投递 ID，收到 `204` 后才移除本地记录。

队列默认放在 Hermes 配置档案数据目录下的 `mobile-delivery/queue.sqlite3`。可通过 `HERMES_MOBILE_SPOOL_PATH` 指定 Hermes 容器内的绝对路径。队列目录和文件仅供运行 Hermes 的用户访问。Docker 部署将队列保存在 Hermes 自己的持久卷即可。

## 从共享队列升级

升级插件时可在 Hermes 配置中保留原有的 `HERMES_MOBILE_SPOOL_PATH`。如果 Hermes 也迁移到新容器，先停止旧版插件和连接器，再把原队列放到 Hermes 的持久卷中。新版插件会沿用原投递 ID 继续发送本档案的记录。新版 BFF 也兼容旧版连接器的投递帧，可以先用旧版连接器清空队列。升级连接器后，可以移除它的投递队列挂载、`HERMES_MOBILE_SPOOL_PATH` 和 `HERMES_MOBILE_PYTHON`。
