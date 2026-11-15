import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import * as attachments from '../src/attachments.js';

test('最终文件通过固定 Webapp 端点交付并稳定重试，不向输出 URL 发送凭据', async (t) => {
  assert.equal(typeof attachments.attachmentReceiver, 'function');
  const downloads: string[] = [];
  const uploads: { path: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/api/files/download') {
      assert.equal(req.headers.authorization, 'Bearer webapp-key');
      assert.equal(url.searchParams.get('profile'), 'default');
      const path = url.searchParams.get('path')!;
      downloads.push(path);
      if (path === '/image.PNG' && uploads.length === 1) { res.writeHead(404).end(); return; }
      if (path === '/retry.txt' && downloads.filter((item) => item === path).length === 1) { res.writeHead(503).end(); return; }
      if (path === '/missing.txt') { res.writeHead(404).end(); return; }
      if (path === '/redirect.txt') { res.writeHead(302, { location: '/leak' }).end(); return; }
      if (path === '/large.mp4') { res.writeHead(200, { 'content-length': 60 * 1024 * 1024 }).end(); return; }
      res.setHeader('content-type', 'application/octet-stream');
      res.end('abc');
      return;
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/internal/attachments/v1/')) {
      assert.equal(req.headers.authorization, 'Bearer bff-key');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      uploads.push({ path: url.pathname, body });
      if (uploads.length === 1) { res.writeHead(503).end(); return; }
      if (body.name === 'retry.txt' && uploads.filter((item) => item.body.name === body.name).length === 1) {
        res.writeHead(503).end(); return;
      }
      const { name, mime, size } = body;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { attachment_id: url.pathname.split('/').at(-1), name, mime: name === 'canonical' ? 'image/png' : mime, size } }));
      return;
    }
    assert.fail('非固定端点收到请求：' + req.url);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const receive = attachments.attachmentReceiver(new URL(origin), 'bff-key',
    { origin, token: 'webapp-key' }, new AbortController().signal);
  const source = 'MEDIA:/image.PNG\n[语音](/voice.mp3)\n[视频](file:///movie.mp4)\n[报告](</report one.md>)\n[页面](/page.html)';
  const first = await receive('default', 'topic', 'message', source);
  assert.equal(first.text, '');
  assert.deepEqual(first.attachments?.map(({ name, mime, size }) => ({ name, mime, size })), [
    { name: 'image.PNG', mime: 'image/png', size: 3 }, { name: 'voice.mp3', mime: 'audio/mpeg', size: 3 },
    { name: 'movie.mp4', mime: 'video/mp4', size: 3 }, { name: 'report one.md', mime: 'text/markdown', size: 3 },
    { name: 'page.html', mime: 'text/html', size: 3 },
  ]);
  assert.equal(uploads[0].path, uploads[1].path);
  assert.deepEqual(uploads[0].body, uploads[1].body);
  assert.equal(uploads[0].body.content_base64, 'YWJj');
  assert.equal(downloads.filter((path) => path === '/image.PNG').length, 1);
  assert.deepEqual(await receive('default', 'topic', 'message', source), first);
  const before = downloads.length;
  const external = 'MEDIA:https://attacker.example/image.png\n[外部](https://attacker.example/page.html)';
  assert.equal((await receive('default', 'topic', 'remote', external)).text, external);
  assert.equal(downloads.length, before);
  assert.equal((await receive('default', 'topic', 'plain', '  普通回复\n')).text, '  普通回复\n');
  const example = '```text\nMEDIA:/image.PNG\n[报告](/report.md)\n```\n`[报告](/report.md)`\n> MEDIA:/image.PNG';
  const illustrated = await receive('default', 'topic', 'example', example + '\nMEDIA:`/image.PNG`');
  assert.equal(illustrated.text, example);
  assert.deepEqual(illustrated.attachments?.map(({ name }) => name), ['image.PNG']);
  const retry = await receive('default', 'topic', 'retry', 'MEDIA:/retry.txt');
  assert.equal(retry.text, '');
  assert.equal(retry.attachments?.length, 1);
  assert.equal(downloads.filter((path) => path === '/retry.txt').length, 2);
  assert.equal(uploads.filter(({ body }) => body.name === 'retry.txt').length, 2);
  const canonical = await receive('default', 'topic', 'canonical', 'MEDIA:/canonical');
  assert.equal(canonical.text, '');
  assert.equal(canonical.attachments?.[0].mime, 'image/png');
  const many = Array.from({ length: 11 }, (_, index) => `MEDIA:/file-${index}.txt`).join('\n');
  const limited = await receive('default', 'topic', 'limited', many);
  assert.equal(limited.attachments?.length, 10);
  assert.match(limited.text, /MEDIA:\/file-10.txt/);
  assert.match(limited.text, /附件.*失败/);
  const failed = await receive('default', 'topic', 'failed', 'MEDIA:/missing.txt\nMEDIA:/redirect.txt\nMEDIA:/large.mp4');
  assert.match(failed.text, /MEDIA:\/missing.txt/);
  assert.match(failed.text, /附件.*失败/);
  assert.equal(failed.attachments?.length ?? 0, 0);
});

test('代码和引用中的文件示例保留原文，MEDIA 路径支持反引号', async () => {
  const receive = attachments.attachmentReceiver(new URL('http://127.0.0.1:1'), 'key', undefined, new AbortController().signal);
  for (const source of ['```text\nMEDIA:/chart.png\n```', '~~~text\n[报告](/report.md)\n~~~',
    '`MEDIA:/chart.png`', '`[报告](/report.md)`', '> MEDIA:/chart.png', '  > [报告](/report.md)']) {
    assert.equal(attachments.hasReceivedAttachments(source), false, source);
    assert.deepEqual(await receive('default', 'topic', 'example', source), { text: source });
  }
  assert.equal(attachments.hasReceivedAttachments('MEDIA:`/tmp/chart.png`'), true);
});

test('未配置 Webapp 时保留未交付引用并给出错误', async () => {
  assert.equal(typeof attachments.attachmentReceiver, 'function');
  const receive = attachments.attachmentReceiver(new URL('http://127.0.0.1:1'), 'key', undefined, new AbortController().signal);
  const source = 'MEDIA:/report.md';
  const result = await receive('default', 'topic', 'message', source);
  assert.match(result.text, /MEDIA:\/report.md/);
  assert.match(result.text, /附件.*失败/);
  const long = await receive('default', 'topic', 'long', source + '\n' + 'x'.repeat(256 * 1024));
  assert(Buffer.byteLength(long.text) <= 256 * 1024);
  assert.match(long.text, /MEDIA:\/report.md/);
  assert.match(long.text, /附件.*失败/);
});
