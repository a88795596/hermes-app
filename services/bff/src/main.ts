import { buildApp } from "./app.js";

const { DATABASE_URL, APP_PAIRING_TOKEN, CONNECTOR_TOKEN, HERMES_PROFILES, HOST, PORT } = process.env;
if (!DATABASE_URL || !APP_PAIRING_TOKEN || !CONNECTOR_TOKEN || APP_PAIRING_TOKEN === CONNECTOR_TOKEN) {
  throw new Error("DATABASE_URL and distinct APP_PAIRING_TOKEN and CONNECTOR_TOKEN are required");
}

const app = buildApp({
  databaseUrl: DATABASE_URL,
  pairingToken: APP_PAIRING_TOKEN,
  connectorToken: CONNECTOR_TOKEN,
  profileRefs: HERMES_PROFILES?.split(","),
});

try {
  await app.listen({ host: HOST ?? "127.0.0.1", port: Number(PORT ?? 3000) });
} catch (error) {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  app.log.error({ code }, "BFF failed to start");
  await app.close();
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void app.close());
}
