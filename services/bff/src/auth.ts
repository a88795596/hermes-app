import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { Store } from "./store.js";

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest();
}

export function matchesToken(candidate: unknown, secret: string) {
  return typeof candidate === "string" && timingSafeEqual(tokenHash(candidate), tokenHash(secret));
}

export function readBearer(request: FastifyRequest) {
  return /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
}

export function deviceAuth(store: Store) {
  return {
    async issue(deviceName: string) {
      const deviceId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      await store.query("INSERT INTO devices (id, token_hash, name) VALUES ($1, $2, $3)", [deviceId, tokenHash(token), deviceName]);
      return { device_id: deviceId, token };
    },
    async authenticate(request: FastifyRequest): Promise<string | undefined> {
      const token = readBearer(request);
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
      const { rows } = await store.query("SELECT id FROM devices WHERE token_hash = $1", [tokenHash(token)]);
      return rows[0]?.id;
    },
    async revoke(deviceId: string) {
      await store.query("DELETE FROM devices WHERE id = $1", [deviceId]);
    },
  };
}
