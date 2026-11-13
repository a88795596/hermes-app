import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import type { Store } from "./store.js";

type Authenticate = (request: FastifyRequest) => Promise<string>;
type Job = { inbox_id: string; device_id: string; token: string; attempts: number };
type Ticket = { status: string; details?: { error?: string } };

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
    // shortcut: one worker per BFF instance, add a DB claim lease before running replicas.
    const { rows } = await store.query<Job>(`
      SELECT o.inbox_id, o.device_id, o.attempts, d.token
      FROM push_outbox o JOIN push_devices d USING (device_id)
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
          title: "Hermes Mobile",
          body: "打开应用查看新结果",
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
      log.warn("Expo Push request failed; will retry queued reminders");
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
    if (!active) active = flush().catch(() => log.warn("Could not process the push queue")).finally(() => { active = undefined; });
  }, 3_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await active;
  };
}
