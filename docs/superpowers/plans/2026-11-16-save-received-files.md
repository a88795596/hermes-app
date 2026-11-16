# 保存收到的附件 Implementation Plan

**Goal:** 聊天和收件箱里可下载的图片、视频和其他文件可以保存到手机本地。

**Architecture:** 保存服务复用 `loadAttachment` 获得已校验的缓存文件。原生端使用系统相册或系统目录选择器，Web 端触发浏览器下载；附件组件负责忙碌、成功、失败状态。

**Tech Stack:** Expo SDK 58、TypeScript、expo-file-system、expo-media-library、Node test。

**Spec:** `docs/superpowers/specs/2026-11-16-save-received-files-design.md`

## Global Constraints

- 使用中文 UI；不修改 Hermes Agent 源码。
- 不覆盖目标目录已有同名文件。
- 原生依赖变化需要重新编译 iOS 和 Android；本次不发布热更新。

## Tasks

- [x] 为原生保存流程写失败测试，覆盖相册、普通文件、重名、取消和失败清理。
- [x] 实现原生保存流程，并使测试通过。
- [x] 为 Web 浏览器下载写失败测试并实现。
- [x] 为附件保存入口与状态写失败测试并实现。
- [x] 配置相册权限与依赖，运行类型检查、测试和 lint，核对原生指纹并推送 `main`。
