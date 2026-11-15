import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { MAX_PROFILE_ALIAS_LENGTH, MAX_PROFILE_AVATAR_BYTES, type Profile } from "@hermes-mobile/protocol";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { profilePreferences } from "../src/profile-preferences.js";
import { profileId } from "../src/projections.js";
import { openStore } from "../src/store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const avatar = { name: "头像.png", mime: "image/png", size: png.length, content_base64: png.toString("base64") };

test("档案设置校验 Unicode 别名、空值及真实图片上传", () => {
  assert.deepEqual(profilePreferences({ alias: "  我的助手  ", is_default: true }), { alias: "我的助手", is_default: true });
  assert.deepEqual(profilePreferences({ alias: "  ", avatar: null, is_default: false }), { alias: null, avatar: null, is_default: false });
  assert.deepEqual(profilePreferences({ alias: null }), { alias: null });
  assert.equal(profilePreferences({ alias: "😀".repeat(MAX_PROFILE_ALIAS_LENGTH) }).alias, "😀".repeat(MAX_PROFILE_ALIAS_LENGTH));
  const accepted = profilePreferences({ avatar }).avatar;
  assert(accepted);
  assert.deepEqual(accepted.content, png);
  assert.equal(accepted.reference.mime, "image/png");
  const text = { name: "文档.txt", mime: "text/plain", size: 3, content_base64: "YWJj" };
  for (const invalid of [
    null, [], { label: "不能改原名" }, { alias: 1 }, { alias: "a".repeat(MAX_PROFILE_ALIAS_LENGTH + 1) },
    { alias: "非法\u0000" }, { is_default: "true" }, { is_default: null }, { avatar: text },
    { avatar: { ...text, mime: "image/png" } }, { avatar: { ...avatar, name: "../头像.png" } },
    { avatar: { ...avatar, size: 0 } }, { avatar: { ...avatar, size: MAX_PROFILE_AVATAR_BYTES + 1 } },
    { avatar: { ...avatar, size: avatar.size + 1 } }, { avatar: { ...avatar, content_base64: "invalid" } },
    { avatar: { ...avatar, extra: true } },
  ]) assert.throws(() => profilePreferences(invalid), { statusCode: 422 });
});

