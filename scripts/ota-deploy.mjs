import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const messageFlag = args.findIndex((arg) => arg === "--message" || arg.startsWith("--message="));
const message = messageFlag === -1 ? undefined : args[messageFlag] === "--message"
  ? args[messageFlag + 1] : args[messageFlag].slice("--message=".length);

if (!message?.trim() || message.startsWith("--")) {
  process.stderr.write("发布热更新时请提供 --message 更新说明。\n");
  process.exitCode = 1;
} else {
  const result = spawnSync("pnpm", ["exec", "hot-updater", "deploy", "--channel", "preview", ...args], {
    cwd: fileURLToPath(new URL("../apps/mobile/", import.meta.url)),
    env: { ...process.env, EXPO_PUBLIC_HERMES_UPDATE_MESSAGE: message.trim() },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
