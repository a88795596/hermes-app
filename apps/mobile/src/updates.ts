import type { HotUpdaterInstance } from "@hot-updater/react-native";

const baseURL = process.env.EXPO_PUBLIC_HOT_UPDATER_BASE_URL;
const apiKey = process.env.EXPO_PUBLIC_HOT_UPDATER_API_KEY;

function reportUpdateError(error: unknown) {
  console.warn("热更新失败，继续使用当前版本。", error);
}

export let hotUpdater: HotUpdaterInstance | undefined;
if (!__DEV__ && baseURL && apiKey) {
  try {
    const { HotUpdater } = require("@hot-updater/react-native") as typeof import("@hot-updater/react-native");
    hotUpdater = HotUpdater.init({
      baseURL: baseURL.replace(/\/+$/, ""),
      requestHeaders: { "x-api-key": apiKey },
      onError: reportUpdateError,
    });
  } catch (error) {
    reportUpdateError(error);
  }
}

export async function prepareUpdate() {
  try {
    const update = await hotUpdater?.checkForUpdate({ updateStrategy: "fingerprint" });
    if (update && !await update.updateBundle()) {
      reportUpdateError(new Error("更新包未能下载完成。"));
    }
  } catch (error) {
    reportUpdateError(error);
  }
}
