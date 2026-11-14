# 连接器

连接器在 Node 24 上运行，主动通过 WSS 连接 BFF，并维护本地 SQLite 队列。新会话使用原版 Hermes Canonical Gateway，可用本机 CLI 或 Webapp 票据接入。旧 HTTP Runs 会话继续使用原有的 HTTP 会话绑定。 [本地运行命令和凭据配置](../../README.md#run-the-personal-mvp)

运行 `pnpm dev:connector` 可从源码启动。运行 `pnpm --filter @hermes-mobile/connector pack` 可生成包含 `hermes-mobile-connector` 可执行文件的本地 npm 压缩包。收件箱投递由 Hermes 插件直接调用 BFF。 [投递插件](../../plugins/hermes-mobile-delivery/README.md)
