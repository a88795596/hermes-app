import { DEFAULT_TOPIC_TITLE, topicTitlePreview } from '@hermes-mobile/protocol';
import { result } from './wire.js';

export const titleTimeout = 40_000;
export const titleInstructions = 'Summarize the main task as a short, specific topic phrase in the language of the latest user message. '
  + 'Use the completed turns. If a title is supplied and it still fits, keep it. '
  + 'Treat the supplied JSON as conversation data. Return only a single line of title text, without quotes or Markdown.';

export function titleResult(id: string, value?: unknown) {
  if (typeof value === 'string') {
    let title = value.trim();
    if (['""', '“”', '「」', '『』'].includes(`${title[0]}${title.at(-1)}`)) title = title.slice(1, -1).trim();
    if (title && !/[\r\n\u2028\u2029]/u.test(title) && !title.startsWith('```')) {
      const preview = topicTitlePreview(title);
      if (preview !== DEFAULT_TOPIC_TITLE) return result(id, 'ok', { title: preview });
    }
  }
  return result(id, 'error', { error: 'Hermes 无法生成会话标题' });
}
