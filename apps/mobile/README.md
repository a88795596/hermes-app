# Hermes 移动端应用

应用使用 Expo Router，路由位于 `src/app`。 [模块边界](./src/ARCHITECTURE.md) · [本地启动步骤](../../README.md#run-the-personal-mvp)

安装原生开发构建后，在工作区根目录启动 Metro。

```sh
pnpm dev:mobile
```

使用 BFF 的服务器地址与配对令牌完成配对。iOS 和 Android 应用支持含附件的聊天、停止回复、处理待办审批或澄清，以及查看收件箱。设备凭据由 SecureStore 保存，聊天历史和待发送消息存储在应用私有的 SQLite 数据库中。原生远程推送需要配置过的开发构建。

在「设置」的「管理」中可以配置所选 Hermes 配置档案的定时任务、模型、日志、技能和 MCP 服务器。在「设置」的「连接」中可以查看连接状态和管理此设备。 [启用移动端管理功能](../../README.md#enable-manage-on-mobile)

## iOS 内部分发

应用使用 Finstep 的 Apple Developer Program 组织账号（Team ID `4SAK5KMM76`），Bundle ID 为 `hermes.cashcat.cn`，Expo 组织为 `finstep-intelligent-technology-co-ltd`。

`eas.json` 中的 `preview` 配置生成 Ad Hoc 签名的 Release 安装包，包含 JavaScript，无需启动 Metro。安装前需要将 iPhone 的 UDID 登记到 Finstep 团队，并包含在本次构建的描述文件中。在仓库根目录运行：

```sh
pnpm --dir apps/mobile dlx eas-cli@27.10.0 device:create
pnpm --dir apps/mobile dlx eas-cli@27.10.0 build --platform ios --profile preview
```

首次构建按提示登录 Apple 账号并选择 Finstep 团队，使用 EAS 管理分发证书、Ad Hoc 描述文件和 APNs 凭据。构建成功后，在已登记的 iPhone 上打开 EAS 提供的安装链接。增加设备后需要重新构建或使用 `eas build:resign` 重签。

也可以在安装了 Xcode、CocoaPods 和 fastlane 的 Mac 上使用相同配置本地编译，复用 EAS 管理的签名凭据。在仓库根目录运行：

```sh
mkdir -p .data/builds
pnpm --dir apps/mobile dlx eas-cli@27.10.0 build --local --platform ios --profile preview --output ../../.data/builds/hermes-cashcat-ios.ipa
```

连接并解锁已登记的 iPhone，将 IPA 解压后用 Xcode 的 `devicectl device install app` 安装其中 `Payload` 目录下的 `.app`。本地构建与云端构建使用相同的 Ad Hoc 设备名单和签名有效期。

安装包的有效期取决于证书和描述文件的实际到期时间，到期前需要重新构建或重签；它不受免费 Personal Team 的 7 天签名限制。新 Bundle ID 会安装为独立应用，需要重新填写 BFF 地址和配对令牌，旧应用的本地缓存不会自动迁移。 [Expo 内部分发说明](https://docs.expo.dev/build/internal-distribution/)

## 热更新

Release 版本启动后检查并后台下载更新，下次完全退出并重新打开 App 时生效。首次启用仍须构建安装一次原生 App；开发调试继续使用 Metro。配置服务、客户端凭据、原生指纹和发布命令见 [热更新操作说明](../../docs/hot-updates.md)。
