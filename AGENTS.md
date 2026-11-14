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

## Coding Style

Use two-space indentation in TypeScript and four spaces in Python. Match neighboring quote style and use descriptive names such as `useWorkspace` and `model-picker.tsx`. Keep the shared protocol framework-neutral. Validate data at transport boundaries and keep Hermes credentials on the Connector host. Update both peers and the shared types when changing a wire contract.

## Testing

Run `pnpm typecheck` and `pnpm test` before submitting. The service suites use Node’s `node:test` through `tsx` and name files `*.test.ts`. Run one suite with `pnpm --filter @hermes-mobile/connector test`. Cover changed behavior with a focused regression case. The mobile package exposes Expo lint through `pnpm --filter @hermes-mobile/mobile lint`.

## Commits and Pull Requests

Write short, imperative subjects. The history includes `feat: add chat commands and profile skills` and `Add interactive model selection and clarification to mobile chat`. In PRs, explain the behavior change, list checks run, link related issues when available, and include screenshots for visible App changes.

## Agent Workflow

Clarify material ambiguities before implementing. If the repository root contains `.codegraph/`, use `codegraph_explore` or `codegraph explore "<symbol or question>"` before searching or reading source files.

## Project

项目内使用中文作为UI语言。
尽量避免使用二级描述来表达功能，尽可能的用布局的方式来表述