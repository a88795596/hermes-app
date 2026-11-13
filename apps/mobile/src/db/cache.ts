import * as Crypto from "expo-crypto";
import { openDatabaseAsync } from "expo-sqlite";
import type { Session } from "../auth/session";

export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(prefix: string): Promise<T[]>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

export async function openCache(session: Session): Promise<Cache> {
  const scope = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify([session.origin, session.token]));
  const db = await openDatabaseAsync(`hermes-${scope}.db`);
  try {
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    `);
  } catch (error) {
    await db.closeAsync();
    throw error;
  }

  return {
    async get<T>(key: string) {
      const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM cache WHERE key = ?", key);
      return row ? JSON.parse(row.value) as T : undefined;
    },
    async list<T>(prefix: string) {
      const rows = await db.getAllAsync<{ value: string }>(
        "SELECT value FROM cache WHERE substr(key, 1, length(?)) = ? ORDER BY key",
        prefix,
        prefix,
      );
      return rows.map((row) => JSON.parse(row.value) as T);
    },
    async set(key, value) {
      await db.runAsync("INSERT OR REPLACE INTO cache (key, value) VALUES (?, ?)", key, JSON.stringify(value));
    },
    async remove(key) {
      await db.runAsync("DELETE FROM cache WHERE key = ?", key);
    },
    async clear() {
      await db.execAsync("DELETE FROM cache");
    },
    close: () => db.closeAsync(),
  };
}
