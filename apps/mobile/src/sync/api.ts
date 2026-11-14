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
  { token, method = "GET", body, signal, timeoutMs = 12_000 }: {
    token?: string;
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: object;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${origin}/mobile/v1${path}`, {
    method,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: "error",
    headers: {
      Accept: "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { "Content-Type": "application/json" }),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).catch((cause: unknown) => {
    if (signal?.aborted) throw cause;
    throw new Error(timeout.aborted ? "服务器请求超时，请稍后重试。" : "无法连接服务器，请检查网络和服务器地址。", { cause });
  });

  if (response.status === 204) return undefined as T;
  const result = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new ApiError(
      response.status,
      result?.error?.code ?? "HTTP_ERROR",
      result?.error?.message ?? `服务器请求失败（状态码 ${response.status}）。`,
      result?.error?.retryable ?? response.status >= 500,
    );
  }
  if (!result || !Object.hasOwn(result, "data")) throw new Error("无法读取服务器响应。");
  return result.data as T;
}

export async function pairDevice(origin: string, token: string): Promise<Session> {
  const result = await request<PairingResult>(origin, "/pairings/redeem", {
    method: "POST",
    body: {
      pairing_token: token,
      device_name: Platform.select({ ios: "iOS", android: "安卓", default: "网页版" }),
    },
  });
  if (typeof result.token !== "string" || !result.token.trim()) {
    throw new Error("服务器未返回设备凭证。");
  }
  return { origin, token: result.token };
}