test("档案设置跨设备持久保存，头像权限隔离且首页默认值唯一", { skip: !databaseUrl, timeout: 20_000 }, async () => {
  const schema = `profile_preferences_${randomUUID().replaceAll("-", "")}`;
  const database = new pg.Pool({ connectionString: databaseUrl });
  await database.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const options = { databaseUrl: url.href, pairingToken: "pairing-secret", connectorToken: "connector-secret",
    inboxDeliveryToken: "delivery-secret", profileRefs: ["default", "work"] };
  const app = buildApp(options);
  const store = openStore(url.href);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  try {
    const pair = async (name: string) => {
      const result = await app.inject({ method: "POST", url: "/mobile/v1/pairings/redeem",
        payload: { pairing_token: options.pairingToken, device_name: name } });
      assert.equal(result.statusCode, 200);
      return result.json().data.token as string;
    };
    const token = await pair("手机");
    const otherToken = await pair("平板");
    const get = async (deviceToken = token) => {
      const result = await app.inject({ url: "/mobile/v1/profiles", headers: bearer(deviceToken) });
      assert.equal(result.statusCode, 200);
      return result.json().data as Profile[];
    };
    const put = (ref: string, payload: object, deviceToken = token) => app.inject({ method: "PUT",
      url: `/mobile/v1/profiles/${profileId(ref)}/preferences`, headers: deviceToken ? bearer(deviceToken) : {}, payload });
    const internal = (profile_ref: string, image: unknown = avatar, machineToken = options.inboxDeliveryToken) => app.inject({
      method: "PUT", url: "/internal/profiles/v1/avatar", headers: machineToken ? bearer(machineToken) : {},
      payload: { profile_ref, avatar: image },
    });
    const initial = await get();
    assert.deepEqual(initial.map(({ profile_id, label }) => ({ profile_id, label })), [
      { profile_id: profileId("default"), label: "default" }, { profile_id: profileId("work"), label: "work" },
    ]);
    assert.equal(initial.filter((profile) => profile.is_default).length, 0);
    assert.equal((await put("work", { alias: "工作助手" }, "")).statusCode, 401);
    assert.equal((await put("work", { alias: "工作助手" }, "connector-secret")).statusCode, 401);
    assert.equal((await put("private", { alias: "隐藏" })).statusCode, 404);
    assert.equal((await put("work", { is_default: 1 })).statusCode, 422);
    assert.equal((await put("work", { unknown: true })).statusCode, 422);
    const saved = await put("work", { alias: "工作助手", avatar, is_default: true });
    assert.equal(saved.statusCode, 200);
    const profiles = saved.json().data as Profile[];
    const work = profiles.find((profile) => profile.label === "work")!;
    assert.equal(work.alias, "工作助手");
    assert.equal(work.is_default, true);
    assert.match(work.avatar_url!, new RegExp(`^/mobile/v1/profiles/${profileId("work")}/avatar\\?v=[a-f0-9]{64}$`, "u"));
    assert.deepEqual(await get(otherToken), profiles);
    assert(!saved.body.includes("content_base64"));

    for (const downloadToken of ["", "connector-secret", "delivery-secret"]) {
      const denied = await app.inject({ url: work.avatar_url!, headers: downloadToken ? bearer(downloadToken) : {} });
      assert.equal(denied.statusCode, 401);
    }
    const image = await app.inject({ url: work.avatar_url!, headers: bearer(otherToken) });
    assert.equal(image.statusCode, 200);
    assert.deepEqual(image.rawPayload, png);
    assert.equal(image.headers["content-type"], "image/png");
    assert.equal(image.headers["x-content-type-options"], "nosniff");
    assert.match(String(image.headers["cache-control"]), /private/u);
    assert.equal((await app.inject({ url: `/mobile/v1/profiles/${profileId("private")}/avatar`, headers: bearer(token) })).statusCode, 404);

    assert.equal((await put("work", { alias: "新别名" })).statusCode, 200);
    const renamed = (await get()).find((profile) => profile.label === "work")!;
    assert.equal(renamed.avatar_url, work.avatar_url);
    assert.equal(renamed.is_default, true);
    assert.equal((await put("default", { is_default: false })).statusCode, 200);
    assert.equal((await get()).find((profile) => profile.label === "work")!.is_default, true);

    for (const machineToken of ["", "pairing-secret", token]) {
      assert.equal((await internal("work", avatar, machineToken)).statusCode, 401);
    }
    assert.equal((await internal("private")).statusCode, 404);
    assert.equal((await internal("work", null)).statusCode, 422);
    assert.equal((await internal("work", { ...avatar, size: MAX_PROFILE_AVATAR_BYTES + 1 })).statusCode, 422);
    assert.equal((await internal("work", { ...avatar, content_base64: "invalid" })).statusCode, 422);
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    const replaced = await internal("work", { name: "头像.gif", mime: "image/gif", size: gif.length,
      content_base64: gif.toString("base64") }, "connector-secret");
    assert.equal(replaced.statusCode, 200);
    const updated = replaced.json().data as Profile;
    assert.equal(updated.alias, "新别名");
    assert.equal(updated.is_default, true);
    assert.notEqual(updated.avatar_url, work.avatar_url);
    assert.deepEqual((await app.inject({ url: updated.avatar_url!, headers: bearer(token) })).rawPayload, gif);
    assert.equal((await internal("work", { name: "头像.gif", mime: "image/gif", size: gif.length,
      content_base64: gif.toString("base64") })).statusCode, 200);

    await store.migrate();
    const restarted = buildApp(options);
    try {
      const refreshed = await restarted.inject({ url: "/mobile/v1/profiles", headers: bearer(otherToken) });
      assert.equal(refreshed.statusCode, 200);
      assert.deepEqual(refreshed.json().data, await get());
    } finally {
      await restarted.close();
    }
    const concurrent = await Promise.all([put("default", { is_default: true }), put("work", { is_default: true }, otherToken)]);
    assert(concurrent.every((result) => result.statusCode === 200));
    const afterConcurrent = await get();
    assert.equal(afterConcurrent.filter((profile) => profile.is_default).length, 1);
    const defaultProfile = afterConcurrent.find((profile) => profile.is_default)!;
    assert.equal((await put(defaultProfile.label, { is_default: false })).statusCode, 200);
    assert.equal((await get()).filter((profile) => profile.is_default).length, 0);
    assert.equal((await put("work", { alias: null, avatar: null })).statusCode, 200);
    const cleared = (await get()).find((profile) => profile.label === "work")!;
    assert.equal(cleared.alias, undefined);
    assert.equal(cleared.avatar_url, undefined);
    assert.equal((await app.inject({ url: updated.avatar_url!, headers: bearer(token) })).statusCode, 404);
    assert.equal((await put("work", { alias: "新别名" })).statusCode, 200);
    assert.equal((await put("work", { alias: "   " })).statusCode, 200);
    assert.equal((await get()).find((profile) => profile.label === "work")!.alias, undefined);
  } finally {
    await app.close();
    await store.close();
    await database.query(`DROP SCHEMA ${schema} CASCADE`);
    await database.end();
  }
});
