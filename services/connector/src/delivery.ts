import { execFile } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { DeliveryFrame } from "@hermes-mobile/protocol";

const run = promisify(execFile);

export function createDeliverySpool(path: string) {
  if (!isAbsolute(path)) throw new Error("HERMES_MOBILE_SPOOL_PATH 必须使用绝对路径");

  const python = process.env.HERMES_MOBILE_PYTHON || "python3";
  const script = typeof __dirname === "string"
    ? join(__dirname, "spool.py")
    : fileURLToPath(new URL("../../../plugins/hermes-mobile-delivery/src/hermes_mobile_delivery/spool.py", import.meta.url));

  async function command(...args: string[]) {
    const { stdout } = await run(python, [script, path, ...args], {
      env: { PATH: process.env.PATH, PYTHONUTF8: "1" },
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  }

  return {
    async pull(): Promise<DeliveryFrame[]> {
      return JSON.parse(await command("pull"));
    },
    async ack(id: string): Promise<void> {
      await command("ack", id);
    },
  };
}
