import { createHash, randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { managementOperations, managementTimeout, type ManagementRequest, type ManagementResult } from '@hermes-mobile/protocol';
import { load } from 'js-yaml';
import { object, type JsonObject } from './gateway.js';
import { boundedText } from './wire.js';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
const levels = ['DEBUG', 'INFO', 'WARNING', 'ERROR'];
const filterLevels = [...levels, 'CRITICAL'];
const logFiles = { agent: 'agent.log', errors: 'errors.log', gateway: 'gateway.log', gui: 'gui.log',
  desktop: 'desktop.log', mcp: 'mcp-stderr.log' };
const logComponents: Record<string, string[]> = { agent: ['agent', 'run_agent', 'model_tools', 'batch_runner'],
  gateway: ['gateway', 'hermes_plugins', 'plugins.platforms'], tools: ['tools'], cli: ['hermes_cli', 'cli'], cron: ['cron'],
  gui: ['hermes_cli.web_server', 'hermes_cli.pty_bridge', 'tui_gateway', 'uvicorn'] };
const cronFields = ['name', 'schedule', 'prompt', 'deliver', 'skills', 'model', 'provider', 'base_url', 'script',
  'workdir', 'no_agent', 'context_from', 'enabled_toolsets'];
const envReference = /^\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}$/u;

class Refusal extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function invalid(message: string): never { throw new Refusal(422, message); }

function fields(value: unknown, allowed: readonly string[]): JsonObject {
  const row = object(value);
  if (!row || Object.keys(row).some((key) => !allowed.includes(key))) invalid('管理请求包含不支持的字段。');
  return row;
}

function text(value: unknown, name: string, max = 512, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0')
    || Buffer.byteLength(value) > max || Buffer.from(value).toString() !== value) invalid(`请检查${name}。`);
  return value;
}

function choice(value: unknown, name: string, allowed: readonly string[]): string {
  const candidate = text(value, name);
  if (!allowed.includes(candidate)) invalid(`请检查${name}。`);
  return candidate;
}

function flag(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') invalid(`请检查${name}。`);
  return value;
}

function list(value: unknown, name: string, empty = false): string[] {
  if (!Array.isArray(value) || value.length > 100) invalid(`请检查${name}。`);
  return value.map((item) => text(item, name, 4096, empty));
}

function nameSegment(value: unknown): string {
  const name = text(value, '名称', 160);
  if (name === '.' || name === '..' || /[/\\\u0000-\u001f\u007f]/u.test(name)) invalid('名称无效。');
  return encodeURIComponent(name);
}

function environment(value: unknown) {
  const env = object(value);
  if (!env || Object.keys(env).length > 50 || Object.keys(env).some((key) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key))) {
    invalid('请输入有效的环境变量名称。');
  }
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, text(value, '环境变量值', 4096, true)]));
}

function endpoint(value: unknown) {
  const address = text(value, '接口地址', 2048).trim();
  const url = URL.parse(address);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) invalid('请输入 HTTP 或 HTTPS 接口地址。');
  return address;
}

function endpointOrReference(value: unknown) {
  return typeof value === 'string' && envReference.test(value) ? value : endpoint(value);
}

function cronInput(value: unknown, creating: boolean) {
  const input = fields(value, cronFields);
  const result = Object.fromEntries(Object.entries(input).map(([key, value]) => {
    const field = `字段 ${key}`;
    if (key === 'no_agent') return [key, flag(value, field)];
    if (['skills', 'context_from', 'enabled_toolsets'].includes(key)) return [key, list(value, field)];
    if (key === 'base_url') return [key, value === '' ? '' : endpoint(value)];
    return [key, text(value, field, key === 'prompt' ? 96 * 1024 : 4096, key !== 'schedule')];
  }));
  if (creating) text(result.schedule, '执行计划', 4096);
  if (!creating && Object.hasOwn(result, 'skills')) result.skill = null;
  return result;
}

function providerKeys(value: unknown) {
  return Object.entries(object(value) ?? {}).flatMap(([key, raw]) => {
    const row = object(raw);
    if (!row || row.category !== 'provider' || !row.is_password || typeof row.provider !== 'string' || !row.provider
      || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(key)) return [];
    return [{ key, provider: row.provider, label: typeof row.provider_label === 'string' ? row.provider_label : row.provider,
      configured: row.is_set === true }];
  });
}

function displayedUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return;
  const url = URL.parse(value);
  if (url && (url.username || url.password)) return `${url.origin}${url.pathname}${url.search ? '?••••' : ''}`;
  return value.split(/[?#]/u, 1)[0];
}

function patterns(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.map(String) : [];
}

function managedBearerKey(name: string, server: JsonObject): string | undefined {
  if (!server.url || server.auth === 'oauth') return;
  const suffix = name.toUpperCase().replace(/[^A-Z0-9_]/gu, '_').replace(/^_+|_+$/gu, '');
  const key = `MCP_${suffix}_API_KEY`;
  const header = Object.entries(object(server.headers) ?? {}).find(([field]) => field.toLowerCase() === 'authorization');
  if (header?.[1] === `Bearer \${${key}}`) return key;
}

function displayArguments(value: unknown) {
  const saved = Array.isArray(value) ? value.map(String) : [];
  const credential = /^(?:-H|--?[\w-]*(?:api[-_]?key|token|secret|password|authorization|credential|header)[\w-]*|[\w-]*(?:api[-_]?key|token|secret|password|authorization|credential)[\w-]*)(?:=|$)/iu;
  const args = saved.map((arg, index) => {
    if (index > 0 && credential.test(saved[index - 1]) && !saved[index - 1].includes('=') && !envReference.test(arg)) return '••••';
    const equal = arg.indexOf('=');
    if (equal >= 0 && credential.test(arg) && !envReference.test(arg.slice(equal + 1))) return `${arg.slice(0, equal + 1)}••••`;
    if (/^(https?:\/\/)/iu.test(arg)) return displayedUrl(arg) ?? '';
    return arg;
  });
  return { args, args_masked: args.some((arg, index) => arg !== saved[index]) };
}

async function readText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error('Hermes 响应为空');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Refusal(502, 'Hermes 响应超出移动端可接收的大小。');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readText(response, maxBytes));
}

