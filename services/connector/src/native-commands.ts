import { MAX_TOPIC_TITLE_BYTES, type NativeCommand, type NativeCommandResult, type SessionStatus } from '@hermes-mobile/protocol';
import { object, type JsonObject } from './gateway.js';
import { QueryUnavailable, queryTimeout } from './topic-query.js';
import { boundedText, text } from './wire.js';

const commandName = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const unavailable = '当前会话通道未开放此原生命令。';
// Python str.strip / re \s (Hermes' command and SessionDB title parsing).
const nativeWhitespace = '[\\t-\\r\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
const trimNativeWhitespace = (value: string) => value.replace(new RegExp(`^${nativeWhitespace}+|${nativeWhitespace}+$`, 'gu'), '');

export class NativeCommandFailure extends Error {
  constructor(message: string, readonly status: 'error' | 'unknown' = 'error') { super(message); }
}

export function nativeCommandList(value: unknown): NativeCommand[] {
  if (!Array.isArray(value) || value.length > 1024) throw new Error('Hermes 原生命令目录无效');
  const names = new Set<string>();
  const commands = value.map((raw) => {
    const row = object(raw);
    if (!row || typeof row.name !== 'string' || !commandName.test(row.name) || names.has(row.name)
      || !text(row.description, 8192, true) || !text(row.category, 128, true)
      || !Array.isArray(row.aliases) || row.aliases.length > 32
      || row.aliases.some((alias) => typeof alias !== 'string' || !commandName.test(alias))
      || typeof row.supported !== 'boolean'
      || (row.args_hint !== undefined && !text(row.args_hint, 1024, true))
      || (row.subcommands !== undefined && (!Array.isArray(row.subcommands) || row.subcommands.length > 64
        || row.subcommands.some((value) => !text(value, 256))))
      || (row.unavailable_reason !== undefined && !text(row.unavailable_reason, 2048, true))) {
      throw new Error('Hermes 原生命令条目无效');
    }
    names.add(row.name);
    return { name: row.name, description: row.description, category: row.category, aliases: row.aliases as string[],
      supported: row.supported, ...(row.args_hint === undefined ? {} : { args_hint: row.args_hint as string }),
      ...(row.subcommands === undefined ? {} : { subcommands: row.subcommands as string[] }),
      ...(row.unavailable_reason === undefined ? {} : { unavailable_reason: row.unavailable_reason as string }) };
  });
  const aliases = new Set<string>();
  for (const entry of commands) for (const alias of entry.aliases) {
    if (names.has(alias) || aliases.has(alias)) throw new Error('Hermes 原生命令别名冲突');
    aliases.add(alias);
  }
  return commands;
}

export function tuiCommandList(value: unknown): NativeCommand[] {
  const raw = object(value);
  const canon = object(raw?.canon);
  if (!Array.isArray(raw?.categories) || !canon) throw new Error('Hermes 原生命令目录无效');
  const commands = raw.categories.flatMap((value) => {
    const category = object(value);
    if (!text(category?.name, 128, true) || !Array.isArray(category?.pairs)) throw new Error('Hermes 原生命令分类无效');
    return category.pairs.map((pair: unknown) => {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !pair[0].startsWith('/')) {
        throw new Error('Hermes 原生命令条目无效');
      }
      return { name: pair[0].slice(1), description: pair[1], category: category.name,
        aliases: Object.entries(canon).filter(([alias, name]) => name === pair[0] && alias !== name).map(([alias]) => alias.slice(1)),
        supported: false, unavailable_reason: unavailable };
    });
  });
  return nativeCommandList(commands);
}

export function enableNativeCommands(commands: NativeCommand[], names: readonly string[]): NativeCommand[] {
  return commands.map((entry) => names.includes(entry.name)
    ? { ...entry, supported: true, unavailable_reason: undefined } : entry);
}

export function nativeStatusOutput(status: SessionStatus): string {
  const activity = { idle: '空闲', running: '正在响应', queued: '排队中', unknown: '执行状态待确认' };
  return ['/status', `状态：${activity[status.activity]}`, status.model && `模型：${status.model}`,
    status.message_count === undefined ? undefined : `消息：${status.message_count} 条`].filter(Boolean).join('\n');
}

