import type { Session } from "../auth/session";
import type { Cache } from "./cache";

export async function openCache(_session: Session): Promise<Cache> {
  const rows = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => rows.get(key) as T | undefined,
    list: async <T>(prefix: string) => [...rows].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value as T),
    set: async (key, value) => { rows.set(key, value); },
    remove: async (key) => { rows.delete(key); },
    clear: async () => { rows.clear(); },
    close: async () => { rows.clear(); },
  };
}
