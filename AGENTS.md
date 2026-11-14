# Repository Guidelines

## Project Structure

- `apps/mobile/` is the Expo app. Routes live in `src/app/`, chat components in `src/chat/`, and bundled images and icons in `assets/`.
- `services/bff/` serves the Mobile API and stores projections in PostgreSQL. `services/connector/` runs on the Hermes host, talks to Hermes, and keeps a local SQLite spool. Both services keep code in `src/` and tests in `test/`.
- `packages/protocol/` contains shared wire types. `packages/hermes-adapter/` parses Hermes-specific payloads. `plugins/hermes-mobile-delivery/` is the Python 3.11+ Inbox delivery plugin.
- Use `docs/` for design and wire contracts and `tests/` for cross-project integration, contract, and fault-injection tests.

## Build and Development

Use Node.js 24 and pnpm 10.14. Run commands from the repository root.

- `pnpm install --frozen-lockfile` installs workspace dependencies.
- `pnpm dev:bff`, `pnpm dev:connector`, and `pnpm dev:mobile` start the API, Hermes bridge, and Expo Metro server. Follow the [README](README.md#run-the-personal-mvp) for PostgreSQL, Hermes, and device pairing.
- `pnpm --filter @hermes-mobile/mobile android` builds and runs the Android development client. Use `ios` for iOS.
- `pnpm --filter @hermes-mobile/connector build` bundles the Connector into `dist/main.cjs`.

日常 App 交付统一从仓库根目录使用：

- `pnpm app:android`：本机编译 Android Release，安装并启动真机。
- `pnpm app:ios`：本机 Xcode 编译 iOS Ad Hoc Release，安装并启动真机。使用 EAS `--local`，不发起云端构建。
- `pnpm ota:push --message "更新说明"`：同时发布 iOS 和 Android 热更新到 `preview`；不执行 Git 提交或推送，不自动重建原生指纹。

多台真机使用 `--device <标识>` 指定。JavaScript 和资源更新优先使用热更新；首次接入或原生依赖、权限、图标、渠道改变时才重新编译原生包。密钥只保存在被 Git 忽略的本地环境文件中。

## Coding Style

Use two-space indentation in TypeScript and four spaces in Python. Match neighboring quote style and use descriptive names such as `useWorkspace` and `model-picker.tsx`. Keep the shared protocol framework-neutral. Validate data at transport boundaries and keep Hermes credentials on the Connector host. Update both peers and the shared types when changing a wire contract.

## Testing

Run `pnpm typecheck` and `pnpm test` before submitting. The service suites use Node’s `node:test` through `tsx` and name files `*.test.ts`. Run one suite with `pnpm --filter @hermes-mobile/connector test`. Cover changed behavior with a focused regression case. The mobile package exposes Expo lint through `pnpm --filter @hermes-mobile/mobile lint`.

## Commits and Pull Requests

Write short, imperative subjects. The history includes `feat: add chat commands and profile skills` and `Add interactive model selection and clarification to mobile chat`. In PRs, explain the behavior change, list checks run, link related issues when available, and include screenshots for visible App changes.

## Agent Workflow

Clarify material ambiguities before implementing. If the repository root contains `.codegraph/`, use `codegraph_explore` or `codegraph explore "<symbol or question>"` before searching or reading source files.

## Project

Hermes Agent 源码保持原版。通过 Hermes 原生接口、配置或插件机制接入。

项目内使用中文作为UI语言。
尽量避免使用二级描述来表达功能，尽可能的用布局的方式来表述
