# 安卓真机调试

1. 在手机上安装与 `apps/mobile/package.json` 中 Expo SDK 匹配的 Expo Go。已验证 SDK 58 和 Expo Go 58.0.5。用 USB 连接手机并授权调试，确认 `adb devices -l` 显示设备状态为 `device`。
2. 按 [README 的本地启动步骤](README.md#run-the-personal-mvp) 启动 BFF 和 Hermes 连接器，BFF 使用端口 `4317`。在仓库根目录执行以下命令。如果本项目的 Metro 已在 `8081` 运行，复用该进程。

   ```sh
   adb reverse tcp:8081 tcp:8081
   adb reverse tcp:4317 tcp:4317
   pnpm dev:mobile --go --localhost --port 8081
   ```

3. 在 Expo Go 的 **Enter URL** 输入 `exp://127.0.0.1:8081`。首次配对时，**服务器地址**填 `http://127.0.0.1:4317`，**配对令牌**使用 BFF 启动环境中的 `APP_PAIRING_TOKEN`。将令牌留在本地配置中。
4. 在**连接**页确认**应用连接**和 **Hermes 连接器**均为**在线**，**实时更新**为**已连接**。

调试期间保持 USB 连接。重新插线后用 `adb reverse --list` 检查两个端口的转发。Expo Go 提示需要本地网络权限时，允许访问附近的设备。如果当前 Wi-Fi 配置了手动代理，将 `localhost` 和 `127.0.0.1` 加入该网络的「不使用的网址」。
