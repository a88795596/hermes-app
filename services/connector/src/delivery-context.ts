export function deliveryInstructions(profileRef: string, sessionId: string) {
  const target = JSON.stringify(`hermes_mobile:${sessionId}`);
  return `当前是 Hermes 移动端聊天。向本 App 投递文件或消息时，优先使用当前会话目标 ${target}。`
    + `可用 send_message 的 target=${target}，文件可用 hermes --profile ${JSON.stringify(profileRef)} mobile-send --to ${target} --file <文件路径>。`
    + '用户明确指定其他目标时按用户要求投递；不带会话 ID 的 hermes_mobile 会投递到收件箱。';
}