export function resolveNativeCommand(command: string, commands: NativeCommand[]) {
  const match = /^\/([a-z0-9][a-z0-9_-]{0,127})(?:[ \t]+(.*))?$/iu.exec(command.replace(/[ \t]+$/u, ''));
  if (!text(command, 8 * 1024) || /[\r\n\u2028\u2029]/u.test(command) || !match) {
    throw new NativeCommandFailure('请输入有效的单行原生命令。');
  }
  const name = match[1].toLowerCase();
  const entry = commands.find((entry) => entry.name === name || entry.aliases.includes(name));
  if (!entry) throw new NativeCommandFailure('Hermes 原生命令目录中没有此命令。');
  return { entry, args: trimNativeWhitespace(match[2] ?? '') };
}

/** Preflight only: the native PATCH still performs SessionDB.sanitize_title and uniqueness checks. */
export function nativeTitle(value: string): string {
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/[\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufff9-\ufffc]/gu, '')
    .replace(new RegExp(`${nativeWhitespace}+`, 'gu'), ' ').trim();
  if (!cleaned) throw new NativeCommandFailure('标题清理后为空，请输入可见字符。');
  if ([...cleaned].length > 100) throw new NativeCommandFailure('会话标题最多为 100 个字符。');
  return cleaned;
}

function nativeResult(data: JsonObject): NativeCommandResult {
  if (data.ok === false && text(data.error, 2048)) {
    throw new NativeCommandFailure(boundedText(data.error, 1024), data.status === 'error' ? 'error' : 'unknown');
  }
  const metadata = data.native_result === undefined ? {} : object(data.native_result);
  if (data.ok !== true || !text(data.output, 256 * 1024, true) || !metadata
    || (metadata.title !== undefined && !text(metadata.title, MAX_TOPIC_TITLE_BYTES))
    || (metadata.session_id !== undefined && (typeof metadata.session_id !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,511}$/u.test(metadata.session_id)))
    || (metadata.rewound_turns !== undefined && (!Number.isSafeInteger(metadata.rewound_turns)
      || (metadata.rewound_turns as number) < 0))
    || (metadata.reset !== undefined && (metadata.reset !== true || metadata.session_id === undefined))) {
    throw new NativeCommandFailure('Hermes 原生命令回执无效，执行结果未确认。', 'unknown');
  }
  if (metadata.confirmation !== undefined && (!text(metadata.confirmation, 16 * 1024)
    || ['title', 'session_id', 'rewound_turns', 'reset'].some((key) => metadata[key] !== undefined))) {
    throw new NativeCommandFailure('Hermes 原生命令确认回执无效。', 'unknown');
  }
  return { output: data.output, ...(metadata.title === undefined ? {} : { title: metadata.title as string }),
    ...(metadata.session_id === undefined ? {} : { session_id: metadata.session_id as string }),
    ...(metadata.reset === true ? { reset: true } : {}),
    ...(metadata.confirmation === undefined ? {} : { confirmation: metadata.confirmation as string }),
    ...(metadata.rewound_turns === undefined ? {} : { rewound_turns: metadata.rewound_turns as number }) };
}

async function readReply(response: Response): Promise<JsonObject> {
  if (!response.body) throw new Error('Hermes 原生命令响应为空');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new Error('Hermes 原生命令响应过大');
      chunks.push(value);
    }
    const data = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!data) throw new Error('Hermes 原生命令响应无效');
    return data;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const profileName = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;
const validApiKey = (value: unknown): value is string =>
  typeof value === 'string' && !!value.trim() && !/[\r\n]/u.test(value);

export function parseNativeApiKeys(defaultKey: string, raw: string | undefined): string | Readonly<Record<string, string>> {
  if (!validApiKey(defaultKey)) throw new Error('请设置有效的 HERMES_API_KEY');
  if (raw === undefined || raw === '') return defaultKey;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('HERMES_API_KEYS 必须是配置档案到 API 密钥的 JSON 对象'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('HERMES_API_KEYS 必须是配置档案到 API 密钥的 JSON 对象');
  }
  const entries = Object.entries(parsed);
  if (!entries.length || entries.some(([profile, key]) => !profileName.test(profile)
    || ['all', 'current', 'default'].includes(profile) || !validApiKey(key))) {
    throw new Error('HERMES_API_KEYS 包含无效的档案名称或密钥');
  }
  return Object.fromEntries([['default', defaultKey], ...entries]);
}

