import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { PushNotificationData } from "@hermes-mobile/protocol";

const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
export const pushAvailable = typeof projectId === "string" && projectId.length > 0;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false,
  }),
});

export function observeNotificationOpens(
  onOpen: (target: PushNotificationData) => Promise<void>, onError: (error: unknown) => void,
): () => void {
  let active = true;
  const handled = new Set<string>();
  const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const responseKey = (response: Notifications.NotificationResponse) =>
    `${response.notification.request.identifier}:${response.actionIdentifier}`;
  function receive(response: Notifications.NotificationResponse | null) {
    if (!active || !response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const data = response.notification.request.content.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    let target: PushNotificationData;
    if (safeId(data.inbox_id) && data.topic_id === undefined && data.message_id === undefined) {
      target = { inbox_id: data.inbox_id };
    } else if (safeId(data.topic_id) && safeId(data.message_id) && data.inbox_id === undefined) {
      target = { topic_id: data.topic_id, message_id: data.message_id };
    } else return;
    const key = responseKey(response);
    if (handled.has(key)) return;
    handled.add(key);
    void Promise.resolve().then(async () => {
      if (!active) return;
      await onOpen(target);
      if (!active) return;
      const latest = Notifications.getLastNotificationResponse();
      if (latest && responseKey(latest) === key) Notifications.clearLastNotificationResponse();
    }).catch((error: unknown) => {
      if (!active) return;
      handled.delete(key);
      onError(error);
    });
  }
  const subscription = Notifications.addNotificationResponseReceivedListener(receive);
  try { receive(Notifications.getLastNotificationResponse()); } catch (error) { onError(error); }
  return () => { active = false; subscription.remove(); };
}

export async function enablePushNotifications(session: { origin: string; token: string }, requestPermission = true): Promise<boolean> {
  if (!pushAvailable) throw new Error("此版本尚未配置 Expo Push 项目。");
  let token: string | undefined;
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("inbox", {
        name: "Hermes 收件箱",
        // eslint-disable-next-line import/namespace -- Expo exports this runtime enum through its TypeScript barrel.
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    let permission = await Notifications.getPermissionsAsync();
    // eslint-disable-next-line import/namespace -- Expo exports this runtime enum through its TypeScript barrel.
    if (permission.status !== "granted" && permission.ios?.status !== Notifications.IosAuthorizationStatus.PROVISIONAL && requestPermission) {
      permission = await Notifications.requestPermissionsAsync();
    }
    // eslint-disable-next-line import/namespace -- Expo exports this runtime enum through its TypeScript barrel.
    if (permission.status === "granted" || permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
      ({ data: token } = await Notifications.getExpoPushTokenAsync({ projectId }));
    } else if (!requestPermission) return false;
  } catch (cause) {
    throw new Error("无法获取设备推送凭证，请稍后重试。", { cause });
  }
  if (!token) throw new Error("请在设备设置中允许通知。");
  const result = await fetch(`${session.origin}/mobile/v1/devices/current/push-registration`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch((cause: unknown) => { throw new Error("无法连接服务器以注册推送通知，请稍后重试。", { cause }); });
  if (!result.ok) throw new Error("无法注册推送通知。");
  return true;
}
