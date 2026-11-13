import { fetch } from "expo/fetch";
import type { PairingResult } from "@hermes-mobile/protocol";
import { Platform } from "react-native";
import type { Session } from "../auth/session";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
  }
}

export async function request<T>(
  origin: string,
  path: string,
  { token, method = "GET", body, signal }: {
    token?: string;
    method?: "GET" | "POST" | "DELETE";
    body?: object;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const response = await fetch(`${origin}/mobile/v1${path}`, {
    method,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
    redirect: "error",
    headers: {
      Accept: "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { "Content-Type": "application/json" }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) return undefined as T;
  const result = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      result?.error?.code ?? "HTTP_ERROR",
      result?.error?.message ?? `Server request failed (${response.status}).`,
      result?.error?.retryable ?? response.status >= 500,
    );
  }
  if (!result || !Object.hasOwn(result, "data")) throw new Error("The server sent an unreadable response.");
  return result.data as T;
}

export async function pairDevice(origin: string, token: string): Promise<Session> {
  const result = await request<PairingResult>(origin, "/pairings/redeem", {
    method: "POST",
    body: {
      pairing_token: token,
      device_name: Platform.select({ ios: "iOS", android: "Android", default: "Web" }),
    },
  });
  if (typeof result.token !== "string" || !result.token.trim()) {
    throw new Error("The server did not return a device credential.");
  }
  return { origin, token: result.token };
}
