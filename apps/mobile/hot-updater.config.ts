/// <reference types="node" />
import { existsSync } from "node:fs";
import { expo } from "@hot-updater/expo";
import { standaloneRepository, standaloneStorage } from "@hot-updater/standalone";
import { defineConfig } from "hot-updater";
import { apiKeys } from "hot-updater/plugins";

for (const file of [".env.local", ".env", ".env.hotupdater"]) {
  if (existsSync(file)) process.loadEnvFile(file);
}

export default defineConfig((options) => {
  if (options && (!process.env.EXPO_PUBLIC_HOT_UPDATER_BASE_URL || !process.env.EXPO_PUBLIC_HOT_UPDATER_API_KEY)) {
    throw new Error("发布热更新前，请在 .env.local 中配置热更新地址和客户端 API Key。");
  }
  const baseUrl = (process.env.HOT_UPDATER_BASE_URL ?? "http://127.0.0.1:4318").replace(/\/+$/, "");
  const url = new URL(baseUrl);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) {
    throw new Error("HOT_UPDATER_BASE_URL 必须使用 HTTPS；仅本机管理连接允许 HTTP。");
  }
  const commonHeaders = {
    // 原生构建和指纹计算只加载配置，不应要求持有发布凭据。
    get Authorization() {
      const token = process.env.HOT_UPDATER_ADMIN_TOKEN;
      if (!token) throw new Error("请在 .env.hotupdater 中配置 HOT_UPDATER_ADMIN_TOKEN。");
      return `Bearer ${token}`;
    },
  };
  return {
    build: expo(),
    updateStrategy: "fingerprint",
    fingerprint: { extraSources: ["app.json", "app.config.js", "eas.json"] },
    database: standaloneRepository({ baseUrl: `${baseUrl}/admin`, commonHeaders }),
    storage: standaloneStorage({ baseUrl: `${baseUrl}/storage`, protocol: "hermes-ota", commonHeaders }),
    plugins: [apiKeys()],
  };
});
