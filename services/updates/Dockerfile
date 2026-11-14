FROM node:24.22.1-bookworm-slim AS workspace
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/updates/package.json ./services/updates/

FROM workspace AS build
RUN pnpm --filter @hermes-mobile/updates install --frozen-lockfile
COPY tsconfig.base.json ./
COPY services/updates/ ./services/updates/
RUN pnpm --filter @hermes-mobile/updates build

FROM workspace AS production-deps
RUN pnpm --filter @hermes-mobile/updates install --prod --frozen-lockfile

FROM node:24.22.1-bookworm-slim
WORKDIR /app
RUN install -d -m 0700 -o node -g node /var/lib/hermes-updates
COPY --from=production-deps /build/node_modules ./node_modules
COPY --from=production-deps /build/services/updates/node_modules ./services/updates/node_modules
COPY --from=build /build/services/updates/dist/ ./services/updates/dist/
ENV NODE_ENV=production HOST=127.0.0.1 PORT=4318 HOT_UPDATER_DATA_DIR=/var/lib/hermes-updates
USER node
EXPOSE 4318
HEALTHCHECK --interval=5s --timeout=3s --start-period=15s \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => { if (!r.ok) process.exitCode = 1 }).catch(() => { process.exitCode = 1 })"]
CMD ["node", "services/updates/dist/main.mjs"]
