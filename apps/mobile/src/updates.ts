import type { HotUpdaterInstance } from "@hot-updater/react-native";

const baseURL = process.env.EXPO_PUBLIC_HOT_UPDATER_BASE_URL;
const apiKey = process.env.EXPO_PUBLIC_HOT_UPDATER_API_KEY;

function reportUpdateError(error: unknown) {
  console.warn("热更新失败，继续使用当前版本。", error);
}

function updateTimestamp(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)
    : undefined;
}

export let hotUpdater: HotUpdaterInstance | undefined;
export let currentUpdate: { id: string; builtAt?: number } = {
  id: __DEV__ ? "开发版本" : baseURL && apiKey ? "不可用" : "未启用",
  builtAt: undefined,
};
if (!__DEV__ && baseURL && apiKey) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- The native updater must not initialize in Expo Go or an unconfigured build.
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
      builtAt: updateTimestamp(bundleId),
    };
  } catch (error) {
    reportUpdateError(error);
  }
}

let automaticUpdate: Promise<void> | undefined;

export function prepareUpdate() {
  automaticUpdate = (async () => {
    try {
      const update = await hotUpdater?.checkForUpdate({ updateStrategy: "fingerprint" });
      if (update && !await update.updateBundle()) {
        reportUpdateError(new Error("更新包未能下载完成。"));
      }
    } catch (error) {
      reportUpdateError(error);
    }
  })();
  return automaticUpdate;
}

export async function checkUpdateManually(confirm: (update: { id: string; message: string | null; publishedAt?: number }) => Promise<boolean>) {
  if (!hotUpdater) return "当前版本未启用热更新。";
  // 启动下载先完成，避免两个入口同时操作原生更新包。
  await automaticUpdate;
  let checkError: Error | undefined;
  let update: Awaited<ReturnType<HotUpdaterInstance["checkForUpdate"]>>;
  try {
    update = await hotUpdater.checkForUpdate({ updateStrategy: "fingerprint", onError: (error) => { checkError = error; } });
    if (checkError) throw checkError;
  } catch (error) {
    throw new Error("检查热更新失败，请稍后重试。", { cause: error });
  }
  const downloaded = "热更新已下载，下次启动 App 时生效。";
  if (!update) return hotUpdater.isUpdateDownloaded() ? downloaded : "当前已是最新版本。";
  if (!await confirm({ id: update.id, message: update.message, publishedAt: updateTimestamp(update.id) })) return;
  try {
    if (!await update.updateBundle()) throw new Error("更新包未能下载完成。");
  } catch (error) {
    throw new Error("热更新下载失败，请稍后重试。", { cause: error });
  }
  return downloaded;
}
