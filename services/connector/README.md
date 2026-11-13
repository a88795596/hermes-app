# 连接器

连接器在 Node 24 上运行，主动通过 WSS 连接 BFF，并维护本地 SQLite 队列。它支持本地 Canonical Gateway，也支持显式配置的 Hermes HTTP Runs 服务。 [本地运行命令和凭据配置](../../README.md#run-the-personal-mvp)

运行 `pnpm dev:connector` 可从源码启动。运行 `pnpm --filter @hermes-mobile/connector pack` 可生成包含 `hermes-mobile-connector` 可执行文件的本地 npm 压缩包。需要 Python 投递插件时，在 Hermes 主机上单独安装。
