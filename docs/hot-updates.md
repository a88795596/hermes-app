# App 热更新

项目通过 Hot Updater 1.1.15 给已安装的 iOS / Android Release App 分发 JavaScript 和资源更新。App 启动后检查并在后台下载，下载完成后的下一次冷启动生效，不会中断正在进行的聊天；标记为必需的更新也遵循这一时机。开发构建继续使用 Metro，Web 不检查原生更新。

本次完成代码接入，**尚未部署更新服务，也未完成首次真机 OTA 验收**。下面是后续部署和验证步骤，命令均从仓库根目录执行。使用 Node 24.22.1 或以上的 24.x 版本、pnpm 10.14。

## 1. 准备更新服务

`services/updates` 独立运行，复用现有 PostgreSQL，表位于独立的 `hot_updater` schema；更新文件保存在 `updates-data` 命名卷。默认 `docker compose up` 不会启动它，需要显式启用 `updates` profile。

在已有仓库根目录 `.env` 中补充以下配置，保留原来的数据库密码和 Hermes 配置：

| 配置 | 填写内容 |
| --- | --- |
| `HOT_UPDATER_BASE_URL` | 手机可访问的更新服务 HTTPS 根地址，不包含 `/admin` 或 `/storage` |
| `HOT_UPDATER_ADMIN_TOKEN` | 独立的随机管理令牌，至少 32 个字符；可用 `openssl rand -hex 32` 生成 |
| `HOT_UPDATER_PORT` | 可选，默认 `4318` |

配置 HTTPS 反向代理，将更新服务专用域名的根路径转发到宿主机 `127.0.0.1:4318`。保留请求路径、查询参数和请求头；允许至少 257 MiB 请求体，覆盖服务允许的 256 MiB 单文件上传及 multipart 开销。`/admin` 和 `/storage` 用于发布管理，可仅允许内网或 SSH 隧道访问；手机需要访问其他客户端路由及 `/download`。

准备完成后再启动：

```sh
docker compose --profile updates up -d --build --wait updates
docker compose logs --tail=50 updates
curl -fsS http://127.0.0.1:4318/health
curl -fsS http://127.0.0.1:4318/version
```

服务启动时自动创建 schema 并执行官方迁移。需要同时从设备网络确认 HTTPS 地址可达；本机健康检查通过不代表手机可下载更新。

创建 App 使用的客户端 API Key：

```sh
docker compose exec updates node services/updates/dist/setup.mjs --create-client-key
```

保存这次输出的明文 Key，服务只持久化摘要，之后无法恢复原文。客户端 Key 只允许检查和下载更新，与管理令牌分开。

若不用 Compose，服务读取进程环境中的 `HOT_UPDATER_DATABASE_URL`、`HOT_UPDATER_BASE_URL`、`HOT_UPDATER_ADMIN_TOKEN`；`HOT_UPDATER_DATA_DIR` 指定持久化目录，`HOST` 默认 `127.0.0.1`，`PORT` 默认 `4318`。设置后用 `pnpm dev:updates` 启动，用 `pnpm --filter @hermes-mobile/updates api-key` 创建 Key。Compose 已注入数据库连接、密码和数据目录，无需重复填写。

## 2. 配置 App 和发布端

首次创建两个本地配置文件；已有文件时直接编辑，不要覆盖：

```sh
cp -n apps/mobile/.env.example apps/mobile/.env.local
cp -n apps/mobile/.env.hotupdater.example apps/mobile/.env.hotupdater
```

| 文件 | 配置 | 用途 |
| --- | --- | --- |
| `apps/mobile/.env.local` | `EXPO_PUBLIC_HOT_UPDATER_BASE_URL` | 手机可达的 HTTPS 根地址，与服务端生成下载链接的地址一致 |
| `apps/mobile/.env.local` | `EXPO_PUBLIC_HOT_UPDATER_API_KEY` | 上一步生成的客户端 Key，可包含在 App 中 |
| `apps/mobile/.env.hotupdater` | `HOT_UPDATER_BASE_URL` | 发布端访问服务的根地址；同机或 SSH 隧道可用 `http://127.0.0.1:4318` |
| `apps/mobile/.env.hotupdater` | `HOT_UPDATER_ADMIN_TOKEN` | 与服务端一致的管理令牌，仅用于发布和 Console |

上述文件已被 Git 忽略。不要给管理令牌添加 `EXPO_PUBLIC_` 前缀。App 的地址与客户端 Key 必须同时配置；两项都留空会停用热更新，缺少其中一项会阻止构建。原生构建和 OTA 打包应使用相同的客户端配置。

EAS 云端构建不会自动获得本机被忽略的 `.env.local`。在所用 EAS 构建环境中设置同名的两个 `EXPO_PUBLIC_` 变量；原生构建不需要管理令牌。

## 3. 安装第一个支持热更新的 Release 包

首次接入需要重新编译并安装原生 App，因为旧安装包不包含 Hot Updater 原生模块。项目使用 `fingerprint` 匹配原生兼容性，原生渠道和发布脚本均默认为 `preview`。

先生成指纹基线并提交 `apps/mobile/fingerprint.json`：

```sh
pnpm ota:fingerprint
```

然后构建所需平台的内部 Release 包：

```sh
pnpm --dir apps/mobile dlx eas-cli@27.10.0 build --platform ios --profile preview
pnpm --dir apps/mobile dlx eas-cli@27.10.0 build --platform android --profile preview
```

