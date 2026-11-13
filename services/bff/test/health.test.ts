import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../src/app.js";

test("GET /health 返回服务状态", async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
});
