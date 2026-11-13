# Hermes 移动端投递插件

`hermes_mobile` 平台将发往移动端收件箱的文本写入队列。Hermes Agent 和连接器须以同一个 Unix 用户运行。连接器通过本地子进程管道调用 Python 3.11 或以上版本，读取并确认插件 SQLite 队列中的消息。

1. 将此目录连同 `plugin.yaml`、`__init__.py` 和 `src/` 复制到负责发送的 Hermes 配置档案下的 `plugins/hermes-mobile-delivery` 目录。默认配置档案的路径为 `~/.hermes/plugins/hermes-mobile-delivery`。在该配置档案下运行 `hermes plugins enable hermes-mobile-delivery` 启用插件。
2. 在该配置档案的 `.env` 中设置 `HERMES_MOBILE_HOME_CHANNEL=1`，并将 `HERMES_MOBILE_SPOOL_PATH` 设为绝对文件路径，例如 `/Users/you/.hermes/mobile-delivery/queue.sqlite3`。请使用专用的父目录。目录不存在时，插件会按 `0700` 权限创建。使用具名配置档案时，将 `HERMES_MOBILE_PROFILE` 设为其准确名称，并把该名称加入 BFF 的 `HERMES_PROFILES`。
3. 在连接器的环境中为 `HERMES_MOBILE_SPOOL_PATH` 设置相同的绝对路径。连接器默认从 `PATH` 查找 `python3`，需要时可通过 `HERMES_MOBILE_PYTHON` 指定可执行文件。如果 Hermes 网关正在运行，请重启它，然后启动或重启连接器。

运行 `hermes send --to hermes_mobile "来自 Hermes 的测试消息"` 测试投递，或将定时任务的投递目标设为 `hermes_mobile`。已配置的默认目标也可写作 `hermes_mobile:1`。插件拒绝其他投递目标和会话串 ID。

插件将文本写入本地队列后，Hermes 即报告发送成功。连接器使用同一个投递 ID 重试，直到 BFF 确认已持久化。上游投递片段的稳定标识可能缺失，因此每次独立调用都会生成一条收件箱记录，即使文本相同。投递仅支持不超过 128 KiB 的纯文本。
