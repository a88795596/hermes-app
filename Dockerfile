FROM node:24-bookworm-slim AS workspace
WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm --version
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/hermes-adapter/package.json ./packages/hermes-adapter/
COPY services/bff/package.json ./services/bff/
COPY services/connector/package.json ./services/connector/

FROM workspace AS build
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/ ./packages/
COPY services/ ./services/
RUN pnpm --filter @hermes-mobile/connector build \
    && pnpm --filter @hermes-mobile/connector exec esbuild ../bff/src/main.ts \
        --bundle --platform=node --target=node24 --format=esm --packages=external \
        --alias:@hermes-mobile/protocol=../../packages/protocol/src/index.ts --outfile=../bff/dist/main.mjs

FROM workspace AS production-deps
RUN pnpm --filter @hermes-mobile/bff... install --prod --frozen-lockfile

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o node -g node /var/lib/hermes-mobile
COPY --from=production-deps /build/node_modules ./node_modules
COPY --from=production-deps /build/services/bff/node_modules ./services/bff/node_modules
COPY --from=build /build/services/bff/dist/ ./services/bff/dist/
COPY --from=build /build/services/connector/dist/ ./services/connector/dist/
COPY docker/start.sh ./start.sh
ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=4317 \
    CONNECTOR_DB_PATH=/var/lib/hermes-mobile/connector.sqlite \
    HERMES_WEBAPP_URL=http://127.0.0.1:9120
USER node
EXPOSE 4317
HEALTHCHECK --interval=5s --timeout=3s --start-period=15s \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(async r => { if (!r.ok || (await r.json()).status !== 'ok') process.exitCode = 1 }).catch(() => { process.exitCode = 1 })"]
CMD ["bash", "/app/start.sh"]
