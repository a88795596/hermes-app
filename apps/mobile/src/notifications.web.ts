export const pushAvailable = false;

export async function enablePushNotifications(_session: { origin: string; token: string }) {
  throw new Error("请在 iOS 或安卓应用中启用推送通知。");
}
