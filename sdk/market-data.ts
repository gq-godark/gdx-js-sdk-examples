/**
 * Market data WebSocket client for public edge feeds.
 *
 * Default URL is the canonical trading path `/ws/v1` (docs wire). Set
 * `GODARK_MARKET_DATA_USE_GOMARKET=1` for the legacy `/ws/gomarket` multiplex,
 * or `GODARK_MARKET_DATA_WS_URL` for a full override.
 */

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { wsUrl } from './client.js';
import {
  mergeWebSocketOptions,
  type TransportOptions,
} from './transport.js';

const ORDERBOOK_DOCS_WIRE_MSG =
  'L2 orderbook is not available on /ws/v1; set GODARK_MARKET_DATA_WS_URL to a direct L2 ' +
  'stream URL, use subscribePublicChannel for public edge feeds, or ' +
  'GODARK_MARKET_DATA_USE_GOMARKET=1 for local /ws/gomarket';

/** True when the resolved URL is the public-docs `/ws/v1` path (ignores trailing slash / query). */
export function isDocsWireUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/\/+$/, '').endsWith('/ws/v1');
  } catch {
    const path = url.split('#')[0].split('?')[0].replace(/\/+$/, '');
    return path.endsWith('/ws/v1');
  }
}

function envFirst(...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = process.env[key]?.trim();
    if (v) return v;
  }
  return undefined;
}

function envTruthy(...keys: string[]): boolean {
  for (const key of keys) {
    const raw = process.env[key]?.trim().toLowerCase();
    if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
      return true;
    }
  }
  return false;
}

/** Strip edge `/ws` suffixes and append `/ws/gomarket` (WebSocket scheme). */
export function gomarketWsUrl(baseUrl: string): string {
  let url = baseUrl.replace(/\/+$/, '');
  if (url.endsWith('/ws/v1')) {
    url = url.slice(0, -'/ws/v1'.length);
  } else if (url.endsWith('/ws')) {
    url = url.slice(0, -'/ws'.length);
  }
  if (url.startsWith('http://')) {
    url = 'ws://' + url.slice('http://'.length);
  } else if (url.startsWith('https://')) {
    url = 'wss://' + url.slice('https://'.length);
  }
  return url + '/ws/gomarket';
}

/**
 * Resolve the market-data WebSocket URL.
 * Hosted edges default to `/ws/v1`. Override with `GODARK_MARKET_DATA_WS_URL`,
 * or set `GODARK_MARKET_DATA_USE_GOMARKET=1` for `/ws/gomarket`.
 */
export function resolveMarketDataWsUrl(baseUrl: string): string {
  const override = envFirst('GODARK_MARKET_DATA_WS_URL', 'GDX_MARKET_DATA_WS_URL');
  if (override) return override;
  if (envTruthy('GODARK_MARKET_DATA_USE_GOMARKET', 'GDX_MARKET_DATA_USE_GOMARKET')) {
    return gomarketWsUrl(baseUrl.trim());
  }
  return wsUrl(baseUrl.trim());
}

/**
 * Map a market-data server message to the callback key `channel:symbol`.
 * Data events use `type` `orderbook` or `trade` (singular); callbacks use `trades` for the latter.
 */
export function subscriptionCallbackKey(msg: Record<string, unknown>): string | null {
  const typ = msg.type as string | undefined;
  if (
    typ === 'status' ||
    typ === 'subscribed' ||
    typ === 'unsubscribed' ||
    typ === 'pong' ||
    typ === 'error'
  ) {
    return null;
  }
  const symbol = (msg.symbol as string) || '';
  if (typ === 'orderbook') {
    return `orderbook:${symbol}`;
  }
  if (typ === 'trade') {
    return `trades:${symbol}`;
  }
  if (typ === 'volume_snapshot') {
    return 'volume:';
  }
  if (typ === 'open_interest_snapshot') {
    return 'open_interest:';
  }
  if (typ === 'funding_rate_snapshot') {
    return 'funding_rate:';
  }
  const channel = (msg.channel as string) || '';
  if (channel) {
    return `${channel}:${symbol}`;
  }
  return null;
}

export class MarketDataClient {
  static readonly HEARTBEAT_INTERVAL = 30_000;

  private _url: string;
  private _docsWire: boolean;
  private _transportOptions: TransportOptions | undefined;
  private _ws: WebSocket | null = null;
  private _connected = false;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _callbacks = new Map<string, (data: any) => void | Promise<void>>();
  private _autoReconnect = true;
  /** Keys are `channel:symbol` or `public\\0channel` for public edge feeds. */
  private _desiredSubs = new Set<string>();

  /**
   * @param baseUrl Edge base URL (with or without a trailing `/ws` or `/ws/v1` suffix).
   * @param transportOptions Optional `ws` client options (TLS, headers, proxy `agent`, etc.).
   */
  constructor(baseUrl: string, transportOptions?: TransportOptions) {
    this._url = resolveMarketDataWsUrl(baseUrl.trim());
    this._docsWire = isDocsWireUrl(this._url);
    this._transportOptions = transportOptions;
  }

  /** Resolved WebSocket URL this client will dial. */
  get url(): string {
    return this._url;
  }

  get isConnected(): boolean {
    return this._connected && this._ws !== null;
  }

