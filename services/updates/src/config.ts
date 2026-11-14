import { resolve } from "node:path";

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = env.HOT_UPDATER_DATABASE_URL;
  const adminToken = env.HOT_UPDATER_ADMIN_TOKEN;
  const baseUrl = env.HOT_UPDATER_BASE_URL;
  if (!databaseUrl || !adminToken || adminToken.length < 32 || !baseUrl) {
    throw new Error("请设置 HOT_UPDATER_DATABASE_URL、HOT_UPDATER_BASE_URL 及至少 32 字符的独立 HOT_UPDATER_ADMIN_TOKEN。");
  }
  const database = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(database.protocol)) throw new Error("HOT_UPDATER_DATABASE_URL 必须是 PostgreSQL 地址。");
  database.searchParams.set("options", "-c search_path=hot_updater");
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("HOT_UPDATER_BASE_URL 必须是没有查询参数和凭据的 HTTP(S) 地址。");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("远程热更新服务必须使用 HTTPS。HTTP 仅支持本机调试。");
  }
  const port = Number(env.PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT 必须是 1 至 65535 的端口号。");
  return { databaseUrl: database.href, adminToken, baseUrl: baseUrl.replace(/\/$/, ""),
    dataDir: resolve(env.HOT_UPDATER_DATA_DIR ?? "../../.data/updates"), host: env.HOST ?? "127.0.0.1", port };
}
