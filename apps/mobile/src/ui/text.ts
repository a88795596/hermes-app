export function profileLabel(label: string) {
  return label === "default" ? "默认" : label;
}

export function formatDateTime(value: string | number) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "日期无效" : date.toLocaleString("zh-CN", {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
}

// 旧版本会把这些错误文本写入缓存和服务端历史，展示时再翻译。
const legacyErrors = new Map([
  ["Topic already has a Hermes session", "此话题已绑定 Hermes 会话。"],
  ["This topic already has a Hermes binding", "此话题已绑定 Hermes 会话。"],
  ["Hermes session binding could not be verified", "无法验证 Hermes 会话绑定。"],
  ["Hermes session is unavailable for this profile", "此配置档案下的 Hermes 会话不可用。"],
  ["Invalid Hermes profile", "Hermes 配置档案无效。"],
  ["Hermes rejected session creation", "Hermes 拒绝创建会话。"],
  ["Hermes topic binding does not match", "Hermes 会话与话题的绑定不匹配。"],
  ["Hermes could not confirm creation", "Hermes 无法确认会话是否创建成功。"],
  ["Hermes could not confirm the outcome", "Hermes 无法确认执行结果。"],
  ["Hermes could not confirm the model request.", "Hermes 无法确认模型请求的结果。"],
  ["Hermes could not confirm the model selection", "Hermes 无法确认模型选择。"],
  ["Hermes could not load the model catalog", "Hermes 无法加载模型目录。"],
  ["This Hermes API version does not support model options", "当前 Hermes API 版本不支持查询模型选项。"],
  ["This Hermes Gateway version does not support model selection", "当前 Hermes 网关版本不支持选择模型。"],
  ["This model is no longer available. Open /model again.", "此模型已不可用，请重新打开 /model。"],
  ["Wait for the current response before switching models.", "请等待当前回复结束，再切换模型。"],
  ["The requested submission is no longer running", "此消息已结束执行。"],
  ["This request has expired or was already answered.", "此请求已过期或已回答。"],
  ["The answer is not available for this control", "无法为此请求提交该回答。"],
  ["Hermes could not confirm the response", "Hermes 无法确认是否已收到答复。"],
  ["Hermes consumed this input as a voice stop", "Hermes 已将此输入用作停止语音交互的指令。"],
  ["Hermes rejected the run", "Hermes 拒绝执行。"],
  ["Hermes reported that the run failed", "Hermes 报告执行失败。"],
  ["Topic not found", "找不到话题。"],
  ["Topic is not ready", "话题尚未就绪。"],
  ["Invalid text", "消息正文无效。"],
  ["This request ID is already used for another operation", "此请求 ID 已用于其他操作。"],
  ["Invalid request", "请求无效。"],
  ["Request could not be completed", "无法完成请求。"],
  ["Access to closed resource", "本地存储连接已关闭。"],
]);

export function errorLabel(message: string) {
  return legacyErrors.get(message) ?? message.replace(/^Hermes refused the request(?=$| \()/u, "Hermes 拒绝了请求");
}
