# Hermes 移动端

本仓库是 Hermes 移动端的 pnpm 工作区。

| 目录 | 模块 | 职责 |
| --- | --- | --- |
| `apps/mobile` | Expo Router 应用 | 原生客户端和本地优先的界面 |
| `services/bff` | Fastify 服务 | 对外提供移动端 API，负责授权与数据投影 |
| `services/connector` | Node 服务 | 从 Hermes 主机主动连接 BFF |
| `services/updates` | Node 服务 | Hot Updater 热更新目录与更新包存储 |
| `packages/protocol` | 共享包 | 定义移动端与连接器的通信协议 |
| `packages/hermes-adapter` | 共享包 | 校验并规范化 Hermes 数据 |
| `plugins/hermes-mobile-delivery` | Hermes Python 插件 | 为定时任务和 `hermes send` 提供移动端收件箱与 Bark 投递渠道 |

`packages/protocol` 独立于应用框架。Hermes 凭据由连接器保管，移动端只依赖能在设备上运行的代码。BFF 通过连接器与 Hermes 通信。

## 设计与交付

- [iOS 和 Android 技术设计](docs/superpowers/specs/2026-11-13-hermes-mobile-design.md)
- [移动端与连接器契约基线](docs/superpowers/specs/2026-11-13-hermes-mobile-contracts.md)
- [并行开发工作包与验收用例](docs/superpowers/plans/2026-11-13-hermes-mobile-parallel-plan.md)
- [个人版已实现的通信协议](docs/superpowers/plans/2026-11-13-personal-mvp-wire.md)
- [工程设计规格书 v2](docs/reference/hermes-expo-engineering-spec-v2.md)

## App 更新命令

在仓库根目录使用以下三个入口。pnpm 会自动使用项目指定的 Node 24.22.1，首次运行需要下载运行时。

| 命令 | 操作 |
| --- | --- |
| `pnpm app:android` | 本机编译 Android Release，安装并启动已连接的真机 |
| `pnpm app:ios` | 本机编译 iOS Ad Hoc Release，安装并启动已连接的 iPhone |
| `pnpm ota:push --message "更新说明"` | 构建并发布 iOS、Android 两个平台的热更新到 `preview` |

