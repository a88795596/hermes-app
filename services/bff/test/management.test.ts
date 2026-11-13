import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { profileId } from "../src/projections.js";
import { registerPersonalRoutes } from "../src/routes/personal.js";
import type { Store } from "../src/store.js";

const connectorToken = "test-connector";
const deviceToken = "d".repeat(43);
const manage = (profile: string, operation: string) => `/mobile/v1/profiles/${profileId(profile)}/manage/${operation}`;

async function setup() {
  const app = Fastify();
  await app.register(websocket, { preClose(done) {
    for (const socket of app.websocketServer.clients) socket.terminate();
    done();
  } });
  app.register(async (api) => registerPersonalRoutes(api, {
    // Only device lookup and the initial empty chat watch list need a database.
    async query(sql: string, values: unknown[]) {
      if (sql.startsWith("SELECT id FROM devices")) return { rows: Buffer.isBuffer(values[0])
        && values[0].equals(createHash("sha256").update(deviceToken).digest()) ? [{ id: "paired-device" }] : [] };
      if (sql.includes("FROM topics") || sql.includes("FROM commands")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as Store, { pairingToken: "test-pairing", connectorToken, profileRefs: ["default", "work"] }));
  await app.ready();
  const call = (url: string, payload: object = {}, token?: string) => app.inject({
    method: "POST", url, payload, headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const connect = (management: boolean) => app.injectWS("/internal/connector/v1/events", { headers: {
    authorization: `Bearer ${connectorToken}`, ...(management && { "x-hermes-mobile-management": "1" }),
  } });
  return { app, call, connect };
}

test("management requires a paired device and an allowed profile", async (t) => {
  const { app, call } = await setup();
  t.after(() => app.close());
  assert.equal((await call(manage("default", "cron.list"))).statusCode, 401);
  assert.equal((await call(manage("default", "cron.list"), {}, "x".repeat(43))).statusCode, 401);
  assert.equal((await call(manage("outside", "cron.list"), {}, deviceToken)).statusCode, 404);
  assert.equal((await call(manage("default", "cron.list"), {}, deviceToken)).statusCode, 503);
});

test("a management request returns the live result for the selected profile", async (t) => {
  const { app, call, connect } = await setup();
  t.after(() => app.close());
  const socket = await connect(true);
  t.after(() => socket.terminate());
  socket.on("message", (raw) => {
    const frame = JSON.parse(String(raw));
    socket.send(JSON.stringify({ type: "management_result", request_id: frame.request_id,
      ok: true, data: { profile: frame.profile_ref, operation: frame.operation } }));
  });
  const result = await call(manage("work", "cron.list"), {}, deviceToken);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().data, { profile: "work", operation: "cron.list" });
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal((await call(manage("work", "cron.list"), { profile: "outside" }, deviceToken)).statusCode, 422);
});

test("an older Connector still connects without advertising management", async (t) => {
  const { app, call, connect } = await setup();
  const socket = await connect(false);
  t.after(async () => { socket.terminate(); await app.close(); });
  assert.equal((await call(manage("work", "cron.list"), {}, deviceToken)).statusCode, 503);
});

test("a disconnected Connector leaves an in-flight write unconfirmed", async (t) => {
  const { app, call, connect } = await setup();
  t.after(() => app.close());
  const socket = await connect(true);
  t.after(() => socket.terminate());
  socket.once("message", () => socket.terminate());
  const result = await call(manage("default", "cron.create"), { input: { schedule: "every 2h" } }, deviceToken);
  assert.equal(result.statusCode, 503);
  assert.match(result.json().error.message, /refresh/i);
});
