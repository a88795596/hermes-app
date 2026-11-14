import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import multipart from "@fastify/multipart";
import type { HotUpdaterHandlers } from "@hot-updater/server";
import Fastify, { LogController, type FastifyReply, type FastifyRequest } from "fastify";
import { createFileStorage, matchesToken } from "./storage.js";

type FileStorage = ReturnType<typeof createFileStorage>;
type Options = {
  adminToken: string;
  dataDir: string;
  storage: FileStorage;
  handlers: HotUpdaterHandlers;
};

async function sendResponse(reply: FastifyReply, response: Response) {
  reply.code(response.status);
  response.headers.forEach((value, name) => reply.header(name, value));
  return reply.send(response.body ? Readable.fromWeb(response.body as NodeReadableStream) : undefined);
}

export function buildApp({ adminToken, dataDir, storage, handlers }: Options) {
  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024,
    logController: new LogController({ disableRequestLogging: true }) });
  app.register(multipart, { limits: { fileSize: 256 * 1024 * 1024, files: 1, fields: 1, parts: 2 } });

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!matchesToken(request.headers.authorization, `Bearer ${adminToken}`)) {
      return reply.code(401).send({ error: "管理凭据无效。" });
    }
  };

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/storage/upload", { onRequest: authenticate }, async (request, reply) => {
    const tempDir = join(dataDir, "uploads");
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    const tempPath = join(tempDir, randomUUID());
    let key: string | undefined;
    let receivedFile = false;
    try {
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (part.fieldname !== "file" || receivedFile) throw new Error("需要一个更新文件。");
          receivedFile = true;
          await pipeline(part.file, createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));
          if (part.file.truncated) return reply.code(413).send({ error: "更新文件超过 256 MiB。" });
        } else if (part.fieldname === "key" && key === undefined && typeof part.value === "string") {
          key = part.value;
        } else {
          return reply.code(400).send({ error: "上传字段无效。" });
        }
      }
      if (!receivedFile || !key) return reply.code(400).send({ error: "缺少更新文件或路径。" });
      return await storage.commit(tempPath, key);
    } finally {
      await rm(tempPath, { force: true });
    }
  });

  const uriBody = { type: "object", required: ["storageUri"], additionalProperties: false,
    properties: { storageUri: { type: "string", minLength: 1, maxLength: 4096 } } } as const;

  app.post<{ Body: { storageUri: string } }>("/storage/get", { onRequest: authenticate, schema: { body: uriBody } }, async (request, reply) => {
    const { response } = await storage.adapter.get({ storageUri: request.body.storageUri });
    return response ? sendResponse(reply, response) : reply.code(404).send();
  });

  app.post<{ Body: { storageUri: string } }>("/storage/exists", { onRequest: authenticate, schema: { body: uriBody } }, async (request) => {
    try {
      return { exists: (await stat(storage.filePath(request.body.storageUri))).isFile() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
      throw error;
    }
  });

  app.delete<{ Body: { storageUri: string } }>("/storage/delete", { onRequest: authenticate, schema: { body: uriBody } }, async (request) => {
    await rm(storage.filePath(request.body.storageUri), { force: true });
    return { deleted: true };
  });

  app.get<{ Querystring: { uri: string; expires: string; signature: string } }>("/download", {
    schema: { querystring: { type: "object", required: ["uri", "expires", "signature"],
      properties: { uri: { type: "string", maxLength: 4096 }, expires: { type: "string", maxLength: 16 },
        signature: { type: "string", maxLength: 64 } } } },
  }, async (request, reply) => {
    const { uri, expires, signature } = request.query;
    if (!storage.validDownload(uri, expires, signature)) return reply.code(403).send({ error: "下载链接已过期或无效。" });
    const { response } = await storage.adapter.get({ storageUri: uri });
    reply.header("cache-control", "private, no-store");
    return response ? sendResponse(reply, response) : reply.code(404).send();
  });

  const forward = (handler: HotUpdaterHandlers["client"], prefix = "") => async (request: FastifyRequest, reply: FastifyReply) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const path = prefix ? request.url.replace(/^\/[^/?]+/, "") : request.url;
    const url = `http://localhost${path || "/"}`;
    const response = await handler(new Request(url, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : JSON.stringify(request.body),
    }));
    return sendResponse(reply, response);
  };
  app.all("/admin", { onRequest: authenticate }, forward(handlers.admin, "/admin"));
  app.all("/admin/*", { onRequest: authenticate }, forward(handlers.admin, "/admin"));
  app.all("/*", forward(handlers.client));
  return app;
}
