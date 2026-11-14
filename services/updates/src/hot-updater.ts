import { postgres } from "@hot-updater/postgres";
import { createHotUpdater } from "@hot-updater/server";
import { apiKeys } from "@hot-updater/server/plugins";
import { readConfig } from "./config.js";
import { createFileStorage } from "./storage.js";

export const config = readConfig();
export const storage = createFileStorage(config.dataDir, config.baseUrl, config.adminToken);
export const hotUpdater = createHotUpdater({
  database: postgres({ connectionString: config.databaseUrl }),
  storage: storage.adapter,
  plugins: [apiKeys()],
});
