import { toolingTargetOf } from "@hot-updater/plugin-core";
import type { HotUpdaterAPI } from "@hot-updater/server";
import pg from "pg";

export async function migrate(databaseUrl: string, hotUpdater: HotUpdaterAPI) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query("CREATE SCHEMA IF NOT EXISTS hot_updater");
  } finally {
    await pool.end();
  }
  const migrator = hotUpdater.database.createMigrator?.(toolingTargetOf(hotUpdater.plugins));
  if (!migrator) throw new Error("更新数据库不支持迁移。");
  await (await migrator.migrateToLatest()).execute();
}
