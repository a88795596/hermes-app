import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
export const pushAvailable = typeof projectId === "string" && projectId.length > 0;

export async function enablePushNotifications(session: { origin: string; token: string }) {
  if (!pushAvailable) throw new Error("This build does not have an Expo Push project.");
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("inbox", {
      name: "Hermes Inbox",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
  let permission = await Notifications.getPermissionsAsync();
  if (permission.status !== "granted") permission = await Notifications.requestPermissionsAsync();
  if (permission.status !== "granted" && permission.ios?.status !== Notifications.IosAuthorizationStatus.PROVISIONAL) {
    throw new Error("Allow notifications in your device settings.");
  }
  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  const result = await fetch(`${session.origin}/mobile/v1/devices/current/push-registration`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!result.ok) throw new Error("Could not register for push notifications.");
}
