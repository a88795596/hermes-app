# Connector

The Connector is a Node 24 process that opens an outbound WSS connection to the BFF and keeps a local SQLite spool. It supports a local Canonical Gateway and an explicitly configured Hermes HTTP Runs server. See the [root README](../../README.md#run-the-personal-mvp) for commands and credentials.

Run from source with `pnpm dev:connector`. Pack with `pnpm --filter @hermes-mobile/connector pack` to obtain a local npm tarball with a `hermes-mobile-connector` executable. The optional Python delivery plugin is installed separately on the Hermes host.
