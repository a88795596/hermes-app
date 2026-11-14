import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { LogController } from "fastify";

import { migratePush, startPushWorker } from "./push.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerPersonalRoutes } from "./routes/personal.js";
import { openStore } from "./store.js";

interface AppOptions {
  databaseUrl: string;
  pairingToken: string;
  connectorToken: string;
  inboxDeliveryToken?: string;
  profileRefs?: string[];
}

export function buildApp(options?: AppOptions) {
  const app = Fastify({
    bodyLimit: 256 * 1024, logger: options !== undefined,
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.register(registerHealthRoute);

  if (options) {
    if (!options.databaseUrl || !options.pairingToken || !options.connectorToken || options.pairingToken === options.connectorToken) {
      throw new Error("请提供数据库地址，并为应用和连接器分别设置不同的令牌。");
    }
    const store = openStore(options.databaseUrl);
    let stopPush: (() => void | Promise<void>) | undefined;
    store.onError(() => app.log.error("数据库连接已断开"));
    app.addHook("onReady", async () => {
      await store.migrate();
      await migratePush(store);
      stopPush = startPushWorker(store, app.log);
    });
    app.addHook("onClose", async () => {
      await stopPush?.();
      await store.close();
    });
    app.register(cors, {
      origin: /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/,
      methods: ["GET", "POST", "PUT", "DELETE"],
    });
    app.register(websocket, {
      options: { maxPayload: 1024 * 1024 },
      errorHandler: (_error, socket) => {
        app.log.warn("处理 WebSocket 连接失败");
        socket.terminate();
      },
    });
    app.register(async (api) => registerPersonalRoutes(api, store, {
      ...options, profileRefs: options.profileRefs ?? ["default"],
    }));
  }

  return app;
}