原生安装命令仅有一台可用真机时自动选择；多台设备用 `--device <标识>` 指定。iOS 使用 `eas build --local` 调用本机 Xcode，复用 Finstep 签名凭据，不发起云端编译；IPA 留在被 Git 忽略的 `.data/builds/ios-*` 中。工具链、设备登记和登录要求见 [移动端说明](apps/mobile/README.md#本地编译并安装到手机)。

日常 JavaScript 和资源改动使用 `ota:push`；两个平台都准备成功后才一起发布，手机后台下载并在下次冷启动生效。这个命令不执行 Git commit 或 Git push，也不重新生成原生指纹。首次启用热更新或变更原生依赖、权限、图标、渠道时，使用对应的原生安装命令。配置、发布和回退步骤见 [热更新操作文档](docs/hot-updates.md)。

## Docker Compose 部署

BFF 和连接器在同一个容器运行，PostgreSQL 由 Compose 单独启动。Hermes Agent 在同一台宿主机运行，手机继续使用 Expo 客户端。应用容器通过 host 网络访问宿主机的回环地址。Linux Docker Engine 可直接使用，Docker Desktop 需要 4.34 或以上版本，并在 **Settings → Resources → Network** 中启用 **Enable host networking**。 [Docker host 网络](https://docs.docker.com/engine/network/drivers/host/)

1. 使用原版 Hermes Agent，在网关的 `config.yaml` 中启用 Webapp。连接器使用 Webapp 签发的一次性票据连接原生 WebSocket。 [Hermes Webapp 配置](https://hermes-agent.nousresearch.com/docs/user-guide/configuration#webapp)

   ```yaml
   webapp:
     enabled: true
     host: 127.0.0.1
     port: 9120
   ```

   已安装为服务的网关用 `hermes gateway restart` 重启。首次在前台启动可用 `hermes gateway run`。回环模式的 Webapp 会在 Hermes 数据目录下生成 `webapp/session-token`，连接器使用该文件中的令牌。

   Hermes 在 Docker 中运行时，使用官方镜像和现有配置及数据卷。在容器内部将 Webapp 绑定到 `0.0.0.0`，通过 `-p 127.0.0.1:9120:9120` 发布到宿主机回环地址，并在 Hermes 容器的环境中设置 `HERMES_DASHBOARD_SESSION_TOKEN` 作为 Webapp 登录令牌。两种接入均使用原版 Hermes。

2. 首次部署时，在仓库根目录生成一份权限受限的 `.env`。已有 `.env` 时保留其中的配对令牌和数据库密码，对照模板补齐缺失项。 [配置模板](.env.example)

   ```sh
   (set -eu
     umask 077
     set -C
     printf "HERMES_DASHBOARD_SESSION_TOKEN=''\nAPP_PAIRING_TOKEN=%s\nPOSTGRES_PASSWORD=%s\n" \
       "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
   )
   ```

   编辑仓库根目录的 `.env`，将上一步的 Webapp 令牌填入 `HERMES_DASHBOARD_SESSION_TOKEN` 的单引号内。`APP_PAIRING_TOKEN` 用于手机配对。`CONNECTOR_TOKEN` 省略时由容器在启动时随机生成，并同时传给 BFF 和连接器。

3. 构建并启动。BFF 默认监听 `127.0.0.1:4317`。健康检查通过后，应用日志应显示「Hermes 连接器已连接 BFF」。

   ```sh
   docker compose up -d --build --wait
   docker compose logs --tail=50 app
   curl -fsS http://127.0.0.1:4317/health
   ```

4. 在移动端填写 BFF 地址和 `APP_PAIRING_TOKEN`，然后新建话题验证 Hermes 连接。本机 iOS 模拟器使用 `http://127.0.0.1:4317`，Android 模拟器使用 `http://10.0.2.2:4317`。真机使用宿主机上的 HTTPS 反向代理，将 HTTPS 和 WebSocket 请求转发至 `127.0.0.1:4317`。代理须允许至少 9 MiB 的请求体，管理请求的响应超时至少设为 60 秒。

端口冲突时，在 `.env` 中调整 `BFF_PORT` 或 `POSTGRES_PORT`，数据库默认通过宿主机的 `127.0.0.1:55433` 访问。若 Webapp 使用其他端口，设置 `HERMES_WEBAPP_URL` 为对应的 `http://127.0.0.1:<端口>`。`HERMES_PROFILES` 默认为 `default`，多个由网关提供服务的配置档案用逗号分隔。

启用移动端管理时，可将 `HERMES_DASHBOARD_URL` 设为 Webapp 的回环地址。Expo 推送可通过 `EXPO_ACCESS_TOKEN` 注入访问令牌。 [控制台配置](#enable-manage-on-mobile)

从旧部署升级时，保留 PostgreSQL、连接器的 SQLite 和 Hermes 的数据卷，并换用原版 Hermes。已有 `mobile_…` 会话通过原版 HTTP Runs 继续发送，需保留对应的 `HERMES_API_URL` 与 `HERMES_API_KEY`。这些会话从原版会话接口读取标题，并通过同一个 Hermes 实例的 Webapp 暂存普通文件。过程显示取决于原版 Runs 提供的事件，新会话通过 WebSocket 接收思考和阶段说明。 [Hermes API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)

多配置档案使用原生命令时，在每个 Hermes 档案的本地 `.env` 中分别设置 `API_SERVER_KEY`。连接器仍以 `HERMES_API_KEY` 访问默认档案，并可通过 `HERMES_API_KEYS` 读取其他档案的密钥，格式为 JSON 对象，例如 `{"finance":"独立密钥"}`；不要把这些密钥提交到 Git。未配置对应档案密钥时，原生命令请求会被拒绝。

启用移动端收件箱投递时，在应用服务的 `.env` 中设置独立的 `INBOX_DELIVERY_TOKEN`。在运行 Hermes 的主机或容器里安装插件，并配置从该环境可访问的 `/internal/inbox/v1/deliveries` 地址。默认 Compose 的 BFF 监听回环地址，分容器部署可使用 HTTPS 反向代理并转发该路径。 [Hermes 投递插件](plugins/hermes-mobile-delivery/README.md)

使用 Bark 时，在 Hermes 配置档案中设置 `BARK_KEY`。 [Bark 推送配置](plugins/hermes-mobile-delivery/README.md#bark-推送)

升级时重新执行 `docker compose up -d --build --wait`。已有共享投递队列的部署可将原队列交给新版插件继续发送。`docker compose down` 停止部署并保留两个命名卷 `postgres-data` 和 `connector-data`。它们分别保存配对和聊天数据、连接器的会话绑定和待发送记录。备份或迁移时应成对保留，`docker compose down -v` 会删除这两个卷。PostgreSQL 首次初始化使用 `POSTGRES_PASSWORD`，之后如需轮换密码，请同步修改数据库角色密码与 `.env`。 [投递队列升级](plugins/hermes-mobile-delivery/README.md#从共享队列升级)

<a name="run-the-personal-mvp"></a>

## 本地运行个人版

使用 Node 24.22.1 或以上的 24.x 版本和 pnpm 10.14 安装依赖。个人版需要一个 BFF 进程、一个 PostgreSQL 数据库和一个连接器进程。BFF 启动时自动建表。以下命令均在工作区根目录执行。

```sh
pnpm install
pnpm typecheck
```

已有 `hermes-mobile-postgres` 容器、运行中的原版 Hermes 网关和 `.data/dev.env` 时，运行 `pnpm dev:services`。脚本检查 PostgreSQL、Hermes 网关、BFF 和连接器，跳过已经运行的服务。新启动的 BFF 和连接器在后台运行，日志分别在 `.data/bff.log` 和 `.data/connector.log`。

运行 `pnpm dev:stop` 停止连接器、BFF 和开发数据库。

`.data/dev.env` 使用 Shell 变量赋值，需包含 `POSTGRES_PASSWORD`、`APP_PAIRING_TOKEN` 和 `CONNECTOR_TOKEN`。可以通过 `PORT` 指定 BFF 端口，默认端口为 `4317`。首次准备环境或分步启动时，使用以下命令。

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

2. 以网关所用的 OS 用户在同一台主机运行连接器。原版 Hermes CLI 须支持 `gateway attach --json`。若网关独立运行在容器中，按上面的 Webapp 配置设置 `HERMES_WEBAPP_URL` 和 `HERMES_DASHBOARD_SESSION_TOKEN`，也可写入 `.data/dev.env` 供一键启动脚本读取。 [Hermes 网关接入](https://hermes-agent.nousresearch.com/docs/developer-guide/gateway-internals)

   ```sh
   export BFF_URL='http://127.0.0.1:4317'
   export CONNECTOR_TOKEN='THE_SAME_MACHINE_SECRET'
   export CONNECTOR_DB_PATH="$PWD/.data/connector.sqlite"
   pnpm dev:connector
   ```

   可用 `HERMES_BIN` 指定本机 Hermes 可执行文件。连接器队列和 BFF 数据库应一起使用，并指向原来的 Hermes 安装和配置档案。若 Hermes 报告 `no_provider_configured`，用 `hermes model` 配置对应档案的模型服务商。

3. 在另一个终端启动应用。按平台选择命令，构建并打开开发客户端。

   ```sh
   pnpm --filter @hermes-mobile/mobile exec expo run:ios
   pnpm --filter @hermes-mobile/mobile exec expo run:android
   ```

   安装开发客户端后，运行 `pnpm dev:mobile` 重新启动 Metro。使用 `APP_PAIRING_TOKEN` 和 BFF 地址配对。在 iOS 模拟器中使用 `http://127.0.0.1:4317`，在 Android 模拟器中使用 `http://10.0.2.2:4317`，在真机上使用 BFF 受信任的 HTTPS 反向代理。原生应用通过 SecureStore 保存设备令牌，并在应用私有的 SQLite 数据库中保存历史记录和待发文本。开发构建配置 Expo 项目 ID 和 APNs／FCM 凭据后，可在「设置」的「连接」中开启通知；已授权设备在线时会自动恢复推送注册。

   聊天每轮成功完成后会为已注册设备排队推送，显示话题标题与回复预览；失败、取消、流式片段和重复同步不会触发完成通知。点击后打开对应话题并定位、高亮该轮回复，冷启动和后台唤醒均可处理；没有可见回复时定位该轮用户消息。收件箱通知点击后打开对应详情。打开目标需要有效配对和网络连接。升级时同时更新 BFF 与移动端，BFF 启动会自动创建会话推送队列。

   收件箱通知显示来源档案和最多 500 个字符的正文预览，清理常见 Markdown 标记，完整内容保留在收件箱。预览随推送发送到 Expo／APNs／FCM，并按系统的「显示预览」设置展示在锁屏。iOS 默认使用时间敏感通知；新增能力需要重新构建并安装 App，系统中也需允许该 App 的时间敏感通知。Android 使用高优先级投递，新建收件箱通知通道的重要性为高；已存在通道的重要性由系统保留，需在系统通知设置中调整。 [iOS 能力配置](https://docs.expo.dev/build-reference/ios-capabilities/)

4. 如需在本地通过 npm 安装连接器，运行 `pnpm --filter @hermes-mobile/connector pack` 并安装生成的压缩包。使用定时投递或 `hermes send` 时，在 Hermes 运行环境安装插件，再配置所用渠道。 [Hermes 投递插件](plugins/hermes-mobile-delivery/README.md)

<a name="interactive-chat"></a>

## 聊天交互

点击「新建会话」直接打开聊天。首条发送的消息会成为临时标题，Hermes 原生自动标题就绪后会同步到聊天顶部和话题列表。

聊天始终使用同一个发送按钮。连接器发送前读取 Hermes 实际运行状态：正在执行时，纯文本通过原生 `session.steer` 补充到当前执行；空闲时开始普通一轮。含附件的消息和旧 HTTP Runs 会话按原流程提交。需要更新 BFF 与连接器，前端不选择发送模式。原生运行器决定读取补充要求的时机，不会中断正在调用的工具，也可能将来不及读取的内容保留到后续轮次。只有明确未送达时才回退普通提交；结果待确认时不会重复投递。

更新 Hermes Mobile Delivery 插件和 Connector 后，支持会话插件事件的 Hermes 网关会在插话进入模型请求时定格当前回复。后续正文和思考显示在新的助手气泡里，同属原执行轮次。

会话流光同时反映原生执行和当前会话中排队、运行的后台子任务。主轮次结束、等待子任务或自动续轮时仍保持运行提示；App 在前台每 3 秒通过状态接口核对，离开会话或进入后台后停止。连接器使用 `subagent.list` 和 `session.resume` 快照，不将单次 `message.complete` 当作整个任务完成。[Hermes 官方后台任务状态](https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/apps/desktop/src/store/session-dot-state.ts)

点输入框左侧的回形针，选择「图片」或「文件」。选中的附件会显示在输入框上方，可移除或继续添加。写好描述后点发送，附件和描述会一起交给 Hermes，也可以单独发送附件。每条消息最多 10 个附件，单个最多 5 MB，合计最多 6 MB。发送后可在聊天气泡中点开图片、播放音视频、预览 Markdown 和 HTML，也可以保存原文件。

图片和普通文件分别通过原版 Hermes 的 `image.attach_bytes` 和 `file.attach` 发送。使用反向代理时，请为消息提交请求允许至少 9 MiB 请求体，并将 `/internal/connector/v1/submissions/` 的 HTTPS 请求转发给 BFF。图片读取由 Hermes 和当前模型的视觉能力决定。

Hermes 投递文件和消息时，`hermes_mobile:<session-id>` 会发送到指定 App 会话的消息列表，`hermes_mobile` 发送到收件箱。聊天时连接器会提供当前会话目标，让 Agent 优先在当前会话交付。纯文件可用 `hermes mobile-send --to hermes_mobile:<session-id> --file /tmp/report.md`；这里的 ID 为已绑定的 Hermes 会话 ID。升级 BFF、投递插件、连接器与 App 后生效。 [投递与文件命令](plugins/hermes-mobile-delivery/README.md#移动端收件箱)

点击会话标题右侧的「过程」开关，可以查看每条回复的思考、阶段说明和工具执行状态。开关在本次使用期间按话题记忆，默认关闭。能查看哪些过程取决于 Hermes 和模型实际提供的数据。

聊天中的「浏览技能」从当前配置档案的原版技能目录读取。Webapp 接入使用 `/api/skills`，本机 CLI 接入使用会话的 `session.info.skills`。

在话题中发送 `/model`，先选择服务商，再选择模型。菜单会显示当前 Hermes 配置档案下可用的服务商，并标记当前选项。等本轮回复完成后即可切换模型，新选择对当前话题的后续对话生效。

在输入框上方点「思考强度」，可为当前话题选择档位，或恢复使用 Hermes 配置档案的默认设置。切换需要会话空闲，并且移动端、BFF 和连接器均已更新。HTTP Runs 使用支持 `model_options.reasoning_effort` 的 Hermes API；Canonical Gateway 使用支持 `reasoning` 操作的 `session.mutate`。各模型实际采用的档位由 Hermes 和服务商决定。

当智能体调用 `clarify` 时，点击选项即可回答当前的问题。澄清卡片也支持多选、输入自定义答案和跳过问题。

话题绑定的 Hermes 会话工具集须包含 `clarify`。旧 HTTP Runs 会话还需要 API 配置档案公开等待处理的交互，可以在对应的 Hermes 环境中启用该工具。

```sh
hermes tools enable --platform api_server clarify
```

具名配置档案使用 `hermes --profile <name> tools enable --platform api_server clarify`。

个人版已实现单账户、带图片和文件的聊天，以及 WSS 变更通知配合 HTTP 补拉。 [已实现的通信协议](docs/superpowers/plans/2026-11-13-personal-mvp-wire.md)

<a name="enable-manage-on-mobile"></a>

## 启用移动端管理功能

在连接器所在主机和运行环境中，启动提供控制台 API 的 Hermes 版本。聊天、定时调度和管理应使用同一套 Hermes 安装及配置档案数据。为控制台和连接器进程设置相同的控制台会话令牌。以下命令在 Hermes 主机执行。 [Hermes 控制台文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard)

```sh
export HERMES_DASHBOARD_SESSION_TOKEN="$(openssl rand -hex 32)"
hermes --profile default serve --isolated --host 127.0.0.1 --port 9119 &

export HERMES_DASHBOARD_URL='http://127.0.0.1:9119'
pnpm dev:connector
```

继续使用连接器已有的环境变量。如果已启用网关的 Webapp，可将 `HERMES_DASHBOARD_URL` 设为该 Webapp 的回环地址，并沿用现有会话令牌。如果 BFF 使用反向代理，管理请求的响应超时时间至少设为 60 秒。

重启更新后的 BFF 和连接器，在已配对的应用中打开「设置」的「管理」。选择 `HERMES_PROFILES` 中的配置档案，即可查看其定时任务、模型、日志、技能和 MCP 服务器。变更由 Hermes 保存。定时任务依赖 Hermes 调度器，投递到 `hermes_mobile` 依赖现有收件箱插件。日志级别在相应的 Hermes 进程重启后生效。需要 OAuth 的 MCP 服务器须在 Hermes 控制台中登录。引用环境变量作为凭据的 MCP 服务器由对应配置档案的控制台进程执行连接测试。
