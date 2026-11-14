import type { HotUpdaterInstance } from "@hot-updater/react-native";

const baseURL = process.env.EXPO_PUBLIC_HOT_UPDATER_BASE_URL;
const apiKey = process.env.EXPO_PUBLIC_HOT_UPDATER_API_KEY;

function reportUpdateError(error: unknown) {
  console.warn("热更新失败，继续使用当前版本。", error);
}

export let hotUpdater: HotUpdaterInstance | undefined;
export let currentUpdate: { id: string; builtAt?: number } = {
  id: __DEV__ ? "开发版本" : baseURL && apiKey ? "不可用" : "未启用",
  builtAt: undefined,
};
if (!__DEV__ && baseURL && apiKey) {
  try {
    const { HotUpdater } = require("@hot-updater/react-native") as typeof import("@hot-updater/react-native");
    hotUpdater = HotUpdater.init({
      baseURL: baseURL.replace(/\/+$/, ""),
      requestHeaders: { "x-api-key": apiKey },
      onError: reportUpdateError,
    });
    // 下载会改变 SDK 的包信息，因此在启动时固定当前正在运行的版本。
    const bundleId = hotUpdater.getManifest().bundleId;
    currentUpdate = {
      id: bundleId === hotUpdater.getMinBundleId() ? "内置版本" : hotUpdater.getBundleId(),
      builtAt: /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bundleId)
        ? Number.parseInt(bundleId.replaceAll("-", "").slice(0, 12), 16)
        : undefined,
    };
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
