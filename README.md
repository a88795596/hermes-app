# Hermes 移动端

本仓库是 Hermes 移动端的 pnpm 工作区。

| 目录 | 模块 | 职责 |
| --- | --- | --- |
| `apps/mobile` | Expo Router 应用 | 原生客户端和本地优先的界面 |
| `services/bff` | Fastify 服务 | 对外提供移动端 API，负责授权与数据投影 |
| `services/connector` | Node 服务 | 从 Hermes 主机主动连接 BFF |
| `packages/protocol` | 共享包 | 定义移动端与连接器的通信协议 |
| `packages/hermes-adapter` | 共享包 | 校验并规范化 Hermes 数据 |
| `plugins/hermes-mobile-delivery` | Hermes Python 插件 | 为定时任务和 `hermes send` 注册文本投递通道 |

`packages/protocol` 独立于应用框架。Hermes 凭据由连接器保管，移动端只依赖能在设备上运行的代码。BFF 通过连接器与 Hermes 通信。

## 设计与交付

- [iOS 和 Android 技术设计](docs/superpowers/specs/2026-11-13-hermes-mobile-design.md)
- [移动端与连接器契约基线](docs/superpowers/specs/2026-11-13-hermes-mobile-contracts.md)
- [并行开发工作包与验收用例](docs/superpowers/plans/2026-11-13-hermes-mobile-parallel-plan.md)
- [个人版已实现的通信协议](docs/superpowers/plans/2026-11-13-personal-mvp-wire.md)
- [工程设计规格书 v2](docs/reference/hermes-expo-engineering-spec-v2.md)

<a name="run-the-personal-mvp"></a>

## 本地运行个人版

使用 Node 24 和 pnpm 10.14 安装依赖。个人版需要一个 BFF 进程、一个 PostgreSQL 数据库和一个连接器进程。BFF 启动时自动建表。以下命令均在工作区根目录执行。

```sh
pnpm install
pnpm typecheck
```

1. 启动 BFF，配置数据库地址和两个不同的随机令牌。手机用配对令牌换取设备专用凭据，连接器使用机器令牌。可用 Docker 启动专用的开发数据库。

   ```sh
   docker run -d --name hermes-mobile-postgres -p 127.0.0.1:55432:5432 \
     -e POSTGRES_DB=hermes_mobile -e POSTGRES_PASSWORD=hermes-dev-local \
     -v hermes-mobile-pgdata:/var/lib/postgresql/data postgres:16-alpine
   ```

   ```sh
   export DATABASE_URL='postgresql://postgres:hermes-dev-local@127.0.0.1:55432/hermes_mobile'
   export APP_PAIRING_TOKEN='REPLACE_WITH_YOUR_PAIRING_SECRET'
   export CONNECTOR_TOKEN='REPLACE_WITH_YOUR_MACHINE_SECRET'
   export PORT=4317
   pnpm dev:bff
   ```

