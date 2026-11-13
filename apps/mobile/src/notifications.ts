import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
export const pushAvailable = typeof projectId === "string" && projectId.length > 0;

export async function enablePushNotifications(session: { origin: string; token: string }) {
  if (!pushAvailable) throw new Error("此版本尚未配置 Expo Push 项目。");
  let token: string | undefined;
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("inbox", {
        name: "Hermes 收件箱",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    let permission = await Notifications.getPermissionsAsync();
    if (permission.status !== "granted") permission = await Notifications.requestPermissionsAsync();
    if (permission.status === "granted" || permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
      ({ data: token } = await Notifications.getExpoPushTokenAsync({ projectId }));
    }
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
}
