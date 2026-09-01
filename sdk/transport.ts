/**
 * Low-level WebSocket transport for gdx-edge.
 *
 * Handles connection lifecycle, JSON framing, heartbeat,
 * command serialization, and inbound message dispatch.
 */

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { TimeoutError } from './errors.js';
import { decodeBinaryFrame, encryptedPushToJson } from './wire.js';

export const HEARTBEAT_INTERVAL = 30_000;
export const STALE_TIMEOUT = 60_000;
export const COMMAND_TIMEOUT = 30_000;

/** Optional TLS, proxy-related, and timeout settings for the `ws` client. */
export interface TransportOptions {
  /** Merged into the WebSocket handshake `headers` (with `wsOptions.headers` if present). */
  headers?: Record<string, string>;
  /** Passed to `ws` (e.g. `ca`, `cert`, `key`, `rejectUnauthorized`, `agent`). */
  wsOptions?: WebSocket.ClientOptions;
  commandTimeout?: number;
  heartbeatInterval?: number;
  staleTimeout?: number;
  /**
   * When true (default), send public-docs `{id, op, args}` frames and normalize
   * inbound `{id, op, code, ...}` replies to legacy `type` / `event` shapes.
   */
  useDocsWire?: boolean;
}

function isDocsReply(msg: Record<string, unknown>): boolean {
  if (msg.type !== undefined) return false;
  if (typeof msg.op !== 'string' || typeof msg.code !== 'number') return false;
  return Number.isInteger(msg.code);
}

/** Map gdx-edge docs replies to legacy `type` / `event` frames. */
export function normalizeInboundMessage(
  msg: Record<string, any>,
): Record<string, any> {
  if (!isDocsReply(msg)) return msg;

  const code = msg.code as number;
  const op = String(msg.op ?? '');
  const data = msg.data as Record<string, unknown> | undefined;
  const message = msg.message;
  const errText = typeof message === 'string' ? message : undefined;

  if (op === 'pong' && code === 0) return { type: 'pong' };

  if (op === 'login') {
    if (code !== 0) {
      return {
        type: 'auth_result',
        success: false,
        error: errText ?? 'authentication failed',
      };
    }
    if (data && typeof data === 'object') {
      return {
        type: 'auth_result',
        success: true,
        user_uuid: data.user_uuid,
        account_id: data.account_id,
        session_id: data.session_id,
        token_expires_at: data.token_expires_at,
        cancel_on_disconnect: data.cancel_on_disconnect ?? false,
        conn_id: data.conn_id,
      };
    }
    return { type: 'auth_result', success: false, error: 'invalid auth response' };
  }

  if (op === 'hpke.setup' || op === 'hpke_setup') {
    if (code !== 0) {
      return { type: 'error', message: errText ?? 'HPKE setup failed' };
    }
    if (!data || typeof data !== 'object') {
      return { type: 'error', message: 'invalid HPKE setup response' };
    }
    return {
      type: 'hpke_setup_reply',
      conn_id: data.conn_id,
      message: data.message ?? '',
      established: Boolean(data.established),
    };
  }

  // Legacy ECDH session.setup removed. Ignore if a peer still sends it.
  if (op === 'session.setup' || op === 'session_setup') {
    return {
      type: 'error',
      message: errText ?? 'session.setup is not supported (HPKE required)',
    };
  }

  if (op === 'subscribe' || op === 'unsubscribe') {
    if (code !== 0) {
      const ch =
        data && typeof data === 'object' && 'channel' in data
          ? String((data as { channel?: unknown }).channel ?? '')
          : '';
      return {
        event: 'error',
        message: errText ?? 'channel error',
        channel: ch,
      };
    }
    if (data && typeof data === 'object' && 'channel' in data) {
      return { event: op, channel: (data as { channel: unknown }).channel };
    }
    return { event: op };
  }

  if (op === 'logout') {
    if (code !== 0) {
      return { type: 'error', message: errText ?? 'logout failed' };
    }
    return { type: 'ack', success: true };
  }

  if (op === 'order.place' || op === 'order.cancel' || op === 'order.modify') {
    if (code !== 0) {
      return { type: 'error', message: errText ?? 'order error' };
    }
    if (!data || typeof data !== 'object') {
      return { type: 'error', message: 'invalid order response' };
    }
    if (data.message_type === 'ack') {
      return {
        type: 'encrypted_push',
        message_type: 'ack',
        encrypted_body: String(data.ciphertext ?? data.encrypted_body ?? ''),
        nonce: data.nonce ?? 0,
        fencing_epoch: data.fencing_epoch ?? 0,
        correlation_id: data.correlation_id,
        session_seq: data.session_seq,
        conn_id: data.conn_id,
      };
    }
    return {
      type: 'ack',
      success: data.success !== undefined ? Boolean(data.success) : true,
      order_id: data.order_id,
      sequence: data.sequence,
      error: data.error,
      error_code: data.error_code,
    };
  }

  if (data && typeof data === 'object' && data.event === 'rekey_required') {
    return { type: 'rekey_required', session_id: data.session_id };
  }

  if (
    data &&
    typeof data === 'object' &&
    data.message_type &&
    ('ciphertext' in data || 'encrypted_body' in data)
  ) {
    return {
      type: 'encrypted_push',
      message_type: data.message_type,
      encrypted_body: String(data.ciphertext ?? data.encrypted_body ?? ''),
      nonce: data.nonce ?? 0,
      fencing_epoch: data.fencing_epoch ?? 0,
      correlation_id: data.correlation_id,
      session_seq: data.session_seq,
      conn_id: data.conn_id,
    };
  }

  return msg;
}

