export const pushAvailable = false;

export async function enablePushNotifications(_session: { origin: string; token: string }) {
  throw new Error("Push notifications need an iOS or Android build.");
}
