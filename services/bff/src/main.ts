import { buildApp } from "./app.js";

const { DATABASE_URL, APP_PAIRING_TOKEN, CONNECTOR_TOKEN, INBOX_DELIVERY_TOKEN, HERMES_PROFILES, HOST, PORT } = process.env;
if (!DATABASE_URL || !APP_PAIRING_TOKEN || !CONNECTOR_TOKEN || APP_PAIRING_TOKEN === CONNECTOR_TOKEN) {
  throw new Error("请设置 DATABASE_URL，并为 APP_PAIRING_TOKEN 和 CONNECTOR_TOKEN 分别设置不同的令牌。");
}

const app = buildApp({
  databaseUrl: DATABASE_URL,
  pairingToken: APP_PAIRING_TOKEN,
  connectorToken: CONNECTOR_TOKEN,
  inboxDeliveryToken: INBOX_DELIVERY_TOKEN,
  profileRefs: HERMES_PROFILES?.split(","),
});

try {
  await app.listen({ host: HOST ?? "127.0.0.1", port: Number(PORT ?? 3000) });
} catch (error) {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  app.log.error({ code }, "BFF 启动失败");
  await app.close();
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close());
}
