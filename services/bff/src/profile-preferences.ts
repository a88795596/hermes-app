import { MAX_PROFILE_ALIAS_LENGTH, MAX_PROFILE_AVATAR_BYTES } from "@hermes-mobile/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { attachmentUpload } from "./attachments.js";
import { matchesToken, readBearer } from "./auth.js";
import { findProfile } from "./mutations.js";
import { profiles } from "./projections.js";
import type { Store } from "./store.js";
import { ApiError, invalid, missing, record, string, uuid } from "./validation.js";

type Preferences = {
  alias?: string | null;
  avatar?: ReturnType<typeof attachmentUpload> | null;
  is_default?: boolean;
};

export function profilePreferences(value: unknown): Preferences {
  const body = record(value, ["alias", "avatar", "is_default"]);
  const update: Preferences = {};
  if (body.alias !== undefined) {
    const alias = body.alias === null ? "" : string(body.alias, "别名", MAX_PROFILE_ALIAS_LENGTH * 4, true).trim();
    if (Array.from(alias).length > MAX_PROFILE_ALIAS_LENGTH || /\p{Cc}/u.test(alias)) invalid(`别名最多 ${MAX_PROFILE_ALIAS_LENGTH} 个字，不能包含控制字符。`);
    update.alias = alias || null;
  }
  if (body.avatar !== undefined) {
    update.avatar = body.avatar === null ? null : attachmentUpload(body.avatar, MAX_PROFILE_AVATAR_BYTES);
    if (update.avatar && !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(update.avatar.reference.mime)) {
      invalid("头像须为 JPEG、PNG、GIF 或 WebP 图片。");
    }
  }
  if (body.is_default !== undefined) {
    if (typeof body.is_default !== "boolean") invalid("首页默认档案设置必须采用布尔值。");
    update.is_default = body.is_default;
  }
  return update;
}

function savePreferences(store: Store, refs: Set<string>, profile: string, update: Preferences) {
  return store.transaction(async (db) => {
    await db.query("INSERT INTO profile_preferences (profile_ref) VALUES ($1) ON CONFLICT DO NOTHING", [profile]);
    if (update.alias !== undefined) await db.query("UPDATE profile_preferences SET alias = $2 WHERE profile_ref = $1", [profile, update.alias]);
    if (update.avatar !== undefined) {
      const avatar = update.avatar;
      await db.query("UPDATE profile_preferences SET avatar_mime = $2, avatar_content = $3, avatar_sha256 = $4 WHERE profile_ref = $1",
        [profile, avatar?.reference.mime ?? null, avatar?.content ?? null, avatar?.reference.sha256 ?? null]);
    }
    if (update.is_default !== undefined) {
      if (update.is_default) await db.query("UPDATE profile_preferences SET is_default = false WHERE is_default");
      await db.query("UPDATE profile_preferences SET is_default = $2 WHERE profile_ref = $1", [profile, update.is_default]);
    }
    return profiles(db, refs);
  });
}

export function registerProfilePreferences(api: FastifyInstance, store: Store, refs: Set<string>,
  config: { connectorToken: string; inboxDeliveryToken?: string }, authenticate: (request: FastifyRequest) => Promise<string>,
  changed: () => void) {
  const bodyLimit = 4 * Math.ceil(MAX_PROFILE_AVATAR_BYTES / 3) + 16 * 1024;
  const deviceOptions = { bodyLimit, onRequest: async (request: FastifyRequest) => { await authenticate(request); } };
  const target = (request: FastifyRequest) => findProfile(refs, uuid(record(request.params).id, "配置档案 ID"));
  const success = (request: FastifyRequest, data: unknown) => ({ data, request_id: request.id, server_time: new Date().toISOString() });

  api.put("/mobile/v1/profiles/:id/preferences", deviceOptions, async (request) => {
    const profile = target(request);
    const updated = await savePreferences(store, refs, profile, profilePreferences(request.body));
    changed();
    return success(request, updated);
  });

  api.get("/mobile/v1/profiles/:id/avatar", deviceOptions, async (request, reply) => {
    const profile = target(request);
    const { rows: [avatar] } = await store.query<{ avatar_mime: string | null; avatar_content: Buffer | null }>(
      "SELECT avatar_mime, avatar_content FROM profile_preferences WHERE profile_ref = $1", [profile],
    );
    if (!avatar?.avatar_content || !avatar.avatar_mime) missing("头像");
    return reply.type(avatar.avatar_mime).header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, max-age=0, must-revalidate")
      .header("Content-Length", avatar.avatar_content.length).send(avatar.avatar_content);
  });

  api.put("/internal/profiles/v1/avatar", { bodyLimit, onRequest: async (request) => {
    const token = readBearer(request);
    if (!matchesToken(token, config.connectorToken) && !(config.inboxDeliveryToken && matchesToken(token, config.inboxDeliveryToken))) {
      throw new ApiError(401, "UNAUTHORIZED", "头像设置凭证无效。");
    }
  } }, async (request) => {
    const body = record(request.body, ["profile_ref", "avatar"]);
    const profile = string(body.profile_ref, "配置档案名称", 64);
    if (!refs.has(profile)) missing("配置档案");
    if (body.avatar === undefined || body.avatar === null) invalid("必须提供头像图片。");
    const updated = await savePreferences(store, refs, profile, profilePreferences({ avatar: body.avatar }));
    changed();
    return success(request, updated.find((item) => item.label === profile));
  });
}
