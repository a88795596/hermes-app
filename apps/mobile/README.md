# Hermes Mobile app

The app uses Expo Router under `src/app`. See the [module boundaries](./src/ARCHITECTURE.md) and [local Hermes setup](../../README.md#run-the-personal-mvp).

After installing a native development build, start Metro from the workspace root:

```sh
pnpm dev:mobile
```

Pair with the BFF origin and its pairing token. The iOS and Android app supports text chat, stop, pending approvals or clarifications, and Inbox. SecureStore keeps the device credential and app-private SQLite keeps cached history and queued text. Native remote notifications require a configured development build.
