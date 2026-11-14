import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createEngineDatabase, createMemoryAdapter, migrateCoreSchema } from "@hot-updater/plugin-core";
import { createHotUpdater } from "@hot-updater/server";
import { apiKeys } from "@hot-updater/server/plugins";
import { standaloneRepository, standaloneStorage } from "@hot-updater/standalone";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { createFileStorage } from "../src/storage.js";

const adminToken = "test-admin-token-with-at-least-32-characters";
const auth = { Authorization: `Bearer ${adminToken}` };

async function server(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "hermes-updates-"));
  const adapter = createMemoryAdapter();
  const plugins = [apiKeys()] as const;
  await migrateCoreSchema(adapter, "memory", plugins);
  const storage = createFileStorage(dataDir, "http://127.0.0.1", adminToken);
  const hotUpdater = createHotUpdater({ database: createEngineDatabase({ name: "memory", adapter }), storage: storage.adapter, plugins });
  const app = buildApp({ dataDir, adminToken, storage, handlers: hotUpdater.handlers });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const downloadStorage = createFileStorage(dataDir, baseUrl, adminToken);
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const client = standaloneStorage({ baseUrl: `${baseUrl}/storage`, protocol: "hermes-ota", commonHeaders: auth });
  return { app, client, baseUrl, dataDir, hotUpdater, storage: downloadStorage };
}

test("管理与上传全部要求独立凭据，客户端 API key 不授予管理权限", async (t) => {
  const { app, baseUrl, hotUpdater } = await server(t);
  for (const url of ["/admin", "/admin/version", "/storage/upload", "/storage/get", "/storage/exists", "/storage/delete", "/%61dmin/version", "/%73torage/upload", "/%73torage/exists"]) {
    const result = await app.inject({ method: url.endsWith("/delete") ? "DELETE" : "POST", url });
    assert.equal(result.statusCode, 401, url);
  }
  assert.equal((await app.inject("/version")).statusCode, 200);
  assert.equal((await app.inject({ url: "/admin/version", headers: auth })).statusCode, 200);
  const { apiKey } = await hotUpdater.api.apiKeys.create({ name: "test-mobile" });
  assert.equal((await app.inject({ url: "/admin/version", headers: { authorization: `Bearer ${apiKey}` } })).statusCode, 401);
  const repo = standaloneRepository({ baseUrl: `${baseUrl}/admin`, commonHeaders: auth });
  assert.equal((await repo.fetchAdmin("/version")).status, 200);
});

test("官方 storage adapter 上传、读取、存在检测和精确删除可往返，签名下载校验内容与期限", async (t) => {
  const { app, client, storage } = await server(t);
  const body = "OTA 资源 # % 中文\n";
  const { storageUri } = await client.put({ key: "bundles/test/中文 #%.bundle", body: new Blob([body]).stream(), contentType: "application/octet-stream" });
  assert.deepEqual(await client.exists({ storageUri }), { exists: true });
  assert.equal(await (await client.get({ storageUri })).response?.text(), body);
  const { url } = await storage.adapter.getDownloadUrl({ storageUri });
  const result = await fetch(url);
  assert.equal(result.status, 200);
  assert.equal(await result.text(), body);
  const tampered = new URL(url);
  tampered.searchParams.set("uri", "hermes-ota://bundles/bundles/other/manifest.json");
  assert.equal((await fetch(tampered)).status, 403);
  const expired = new URL(url);
  const expires = String(Math.floor(Date.now() / 1000) - 1);
  expired.searchParams.set("expires", expires);
  expired.searchParams.set("signature", createHmac("sha256", adminToken).update(`download\n${expires}\n${storageUri}`).digest("hex"));
  assert.equal((await fetch(expired)).status, 403);
  assert.equal((await app.inject({ url: "/download" })).statusCode, 400);
  await client.delete({ storageUri });
  await client.delete({ storageUri });
  assert.deepEqual(await client.exists({ storageUri }), { exists: false });
  assert.equal((await client.get({ storageUri })).response, null);
});

test("拒绝路径穿越和其他桶，上传失败不覆盖已有文件或留下临时文件", async (t) => {
  const { app, client, baseUrl, dataDir } = await server(t);
  const original = await client.put({ key: "bundles/original/manifest.json", body: new Blob(["original"]).stream(), contentType: "application/json" });
  for (const key of ["../escape", "/absolute", "a//b", "a/./b", "a\\b", "a/\0b"]) {
    await assert.rejects(client.put({ key, body: new Blob(["bad"]).stream(), contentType: "application/octet-stream" }));
  }
  for (const storageUri of ["hermes-ota://other/a", "hermes-ota://bundles/../a", "hermes-ota://bundles/a/%2E%2E/b", "hermes-ota://bundles/a%2Fb", "file://bundles/a"]) {
    for (const route of ["get", "exists", "delete"]) {
      const result = await app.inject({ method: route === "delete" ? "DELETE" : "POST", url: `/storage/${route}`, headers: auth, payload: { storageUri } });
      assert.equal(result.statusCode, 400, `${route} ${storageUri}`);
    }
  }
  const form = new FormData();
  form.append("file", new Blob(["replacement"]), "manifest.json");
  form.append("key", "bundles/original/manifest.json");
  form.append("unexpected", "field");
  assert.equal((await fetch(`${baseUrl}/storage/upload`, { method: "POST", headers: auth, body: form })).status, 413);
  assert.equal(await (await client.get(original)).response?.text(), "original");
  assert.deepEqual(await readdir(join(dataDir, "uploads")), []);
});

test("服务配置拒绝缺少凭据、无效地址与端口", () => {
  const env = { HOT_UPDATER_DATABASE_URL: "postgresql://localhost/test", HOT_UPDATER_ADMIN_TOKEN: adminToken, HOT_UPDATER_BASE_URL: "https://updates.example.com/ota/" };
  assert.equal(readConfig(env).baseUrl, "https://updates.example.com/ota");
  assert.equal(new URL(readConfig({ ...env, HOT_UPDATER_DATABASE_URL: "postgres://localhost/test?options=-c%20search_path%3Dpublic" }).databaseUrl).searchParams.get("options"), "-c search_path=hot_updater");
  assert.throws(() => readConfig({ ...env, HOT_UPDATER_ADMIN_TOKEN: "short" }));
  assert.throws(() => readConfig({ ...env, HOT_UPDATER_BASE_URL: "https://user:password@example.com" }));
  assert.throws(() => readConfig({ ...env, PORT: "0" }));
  assert.throws(() => readConfig({ ...env, PORT: "NaN" }));
});
