import { topicTitlePreview } from "@hermes-mobile/protocol";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import type { Store } from "./store.js";

type Authenticate = (request: FastifyRequest) => Promise<string>;
type Job = { inbox_id: string; device_id: string; token: string; attempts: number; profile_ref: string; text: string };
type Ticket = { status: string; details?: { error?: string } };

function bodyPreview(text: string) {
  // shortcut: 仅清理常见 Markdown 标记；需要完整富文本预览时再接入解析器。
  const plain = text.replace(/!?\[([^\n[\]]*)\]\([^\n()[\]]*\)/gu, "$1")
    .replace(/^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+)/gmu, "")
    .replace(/\*\*|__|~~|`/gu, "")
    .replace(/[\s\p{Cc}]+/gu, " ").trim();
  const characters = Array.from(plain || text.trim());
  return characters.length > 500 ? characters.slice(0, 499).join("").trimEnd() + "…" : characters.join("");
}

export async function migratePush(store: Store) {
  await store.query(`
    CREATE TABLE IF NOT EXISTS push_devices (
      device_id uuid PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      token text NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS push_outbox (
      inbox_id uuid NOT NULL REFERENCES inbox(id) ON DELETE CASCADE,
      device_id uuid NOT NULL REFERENCES push_devices(device_id) ON DELETE CASCADE,
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (inbox_id, device_id)
    );
  `);
}

export function registerPushRoutes(api: FastifyInstance, store: Store, authenticate: Authenticate) {
  const route = "/mobile/v1/devices/current/push-registration";
  api.put<{ Body: { token: string } }>(route, {
    schema: {
      body: {
        type: "object",
        required: ["token"],
        additionalProperties: false,
        properties: { token: { type: "string", maxLength: 256, pattern: "^(Expo|Exponent)PushToken\\[[A-Za-z0-9_-]+\\]$" } },
      },
    },
  }, async (request, reply) => {
    const device = await authenticate(request);
    await store.transaction(async (client) => {
      await client.query("DELETE FROM push_devices WHERE token = $1 AND device_id <> $2", [request.body.token, device]);
      await client.query(`
        INSERT INTO push_devices (device_id, token) VALUES ($1, $2)
        ON CONFLICT (device_id) DO UPDATE SET token = EXCLUDED.token
      `, [device, request.body.token]);
    });
    return reply.code(204).send();
  });
  api.delete(route, async (request, reply) => {
    const device = await authenticate(request);
    await store.query("DELETE FROM push_devices WHERE device_id = $1", [device]);
    return reply.code(204).send();
  });
}

export async function queueInboxPush(client: PoolClient, inboxId: string) {
  await client.query(`
    INSERT INTO push_outbox (inbox_id, device_id)
    SELECT $1, device_id FROM push_devices ON CONFLICT DO NOTHING
  `, [inboxId]);
}

export function startPushWorker(store: Store, log: FastifyBaseLogger) {
  let active: Promise<void> | undefined;
  const accessToken = process.env.EXPO_ACCESS_TOKEN;
  async function flush() {
    // shortcut: 每个 BFF 实例运行一个推送工作进程。部署多副本前，在数据库中增加任务领取租约。
    const { rows } = await store.query<Job>(`
      SELECT o.inbox_id, o.device_id, o.attempts, d.token, i.profile_ref, i.data->>'text' AS text
      FROM push_outbox o JOIN push_devices d USING (device_id)
      JOIN inbox i ON i.id = o.inbox_id
      WHERE o.next_attempt_at <= now()
      ORDER BY o.next_attempt_at LIMIT 50
    `);
    if (!rows.length) return;
    let tickets: Ticket[] = [];
    try {
      const result = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(accessToken && { Authorization: `Bearer ${accessToken}` }) },
        body: JSON.stringify(rows.map((job) => ({
          to: job.token,
          title: job.profile_ref === "default" ? "Hermes 收件箱" : topicTitlePreview(`Hermes · ${job.profile_ref}`),
          body: bodyPreview(job.text),
          interruptionLevel: "time-sensitive",
          priority: "high",
          sound: "default",
          channelId: "inbox",
          ttl: 3600,
          data: { inbox_id: job.inbox_id },
        }))),
        signal: AbortSignal.timeout(8_000),
        redirect: "error",
      });
      if (result.ok) {
        const body = await result.json() as { data?: Ticket[] };
        if (Array.isArray(body.data) && body.data.length === rows.length) tickets = body.data;
      }
    } catch {
      log.warn("Expo 推送请求失败，将重试队列中的通知");
    }
    for (const [i, job] of rows.entries()) {
      const ticket = tickets[i];
      if (ticket?.details?.error === "DeviceNotRegistered") {
        await store.query("DELETE FROM push_devices WHERE device_id = $1 AND token = $2", [job.device_id, job.token]);
      } else if (ticket?.status === "ok" || job.attempts >= 4) {
        await store.query("DELETE FROM push_outbox WHERE inbox_id = $1 AND device_id = $2", [job.inbox_id, job.device_id]);
      } else {
        await store.query(`
          UPDATE push_outbox SET attempts = attempts + 1, next_attempt_at = now() + ($3 * interval '1 second')
          WHERE inbox_id = $1 AND device_id = $2
        `, [job.inbox_id, job.device_id, 15 * 2 ** job.attempts]);
      }
    }
  }
  const timer = setInterval(() => {
    if (!active) active = flush().catch(() => log.warn("处理推送队列失败")).finally(() => { active = undefined; });
  }, 3_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await active;
  };
}