  async connect(): Promise<void> {
    this._stopHeartbeat();
    if (this._ws) {
      this._ws.removeAllListeners();
      try { this._ws.close(); } catch { /* ignore */ }
      this._ws = null;
    }

    return new Promise<void>((resolve, reject) => {
      const wsOpts = mergeWebSocketOptions(this._transportOptions);
      const ws = wsOpts
        ? new WebSocket(this._url, wsOpts)
        : new WebSocket(this._url);

      ws.on('open', () => {
        this._ws = ws;
        this._connected = true;
        this._startRecvLoop();
        this._startHeartbeat();
        void this._resubscribeAll().then(() => resolve());
      });

      ws.on('error', (err) => {
        if (!this._connected) {
          reject(err);
        }
      });

      ws.on('close', () => {
        this._connected = false;
        this._stopHeartbeat();
        if (this._autoReconnect && this._ws === ws) {
          this._ws = null;
          this._reconnect();
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this._autoReconnect = false;
    this._stopHeartbeat();
    if (this._ws) {
      const ws = this._ws;
      this._ws = null;
      ws.removeAllListeners();
      try { ws.close(); } catch { /* ignore */ }
    }
  }

  async subscribeOrderbook(
    symbol: string,
    callback: (data: any) => void | Promise<void>,
  ): Promise<void> {
    if (this._docsWire) {
      throw new Error(ORDERBOOK_DOCS_WIRE_MSG);
    }
    await this._subscribe('orderbook', symbol, callback);
  }

  async subscribeTrades(
    symbol: string,
    callback: (data: any) => void | Promise<void>,
  ): Promise<void> {
    await this._subscribe('trades', symbol, callback);
  }

  /**
   * Public edge channel on `/ws/v1` (no auth): `volume`, `open_interest`, `funding_rate`.
   */
  async subscribePublicChannel(
    channel: string,
    callback: (data: any) => void | Promise<void>,
  ): Promise<void> {
    if (!channel) {
      throw new Error('channel is required');
    }
    if (!this._docsWire) {
      throw new Error('subscribePublicChannel requires /ws/v1 edge URL');
    }
    const key = `${channel}:`;
    this._callbacks.set(key, callback);
    this._desiredSubs.add(`public\0${channel}`);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._sendPublicSubscribe(channel);
    }
  }

  async unsubscribe(channel: string, symbol: string): Promise<void> {
    const key = `${channel}:${symbol}`;
    this._callbacks.delete(key);
    this._callbacks.delete(`${channel}:`);
    this._desiredSubs.delete(key);
    this._desiredSubs.delete(`public\0${channel}`);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._sendUnsubscribe(channel, symbol);
    }
  }

  private async _subscribe(
    channel: string,
    symbol: string,
    callback: (data: any) => void | Promise<void>,
  ): Promise<void> {
    const key = `${channel}:${symbol}`;
    this._callbacks.set(key, callback);
    this._desiredSubs.add(key);
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._sendSubscribe(channel, symbol);
    }
  }

  private _sendPublicSubscribe(channel: string): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({
      id: randomUUID(),
      op: 'subscribe',
      args: [{ channel }],
    }));
  }

  private _sendSubscribe(channel: string, symbol: string): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    if (this._docsWire) {
      this._ws.send(JSON.stringify({
        id: randomUUID(),
        op: 'subscribe',
        args: [{ channel, symbol }],
      }));
    } else {
      this._ws.send(JSON.stringify({ action: 'subscribe', channel, symbol }));
    }
  }

  private _sendUnsubscribe(channel: string, symbol: string): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    if (this._docsWire) {
      const arg: Record<string, string> = { channel };
      if (symbol) arg.symbol = symbol;
      this._ws.send(JSON.stringify({
        id: randomUUID(),
        op: 'unsubscribe',
        args: [arg],
      }));
    } else {
      this._ws.send(JSON.stringify({ action: 'unsubscribe', channel, symbol }));
    }
  }

  private async _resubscribeAll(): Promise<void> {
    for (const key of this._desiredSubs) {
      if (key.startsWith('public\0')) {
        this._sendPublicSubscribe(key.slice('public\0'.length));
        continue;
      }
      const i = key.indexOf(':');
      if (i > 0) {
        this._sendSubscribe(key.slice(0, i), key.slice(i + 1));
      }
    }
  }

  private _startRecvLoop(): void {
    if (!this._ws) return;
    this._ws.on('message', async (raw: WebSocket.Data) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const key = subscriptionCallbackKey(msg);
      if (key === null) {
        if (msg.type === 'error') {
          console.warn('Market data server error:', msg);
        }
        return;
      }
      const cb = this._callbacks.get(key);
      if (cb) {
        try {
          await cb(msg);
        } catch (e) {
          console.error('Market data callback error:', e);
        }
      }
    });
  }

  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this._ws && this._connected && this._ws.readyState === WebSocket.OPEN) {
        try {
          if (this._docsWire) {
            this._ws.send(JSON.stringify({ id: randomUUID(), op: 'ping' }));
          } else {
            this._ws.send(JSON.stringify({ action: 'ping' }));
          }
        } catch {
          // send error triggers close event
        }
      }
    }, MarketDataClient.HEARTBEAT_INTERVAL);
  }

  private _stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  private async _reconnect(): Promise<void> {
    let delay = 1000;
    const maxDelay = 15_000;
    while (this._autoReconnect) {
      await new Promise((r) => setTimeout(r, delay));
      try {
        await this.connect();
        console.info('Market data WebSocket reconnected and resubscribed');
        return;
      } catch (e) {
        console.error('Market data reconnect failed:', e);
        delay = Math.min(delay * 2, maxDelay);
      }
    }
  }
}
