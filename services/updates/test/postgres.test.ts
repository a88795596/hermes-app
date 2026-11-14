import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { createUUIDv7 } from "@hot-updater/plugin-core";
import { postgres } from "@hot-updater/postgres";
import { createHotUpdater } from "@hot-updater/server";
import { apiKeys } from "@hot-updater/server/plugins";
import { standaloneRepository, standaloneStorage } from "@hot-updater/standalone";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { migrate } from "../src/migrate.js";
import { createFileStorage } from "../src/storage.js";

test("PostgreSQL 中发布、指纹匹配、下载和禁用更新可通过官方 HTTP 协议闭环", {
  skip: !process.env.TEST_UPDATES_DATABASE_URL && "设置 TEST_UPDATES_DATABASE_URL 指向隔离测试数据库后运行。",
}, async (t) => {
  const adminToken = "test-only-admin-token-at-least-32-characters";
  const config = readConfig({ HOT_UPDATER_DATABASE_URL: process.env.TEST_UPDATES_DATABASE_URL,
    HOT_UPDATER_ADMIN_TOKEN: adminToken, HOT_UPDATER_BASE_URL: "http://127.0.0.1" });
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const publicBefore = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const dataDir = await mkdtemp(join(tmpdir(), "hermes-updates-pg-"));
  const storage = createFileStorage(dataDir, config.baseUrl, adminToken);
  let baseUrl = config.baseUrl;
  const hotUpdater = createHotUpdater({
    database: postgres({ connectionString: config.databaseUrl }),
    plugins: [apiKeys()],
    storage: { ...storage.adapter, async getDownloadUrl(input) {
      const { url } = await storage.adapter.getDownloadUrl(input);
      const parsed = new URL(url);
      return { url: `${baseUrl}${parsed.pathname}${parsed.search}` };
    } },
  });
  const app = buildApp({ dataDir, adminToken, storage, handlers: hotUpdater.handlers });
  t.after(async () => {
    await app.close();
    await hotUpdater.database.dispose?.();
    await pool.end();
    await rm(dataDir, { recursive: true, force: true });
  });
  await migrate(config.databaseUrl, hotUpdater);
  await migrate(config.databaseUrl, hotUpdater);
  baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const commonHeaders = { Authorization: `Bearer ${adminToken}` };
  const repository = standaloneRepository({ baseUrl: `${baseUrl}/admin`, commonHeaders });
  const files = standaloneStorage({ baseUrl: `${baseUrl}/storage`, protocol: "hermes-ota", commonHeaders });
  const { apiKey } = await hotUpdater.api.apiKeys.create({ name: "integration-test" });
  const headers = { "x-api-key": apiKey };
  const bundleId = createUUIDv7();
  const fingerprintHash = createHash("sha256").update(bundleId).digest("hex");
  const channel = `test-${bundleId}`;
  const channelKey = Buffer.from(channel).toString("base64url");
  const manifest = JSON.stringify({ bundleId, assets: {} });
  const { storageUri } = await files.put({ key: `bundles/${bundleId}/manifest.json`,
    body: new Blob([manifest]).stream(), contentType: "application/json" });
  const [deployment] = await repository.core.deploy([{
    bundle: { id: bundleId, platform: "ios", gitCommitHash: null,
      manifestStorageUri: storageUri, manifestFileHash: createHash("sha256").update(manifest).digest("hex"),
      assetBaseStorageUri: `hermes-ota://bundles/bundles/${bundleId}` },
    release: { channel, enabled: true, fingerprintHash, message: "测试更新", shouldForceUpdate: false, targetAppVersion: null },
  }]);
  assert.ok(deployment?.release);
  assert.equal((await repository.core.getBundle(bundleId))?.bundle.id, bundleId);
  const catalogUrl = `${baseUrl}/release-catalogs/fingerprint/ios/${channelKey}/${fingerprintHash}`;
  assert.equal((await fetch(catalogUrl)).status, 401);
  const catalog = await fetch(catalogUrl, { headers });
  assert.equal(catalog.status, 200);
  assert.match(await catalog.text(), new RegExp(bundleId));
  assert.equal((await fetch(`${baseUrl}/release-catalogs/fingerprint/ios/${channelKey}/${"a".repeat(64)}`, { headers })).status, 404);
  const artifact = await fetch(`${baseUrl}/artifacts/v2/${bundleId}/from/00000000-0000-0000-0000-000000000000`, { headers });
  assert.equal(artifact.status, 200);
  const info = await artifact.json() as { manifestUrl: string; manifestFileHash: string };
  const downloaded = await fetch(info.manifestUrl);
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), manifest);
  assert.equal(info.manifestFileHash, createHash("sha256").update(manifest).digest("hex"));
  await repository.core.updateReleasePolicy({ releaseId: deployment.release.id, patch: { enabled: false } });
  await setTimeout(5100);
  const afterDisable = await fetch(catalogUrl, { headers });
  assert.equal(afterDisable.status, 200);
  assert.doesNotMatch(await afterDisable.text(), new RegExp(bundleId));
  const publicAfter = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  assert.deepEqual(publicAfter.rows, publicBefore.rows);
  assert.ok((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='hot_updater'")).rowCount! > 0);
});
