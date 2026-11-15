import type { PushNotificationData } from "@hermes-mobile/protocol";

export const pushAvailable = false;

export function observeNotificationOpens(
  _onOpen: (target: PushNotificationData) => Promise<void>, _onError: (error: unknown) => void,
): () => void {
  return () => {};
}

export async function enablePushNotifications(_session: { origin: string; token: string }, requestPermission = true): Promise<boolean> {
  if (!requestPermission) return false;
  throw new Error("请在 iOS 或安卓应用中启用推送通知。");
}
