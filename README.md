# Hermes Mobile

This repository is a pnpm workspace for the Hermes mobile client system.

| Area | Owner | Purpose |
| --- | --- | --- |
| `apps/mobile` | Expo Router app | Native client and local-first UI |
| `services/bff` | Fastify service | Public Mobile API, authorization, and projections |
| `services/connector` | Node service | Outbound connection from the Hermes host to the BFF |
| `packages/protocol` | Shared package | Mobile and Connector wire contracts |
| `packages/hermes-adapter` | Shared package | Hermes-specific normalization boundary |
| `plugins/hermes-mobile-delivery` | Hermes Python plugin | Registers the text delivery channel for Cron and `hermes send` |

`packages/protocol` must remain framework-neutral. The mobile app must not receive Hermes credentials or import Node-only code. The BFF does not connect directly to Hermes; the Connector owns that boundary.

## Design and delivery

- [iOS and Android technical design](docs/superpowers/specs/2026-11-13-hermes-mobile-design.md)
- [Mobile and Connector contract baseline](docs/superpowers/specs/2026-11-13-hermes-mobile-contracts.md)
- [Parallel implementation work packages and acceptance cases](docs/superpowers/plans/2026-11-13-hermes-mobile-parallel-plan.md)
- [Implemented MVP wire contract](docs/superpowers/plans/2026-11-13-personal-mvp-wire.md)
- [Engineering specification v2 source](docs/reference/hermes-expo-engineering-spec-v2.md)

## Run the personal MVP

Install with Node 24 and pnpm 10.14. Use one BFF, one PostgreSQL database and one Connector. The BFF creates its tables on startup. Run commands from the workspace root.

```sh
pnpm install
pnpm typecheck
```

1. Start the BFF. Supply the database URL and two distinct, random secrets. The phone exchanges the pairing token for a per-device credential. The Connector uses the machine token. To start a dedicated development database with Docker, run:

   ```sh
   docker run -d --name hermes-mobile-postgres -p 127.0.0.1:55432:5432 \
     -e POSTGRES_DB=hermes_mobile -e POSTGRES_PASSWORD=hermes-dev-local \
     -v hermes-mobile-pgdata:/var/lib/postgresql/data postgres:16-alpine
   ```

   ```sh
   export DATABASE_URL='postgresql://postgres:hermes-dev-local@127.0.0.1:55432/hermes_mobile'
   export APP_PAIRING_TOKEN='REPLACE_WITH_YOUR_PAIRING_SECRET'
   export CONNECTOR_TOKEN='REPLACE_WITH_YOUR_MACHINE_SECRET'
   export PORT=4317
   pnpm dev:bff
   ```

2. For the local `hermes-dev` container, use the HTTP Runs API published at port 8642. Keep the API key in the Connector environment. This command captures the configured key without printing it. Leave shell tracing disabled.

   ```sh
   export BFF_URL='http://127.0.0.1:4317'
   export CONNECTOR_TOKEN='THE_SAME_MACHINE_SECRET'
   export HERMES_API_URL='http://127.0.0.1:8642'
   export HERMES_API_KEY="$(docker exec hermes-dev printenv API_SERVER_KEY)"
   export CONNECTOR_DB_PATH="$PWD/.data/connector.sqlite"
   pnpm dev:connector
   ```

   The HTTP adapter uses Hermes API-owned sessions. For a newer Hermes installation, leave `HERMES_API_URL` unset and run the Connector on that machine as the Gateway owner, with `HERMES_BIN` pointing to a CLI that supports `gateway attach --json`. Keep the Connector database and BFF database paired with the same Hermes backend and transport. Use separate databases to try a different backend.

   If chat runs fail with `no_provider_configured` in the container logs, configure a model provider for the container's Hermes user with `docker exec -it -u hermes hermes-dev hermes model`. The API server key authenticates the Connector; the model provider has its own credentials.

3. Start the App in a separate terminal. Build and open a development client on either platform using the matching command:

   ```sh
   pnpm --filter @hermes-mobile/mobile exec expo run:ios
   pnpm --filter @hermes-mobile/mobile exec expo run:android
   ```

   After installing the development client, use `pnpm dev:mobile` to restart Metro. Pair with `APP_PAIRING_TOKEN` and the BFF origin. Use `http://127.0.0.1:4317` on the iOS simulator, `http://10.0.2.2:4317` on the Android emulator, or the BFF's trusted HTTPS reverse proxy on a physical device. The native app stores the device token in SecureStore and uses app-private SQLite for history and queued text. A development build with a configured Expo project ID and APNs/FCM credentials can enable Inbox notifications in Connection.

4. To package the Connector for local npm installation, run `pnpm --filter @hermes-mobile/connector pack` and install the resulting tarball. For Cron and `hermes send`, install the [Hermes delivery plugin](plugins/hermes-mobile-delivery/README.md) on the Hermes machine, with the spool available to the Connector.

## Interactive chat

Send `/model` in a Topic and choose a provider, then a model. The menu uses that Hermes profile’s configured providers and marks the current selection. You can switch once the current turn finishes. The selection applies to future turns in the current Topic.

When the agent calls `clarify`, tap an option to answer the waiting turn. The card also supports multiple selections, a typed answer, and skipping the question.

With HTTP Runs, the Hermes API profile must expose pending run controls and have the `clarify` tool enabled. On the development container, enable it as the Hermes user:

```sh
docker exec -u hermes hermes-dev hermes tools enable --platform api_server clarify
```

For a named Hermes profile, use the same command with `hermes --profile <name> tools enable --platform api_server clarify`. For Canonical Gateway, the Topic’s local-session toolset must include `clarify`.

The [implemented wire](docs/superpowers/plans/2026-11-13-personal-mvp-wire.md) is the first slice of the design. It uses a single account, text chat, and WSS change notices with HTTP catch-up. Media attachments, system share-in, snapshot cursors, and production-grade deployment and device validation remain separate work.
