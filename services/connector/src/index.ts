import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import type { Command, TopicQuery, TopicQueryData, TopicQueryResult } from '@hermes-mobile/protocol';
import { attachmentDownloader } from './attachments.js';
import { CanonicalConnector } from './connector.js';
import { createDeliverySpool } from './delivery.js';
import type { JsonObject } from './gateway.js';
import { createHttpConnector } from './http-mode.js';
import { createDashboardManagement } from './management.js';
import { Spool } from './spool.js';
import { QueryUnavailable } from './topic-query.js';
import { bridgeFrame, result } from './wire.js';

type Mode = {
  command(command: Command, current: () => boolean): Promise<void>;
  query(query: TopicQuery): Promise<TopicQueryData>;
  close(): void;
};

function bridgeUrl(input: string | undefined): URL {
  if (!input) throw new Error('请设置 BFF_URL');
  const url = new URL(input);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && url.protocol !== 'wss:' &&
    !(local && ['http:', 'ws:'].includes(url.protocol))) {
    throw new Error('BFF_URL 使用非回环地址时必须采用 HTTPS 或 WSS');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('BFF_URL 无效');
  return new URL('/internal/connector/v1/events', url.href.replace(/^http/u, 'ws'));
}

async function main(): Promise<void> {
  const url = bridgeUrl(process.env.BFF_URL);
  const token = process.env.CONNECTOR_TOKEN;
  if (!token?.trim() || /[\r\n]/u.test(token)) throw new Error('请设置有效的 CONNECTOR_TOKEN');
  const httpUrl = process.env.HERMES_API_URL;
  const httpKey = process.env.HERMES_API_KEY;
  if (httpUrl && !httpKey?.trim()) throw new Error('设置 HERMES_API_URL 时需要同时设置 HERMES_API_KEY');
  const dashboardUrl = process.env.HERMES_DASHBOARD_URL;
  const dashboardToken = process.env.HERMES_DASHBOARD_SESSION_TOKEN;
  const manage = dashboardUrl ? createDashboardManagement(dashboardUrl, dashboardToken ?? '') : undefined;
  const path = process.env.CONNECTOR_DB_PATH ?? join(homedir(), '.hermes-mobile', 'connector.sqlite');
  const spool = new Spool(path);
  const deliveryPath = process.env.HERMES_MOBILE_SPOOL_PATH;
  const delivery = deliveryPath ? createDeliverySpool(deliveryPath) : undefined;
  let socket: WebSocket | undefined;
  const shutdown = new AbortController();
  let serial = Promise.resolve();
  const titleTasks = new Set<Promise<void>>();
  let flush: () => void = () => {};
  const stop = () => {
    shutdown.abort();
    socket?.terminate();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const downloadAttachment = attachmentDownloader(url, token, shutdown.signal);
  const mode: Mode = httpUrl && httpKey ? createHttpConnector({
    url: httpUrl, token: httpKey, spool, send: () => flush(), downloadAttachment,
  }) : new CanonicalConnector(process.env.HERMES_BIN ?? 'hermes', spool, () => socket?.terminate(), downloadAttachment);
  for (const id of spool.unfinished()) {
    spool.finish(id, { ...result(id, 'unknown', { error: 'Hermes 无法确认执行结果' }) });
  }

  try {
    let wait = 1_000;
    while (!shutdown.signal.aborted) {
      const started = Date.now();
      const peer = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}`, 'X-Hermes-Mobile-Topic-Query': '1', 'X-Hermes-Mobile-Reasoning': '1',
          'X-Hermes-Mobile-Topic-Title': '1', 'X-Hermes-Mobile-Attachments': '1',
          ...(manage && { 'X-Hermes-Mobile-Management': '1' }) },
        handshakeTimeout: 10_000, maxPayload: 1024 * 1024, perMessageDeflate: false,
      });
      socket = peer;
      const current = () => !shutdown.signal.aborted && socket === peer && peer.readyState === WebSocket.OPEN;
      const resultIds = new Set<string>();
      const eventIds = new Set<string>();
      const deliveryIds = new Set<string>();
      const assigned = new Set<string>();
      const awaitingCreateAck = new Map<string, string>();
      let polling = false;
      let queued = 0;
      let querying = 0;
      let managementPending = 0;
      let alive = true;
      function send(frame: JsonObject): boolean {
        if (!current() || peer.bufferedAmount > 1024 * 1024) return false;
        peer.send(JSON.stringify(frame), (error) => { if (error) peer.terminate(); });
        return true;
      }
      flush = () => {
        if (!current()) return;
        try {
          for (const { id, body } of spool.results(resultIds, 64 - resultIds.size - eventIds.size)) {
            if (!send(body)) return;
            resultIds.add(id);
            if (body.status === 'ok' && typeof body.session_id === 'string'
              && spool.binding(id)?.sessionId === body.session_id) awaitingCreateAck.set(id, id);
          }
          const available = 64 - resultIds.size - eventIds.size;
          if (available <= 0 || assigned.size === 0) return;
          for (const { id, body } of spool.events(assigned, eventIds, available)) {
            if (!send(body)) return;
            eventIds.add(id);
          }
        } catch {
          peer.terminate();
        }
      };
      const relay = async () => {
        if (!delivery || !current() || polling) return;
        polling = true;
        try {
          for (const frame of await delivery.pull()) {
            if (!deliveryIds.has(frame.event_id) && send({ ...frame })) deliveryIds.add(frame.event_id);
          }
        } catch {
          process.stderr.write('连接器无法读取本地投递队列\n');
        } finally {
          polling = false;
        }
      };
      const pump = setInterval(flush, 100);
      const poll = setInterval(() => { void relay(); }, 2_000);
      const heartbeat = setInterval(() => {
        if (!current()) return;
        if (!alive) {
          peer.terminate();
          return;
        }
        alive = false;
        peer.ping();
      }, 25_000);
      peer.on('pong', () => { alive = true; });
      peer.on('error', () => peer.terminate());
      peer.on('open', () => {
        process.stdout.write('Hermes 连接器已连接 BFF\n');
        flush();
        void relay();
      });
      peer.on('message', (raw, binary) => {
        if (binary) {
          peer.terminate();
          return;
        }
        let frame;
        try {
          frame = bridgeFrame(raw.toString());
        } catch {
          peer.terminate();
          return;
        }
        if (frame.type === 'ack') {
          const { id } = frame;
          if (resultIds.delete(id) || eventIds.delete(id)) {
            try {
              spool.ack(id);
            } catch {
              peer.terminate();
              return;
            }
            const topicId = awaitingCreateAck.get(id);
            if (topicId) {
              awaitingCreateAck.delete(id);
              assigned.add(topicId);
            }
            flush();
          }
          if (delivery && deliveryIds.has(id)) {
            void delivery.ack(id).then(() => deliveryIds.delete(id), () => peer.terminate());
          }
          return;
        }
        if (frame.type === 'topic_query') {
          const base = { type: 'topic_query_result' as const, request_id: frame.request_id };
          if (querying >= 8) {
            send({ ...base, error: 'failed' } satisfies TopicQueryResult);
            return;
          }
          querying += 1;
          void mode.query(frame).then((data) => {
            const response: TopicQueryResult = { ...base, data };
            send(Buffer.byteLength(JSON.stringify(response)) <= 1024 * 1024
              ? response : { ...base, error: 'too_large' });
          }, (error: unknown) => {
            send({ ...base, error: error instanceof QueryUnavailable ? 'unavailable' : 'failed' } satisfies TopicQueryResult);
          }).finally(() => { querying -= 1; });
          return;
        }
        if (frame.type === 'management_request') {
          if (!manage || managementPending >= 16) {
            send({ type: 'management_result', request_id: frame.request_id, ok: false,
              status: manage ? 429 : 503, message: manage ? 'Hermes 正在处理其他管理请求，请稍后重试。' : '请在 Hermes 连接器中配置 Hermes 控制台。' });
            return;
          }
          managementPending += 1;
          void manage(frame).then((reply) => { send(reply); }).catch(() => peer.terminate()).finally(() => { managementPending -= 1; });
          return;
        }
        if (frame.kind === 'summarize_title') {
          const task = mode.command(frame, current).then(flush, () => peer.terminate())
            .finally(() => { titleTasks.delete(task); });
          titleTasks.add(task);
          return;
        }
        if (queued >= 256) {
          peer.terminate();
          return;
        }
        if (frame.kind === 'watch') {
          const binding = spool.binding(frame.topic_id);
          if (binding?.profileRef === frame.profile_ref && binding.sessionId === frame.session_id) assigned.add(frame.topic_id);
        }
        queued += 1;
        serial = serial.then(async () => {
          if (current()) {
            await mode.command(frame, current);
            flush();
          }
        }).catch(() => {
          process.stderr.write('连接器无法处理 Hermes 命令，正在重新连接\n');
          peer.terminate();
        }).finally(() => { queued -= 1; });
      });
      await new Promise<void>((resolve) => peer.once('close', () => resolve()));
      clearInterval(pump);
      clearInterval(poll);
      clearInterval(heartbeat);
      socket = undefined;
      flush = () => {};
      if (!shutdown.signal.aborted) {
        wait = Date.now() - started > 30_000 ? 1_000 : Math.min(15_000, wait * 2);
        await delay(wait, undefined, { signal: shutdown.signal }).catch(() => {});
      }
    }
  } finally {
    mode.close();
    await Promise.all([serial, ...titleTasks]);
    spool.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

void main().catch(() => {
  process.stderr.write('连接器启动失败。请检查 BFF_URL、CONNECTOR_TOKEN、本地队列路径以及 Hermes 和控制台配置。\n');
  process.exitCode = 1;
});