iOS 设备登记与签名要求见 [移动端内部分发](../apps/mobile/README.md#ios-内部分发)。安装后保留同一个 App 完成下面的 OTA 测试。

有本机原生工具链时，也可以用 Expo 创建 Release 测试构建：

```sh
pnpm --filter @hermes-mobile/mobile exec expo run:ios --configuration Release
pnpm --filter @hermes-mobile/mobile exec expo run:android --variant release
```

本地 iOS 编译需要 Xcode 和 CocoaPods；Android 编译需要 JDK 和 Android SDK。Expo Go、Debug 构建和 Metro 热刷新不能证明 OTA 工作。Expo prebuild 会应用原生插件并生成指纹；绕过 prebuild 直接构建时仍须确保指纹文件存在。 [官方 App 接入](https://hot-updater.dev/docs/get-started/app-setup)

## 4. 发布 JavaScript 或资源更新

修改一处易辨认的页面文字或业务图片，保留原生依赖、配置和指纹基线。完成项目检查后，发布到对应平台：

```sh
pnpm typecheck
pnpm test
pnpm ota:deploy -p ios --message "更新聊天页面"
```

确认 iOS 发布成功后，再发布 Android：

```sh
pnpm ota:deploy -p android --message "更新聊天页面"
```

命令默认发布至 `preview`，只匹配该渠道下具有相同原生指纹的安装包。记录每个平台输出的 Bundle ID；两个平台分别发布，第二个平台失败不会撤回第一个。OTA 打包使用 Expo 和 Hermes 编译器，不需要重新运行 Xcode、CocoaPods 或 Gradle。

**不要在每次 OTA 前执行 `ota:fingerprint`。** 指纹不一致意味着需要审查原生变化、生成新基线并交付新原生包，不能通过刷新基线让旧安装包支持新原生能力。 [发布命令](https://hot-updater.dev/docs/guides/deploy)

首次验收按以下顺序进行，iOS 和 Android 分别记录结果：

1. 打开刚才安装的 Release App，触发检查并等待后台下载。检查或下载失败时保留当前版本，下一次启动会重试。
2. 完全退出 App 后重新打开，确认新文字和图片已经出现；仅切到后台再回前台不等于冷启动。
3. 不重装 App，断网冷启动，确认已安装版本仍能进入原有界面。
4. 按下一节停用测试更新，再检查、下载并冷启动，确认恢复到上一可用版本。

上传成功只证明发布端完成了工作；需观察已安装 App 的实际界面变化，才能确认 OTA 已生效。当前只启用了 `apiKeys` 插件，Console 不提供 Insights 安装统计。 [官方 OTA 验收步骤](https://hot-updater.dev/docs/get-started/test-ota)

## 5. 查看、停用和回退

启动本机 Console，查看更新所属平台、渠道和指纹，再停用有问题的发布：

```sh
pnpm ota:console
```

也可以使用发布时记录的 Bundle ID，先查看详情再停用：

```sh
pnpm --filter @hermes-mobile/mobile exec hot-updater bundle show <Bundle-ID>
pnpm --filter @hermes-mobile/mobile exec hot-updater bundle disable <Bundle-ID>
```

设备下一次启动检查时会获取回退目标，准备完成后在下一次冷启动生效。目标通常是上一条兼容且启用的更新；没有其他可用更新时回到原生包内置版本。停用更新不会即时重启当前聊天，也不会删除用户的配对和聊天数据。自动崩溃回退是 SDK 的另一个机制，不能用停用测试替代崩溃恢复验证。 [Console](https://hot-updater.dev/docs/guides/console)

## 6. 原生变化与备份

以下变化仍需重新编译并安装原生包：RN / Expo / 原生模块升级、增删原生依赖、权限或原生配置修改、图标和原生启动屏变更、原生渠道变更。当前指纹除原生接口外，还明确追踪 `app.json`、`app.config.js`、`eas.json`；业务 TS/TSX 和普通图片不在额外追踪范围内。

新增自定义原生文件、配置插件或影响原生能力的环境变量时，将相应文件加入 `hot-updater.config.ts` 的 `fingerprint.extraSources`，或提高 `fingerprint.nativeVersion`。文件追踪不会自动识别环境变量展开后的值。改变构建 profile 时，需确认原生配置与原生渠道仍对应。当前原生渠道在 `app.json` 的 Hot Updater 插件中设置，EAS profile 名称不等于 Hot Updater 渠道。 [指纹覆盖范围](https://hot-updater.dev/docs/guides/update-strategies/fingerprint)

备份时一起保留 PostgreSQL 中的 `hot_updater` schema、`updates-data` 卷，以及安全保存的管理令牌和客户端构建配置。停止发布后再做一致性备份；只恢复数据库会留下指向缺失文件的发布记录。`docker compose down` 保留数据卷，`docker compose down -v` 会删除更新包和其他命名卷。当前磁盘存储面向单服务实例，不应在多个节点使用互不共享的本地目录。

当前使用 HTTPS、管理鉴权、客户端 Key 和有时效的下载链接，未启用 Bundle Signing。若启用签名，应先把公钥写入原生配置并发布新安装包，再推送匹配私钥签名的更新。 [签名配置](https://hot-updater.dev/docs/guides/bundle-signing)

服务测试默认覆盖鉴权和文件存储。另设 `TEST_UPDATES_DATABASE_URL` 指向隔离测试数据库后，`pnpm test` 会执行真实 PostgreSQL 的发布、指纹匹配、下载与停用回退测试。当前文件存储只实现发布所需操作，尚不支持 `hot-updater storage prune`，不要手工删除仍被发布记录引用的文件。
