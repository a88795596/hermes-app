#!/bin/bash
set -euo pipefail

: "${DATABASE_URL:?请配置 DATABASE_URL}"
: "${APP_PAIRING_TOKEN:?请配置 APP_PAIRING_TOKEN}"
: "${HERMES_API_URL:?请配置 HERMES_API_URL}"
: "${HERMES_API_KEY:?请配置 HERMES_API_KEY}"
export BFF_URL="http://127.0.0.1:${PORT}"
CONNECTOR_TOKEN="${CONNECTOR_TOKEN:-$(node -p 'require("node:crypto").randomBytes(32).toString("hex")')}"
export CONNECTOR_TOKEN

node /app/services/bff/dist/main.mjs &
bff_pid=$!
node /app/services/connector/dist/main.cjs &
connector_pid=$!

trap 'kill "$connector_pid" "$bff_pid" 2>/dev/null || true; wait' EXIT
trap 'exit 0' TERM INT
wait -n "$bff_pid" "$connector_pid"
