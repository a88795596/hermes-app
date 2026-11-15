export const currentUpdate: { id: string; builtAt?: number } = { id: "网页版本", builtAt: undefined };

export async function prepareUpdate() {}

export async function checkUpdateManually(
  _confirm: (update: { id: string; message: string | null; publishedAt?: number }) => Promise<boolean>,
  _confirmReload: () => Promise<boolean>,
) {
  return "网页版本无需热更新。";
}
