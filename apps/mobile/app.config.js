module.exports = ({ config }) => {
  const baseURL = process.env.EXPO_PUBLIC_HOT_UPDATER_BASE_URL;
  const apiKey = process.env.EXPO_PUBLIC_HOT_UPDATER_API_KEY;
  if (Boolean(baseURL) !== Boolean(apiKey)) {
    throw new Error("热更新地址和客户端 API Key 必须同时配置。");
  }
  if (baseURL) {
    const url = new URL(baseURL);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || baseURL.trim() !== baseURL) {
      throw new Error("EXPO_PUBLIC_HOT_UPDATER_BASE_URL 必须是无凭据、查询参数和片段的 HTTPS 地址。");
    }
  }
  return config;
};
