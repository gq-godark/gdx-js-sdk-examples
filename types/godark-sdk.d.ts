/**
 * Ambient typings for local `tsc` when the npm tarball omits `dist/index.d.ts`.
 * Delete this file once `@godark/sdk` publishes declarations (see SDK `package.json` `"types"`).
 */
declare module '@godark/sdk' {
  export class GodarkError extends Error {}

  export class AuthenticationError extends GodarkError {}
  export class ConnectionError extends GodarkError {}
  export class SessionError extends GodarkError {}
  export class EncryptionError extends GodarkError {}
  export class TimeoutError extends GodarkError {}
  export class OrderError extends GodarkError {}

  export interface TransportOptions {
    headers?: Record<string, string>;
    wsOptions?: Record<string, unknown>;
    commandTimeout?: number;
    heartbeatInterval?: number;
    staleTimeout?: number;
    useDocsWire?: boolean;
  }

  export interface OrderAck {
    success?: boolean;
    orderId: string;
    sequence?: number;
  }

  export interface OrderUpdate {
    orderId: string;
    updateType: string;
    status: string;
    filledQty: string;
    remainingQty: string;
  }

  export interface PositionUpdate {
    symbolId: string;
    side: string;
    size: string;
    entryPrice: string;
  }

  export interface GodarkClientOptions {
    apiKeyId?: string;
    apiSecret?: string;
    apiKey?: string;
    baseUrl?: string;
    transportOptions?: TransportOptions;
    streamBufferSize?: number;
    autoReconnect?: boolean;
    onError?: (err: GodarkError) => void;
  }

  export class GodarkClient {
    constructor(opts: GodarkClientOptions);
    userUuid: string | undefined;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    subscribe(channels?: string[]): Promise<void>;
    placeOrder(args: Record<string, unknown>): Promise<OrderAck>;
    cancelOrder(orderId: string, symbol: string): Promise<OrderAck>;
    modifyOrder(
      orderId: string,
      symbol: string,
      opts: Record<string, unknown>,
    ): Promise<OrderAck>;
    onOrderUpdate(cb: (u: OrderUpdate) => void): void;
    onPositionUpdate(cb: (u: PositionUpdate) => void): void;
    onReconnect(cb: () => void): void;
    orderUpdates(): AsyncIterableIterator<OrderUpdate>;
  }

  export class MarketDataClient {
    constructor(baseUrl: string, transportOptions?: TransportOptions);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    subscribeOrderbook(
      symbol: string,
      cb: (data: Record<string, unknown>) => void,
    ): Promise<void>;
    subscribeTrades(
      symbol: string,
      cb: (data: Record<string, unknown>) => void,
    ): Promise<void>;
  }

  export interface GodarkRestClientOptions {
    apiKey?: string;
    apiKeyId?: string;
    apiSecret?: string;
    restBaseUrl?: string;
    userUuid?: string;
  }

  export class GodarkRestClient {
    constructor(opts: GodarkRestClientOptions);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    placeOrder(
      symbol: string,
      side: string,
      opts: Record<string, unknown>,
    ): Promise<OrderAck>;
    cancelOrder(orderId: string, symbol?: string): Promise<OrderAck>;
  }
}
