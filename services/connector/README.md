# 连接器

连接器在 Node 24 上运行，主动通过 WSS 连接 BFF，并维护本地 SQLite 队列。新会话使用原版 Hermes Canonical Gateway，可用本机 CLI 或 Webapp 票据接入。旧 HTTP Runs 会话继续使用原有的 HTTP 会话绑定。 [本地运行命令和凭据配置](../../README.md#run-the-personal-mvp)

运行 `pnpm dev:connector` 可从源码启动。运行 `pnpm --filter @hermes-mobile/connector pack` 可生成包含 `hermes-mobile-connector` 可执行文件的本地 npm 压缩包。收件箱投递由 Hermes 插件直接调用 BFF。 [投递插件](../../plugins/hermes-mobile-delivery/README.md)

聊天回复的本地文件交付需要配置 `HERMES_WEBAPP_URL` 和 `HERMES_DASHBOARD_SESSION_TOKEN`。连接器识别最终回复中的 `MEDIA:/绝对路径`、`[文件](/绝对路径)` 和 `![图片](file:///绝对路径)`，通过原版 Webapp 文件接口读取并上传到 BFF；不会修改 Hermes 源码或将凭据发往回复中的 URL。图片、音频、视频、Markdown、HTML 和其他文件均以附件元数据交付，单条最多 10 个，单个最多 50 MiB。远程 URL 保留在正文中。

传输完成后才记录消息终态及附件引用；重连沿用本地队列和相同内容的附件 ID。单个文件传输失败时重试一次，仍失败则保留原引用并在回复中显示交付失败提示。超过限制的文件也保留原引用。
