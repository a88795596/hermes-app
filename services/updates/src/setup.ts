import { config, hotUpdater } from "./hot-updater.js";
import { migrate } from "./migrate.js";

try {
  await migrate(config.databaseUrl, hotUpdater);
  if (process.argv.includes("--create-client-key")) {
    const { apiKey } = await hotUpdater.api.apiKeys.create({ name: "mobile" });
    console.log(`EXPO_PUBLIC_HOT_UPDATER_API_KEY=${apiKey}`);
  } else {
    console.log("热更新数据库已就绪。");
  }
} finally {
  await hotUpdater.database.dispose?.();
}