2. 本地 `hermes-dev` 容器通过 8642 端口提供 HTTP Runs API。将 API 密钥留在连接器的环境变量中。以下命令读取已配置的密钥。执行时请关闭 Shell 命令跟踪。

   ```sh
   export BFF_URL='http://127.0.0.1:4317'
   export CONNECTOR_TOKEN='THE_SAME_MACHINE_SECRET'
   export HERMES_API_URL='http://127.0.0.1:8642'
   export HERMES_API_KEY="$(docker exec hermes-dev printenv API_SERVER_KEY)"
   export CONNECTOR_DB_PATH="$PWD/.data/connector.sqlite"
   pnpm dev:connector
   ```

   HTTP 适配器使用 Hermes API 管理的会话。如果安装了较新版本的 Hermes，可将 `HERMES_API_URL` 留空，以网关所用的账户在同一台主机上运行连接器，并将 `HERMES_BIN` 指向支持 `gateway attach --json` 的命令行程序。连接器与 BFF 的数据库应配套使用，绑定同一个 Hermes 后端和传输方式。试用其他后端时请使用独立的数据库。

   在 HTTP 模式下，聊天中的「技能」菜单读取 `GET /p/<profile>/v1/skills`。如果该接口因 `include_editorial` 错误返回 500，运行 `docker build -t hermes-mobile-runtime - < services/connector/Dockerfile.hermes`，然后使用 `hermes-mobile-runtime` 作为 Hermes 容器镜像。 [上游修复](https://github.com/NousResearch/hermes-agent/pull/108968)

   如果聊天运行失败，且容器日志显示 `no_provider_configured`，运行 `docker exec -it -u hermes hermes-dev hermes model`，为容器中的 Hermes 用户配置模型服务商。API 服务密钥用于验证连接器，模型服务商使用自己的凭据。

3. 在另一个终端启动应用。按平台选择命令，构建并打开开发客户端。

   ```sh
   pnpm --filter @hermes-mobile/mobile exec expo run:ios
   pnpm --filter @hermes-mobile/mobile exec expo run:android
   ```

   安装开发客户端后，运行 `pnpm dev:mobile` 重新启动 Metro。使用 `APP_PAIRING_TOKEN` 和 BFF 地址配对。在 iOS 模拟器中使用 `http://127.0.0.1:4317`，在 Android 模拟器中使用 `http://10.0.2.2:4317`，在真机上使用 BFF 受信任的 HTTPS 反向代理。原生应用通过 SecureStore 保存设备令牌，并在应用私有的 SQLite 数据库中保存历史记录和待发文本。开发构建配置 Expo 项目 ID 和 APNs／FCM 凭据后，可在「设置」的「连接」中开启收件箱通知。

4. 如需在本地通过 npm 安装连接器，运行 `pnpm --filter @hermes-mobile/connector pack` 并安装生成的压缩包。定时投递与 `hermes send` 需要在 Hermes 主机安装插件，并让连接器访问插件的本地投递队列。 [Hermes 投递插件](plugins/hermes-mobile-delivery/README.md)

<a name="interactive-chat"></a>

## 聊天交互

在话题中发送 `/model`，先选择服务商，再选择模型。菜单会显示当前 Hermes 配置档案下可用的服务商，并标记当前选项。等本轮回复完成后即可切换模型，新选择对当前话题的后续对话生效。

当智能体调用 `clarify` 时，点击选项即可回答当前的问题。澄清卡片也支持多选、输入自定义答案和跳过问题。

使用 HTTP Runs 时，Hermes API 对应的配置档案须公开运行中等待处理的交互，并启用 `clarify` 工具。在开发容器中，用 Hermes 用户执行以下命令即可启用该工具。

```sh
docker exec -u hermes hermes-dev hermes tools enable --platform api_server clarify
```

如果使用具名配置档案，命令中的 Hermes 调用部分为 `hermes --profile <name> tools enable --platform api_server clarify`。如果使用 Canonical Gateway，话题所绑定的本地会话工具集须包含 `clarify`。

个人版已实现单账户、文本聊天，以及 WSS 变更通知配合 HTTP 补拉。媒体附件、从系统分享导入、快照游标、生产级部署和设备验证另行交付。 [已实现的通信协议](docs/superpowers/plans/2026-11-13-personal-mvp-wire.md)

<a name="enable-manage-on-mobile"></a>

## 启用移动端管理功能

在连接器所在主机和运行环境中，启动提供控制台 API 的 Hermes 版本。聊天、定时调度和管理应使用同一套 Hermes 安装及配置档案数据。为控制台和连接器进程设置相同的控制台会话令牌。以下命令在 Hermes 主机执行。 [Hermes 控制台文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard)

```sh
export HERMES_DASHBOARD_SESSION_TOKEN="$(openssl rand -hex 32)"
hermes --profile default serve --isolated --host 127.0.0.1 --port 9119 &

export HERMES_DASHBOARD_URL='http://127.0.0.1:9119'
pnpm dev:connector
```

继续使用连接器已有的环境变量，包括 `BFF_URL`、`CONNECTOR_TOKEN` 和 HTTP Runs API 相关配置。Hermes 在容器中运行时，将支持管理的连接器放在同一容器或网络命名空间中，使它可以访问环回地址上的控制台。复用已有的控制台进程时，为连接器配置对应的环回地址和已发放的会话令牌。如果 BFF 使用反向代理，管理请求的响应超时时间至少设为 60 秒。

重启更新后的 BFF 和连接器，在已配对的应用中打开「设置」的「管理」。选择 `HERMES_PROFILES` 中的配置档案，即可查看其定时任务、模型、日志、技能和 MCP 服务器。变更由 Hermes 保存。定时任务依赖 Hermes 调度器，投递到 `hermes_mobile` 依赖现有收件箱插件。日志级别在相应的 Hermes 进程重启后生效。需要 OAuth 的 MCP 服务器须在 Hermes 控制台中登录。引用环境变量作为凭据的 MCP 服务器由对应配置档案的控制台进程执行连接测试。
