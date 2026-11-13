import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const sessionKey = "hermes-mobile.session";

export interface Session {
  origin: string;
  token: string;
}

export function parseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter the server's HTTPS origin, without a path.");
  }
  const local = /^(localhost|127\.0\.0\.1|10\.0\.2\.2|\[::1\])$/.test(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) {
    throw new Error("Enter the server's HTTPS origin, without a path.");
  }
  return url.origin;
}

export async function loadSession(): Promise<Session | null> {
  if (Platform.OS === "web") return null;
  const value = await SecureStore.getItemAsync(sessionKey);
  if (!value) return null;
  const stored: Partial<Session> = JSON.parse(value);
  if (typeof stored.origin !== "string" || typeof stored.token !== "string" || !stored.token) {
    throw new Error("The saved device session could not be read.");
  }
  return { origin: parseOrigin(stored.origin), token: stored.token };
}

export async function saveSession(session: Session | null): Promise<void> {
  if (Platform.OS === "web") return;
  if (session) {
    await SecureStore.setItemAsync(sessionKey, JSON.stringify(session), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } else {
    await SecureStore.deleteItemAsync(sessionKey);
  }
}
