# 接收与预览文件实现计划

**目标：** Hermes 插件与聊天回复可向 App 投递图片、语音、视频、Markdown、HTML；会话和收件箱共用展示组件。

**方案：** 复用现有鉴权、消息投影与持久队列。文件先经 HTTP 上传，消息只携带文件 ID 和元数据；App 鉴权读取后用原生播放器和隔离 HTML 预览展示。不修改 Hermes 源码。

**取舍：** 直接把 base64 放入消息会超过 WebSocket 限额；仅添加外部链接无法满足原生预览和权限要求。选独立上传与引用，使用现有 PostgreSQL 保存字节。每个接收文件最多 50 MiB，每条消息最多 10 个；现有 App 上传限额不变。

## 接口

- `Attachment` 增加可选 `attachment_id`，旧缓存仍可显示名称；消息和收件箱增加附件引用。
- `PUT /internal/attachments/v1/:id` 使用插件投递或 Connector 凭证，正文 `{profile_ref,name,mime,size,content_base64}`，返回 `{data:{attachment_id,name,mime,size}}`。同 ID 同内容可重试，冲突拒绝。
- `GET/HEAD /mobile/v1/attachments/:id` 使用设备凭证；仅下载可见消息引用的文件，支持 Range，HTML 不在服务器源直接执行。
- 插件在入队前保存文件快照；Connector 识别最终回复中的明确 `MEDIA:` 与本地 Markdown 链接，通过 Hermes 原生文件接口获取内容。
- App `MediaPlayer({uri,kind,name})` 只接收本地/Blob URI；`HtmlPreview({html,name})` 不接收设备凭证。

## 实施与验证

- [x] BFF/协议：持久附件、严格边界校验、按档案验证引用、鉴权下载、Range、纯附件投递及通知。
- [x] 插件：原生媒体发送方法、耐久文件快照、失败重试、旧 Hermes CLI 兼容入口。
- [x] Connector：最终文件标记解析、固定来源下载、幂等上传、保留失败文件提示、崩溃恢复。
- [x] App：共用附件组件；图片直接展示及放大，音视频播放，文档点击预览；加载失败可重试。
- [x] 验证：每层新增行为回归；独立临时 PostgreSQL 跑集成测试；`pnpm typecheck`、`pnpm test`、Python 插件测试及 iOS/Android JS bundle 导出。

实际浏览器验收使用 390×844 视口及独立 BFF：聊天与收件箱显示五类文件；图片全屏、Markdown 渲染通过；WAV 与 H.264/AAC MP4 播放时间正常推进；HTML 按钮计数从 0 变为 1，未发生页面运行错误。Python 插件持久队列到真实测试 BFF 的五类文件上传、投递及鉴权下载逐字节校验通过。

未部署正式服务或安装新原生包，未做 iOS/Android 真机解码与 WebView 验收。Connector 尚未保存文件字节快照，进程重启恢复在最终引用落盘前仍要求 Hermes 源文件存在；插件已保存完整字节。文件持久存储使用 PostgreSQL，未引用上传当前不自动回收。

## 核心检查

- 重试、源文件被删除时仍能投递同一文件，且不重复产生消息。
- 凭证不传给 Hermes 输出的任意 URL，附件不可跨档案读取或伪造元数据。
- 只有文件、没有文字时，消息及通知仍有内容。
- HTML 可运行内联交互；不共享 App 来源、凭证或本地文件访问，限制外跳、常规资源加载和 fetch。浏览器 CSP 不覆盖所有底层联网能力，不将此预览宣称为完全断网沙箱。
- 旧消息无文件 ID 时保留名称显示；新增原生依赖要求重新构建 App，不能只使用 OTA。
