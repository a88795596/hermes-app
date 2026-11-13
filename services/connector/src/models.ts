import type { ModelCatalog, ModelSelection } from '@hermes-mobile/protocol';
import { object } from './gateway.js';
import { text } from './wire.js';

export function modelCatalog(data: unknown, selected?: ModelSelection): ModelCatalog {
  const source = object(data);
  if (!Array.isArray(source?.providers)) throw new Error('Hermes 模型目录无效');
  const providers: ModelCatalog['providers'] = [];
  const seen = new Set<string>();
  let current = '';
  for (const value of source.providers) {
    const row = object(value);
    if (!row || !text(row.slug, 256) || !text(row.name, 256) || seen.has(row.slug) || row.authenticated === false) continue;
    const unavailable = new Set(Array.isArray(row.unavailable_models) ? row.unavailable_models : []);
    const models = Array.isArray(row.models) ? [...new Set(row.models.filter(
      (id): id is string => text(id, 512) && !unavailable.has(id),
    ))] : [];
    providers.push({ id: row.slug, name: row.name, models });
    if (row.slug === source.provider || row.name === source.provider ||
      (Array.isArray(row.aliases) && row.aliases.includes(source.provider))) current = row.slug;
    else if (row.is_current === true && !current) current = row.slug;
    seen.add(row.slug);
  }
  const catalog: ModelCatalog = {
    provider: current,
    model: text(source.model, 512, true) ? source.model : '',
    ...selected,
    providers,
  };
  // shortcut: 模型目录使用单个转发帧，超出容量时改为分页传输。
  if (Buffer.byteLength(JSON.stringify(catalog)) > 768 * 1024) throw new Error('Hermes 模型目录超出大小限制');
  return catalog;
}

export function hasModel(catalog: ModelCatalog, { provider, model }: ModelSelection): boolean {
  return catalog.providers.some((row) => row.id === provider && row.models.includes(model));
}