export function createNativeCommands(origin: string, tokens: string | Readonly<Record<string, string>>) {
  const url = URL.parse(origin);
  if (!url || !['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (typeof tokens === 'string' ? !validApiKey(tokens) : !tokens || Array.isArray(tokens)
      || Object.entries(tokens).some(([profile, key]) => !profileName.test(profile) || !validApiKey(key)))) {
    throw new Error('原生命令需要 Hermes HTTP API 的回环地址和密钥');
  }
  async function request(profile: string, body: JsonObject, signal?: AbortSignal) {
    if (!profileName.test(profile) || ['all', 'current'].includes(profile)) {
      throw new NativeCommandFailure('Hermes 配置档案无效。');
    }
    const token = typeof tokens === 'string' ? tokens : Object.hasOwn(tokens, profile) ? tokens[profile] : undefined;
    if (!validApiKey(token)) throw new NativeCommandFailure('此 Hermes 配置档案的 API 密钥未配置。');
    const timeout = AbortSignal.timeout(body.kind === 'catalog' ? queryTimeout : 15_000);
    const response = await fetch(new URL(`/p/${encodeURIComponent(profile)}/api/platforms/hermes_mobile/events`, url!), {
      method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, profile_ref: profile }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      if (response.status === 503 && body.kind === 'runtime') {
        const failure = await readReply(response).catch(() => undefined);
        if (object(failure?.error)?.code === 'platform_http_events_unsupported') throw new QueryUnavailable();
      } else await response.body?.cancel();
      if ([404, 501].includes(response.status) || (response.status === 503 && body.kind !== 'runtime')) throw new QueryUnavailable();
      throw new NativeCommandFailure(`Hermes 拒绝了原生命令请求（${response.status}）。`, response.status >= 500 ? 'unknown' : 'error');
    }
    return readReply(response);
  }
  return {
    async catalog(profile: string, signal?: AbortSignal) {
      const data = await request(profile, { kind: 'catalog' }, signal);
      if (data.ok === false && text(data.error, 2048)) throw new NativeCommandFailure(boundedText(data.error, 1024));
      return nativeCommandList(data.commands);
    },
    async runtime(profile: string, sessionId: string, signal?: AbortSignal): Promise<string> {
      const data = await request(profile, { kind: 'runtime', session_id: sessionId }, signal);
      if (data.ok === false && text(data.error, 2048)) throw new NativeCommandFailure(boundedText(data.error, 1024));
      if (!text(data.system_prompt, 256 * 1024, true)) throw new NativeCommandFailure('Hermes 人格运行配置无效。');
      return data.system_prompt;
    },
    async execute(profile: string, sessionId: string, requestId: string, command: string, signal?: AbortSignal,
      approval?: 'once' | 'always'): Promise<NativeCommandResult> {
      let data: JsonObject;
      try {
        data = await request(profile, { kind: 'execute', request_id: requestId, session_id: sessionId, command,
          ...(approval && { approval }) }, signal);
      } catch (error) {
        if (error instanceof NativeCommandFailure) throw error;
        if (error instanceof QueryUnavailable) throw new NativeCommandFailure('请更新并启用 Hermes 移动端命令插件。');
        throw new NativeCommandFailure('Hermes 尚未确认命令结果，请查询同一请求的状态。', 'unknown');
      }
      return nativeResult(data);
    },
    async result(profile: string, sessionId: string, requestId: string, signal?: AbortSignal): Promise<NativeCommandResult> {
      // This endpoint only reads the original receipt and must never dispatch the command again.
      return nativeResult(await request(profile, { kind: 'result', request_id: requestId, session_id: sessionId }, signal));
    },
  };
}

export type NativeCommands = ReturnType<typeof createNativeCommands>;
