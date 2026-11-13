import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { parseCanonicalJson } from '@hermes-mobile/hermes-adapter';

const exec = promisify(execFile);
const protocol = 'hermes-gateway-v1';
const requestTimeout = 30_000;

export type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

export function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export class GatewayRefusal extends Error {
  constructor(readonly code: number, readonly reason: string | undefined) {
    super('Hermes rejected the request');
  }
}

type Pending = {
  resolve: (result: JsonObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Identity = {
  profileId: string;
  instanceId: string;
  authorityEpoch: string;
};

function identity(value: JsonObject | undefined): Identity | undefined {
  const profileId = string(value?.profile_id);
  const instanceId = string(value?.instance_id);
  const rawEpoch = value?.authority_epoch;
  const authorityEpoch = typeof rawEpoch === 'bigint' && rawEpoch >= 0n
    ? String(rawEpoch) : integer(rawEpoch)?.toString();
  if (profileId && instanceId && authorityEpoch !== undefined) {
    return { profileId, instanceId, authorityEpoch };
  }
}

export type GatewayConfig = { binary: string; profile: string };

export class Gateway {
  clarifyBatch = false;
  readonly #pending = new Map<string, Pending>();
  readonly ready: Promise<JsonObject>;
  #ping: ReturnType<typeof setInterval> | undefined;

  private constructor(
    readonly socket: WebSocket,
    readonly identity: Identity,
    onFrame: (frame: JsonObject, bytes: number) => void,
    onClose: () => void,
  ) {
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Hermes gateway ready timed out'));
        socket.terminate();
      }, requestTimeout);
      socket.once('close', () => {
        clearTimeout(timeout);
        reject(new Error('Hermes gateway disconnected'));
      });
      socket.on('error', () => socket.terminate());
      socket.on('message', (raw, binary) => {
        try {
          if (binary) throw new Error('Invalid binary Hermes frame');
          const source = raw.toString();
          const frame = object(parseCanonicalJson(source));
          if (!frame || frame.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC envelope');
          const params = object(frame.params);
          if (frame.method === 'event' && params?.type === 'gateway.ready') {
            clearTimeout(timeout);
            const payload = object(params.payload);
            if (socket.protocol !== protocol || payload?.session_authority !== true) {
              reject(new Error('Hermes canonical session authority is unavailable'));
              socket.terminate();
              return;
            }
            resolve(payload);
            return;
          }
          const pending = typeof frame.id === 'string' ? this.#pending.get(frame.id) : undefined;
          if (pending && !frame.method) {
            clearTimeout(pending.timer);
            this.#pending.delete(frame.id as string);
            const error = object(frame.error);
            const result = object(frame.result);
            if (typeof error?.code === 'number') {
              pending.reject(new GatewayRefusal(error.code, string(object(error.data)?.reason)));
            } else if (result) {
              pending.resolve(result);
            } else {
              pending.reject(new Error('Invalid Hermes RPC reply'));
            }
            return;
          }
          if (typeof frame.method === 'string') onFrame(frame, Buffer.byteLength(source));
        } catch {
          socket.terminate();
        }
      });
    });
    socket.once('close', () => {
      clearInterval(this.#ping);
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Hermes gateway disconnected'));
      }
      this.#pending.clear();
      onClose();
    });
  }

  static async connect(
    config: GatewayConfig,
    onFrame: (frame: JsonObject, bytes: number) => void,
    onClose: () => void,
  ): Promise<Gateway> {
    let receipt: JsonObject | undefined;
    try {
      const env = { ...process.env };
      delete env.CONNECTOR_TOKEN;
      const { stdout } = await exec(config.binary, ['--profile', config.profile, 'gateway', 'attach', '--json'], {
        env,
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      });
      receipt = object(parseCanonicalJson(stdout));
    } catch {
      throw new Error('Local Hermes gateway attach failed');
    }
    const endpoint = object(receipt?.endpoint);
    const owner = identity(endpoint);
    const address = string(receipt?.url);
    const ticket = string(receipt?.ticket);
    if (!owner || !address || !ticket || receipt?.protocol !== protocol ||
      !Array.isArray(receipt.protocols) || receipt.protocols.length !== 2 ||
      receipt.protocols[0] !== protocol || receipt.protocols[1] !== `hermes-gateway-ticket.${ticket}`) {
      throw new Error('Hermes gateway attach returned an incompatible receipt');
    }
    const url = new URL(address);
    if (!['ws:', 'wss:'].includes(url.protocol) ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/api/ws' || url.search || url.hash) {
      throw new Error('Hermes gateway attach did not return a local socket');
    }
    const socket = new WebSocket(url, receipt.protocols, {
      handshakeTimeout: 10_000,
      maxPayload: 16 * 1024 * 1024,
      perMessageDeflate: false,
    });
    const gateway = new Gateway(socket, owner, onFrame, onClose);
    try {
      await gateway.ready;
      const description = await gateway.rpc('runtime.describe', {});
      const described = identity(description);
      const create = object(description.session_create);
      if (described?.profileId !== owner.profileId || described.instanceId !== owner.instanceId ||
        described.authorityEpoch !== owner.authorityEpoch || !Array.isArray(description.capabilities) ||
        !['durable-admission-v1', 'event-replay-v1'].every((item) => description.capabilities instanceof Array &&
          description.capabilities.includes(item)) ||
        !Array.isArray(create?.sources) || !create.sources.includes('tool') ||
        !Array.isArray(create.parameters) || !create.parameters.includes('source') || !create.parameters.includes('request_id')) {
        throw new Error('Hermes runtime identity or capabilities differ from the required session protocol');
      }
      const capabilities = await gateway.rpc('client.capabilities', { server_requests: true });
      if (!Array.isArray(capabilities.server_requests)) {
        throw new Error('Hermes did not negotiate server requests');
      }
      gateway.clarifyBatch = capabilities.canonical_clarify_batch === true && capabilities.server_requests.includes('clarify');
      gateway.#keepAlive();
      return gateway;
    } catch (error) {
      socket.terminate();
      throw error;
    }
  }

  #keepAlive(): void {
    let alive = true;
    this.socket.on('pong', () => { alive = true; });
    this.#ping = setInterval(() => {
      if (!alive) {
        this.socket.terminate();
        return;
      }
      alive = false;
      if (this.connected) this.socket.ping();
    }, 20_000);
  }

  get connected(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  send(frame: JsonObject): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('Hermes gateway is offline'));
        return;
      }
      this.socket.send(JSON.stringify(frame), (error) => error ? reject(error) : resolve());
    });
  }

  rpc(method: string, params: JsonObject, id = randomUUID() as string): Promise<JsonObject> {
    return new Promise((resolve, reject) => {
      if (this.#pending.has(id)) {
        reject(new Error('Hermes RPC is already pending'));
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('Hermes RPC timed out'));
      }, requestTimeout);
      this.#pending.set(id, { resolve, reject, timer });
      void this.send({ jsonrpc: '2.0', id, method, params }).catch((error: unknown) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  close(): void {
    this.socket.terminate();
  }
}
