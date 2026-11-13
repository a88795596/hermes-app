import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import type { ManagementOperation, ManagementRequest } from '@hermes-mobile/protocol';
import { bridgeFrame } from '../src/wire.js';

function frame(operation: ManagementOperation, input: Record<string, unknown> = {}, profile_ref = 'work'): ManagementRequest {
  return { type: 'management_request', request_id: '00000000-0000-4000-8000-000000000001', operation, profile_ref, input };
}

test('连接器协议接受不包含聊天会话的管理帧', () => {
  assert.deepEqual(bridgeFrame(JSON.stringify(frame('cron.list'))), frame('cron.list'));
  assert.throws(() => bridgeFrame(JSON.stringify(frame('cron.list', {}, 'all'))));
  assert.throws(() => bridgeFrame(JSON.stringify({ ...frame('cron.list'), operation: 'config.raw' })));
});

async function dashboard(t: TestContext, respond: (method: string, url: string, body: Record<string, unknown>) => object | string) {
  const requests: string[] = [];
  const server = createServer(async (request, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    requests.push(`${request.method} ${request.url}`);
    try {
      assert.equal(request.headers['x-hermes-session-token'], 'dashboard-test-token');
      const result = respond(request.method!, request.url!, raw ? JSON.parse(raw) : undefined);
      if (typeof result === 'string') {
        assert.equal(request.headers.range, 'bytes=-262144');
        reply.setHeader('content-type', 'text/plain');
        reply.end(result);
      } else {
        reply.setHeader('content-type', 'application/json');
        reply.end(JSON.stringify(result));
      }
    } catch {
      reply.statusCode = 500;
      reply.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { createDashboardManagement } = await import('../src/management.js');
  const run = createDashboardManagement(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'dashboard-test-token');
  return { run, requests };
}

test('定时任务编辑仅作用于选定配置档案，并拒绝覆盖档案或修改只读字段', async (t) => {
  const { run, requests } = await dashboard(t, (method, url, body) => {
    assert.equal(method, 'PUT');
    assert.equal(url, '/api/cron/jobs/job-7?profile=work');
    assert.deepEqual(body, { updates: { name: '晨间任务', skills: ['weather'], skill: null } });
    return { id: 'job-7', name: '晨间任务', enabled: true };
  });
  assert.equal((await run(frame('cron.edit', { id: 'job-7', updates: { name: '晨间任务', skills: ['weather'] } }))).ok, true);
  for (const updates of [{ profile: 'outside' }, { next_run_at: 'now' }]) {
    assert.equal((await run(frame('cron.edit', { id: 'job-7', updates }))).ok, false);
  }
  assert.deepEqual(requests, ['PUT /api/cron/jobs/job-7?profile=work']);
});

test('返回定时任务历史时省略完整会话提示词和模型配置', async (t) => {
  const { run } = await dashboard(t, (_method, url) => {
    assert.equal(url, '/api/cron/jobs/job-7/runs?limit=20&profile=work');
    return { runs: Array.from({ length: 20 }, (_, i) => ({ id: `run-${i}`, title: '每日任务', started_at: 42,
      ended_at: null, is_active: false, system_prompt: 'x'.repeat(50 * 1024), model_config: 'server-only' })), limit: 20 };
  });
  const result = await run(frame('cron.runs', { id: 'job-7' }));
  assert.ok(result.ok);
  const { runs } = result.data as { runs: unknown[] };
  assert.equal(runs.length, 20);
  assert.deepEqual(runs[0], { id: 'run-0', title: '每日任务', started_at: 42, ended_at: null, is_active: false });
});

test('日志请求读取选定配置档案并筛选近期日志', async (t) => {
  const { run, requests } = await dashboard(t, (_method, url) => {
    if (url === '/api/profiles/active') return { active: 'work', current: 'default' };
    if (url === '/api/profiles') return { profiles: [{ name: 'work', path: '/srv/hermes/profiles/work' }] };
    if (url === '/api/config?profile=work') return { logging: { level: 'WARNING' } };
    assert.equal(url, '/api/files/download?path=%2Fsrv%2Fhermes%2Fprofiles%2Fwork%2Flogs%2Ferrors.log');
    return '2026-11-13 12:00:00,010 WARNING gateway.run: Sync 模块响应延迟\n'
      + '2026-11-13 12:00:00,011 ERROR tools.mcp_tool: Sync 模块执行失败\n'
      + '2026-11-13 12:00:00,012 ERROR gateway.run: Sync 模块执行失败\n';
  });
  const result = await run(frame('logs.read', { file: 'errors', level: 'ERROR', component: 'gateway', search: 'SYNC', lines: 50 }));
  assert.ok(result.ok);
  assert.deepEqual(result.data, { file: 'errors', level: 'WARNING', lines: ['2026-11-13 12:00:00,012 ERROR gateway.run: Sync 模块执行失败'] });
  assert.equal(requests.some((path) => path.startsWith('GET /api/logs')), false);
});

test('编辑 MCP 服务器时保留现有凭据和其他服务器', async (t) => {
  const servers = {
    weather: { url: 'https://old.example/mcp', enabled: false, headers: { Authorization: 'Bearer ${WEATHER_KEY}' } },
    local: { command: 'node', args: ['server.js'] },
  };
  const { run } = await dashboard(t, (method, url, body) => {
    if (method === 'GET' && url === '/api/config/raw?profile=work') return { yaml: [
      'http_defaults: &http_defaults', '  enabled: false', '  headers:', '    Authorization: Bearer ${WEATHER_KEY}',
      'mcp_servers:', '  weather:', '    <<: *http_defaults', '    url: https://old.example/mcp', '  local:',
      '    command: node', '    args: [server.js]',
    ].join('\n') };
    assert.equal(url, '/api/mcp/servers?profile=work');
    assert.equal(method, 'PUT');
    assert.deepEqual(body, { servers: { ...servers, weather: { ...servers.weather, url: 'https://new.example/mcp' } } });
    return { ok: true };
  });
  const result = await run(frame('mcp.edit', { name: 'weather', url: 'https://new.example/mcp' }));
  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify(result), /WEATHER_KEY/);
});

test('MCP 列表保留引用原文、遮蔽内联凭据并规范化工具过滤条件', async (t) => {
  const { run } = await dashboard(t, (_method, url) => {
    assert.equal(url, '/api/config/raw?profile=work');
    return { yaml: 'mcp_servers:\n  weather:\n    command: node\n    args: [server.js, --token, "${WEATHER_KEY}", --secret=abcd]\n    tools:\n      include: lookup_*\n' };
  });
  const result = await run(frame('mcp.list'));
  assert.ok(result.ok);
  assert.deepEqual(result.data, { servers: [{ name: 'weather', transport: 'stdio', command: 'node', args: ['server.js', '--token', '${WEATHER_KEY}', '--secret=••••'],
    env_keys: [], enabled: true, tools: { include: ['lookup_*'], exclude: [] }, args_masked: true }] });
});

test('轮换 MCP Bearer 令牌时仅更新选定配置档案下该服务器托管的凭据', async (t) => {
  const { run, requests } = await dashboard(t, (method, url, body) => {
    if (method === 'GET') {
      assert.equal(url, '/api/config/raw?profile=work');
      return { yaml: [
        'mcp_servers:', '  my-weather:', '    url: https://weather.example/mcp',
        '    headers:', '      Authorization: Bearer ${MCP_MY_WEATHER_API_KEY}',
        '  custom:', '    url: https://custom.example/mcp', '    headers:', '      Authorization: Bearer ${CUSTOM_API_KEY}',
      ].join('\n') };
    }
    assert.equal(method, 'PUT');
    assert.equal(url, '/api/env?profile=work');
    assert.deepEqual(body, { key: 'MCP_MY_WEATHER_API_KEY', value: 'replacement-token' });
    return { ok: true, value: body.value };
  });
  const listing = await run(frame('mcp.list'));
  assert.ok(listing.ok);
  const { servers } = listing.data as { servers: { name: string; bearer_managed?: boolean }[] };
  assert.equal(servers.find((row) => row.name === 'my-weather')?.bearer_managed, true);
  assert.equal(servers.find((row) => row.name === 'custom')?.bearer_managed, undefined);
  const foreign = await run(frame('mcp.token', { name: 'custom', bearer_token: 'replacement-token' }));
  assert.ok(!foreign.ok);
  assert.equal(foreign.status, 422);
  const result = await run(frame('mcp.token', { name: 'my-weather', bearer_token: 'Bearer replacement-token' }));
  assert.ok(result.ok);
  assert.deepEqual(result.data, { ok: true });
  assert.equal(requests.filter((path) => path.startsWith('PUT ')).length, 1);
});

test('MCP 连接测试拒绝使用其他运行配置档案的环境变量凭据', async (t) => {
  const { run, requests } = await dashboard(t, (_method, url) => {
    if (url === '/api/config/raw?profile=work') return { yaml: 'mcp_servers:\n  weather:\n    url: https://example.com/mcp\n    headers:\n      Authorization: Bearer ${WEATHER_KEY}\n' };
    if (url === '/api/profiles/active') return { active: 'work', current: 'default' };
    throw new Error('控制台不应执行连接测试');
  });
  const result = await run(frame('mcp.test', { name: 'weather' }));
  assert.ok(!result.ok);
  assert.equal(result.status, 409);
  assert.equal(requests.some((request) => request.startsWith('POST ')), false);
});

test('为默认配置档案安装时要求控制台运行在默认档案且选中默认档案', async (t) => {
  const { run, requests } = await dashboard(t, () => ({ active: 'work', current: 'default' }));
  const result = await run(frame('skill.install', { identifier: 'official/creative/pixel-art' }, 'default'));
  assert.ok(!result.ok);
  assert.equal(result.status, 409);
  assert.deepEqual(requests, ['GET /api/profiles/active']);
});

test('安装回执归属对应配置档案，并提供启动安装的进程状态', async (t) => {
  const action = 'skills-install-official-creative-pixel-art-c9627dec';
  let pid = 42;
  let started = false;
  const { run, requests } = await dashboard(t, (method, url) => {
    if (method === 'POST') {
      assert.equal(url, '/api/skills/hub/install?profile=work');
      started = true;
      return { ok: true, name: action, pid };
    }
    assert.equal(url, `/api/actions/${action}/status?lines=60`);
    return { running: false, pid: started ? pid : 12, exit_code: 0, lines: ['Installed: creative/pixel-art'] };
  });
  const result = await run(frame('skill.install', { identifier: 'official/creative/pixel-art' }));
  assert.ok(result.ok);
  const { name } = result.data as { name: string };
  assert.notEqual(name, action);
  const other = await run(frame('action.status', { name }, 'default'));
  assert.ok(!other.ok);
  assert.equal(other.status, 404);
  const own = await run(frame('action.status', { name }));
  assert.ok(own.ok);
  assert.deepEqual(own.data, { running: false, exit_code: 0 });
  pid += 1;
  const replaced = await run(frame('action.status', { name }));
  assert.ok(replaced.ok);
  assert.deepEqual(replaced.data, { running: false, exit_code: null });
  assert.equal(requests.length, 4);
});

test('模型配置返回现有主模型接口地址，并拒绝缺少接口地址的辅助模型密钥', async (t) => {
  const { run, requests } = await dashboard(t, (_method, url) => {
    if (url === '/api/model/auxiliary?profile=work') return { main: { provider: 'custom', model: 'my-model' }, tasks: [] };
    assert.equal(url, '/api/config/raw?profile=work');
    return { yaml: 'model:\n  provider: custom\n  base_url: https://models.example/v1\n  api_key: ${MODEL_KEY}\n' };
  });
  const result = await run(frame('model.list'));
  assert.ok(result.ok);
  assert.deepEqual(result.data, { main: { provider: 'custom', model: 'my-model', base_url: 'https://models.example/v1' }, tasks: [] });
  const invalid = await run(frame('model.set', { scope: 'auxiliary', task: 'vision', provider: 'openai', model: 'my-model', api_key: 'key' }));
  assert.ok(!invalid.ok);
  assert.equal(invalid.status, 422);
  assert.equal(requests.some((request) => request.startsWith('POST ')), false);
});

test('从 MCP 目录安装时只接受目录条目声明的环境变量', async (t) => {
  const { run, requests } = await dashboard(t, (_method, url) => {
    assert.equal(url, '/api/mcp/catalog?profile=work');
    return { entries: [{ name: 'weather', required_env: [{ name: 'WEATHER_KEY' }] }] };
  });
  const result = await run(frame('mcp.install', { name: 'weather', env: { HERMES_DASHBOARD_SESSION_TOKEN: 'invalid' } }));
  assert.equal(result.ok, false);
  assert.deepEqual(requests, ['GET /api/mcp/catalog?profile=work']);
});

test('模型密钥管理仅返回服务商元数据', async (t) => {
  const { run, requests } = await dashboard(t, (method, url, body) => {
    assert.equal(url, '/api/env?profile=work');
    if (method === 'PUT') {
      assert.deepEqual(body, { key: 'OPENAI_API_KEY', value: 'replacement-key' });
      return { ok: true, value: body.value };
    }
    if (method === 'DELETE') {
      assert.deepEqual(body, { key: 'OPENAI_API_KEY' });
      return { ok: true };
    }
    return {
      OPENAI_API_KEY: { category: 'provider', provider: 'openai', provider_label: 'OpenAI', is_password: true, is_set: true, redacted_value: 'secret-preview' },
      HERMES_DASHBOARD_SESSION_TOKEN: { category: 'custom', is_password: true, is_set: true },
    };
  });
  const listing = await run(frame('model.keys'));
  assert.ok(listing.ok);
  assert.deepEqual(listing.data, [{ key: 'OPENAI_API_KEY', provider: 'openai', label: 'OpenAI', configured: true }]);
  assert.equal((await run(frame('model.key', { key: 'HERMES_DASHBOARD_SESSION_TOKEN', value: 'replacement-key' }))).ok, false);
  const written = await run(frame('model.key', { key: 'OPENAI_API_KEY', value: 'replacement-key' }));
  assert.ok(written.ok);
  assert.doesNotMatch(JSON.stringify(written), /replacement-key/);
  assert.equal((await run(frame('model.key.remove', { key: 'HERMES_DASHBOARD_SESSION_TOKEN' }))).ok, false);
  assert.equal((await run(frame('model.key.remove', { key: 'OPENAI_API_KEY' }))).ok, true);
  assert.equal(requests.filter((request) => request.startsWith('PUT')).length, 1);
  assert.equal(requests.filter((request) => request.startsWith('DELETE')).length, 1);
});
