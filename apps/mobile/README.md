# Hermes 移动端应用

应用使用 Expo Router，路由位于 `src/app`。 [模块边界](./src/ARCHITECTURE.md) · [本地启动步骤](../../README.md#run-the-personal-mvp)

Markdown 表格支持右上角放大为横屏全屏，关闭后恢复竖屏。此功能新增 `expo-screen-orientation` 原生模块与 iOS 横屏配置，首次交付需重新编译两端原生包；仅发布 OTA 无法补齐旧包的原生能力。

安装原生开发构建后，在工作区根目录启动 Metro。

```sh
pnpm dev:mobile
```

使用 BFF 的服务器地址与配对令牌完成配对。iOS 和 Android 应用支持含附件的聊天、停止回复、处理待办审批或澄清，以及查看收件箱。设备凭据由 SecureStore 保存，聊天历史和待发送消息存储在应用私有的 SQLite 数据库中。原生远程推送需要配置过的开发构建。

在「设置」的「管理」中可以配置所选 Hermes 配置档案的定时任务、模型、日志、技能和 MCP 服务器。在「设置」的「连接」中可以查看连接状态和管理此设备。 [启用移动端管理功能](../../README.md#enable-manage-on-mobile)

## 接收文件

聊天回复和收件箱共用文件预览：图片直接显示，点击可全屏查看；音频和视频点击后下载并在消息内播放；Markdown 和 HTML 点击进入预览。下载失败可重试，文件使用设备凭证读取。iOS / Android 将完整下载的文件保存在本地缓存，离开消息或重启 App 后再次打开无需下载，也可离线预览；缓存按服务器和配对凭证隔离，文件被系统清理或大小不符时自动重新下载。并发打开同一文件共用下载，退出预览后已开始的下载继续完成并缓存。每个接收文件最多 50 MiB，每条消息最多 10 个，App 上传到 Hermes 的原有限额保持不变。

HTML 支持内联 JavaScript 交互，使用不共享 App 来源与凭证的沙箱，不提供原生消息桥或本地文件访问。外部脚本、图片、fetch、表单和页面跳转受到限制；需要离线自包含 HTML（样式、脚本及图片内嵌）。浏览器 CSP 不覆盖所有底层网络通道，因此此预览不是完全断网的执行环境。

接收聊天文件需配置 Connector 的 Hermes Webapp 接口，插件投递方式与旧版 Hermes 的 `mobile-send --file` 兼容命令见 [插件说明](../../plugins/hermes-mobile-delivery/README.md)。历史消息只有文件名、没有附件 ID 时仍保留文件名显示。

本功能新增 `expo-audio`、`expo-video` 和 `react-native-webview` 原生模块；首次交付必须运行下方本地原生构建命令。仅发布 OTA 不会为旧安装包补上这些模块。音视频解码取决于设备系统，建议使用 MP3/M4A/WAV 和 H.264/AAC MP4；不请求麦克风权限，也不在后台继续播放。

## 本地编译并安装到手机

在仓库根目录运行：

```sh
pnpm app:android
pnpm app:ios
```

两个命令都在本机编译 Release，包含 JavaScript，无需 Metro；编译成功后安装并启动真机。只有一台可用真机时自动选择，多台设备时明确指定：

```sh
pnpm app:android --device <ADB序列号>
pnpm app:ios --device <iPhone的UDID>
```

Android 需要 Android SDK、ADB 和 JDK 17；Mac 未配置 `JAVA_HOME` 时自动选择已安装的 JDK 17。手机需启用 USB 调试并授权本机。每次编译前通过 Expo prebuild 同步当前工作区的原生配置，不卸载已有 App。

iOS 需要 Mac、Xcode、支持当前 Expo 的 CocoaPods（本机已验证 1.16.2）和 fastlane。命令固定使用 EAS CLI 27.10.0 的 `--local` 模式，编译由本机 Xcode 完成；EAS 仅用于项目与现有签名凭据。首次使用先通过 `pnpm --dir apps/mobile dlx eas-cli@27.10.0 login` 登录；设备需登记在 Finstep Ad Hoc 描述文件中，并解锁、信任本机。构建不会自动修改签名凭据；凭据过期或缺少设备时先按下节处理。IPA 保存在 `.data/builds/ios-*`，签名检查通过后才安装。

两端都读取本地 `apps/mobile/.env.local` 的更新地址和客户端 Key；原生编译不需要发布管理令牌。任何编译、签名、安装或启动失败都会立即停止，错误修复后重新执行同一个命令。可用 `--help` 查看参数。原生目录与产物均在 Git 忽略范围内，不要手工把密钥加进仓库。

原生构建会生成指纹基线，iOS 会在进入 EAS 临时目录前保存当前工作区的指纹。原生依赖或配置改变后，检查并提交 `apps/mobile/fingerprint.json` 的变化，再安装两端对应的新原生包。日常 `ota:push` 保留该基线，不会自动刷新指纹。

## iOS 内部分发

应用使用 Finstep 的 Apple Developer Program 组织账号（Team ID `4SAK5KMM76`），Bundle ID 为 `hermes.cashcat.cn`，Expo 组织为 `finstep-intelligent-technology-co-ltd`。

`eas.json` 中的 `preview` 配置生成 Ad Hoc 签名的 Release 安装包，包含 JavaScript，无需启动 Metro。安装前需要将 iPhone 的 UDID 登记到 Finstep 团队，并包含在本次构建的描述文件中。在仓库根目录运行：

```sh
pnpm --dir apps/mobile dlx eas-cli@27.10.0 device:create
pnpm --dir apps/mobile dlx eas-cli@27.10.0 credentials --platform ios
```

首次按提示登录 Apple 账号并选择 Finstep 团队，使用 EAS 管理分发证书、Ad Hoc 描述文件和 APNs 凭据。确认描述文件包含目标 iPhone 后，运行 `pnpm app:ios` 本地编译并安装。增加设备后先更新描述文件，再重新本地编译。

日常本地编译与手机安装统一使用 `pnpm app:ios`。仅需单独生成 IPA 时，也可以使用以下底层命令：

```sh
mkdir -p .data/builds
pnpm --dir apps/mobile dlx eas-cli@27.10.0 build --local --platform ios --profile preview --output ../../.data/builds/hermes-cashcat-ios.ipa
```

连接并解锁已登记的 iPhone，将 IPA 解压后用 Xcode 的 `devicectl device install app` 安装其中 `Payload` 目录下的 `.app`。本地构建与云端构建使用相同的 Ad Hoc 设备名单和签名有效期。

安装包的有效期取决于证书和描述文件的实际到期时间，到期前需要重新构建或重签；它不受免费 Personal Team 的 7 天签名限制。新 Bundle ID 会安装为独立应用，需要重新填写 BFF 地址和配对令牌，旧应用的本地缓存不会自动迁移。 [Expo 内部分发说明](https://docs.expo.dev/build/internal-distribution/)

## 热更新

日常在仓库根目录运行 `pnpm ota:push --message "更新说明"`，一次发布两个平台到 `preview`，不操作 Git。Release 版本启动后检查并后台下载更新，下次完全退出并重新打开 App 时生效；设置页手动检查并下载成功后，可选择立即重启应用更新或稍后生效。首次启用仍须构建安装一次原生 App；开发调试继续使用 Metro。配置服务、客户端凭据、原生指纹和发布命令见 [热更新操作说明](../../docs/hot-updates.md)。