function filteredLogTail(raw: string, partial: boolean, level: string, component: string, search: string, lines: number) {
  const rows = raw.split(/\r?\n/u);
  if (partial) rows.shift();
  const minimum = filterLevels.indexOf(level);
  const needle = search.toLowerCase();
  return rows.filter((line) => {
    if (!line.trim() || !line.toLowerCase().includes(needle)) return false;
    const match = /\s(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+(?:\[.*?\]\s+)?(\S+):/u.exec(line);
    if (match && filterLevels.indexOf(match[1]) < minimum) return false;
    return component === 'all' || !!match && logComponents[component].some((prefix) => match[2].startsWith(prefix));
  }).slice(-lines);
}

export function createDashboardManagement(origin: string, token: string) {
  const address = URL.parse(origin);
  if (!address || !['http:', 'https:'].includes(address.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(address.hostname)
    || address.username || address.password || address.pathname !== '/' || address.search || address.hash || !/^[\x21-\x7e]+$/u.test(token)) {
    throw new Error('Hermes 管理功能需要回环地址上的控制台 URL 和会话令牌');
  }
  const dashboardOrigin = address.origin;
  let writing = false;
  const installs = new Map<string, { name: string; profile: string; pid: number; since: number }>();

  return async function run(frame: ManagementRequest): Promise<ManagementResult> {
    const base = { type: 'management_result' as const, request_id: frame.request_id };
    const { operation, profile_ref, input } = frame;
    const write = managementOperations[operation] === 'write';
    if (write && writing) return { ...base, ok: false, status: 429, message: 'Hermes 正在处理其他配置变更，请稍后重试。' };
    if (write) writing = true;
    let sentWrite = false;
    const signal = AbortSignal.timeout(managementTimeout(operation));

    async function fetchDashboard(method: Method, path: string, body: JsonObject | undefined,
      query: Record<string, string>, scoped: boolean, headers?: Record<string, string>) {
      const url = new URL(`/api${path}`, dashboardOrigin);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      if (scoped) url.searchParams.set('profile', profile_ref);
      if (write && method !== 'GET') sentWrite = true;
      return fetch(url, {
        method, signal, redirect: 'error', headers: { Accept: 'application/json', 'X-Hermes-Session-Token': token,
          ...(body && { 'Content-Type': 'application/json' }), ...headers }, body: body && JSON.stringify(body),
      });
    }

    async function request(method: Method, path: string, body?: JsonObject, query: Record<string, string> = {}, scoped = true) {
      const response = await fetchDashboard(method, path, body, query, scoped);
      if (response.status === 204) return null;
      if (response.ok) return readJson(response, 4 * 1024 * 1024);
      const detail = object(await readJson(response, 8192).catch(() => undefined))?.detail;
      if ([400, 404, 409, 422, 429].includes(response.status)) {
        // FastAPI 的校验详情可能回显只写字段。
        const secret = ['model.set', 'model.key', 'mcp.add', 'mcp.edit', 'mcp.token', 'mcp.install'].includes(operation);
        const message = `Hermes 拒绝了请求（${response.status}）。`;
        throw new Refusal(response.status, !secret && typeof detail === 'string' && detail.trim()
          ? `${message}\n${boundedText(detail, 1800)}` : message);
      }
      if (response.status === 401 || response.status === 403) throw new Refusal(502, 'Hermes 控制台拒绝了连接器凭据。');
      throw new Error(`Hermes 控制台返回状态码 ${response.status}`);
    }

    async function dashboardProfiles() {
      return object(await request('GET', '/profiles/active', undefined, {}, false));
    }

    async function profileDirectory() {
      const data = object(await request('GET', '/profiles', undefined, {}, false))?.profiles;
      if (!Array.isArray(data)) throw new Error('Hermes 配置档案列表无效');
      return data.map(object);
    }

    async function rawConfig() {
      const data = object(await request('GET', '/config/raw'));
      if (typeof data?.yaml !== 'string') throw new Error('Hermes 配置响应无效');
      const parsed = load(data.yaml);
      if (parsed == null) return {};
      const config = object(parsed);
      if (!config) throw new Error('Hermes 配置无效');
      return config;
    }

    async function requireDefaultActionProfile() {
      if (profile_ref === 'default') {
        const profiles = await dashboardProfiles();
        if (profiles?.current !== 'default' || profiles.active !== 'default') {
          throw new Refusal(409, '请以 default 配置档案启动 Hermes 控制台，并将 default 设为当前活动档案后再安装。');
        }
      }
    }

    function actionState(name: string) {
      return request('GET', `/actions/${name}/status`, undefined, { lines: '60' }, false).then(object);
    }

    async function startInstall(kind: 'skills-install' | 'mcp-install', item: string, start: () => Promise<unknown>) {
      const slug = item.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 48);
      const digest = createHash('sha1').update(item).digest('hex').slice(0, 8);
      const name = `${kind}-${slug || (kind === 'skills-install' ? 'skill' : 'server')}-${digest}`;
      const state = await actionState(name).catch((failure: unknown) => {
        if (failure instanceof Refusal && failure.status === 404) return;
        throw failure;
      });
      if (state?.running === true) throw new Refusal(409, '此项目正在安装。');
      const result = object(await start());
      if (result?.ok !== true) throw new Error('Hermes 未启动安装');
      if (kind === 'mcp-install' && result.background !== true) return { ok: true, background: false };
      if ((kind === 'skills-install' ? result.name : result.action) !== name) throw new Error('Hermes 返回了无效的安装回执');
      const pid = typeof result.pid === 'number' ? result.pid : (await actionState(name))?.pid;
      if (typeof pid !== 'number') throw new Error('Hermes 未确认安装进程');
      const id = randomUUID();
      const now = Date.now();
      for (const [receipt, install] of installs) {
        if (install.name === name || now - install.since > 30 * 60_000) installs.delete(receipt);
      }
      if (installs.size >= 64) installs.delete(installs.keys().next().value!);
      installs.set(id, { name, pid, profile: profile_ref, since: now });
      return kind === 'skills-install' ? { name: id } : { background: true, action: id };
    }

    async function profileLogs(file: keyof typeof logFiles, level: string, component: string, search: string, lines: number) {
      if ((await dashboardProfiles())?.current === profile_ref) {
        const data = object(await request('GET', '/logs', undefined, { file, level, component, search, lines: String(lines) }, false));
        if (!Array.isArray(data?.lines)) throw new Error('Hermes 日志响应无效');
        return data.lines.filter((line): line is string => typeof line === 'string');
      }
      const profile = (await profileDirectory()).find((row) => row?.name === profile_ref);
      const home = profile?.path;
      if (typeof home !== 'string' || !(posix.isAbsolute(home) || win32.isAbsolute(home))) {
        throw new Refusal(404, '找不到 Hermes 配置档案。');
      }
      const path = (posix.isAbsolute(home) ? posix : win32).join(home, 'logs', logFiles[file]);
      // shortcut: 跨档案读取时最多读取末尾 256 KiB，待 Hermes 日志接口支持按配置档案查询后改用该接口。
      const response = await fetchDashboard('GET', '/files/download', undefined, { path }, false, { Range: 'bytes=-262144' });
      if (response.status === 404 || response.status === 416) {
        await response.body?.cancel();
        return [];
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Refusal(502, 'Hermes 控制台无法读取所选配置档案的日志。');
      }
      return filteredLogTail(await readText(response, 256 * 1024), response.status === 206
        && !response.headers.get('content-range')?.startsWith('bytes 0-'), level, component, search, lines);
    }

    async function perform(): Promise<unknown> {
      switch (operation) {
        case 'cron.list':
          fields(input, []);
          return request('GET', '/cron/jobs');
        case 'cron.create':
          return request('POST', '/cron/jobs', cronInput(input, true));
        case 'cron.edit':
          fields(input, ['id', 'updates']);
          return request('PUT', `/cron/jobs/${nameSegment(input.id)}`, { updates: cronInput(input.updates, false) });
        case 'cron.runs': case 'cron.pause': case 'cron.resume': case 'cron.trigger': case 'cron.remove': {
          fields(input, ['id']);
          const path = `/cron/jobs/${nameSegment(input.id)}`;
          const action = operation.slice(5);
          if (action === 'runs') {
            const data = object(await request('GET', `${path}/runs`, undefined, { limit: '20' }));
            if (!Array.isArray(data?.runs)) throw new Error('Hermes 运行历史无效');
            return { runs: data.runs.map((raw) => {
              const run = object(raw);
              if (!run) throw new Error('Hermes 运行记录无效');
              return { id: run.id, title: run.title, started_at: run.started_at, ended_at: run.ended_at, is_active: run.is_active };
            }) };
          }
          if (action === 'remove') return request('DELETE', path);
          return request('POST', `${path}/${action}`);
        }
        case 'model.list': {
          fields(input, []);
          const [raw, config] = await Promise.all([request('GET', '/model/auxiliary'), rawConfig()]);
          const data = object(raw);
          const main = object(data?.main);
          if (!main || !Array.isArray(data?.tasks)) throw new Error('Hermes 模型配置无效');
          const savedAux = object(config.auxiliary);
          function baseUrl(raw: unknown) {
            const base_url = displayedUrl(raw);
            return { base_url, ...(base_url !== undefined && base_url !== raw && { base_url_masked: true }) };
          }
          return {
            main: { provider: main.provider, model: main.model, ...baseUrl(object(config.model)?.base_url) },
            tasks: data.tasks.map((raw) => {
              const task = object(raw);
              if (typeof task?.task !== 'string') throw new Error('Hermes 模型用途无效');
              return { task: task.task, provider: task.provider, model: task.model, ...baseUrl(object(savedAux?.[task.task])?.base_url) };
            }),
          };
        }
        case 'model.options': {
          fields(input, []);
          const data = object(await request('GET', '/model/options', undefined, { include_unconfigured: 'true' }));
          if (!Array.isArray(data?.providers)) throw new Error('Hermes 模型选项无效');
          return data.providers.flatMap((raw) => {
            const row = object(raw);
            return row && typeof row.slug === 'string' ? [{ slug: row.slug, name: row.name, authenticated: row.authenticated,
              models: Array.isArray(row.models) ? row.models.filter((value) => typeof value === 'string') : [] }] : [];
          });
        }
        case 'model.set': {
          fields(input, ['scope', 'task', 'provider', 'model', 'base_url', 'api_key', 'confirm_expensive_model']);
          const scope = choice(input.scope, '模型用途', ['main', 'auxiliary']);
          const provider = text(input.provider, '服务商', 160).trim();
          if (scope === 'auxiliary' && input.api_key !== undefined && input.base_url === undefined) invalid('设置辅助模型的 API 密钥前，请先填写接口地址。');
          const data = object(await request('POST', '/model/set', {
            scope, provider, model: text(input.model, '模型', 512, scope === 'auxiliary').trim(),
            ...(scope === 'auxiliary' && { task: text(input.task, '辅助任务', 64) }),
            ...(input.base_url !== undefined && { base_url: endpointOrReference(input.base_url) }),
            ...(input.api_key !== undefined && { api_key: text(input.api_key, 'API 密钥', 4096) }),
            ...(input.confirm_expensive_model !== undefined && { confirm_expensive_model: flag(input.confirm_expensive_model, '确认状态') }),
          }));
          if (data?.confirm_required === true) return { ok: false, confirm_required: true,
            confirm_message: typeof data.confirm_message === 'string' ? boundedText(data.confirm_message, 1000) : undefined };
          if (data?.ok !== true) throw new Error('Hermes 未确认模型变更');
          return { ok: true };
        }
        case 'model.keys':
          fields(input, []);
          return providerKeys(await request('GET', '/env'));
        case 'model.key': case 'model.key.remove': {
          const remove = operation === 'model.key.remove';
          fields(input, remove ? ['key'] : ['key', 'value']);
          const key = text(input.key, '服务商密钥名称', 128);
          const value = remove ? undefined : text(input.value, 'API 密钥', 4096).trim();
          if (!providerKeys(await request('GET', '/env')).some((row) => row.key === key)) invalid('请选择已知模型服务商的密钥。');
          await request(remove ? 'DELETE' : 'PUT', '/env', { key, value });
          return { ok: true };
        }
        case 'logs.read': {
          fields(input, ['file', 'level', 'component', 'search', 'lines']);
          const file = choice(input.file ?? 'agent', '日志文件', Object.keys(logFiles)) as keyof typeof logFiles;
          const level = choice(input.level ?? 'ALL', '最低日志级别', ['ALL', ...filterLevels]);
          const component = choice(input.component ?? 'all', '组件', ['all', ...Object.keys(logComponents)]);
          const search = text(input.search ?? '', '搜索关键词', 512, true).trim();
          const lines = input.lines ?? 100;
          if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 1 || lines > 200) invalid('日志行数必须为 1 至 200。');
          const [raw, config] = await Promise.all([
            profileLogs(file, level, component, search, lines),
            request('GET', '/config'),
          ]);
          return { file, level: object(object(config)?.logging)?.level ?? 'INFO',
            lines: raw.slice(-lines).map((line) => boundedText(line, 3072)) };
        }
        case 'logs.level':
          fields(input, ['level']);
          return request('PUT', '/config', { config: { logging: { level: choice(input.level, '日志级别', levels) } } });
        case 'skill.list':
          fields(input, []);
          return request('GET', '/skills');
        case 'skill.read': {
          fields(input, ['name']);
          const data = object(await request('GET', '/skills/content', undefined, { name: text(input.name, '技能名称', 160) }));
          if (typeof data?.content !== 'string') throw new Error('Hermes 技能内容无效');
          return { content: data.content };
        }
        case 'skill.create': case 'skill.edit': {
          const create = operation === 'skill.create';
          fields(input, create ? ['name', 'content', 'category'] : ['name', 'content']);
          return request(create ? 'POST' : 'PUT', create ? '/skills' : '/skills/content', {
            name: text(input.name, '技能名称', 160), content: text(input.content, 'SKILL.md', 240 * 1024),
            ...(input.category !== undefined && { category: text(input.category, '分类', 160) }), profile: profile_ref,
          });
        }
        case 'skill.toggle':
          fields(input, ['name', 'enabled']);
          return request('PUT', '/skills/toggle', { name: text(input.name, '技能名称', 160), enabled: flag(input.enabled, '启用状态') });
        case 'skill.install': {
          fields(input, ['identifier']);
          const identifier = text(input.identifier, '技能标识', 2048).trim();
          if (identifier.startsWith('-')) invalid('技能标识无效。');
          await requireDefaultActionProfile();
          return startInstall('skills-install', identifier, () => request('POST', '/skills/hub/install', { identifier }));
        }
        case 'mcp.list': {
          fields(input, []);
          const servers = object((await rawConfig()).mcp_servers) ?? {};
          return { servers: Object.entries(servers).sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, raw]) => {
            const row = object(raw);
            if (!row) return [];
            const tools = object(row.tools);
            const auth = row.auth ?? (Object.keys(object(row.headers) ?? {}).length ? 'header' : undefined);
            const url = displayedUrl(row.url);
            return [{ name, transport: row.url ? 'http' : row.command ? 'stdio' : 'unknown',
              ...(url && { url, ...(url !== row.url && { url_masked: true }) }), ...(typeof row.command === 'string' && { command: row.command }),
              ...displayArguments(row.args), env_keys: Object.keys(object(row.env) ?? {}), ...(typeof auth === 'string' && { auth }), enabled: row.enabled !== false,
              ...(managedBearerKey(name, row) && { bearer_managed: true }),
              ...(tools && { tools: { include: patterns(tools.include), exclude: patterns(tools.exclude) } }) }];
          }) };
        }
        case 'mcp.token': {
          fields(input, ['name', 'bearer_token']);
          const name = text(input.name, '服务器名称', 160);
          const value = text(input.bearer_token, 'Bearer 令牌', 4096).trim().replace(/^Bearer\s+/iu, '');
          if (!value || /^bearer$/iu.test(value) || /\s/u.test(value)) invalid('请输入有效的 Bearer 令牌。');
          const servers = object((await rawConfig()).mcp_servers);
          const server = servers && Object.hasOwn(servers, name) ? object(servers[name]) : undefined;
          if (!server) throw new Refusal(404, '找不到 MCP 服务器。');
          const key = managedBearerKey(name, server);
          if (!key) invalid('此服务器的凭据由外部配置管理。');
          await request('PUT', '/env', { key, value });
          return { ok: true };
        }
        case 'mcp.add': case 'mcp.edit': {
          const add = operation === 'mcp.add';
          fields(input, add ? ['name', 'url', 'command', 'args', 'env', 'bearer_token', 'auth']
            : ['name', 'url', 'command', 'args', 'env', 'remove_env', 'tools']);
          nameSegment(input.name);
          const name = input.name as string;
          const transport = {
            ...(input.url !== undefined && { url: endpointOrReference(input.url) }),
            ...(input.command !== undefined && { command: text(input.command, '启动命令', 2048).trim() }),
            ...(input.args !== undefined && { args: list(input.args, '命令参数', true) }),
            ...(input.env !== undefined && { env: environment(input.env) }),
          };
          if (add) {
            if (Boolean(transport.url) === Boolean(transport.command)) invalid('请选择一种 MCP 传输方式。');
            const auth = input.bearer_token !== undefined ? 'header' : choice(input.auth ?? 'none', '身份验证方式', ['none', 'oauth']);
            if (auth !== 'none' && !transport.url) invalid('使用 HTTP 身份验证时，必须填写 MCP 服务器 URL。');
            await request('POST', '/mcp/servers', { name, ...transport, auth,
              ...(input.bearer_token !== undefined && { bearer_token: text(input.bearer_token, 'Bearer 令牌', 4096) }) });
            return { ok: true };
          }
          const servers = object((await rawConfig()).mcp_servers);
          const current = servers && Object.hasOwn(servers, name) ? object(servers[name]) : undefined;
          if (!current) throw new Refusal(404, '找不到 MCP 服务器。');
          if ((transport.url && !current.url) || ((transport.command || transport.args || transport.env || input.remove_env !== undefined) && !current.command)) {
            invalid('编辑时需保留服务器当前的传输方式。');
          }
          const next: JsonObject = { ...current, ...transport };
          if (transport.env || input.remove_env !== undefined) {
            const env = { ...object(current.env), ...transport.env };
            for (const key of list(input.remove_env ?? [], '环境变量名称')) delete env[key];
            next.env = env;
          }
          if (input.tools !== undefined) {
            const tools = fields(input.tools, ['include', 'exclude']);
            next.tools = { ...object(current.tools), include: list(tools.include, '允许使用的工具'), exclude: list(tools.exclude, '禁止使用的工具') };
          }
          // shortcut: Hermes 会保存完整的 MCP 服务器配置，等上游支持单个服务器更新后改用该接口。
          const result = object(await request('PUT', '/mcp/servers', { servers: { ...servers, [name]: next } }));
          if (result?.ok !== true) throw new Error('Hermes 未确认 MCP 配置变更');
          return { ok: true };
        }
        case 'mcp.toggle': case 'mcp.test': case 'mcp.remove': {
          fields(input, operation === 'mcp.toggle' ? ['name', 'enabled'] : ['name']);
          const path = `/mcp/servers/${nameSegment(input.name)}`;
          if (operation === 'mcp.toggle') return request('PUT', `${path}/enabled`, { enabled: flag(input.enabled, '启用状态') });
          if (operation === 'mcp.test') {
            const servers = object((await rawConfig()).mcp_servers);
            const config = servers && Object.hasOwn(servers, input.name as string) ? object(servers[input.name as string]) : undefined;
            if (!config) throw new Refusal(404, '找不到 MCP 服务器。');
            const references = [...JSON.stringify(config).matchAll(/\$\{\s*(?:env:)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}/gu)].map((match) => match[1]);
            if (references.length) {
              if ((await dashboardProfiles())?.current !== profile_ref) {
                throw new Refusal(409, '请在对应配置档案下运行 Hermes 控制台，并在其中测试此服务器，以使用正确的凭据。');
              }
              for (const other of await profileDirectory()) {
                if (typeof other?.name !== 'string' || other.name === profile_ref || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(other.name)
                  || other.name === 'all' || other.name === 'current') continue;
                const env = object(await request('GET', '/env', undefined, { profile: other.name }, false));
                if (!env || references.some((key) => object(env[key])?.is_set === true)) {
                  throw new Refusal(409, '此服务器使用了与其他配置档案同名的环境变量。请使用此档案专用的变量名，或在 Hermes 主机上测试。');
                }
              }
            }
            const result = object(await request('POST', `${path}/test`));
            if (result?.ok !== true) return { ok: false, tools: [], error: config.auth === 'oauth'
              ? '连接失败。请检查服务器，并在 Hermes 控制台确认 OAuth 登录状态。' : '连接失败。请检查接口地址、凭据或 Hermes 日志。' };
            return { ok: true, tools: result.tools };
          }
          return request('DELETE', path);
        }
        case 'mcp.catalog':
          fields(input, []);
          return request('GET', '/mcp/catalog');
        case 'mcp.install': {
          fields(input, ['name', 'env']);
          const name = text(input.name, '目录条目名称', 160);
          const env = environment(input.env ?? {});
          const rows = object(await request('GET', '/mcp/catalog'))?.entries;
          const entry = Array.isArray(rows) ? rows.map(object).find((row) => row?.name === name) : undefined;
          if (!entry) throw new Refusal(404, '找不到 MCP 目录条目。');
          if (entry.installed === true) throw new Refusal(409, '此 MCP 服务器已安装。');
          const required = Array.isArray(entry.required_env) ? entry.required_env.map(object) : [];
          if (Object.keys(env).some((key) => !required.some((row) => row?.name === key))) invalid('请求包含此 MCP 服务器未声明的环境变量。');
          if (entry.needs_install === true) await requireDefaultActionProfile();
          const install = () => request('POST', '/mcp/catalog/install', { name, env });
          return entry.needs_install === true ? startInstall('mcp-install', name, install) : install();
        }
        case 'action.status': {
          fields(input, ['name']);
          const id = text(input.name, '安装回执', 36);
          const install = installs.get(id);
          if (install?.profile !== profile_ref) throw new Refusal(404, '无法获取安装状态，请刷新列表查看。');
          const data = await actionState(install.name);
          if (typeof data?.running !== 'boolean') throw new Error('Hermes 安装状态无效');
          if (data.pid !== install.pid) return { running: false, exit_code: null };
          if (data.exit_code === 0 && install.name.startsWith('skills-install-') && Array.isArray(data.lines)) {
            const lines = data.lines.filter((line): line is string => typeof line === 'string').map((line) => line.replace(/\x1b\[[0-9;]*m/gu, ''));
            const latest = lines.map((line) => line.startsWith(`=== ${install.name} started `)).lastIndexOf(true);
            return { running: false, exit_code: lines.slice(latest + 1).some((line) => /^\s*Installed:/u.test(line)) ? 0 : 1 };
          }
          return { running: data.running, exit_code: data.exit_code ?? null };
        }
      }
    }

    try {
      const data = await perform();
      if (Buffer.byteLength(JSON.stringify(data)) > 900 * 1024) throw new Refusal(502, 'Hermes 响应超出移动端可接收的大小。');
      return { ...base, ok: true, data };
    } catch (error) {
      if (error instanceof Refusal) return { ...base, ok: false, status: error.status, message: error.message };
      return { ...base, ok: false, status: signal.aborted ? 504 : 502,
        message: sentWrite ? 'Hermes 无法确认本次更改。请刷新查看当前状态后再重试。'
          : signal.aborted && operation === 'mcp.test' ? 'MCP 连接测试超时。请检查服务器或 Hermes 日志。'
          : '无法读取 Hermes 控制台数据。请确认控制台正在运行后重试。' };
    } finally {
      if (write) writing = false;
    }
  };
}
