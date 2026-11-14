# Hermes 移动端应用

应用使用 Expo Router，路由位于 `src/app`。 [模块边界](./src/ARCHITECTURE.md) · [本地启动步骤](../../README.md#run-the-personal-mvp)

安装原生开发构建后，在工作区根目录启动 Metro。

```sh
pnpm dev:mobile
```

使用 BFF 的服务器地址与配对令牌完成配对。iOS 和 Android 应用支持文本聊天、停止回复、处理待办审批或澄清，以及查看收件箱。设备凭据由 SecureStore 保存，缓存的历史记录与待发文本存储在应用私有的 SQLite 数据库中。原生远程推送需要配置过的开发构建。

在「设置」的「管理」中可以配置所选 Hermes 配置档案的定时任务、模型、日志、技能和 MCP 服务器。在「设置」的「连接」中可以查看连接状态和管理此设备。 [启用移动端管理功能](../../README.md#enable-manage-on-mobile)
