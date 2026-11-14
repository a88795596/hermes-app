import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createStorageAdapter, createStorageUri, parseStorageUri } from "@hot-updater/plugin-core";

export const STORAGE_PROTOCOL = "hermes-ota";
const BUCKET = "bundles";

export function matchesToken(candidate: unknown, secret: string) {
  return typeof candidate === "string" && timingSafeEqual(
    createHash("sha256").update(candidate).digest(),
    createHash("sha256").update(secret).digest(),
  );
}

// shortcut: 更新包保存在单实例磁盘，多节点部署时改用共享对象存储。
export function createFileStorage(dataDir: string, baseUrl: string, secret: string) {
  function uriFor(key: string) {
    try {
      if (typeof key !== "string" || key.includes("\0")) throw new Error();
      return createStorageUri({ protocol: STORAGE_PROTOCOL, bucket: BUCKET, key });
    } catch {
      throw Object.assign(new Error("更新文件路径无效。"), { statusCode: 400 });
    }
  }

  function filePath(storageUri: string) {
    try {
      const { bucket, key } = parseStorageUri(storageUri, STORAGE_PROTOCOL);
      if (bucket !== BUCKET || uriFor(key) !== storageUri) throw new Error();
      return join(dataDir, "objects", key);
    } catch {
      throw Object.assign(new Error("更新文件地址无效。"), { statusCode: 400 });
    }
  }

  async function get(storageUri: string) {
    const path = filePath(storageUri);
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>, {
        headers: { "content-type": "application/octet-stream", "content-length": String(info.size) },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  const signature = (uri: string, expires: string) => createHmac("sha256", secret)
    .update(`download\n${expires}\n${uri}`).digest("hex");

  return {
    filePath,
    async commit(tempPath: string, key: string) {
      const storageUri = uriFor(key);
      const path = filePath(storageUri);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await rename(tempPath, path);
      return { storageUri };
    },
    validDownload(uri: string, expires: string, token: string) {
      return /^\d+$/.test(expires) && Number(expires) > Math.floor(Date.now() / 1000)
        && matchesToken(token, signature(uri, expires));
    },
    adapter: createStorageAdapter({
      name: "hermesFiles",
      protocol: STORAGE_PROTOCOL,
      async get({ storageUri }) { return { response: await get(storageUri) }; },
      async getDownloadUrl({ storageUri }) {
        filePath(storageUri);
        const expires = String(Math.floor(Date.now() / 1000) + 3600);
        const url = new URL(`${baseUrl.replace(/\/$/, "")}/download`);
        url.searchParams.set("uri", storageUri);
        url.searchParams.set("expires", expires);
        url.searchParams.set("signature", signature(storageUri, expires));
        return { url: url.href };
      },
    }),
  };
}