/** Merge {@link TransportOptions} into a single `ws` client options object. */
export function mergeWebSocketOptions(
  opts?: TransportOptions,
): WebSocket.ClientOptions | undefined {
  if (!opts) return undefined;
  const merged: WebSocket.ClientOptions = { ...(opts.wsOptions ?? {}) };
  if (opts.headers) {
    const prev = merged.headers as Record<string, string> | undefined;
    merged.headers = { ...(prev ?? {}), ...opts.headers };
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

type MessageHandler = (msg: any) => void;
type DisconnectHandler = () => void;

interface PendingCommand {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

interface PendingSubscription {
  resolve: () => void;
  reject: (reason: any) => void;
  expected: number;
  op: string;
}

interface PendingHpkeSetup {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

export class EdgeTransport {
  private _url: string;
  private _opts?: TransportOptions;
  private _commandTimeoutMs: number;
  private _heartbeatIntervalMs: number;
  private _staleTimeoutMs: number;
  private _ws: WebSocket | null = null;
  private _connected = false;
  private _lastInbound = 0;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private _pendingCmd: PendingCommand | null = null;
  private _cmdQueue: Array<() => void> = [];
  private _cmdBusy = false;

  private _pendingSub: PendingSubscription | null = null;
  private _pendingHpkeSetup: PendingHpkeSetup | null = null;
  private _useDocsWire: boolean;

  onAuthResult: MessageHandler | null = null;
  onOrderUpdate: MessageHandler | null = null;
  onPositionUpdate: MessageHandler | null = null;
  onEncryptedPush: MessageHandler | null = null;
  onPublicMessage: MessageHandler | null = null;
  onHpkeSetupReply: MessageHandler | null = null;
  onRekeyRequired: MessageHandler | null = null;
  onDisconnect: DisconnectHandler | null = null;

  constructor(url: string, opts?: TransportOptions) {
    this._url = url;
    this._opts = opts;
    this._commandTimeoutMs = opts?.commandTimeout ?? COMMAND_TIMEOUT;
    this._heartbeatIntervalMs = opts?.heartbeatInterval ?? HEARTBEAT_INTERVAL;
    this._staleTimeoutMs = opts?.staleTimeout ?? STALE_TIMEOUT;
    this._useDocsWire = opts?.useDocsWire !== false;
  }

  get useDocsWire(): boolean {
    return this._useDocsWire;
  }

  get commandTimeoutMs(): number {
    return this._commandTimeoutMs;
  }

  private newWireId(): string {
    return randomUUID();
  }

  get isConnected(): boolean {
    return this._connected && this._ws !== null;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsOpts = mergeWebSocketOptions(this._opts);
      const ws = wsOpts ? new WebSocket(this._url, wsOpts) : new WebSocket(this._url);

      ws.on('open', () => {
        this._ws = ws;
        this._connected = true;
        this._lastInbound = Date.now();
        this._startHeartbeat();
        this._setupListeners(ws);
        resolve();
      });

      ws.on('error', (err) => {
        if (!this._connected) {
          reject(err);
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this._stopHeartbeat();

    if (this._ws) {
      const ws = this._ws;
      this._ws = null;
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) {
          resolve();
        } else {
          ws.once('close', () => resolve());
          ws.close();
        }
      });
    }

    this._rejectPending('disconnected');
  }

  async sendJson(obj: Record<string, any>): Promise<void> {
    if (!this._ws) {
      throw new Error('Not connected');
    }
    return new Promise((resolve, reject) => {
      this._ws!.send(JSON.stringify(obj), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async sendBinary(bytes: Uint8Array): Promise<void> {
    if (!this._ws) {
      throw new Error('Not connected');
    }
    return new Promise((resolve, reject) => {
      this._ws!.send(Buffer.from(bytes), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  sendHpkeSetup(frame: Uint8Array): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this._ws || !this._connected) {
        reject(new Error('Not connected'));
        return;
      }

      const timer = setTimeout(() => {
        if (this._pendingHpkeSetup) {
          this._pendingHpkeSetup = null;
          reject(
            new TimeoutError(
              `HPKE setup timed out after ${this._commandTimeoutMs}ms`,
            ),
          );
        }
      }, this._commandTimeoutMs);

      this._pendingHpkeSetup = {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };

      this.sendBinary(frame).catch((err) => {
        if (this._pendingHpkeSetup) {
          const pending = this._pendingHpkeSetup;
          this._pendingHpkeSetup = null;
          pending.reject(err);
        }
      });
    });
  }

  sendCommand(payload: Record<string, any>): Promise<any> {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        this._cmdBusy = true;
        if (!this._ws || !this._connected) {
          this._cmdBusy = false;
          this._drainQueue();
          reject(new Error('Not connected'));
          return;
        }

        this._pendingCmd = { resolve: cmdResolve, reject: cmdReject };

        try {
          await this.sendJson(payload);
        } catch (err) {
          this._pendingCmd = null;
          this._cmdBusy = false;
          this._drainQueue();
          reject(err);
          return;
        }

        const timer = setTimeout(() => {
          if (this._pendingCmd) {
            const pending = this._pendingCmd;
            this._pendingCmd = null;
            this._cmdBusy = false;
            this._drainQueue();
            pending.reject(
              new TimeoutError(
                `Command timed out after ${this._commandTimeoutMs}ms`,
              ),
            );
          }
        }, this._commandTimeoutMs);

        function cmdResolve(val: any) {
          clearTimeout(timer);
          resolve(val);
        }

        function cmdReject(err: any) {
          clearTimeout(timer);
          reject(err);
        }
      };

      if (this._cmdBusy) {
        this._cmdQueue.push(execute);
      } else {
        execute();
      }
    });
  }

  sendSubscribe(channels: string[], op = 'subscribe'): Promise<void> {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        this._cmdBusy = true;
        if (!this._ws || !this._connected) {
          this._cmdBusy = false;
          this._drainQueue();
          reject(new Error('Not connected'));
          return;
        }

        this._pendingSub = {
          resolve: subResolve,
          reject: subReject,
          expected: channels.length,
          op,
        };

        try {
          const subMsg: Record<string, unknown> = {
            op,
            args: channels.map((c) => ({ channel: c })),
          };
          if (this._useDocsWire) subMsg.id = this.newWireId();
          await this.sendJson(subMsg as Record<string, any>);
        } catch (err) {
          this._pendingSub = null;
          this._cmdBusy = false;
          this._drainQueue();
          reject(err);
          return;
        }

        const timer = setTimeout(() => {
          if (this._pendingSub) {
            this._pendingSub = null;
            this._cmdBusy = false;
            this._drainQueue();
            reject(new TimeoutError(`${op} timed out`));
          }
        }, this._commandTimeoutMs);

        function subResolve() {
          clearTimeout(timer);
          resolve();
        }

        function subReject(err: any) {
          clearTimeout(timer);
          reject(err);
        }
      };

      if (this._cmdBusy) {
        this._cmdQueue.push(execute);
      } else {
        execute();
      }
    });
  }

  authenticate(apiKey: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const prevHandler = this.onAuthResult;

      const handleAuth = (msg: any) => {
        this.onAuthResult = prevHandler;
        resolve(msg);
      };
      this.onAuthResult = handleAuth;

      const timer = setTimeout(() => {
        this.onAuthResult = prevHandler;
        reject(new TimeoutError('Auth timed out'));
      }, this._commandTimeoutMs);

      const authPayload = this._useDocsWire
        ? { id: this.newWireId(), op: 'login', args: { token: apiKey } }
        : { type: 'auth', data: { token: apiKey } };
      this.sendJson(authPayload).catch((err) => {
        clearTimeout(timer);
        this.onAuthResult = prevHandler;
        reject(err);
      });

      const origResolve = resolve;
      resolve = ((val: any) => {
        clearTimeout(timer);
        origResolve(val);
      }) as any;
    });
  }

  resolveCommand(result: Record<string, any>): boolean {
    if (this._pendingCmd) {
      const pending = this._pendingCmd;
      this._pendingCmd = null;
      this._cmdBusy = false;
      this._drainQueue();
      pending.resolve(result);
      return true;
    }
    return false;
  }

  private _drainQueue(): void {
    if (this._cmdQueue.length > 0) {
      const next = this._cmdQueue.shift()!;
      next();
    }
  }

  private _rejectPending(reason: string): void {
    if (this._pendingCmd) {
      const pending = this._pendingCmd;
      this._pendingCmd = null;
      this._cmdBusy = false;
      pending.reject(new Error(reason));
    }
    if (this._pendingSub) {
      const pending = this._pendingSub;
      this._pendingSub = null;
      pending.reject(new Error(reason));
    }
    if (this._pendingHpkeSetup) {
      const pending = this._pendingHpkeSetup;
      this._pendingHpkeSetup = null;
      pending.reject(new Error(reason));
    }
    this._cmdQueue = [];
  }

  private _dispatchBinary(data: Buffer): void {
    try {
      const decoded = decodeBinaryFrame(data);
      switch (decoded.kind) {
        case 'hpke_setup_reply': {
          const msg = {
            type: 'hpke_setup_reply',
            conn_id: decoded.connId,
            established: decoded.established,
          };
          this.onHpkeSetupReply?.(msg);
          if (this._pendingHpkeSetup) {
            const pending = this._pendingHpkeSetup;
            this._pendingHpkeSetup = null;
            pending.resolve(msg);
          }
          return;
        }
        case 'encrypted_push': {
          const msg = encryptedPushToJson(decoded.value);
          if (msg) this.onEncryptedPush?.(msg);
          return;
        }
        default:
          return;
      }
    } catch {
      // ignore malformed binary frames
    }
  }

  private _setupListeners(ws: WebSocket): void {
    ws.on('message', (data: WebSocket.Data) => {
      this._lastInbound = Date.now();
      const buf = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);
      // `ws` delivers both text and binary as Buffer; protobuf frames are never JSON.
      if (buf.length > 0 && buf[0] !== 0x7b) {
        this._dispatchBinary(buf);
        return;
      }
      try {
        const msg = normalizeInboundMessage(JSON.parse(buf.toString()));
        this._dispatch(msg);
      } catch {
        // ignore non-JSON
      }
    });

    ws.on('close', () => {
      const wasConnected = this._connected;
      this._connected = false;
      this._rejectPending('connection lost');
      if (wasConnected && this.onDisconnect) {
        try {
          this.onDisconnect();
        } catch {
          /* noop */
        }
      }
    });

    ws.on('error', () => {
      // close event handles cleanup
    });
  }

  private _dispatch(msg: Record<string, any>): void {
    const msgType = msg.type as string | undefined;
    const event = msg.event as string | undefined;

    if (msgType === 'pong') return;

    if (msgType === 'auth_result') {
      this.onAuthResult?.(msg);
      return;
    }

    if (msgType === 'hpke_setup_reply') {
      this.onHpkeSetupReply?.(msg);
      if (this._pendingHpkeSetup) {
        const pending = this._pendingHpkeSetup;
        this._pendingHpkeSetup = null;
        pending.resolve(msg);
      }
      return;
    }

    if (msgType === 'rekey_required') {
      this.onRekeyRequired?.(msg);
      return;
    }

    if (msgType === 'order_update') {
      this.onOrderUpdate?.(msg);
      return;
    }

    if (msgType === 'position_update') {
      this.onPositionUpdate?.(msg);
      return;
    }

    if (msgType === 'encrypted_push') {
      this.onEncryptedPush?.(msg);
      return;
    }

    if (
      msgType === 'funding_rate_snapshot' ||
      msgType === 'volume_snapshot' ||
      msgType === 'open_interest_snapshot'
    ) {
      this.onPublicMessage?.(msg);
      return;
    }

    if (event === 'subscribe' || event === 'unsubscribe') {
      if (this._pendingSub && event === this._pendingSub.op) {
        this._pendingSub.expected -= 1;
        if (this._pendingSub.expected <= 0) {
          const pending = this._pendingSub;
          this._pendingSub = null;
          this._cmdBusy = false;
          this._drainQueue();
          pending.resolve();
        }
      }
      return;
    }

    if (event === 'error') {
      if (this._pendingSub) {
        const pending = this._pendingSub;
        this._pendingSub = null;
        this._cmdBusy = false;
        this._drainQueue();
        pending.reject(new Error(msg.message ?? 'channel error'));
      }
      return;
    }

    if (msgType === 'ack') {
      if (this._pendingCmd) {
        const pending = this._pendingCmd;
        this._pendingCmd = null;
        this._cmdBusy = false;
        this._drainQueue();
        pending.resolve(msg);
      }
      return;
    }

    if (msgType === 'error') {
      if (this._pendingCmd) {
        const pending = this._pendingCmd;
        this._pendingCmd = null;
        this._cmdBusy = false;
        this._drainQueue();
        pending.resolve(msg);
      }
      return;
    }
  }

  private _startHeartbeat(): void {
    this._heartbeatTimer = setInterval(() => {
      if (!this._connected) {
        this._stopHeartbeat();
        return;
      }
      const elapsed = Date.now() - this._lastInbound;
      if (elapsed > this._staleTimeoutMs) {
        this._ws?.close(4000, 'heartbeat timeout');
        this._stopHeartbeat();
        return;
      }
      const pingPayload = this._useDocsWire
        ? { id: this.newWireId(), op: 'ping', args: {} }
        : { type: 'ping' };
      this.sendJson(pingPayload).catch(() => {
        // connection will close on its own
      });
    }, this._heartbeatIntervalMs);
  }

  private _stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }
}
