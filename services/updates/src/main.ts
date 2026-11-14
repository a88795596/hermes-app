import { buildApp } from "./app.js";
import { config, hotUpdater, storage } from "./hot-updater.js";
import { migrate } from "./migrate.js";

const app = buildApp({ ...config, storage, handlers: hotUpdater.handlers });
app.addHook("onClose", async () => {
  await hotUpdater.flush();
  await hotUpdater.database.dispose?.();
});

try {
  await migrate(config.databaseUrl, hotUpdater);
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error, "热更新服务启动失败");
  await app.close();
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close());
}
