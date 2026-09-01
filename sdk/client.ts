import { randomUUID } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { CryptoSession } from './session.js';
import { EdgeTransport, type TransportOptions } from './transport.js';
import * as proto from './proto.js';
import { parsePinnedStaticPublicKeyHex } from './hpke.js';
import { encodeEncryptedOrder, encodeHpkeSetup, encryptedOrderRequest } from './wire.js';
import { OrderHeaderSchema } from './generated/gdx/edge/v1/edge_pb.js';
import { REQUEST_TYPE_TO_PROTO } from './enums.js';
import {
  AuthenticationError,
  ConnectionError,
  EncryptionError,
  GodarkError,
  OrderError,
  SessionError,
  TimeoutError,
} from './errors.js';
import {
  makeOrderErrorFromCode,
  makeOrderErrorFromJson,
} from './orderErrorCode.js';
import type {
  OrderAck,
  OrderUpdate,
  PositionUpdate,
  PositionsSnapshot,
  SystemHealthUpdate,
  BalanceUpdate,
  MarginAlert,
  FundingRateUpdate,
  SettlementUpdate,
  SequencerPush,
  MassQuoteAck,
  MassQuoteLegResult,
  BatchCancelAck,
  BatchCancelLegResult,
  BatchModifyAck,
  BatchModifyLegResult,
  CountAck,
  TpslAck,
  LeverageSettings,
  PlaceOrderOptions as PlaceOrderFlags,
} from './types.js';
import {
  createOrderAck,
  createOrderUpdate,
  createPositionUpdate,
  createMassQuoteAck,
  createBatchCancelAck,
  createBatchModifyAck,
} from './types.js';
import { BoundedQueue } from './bounded-queue.js';
import { DEFAULT_SYMBOLS, resolveSymbol as resolveSymbolId } from './symbols.js';
import { loadSymbolMapFromEdge } from './edgeInstruments.js';
import type {
  CancelReason,
  OrderStatus,
  OrderUpdateType,
  PositionUpdateType,
  Side,
} from './enums.js';
import {
  CANCEL_REASON_FROM_PROTO,
  RESPONSE_MESSAGE_TYPE_TO_PROTO,
} from './enums.js';

const DEFAULT_TESTNET_EDGE_BASE_URL = 'wss://api.godark-dex.com';
const DEFAULT_DEVNET_EDGE_BASE_URL = 'wss://api.devnet.godark-dex.com';
const HPKE_SETUP_TIMEOUT_MS = 10_000;

/** Encrypted command request_type -> ack message_type it must resolve on. */
const INFLIGHT_ACK_TYPE: Record<string, string> = {
  mass_quote: 'mass_quote_ack',
  batch_cancel: 'batch_cancel_ack',
  batch_modify: 'batch_modify_ack',
  amend_tpsl: 'tpsl_ack',
  cancel_tpsl: 'tpsl_ack',
  cancel_all: 'cancel_all_ack',
  close_all: 'close_all_ack',
  reverse: 'reverse_ack',
};

/**
 * Sequencer HPKE static public key for public testnet (64 hex).
 */
export const TESTNET_HPKE_STATIC_PUBLIC_KEY_HEX =
  'a9fdd7f26c0de36d82811e9fe1df2509960cd5b25eef037355e209b9222bea7d';

/**
 * Sequencer HPKE static public key for public devnet (64 hex).
 */
export const DEVNET_HPKE_STATIC_PUBLIC_KEY_HEX =
  'a6807e2f6cd04b54cc19be2fd4faea2a1239f1e2896912d91222678ab54cdd45';
/**
 * Named deployment target. Selects the default edge URL and, when known,
 * a baked-in sequencer HPKE public key pin when known.
 *
 * Explicit `baseUrl` / `hpkeStaticPublicKeyHex` and the corresponding
 * environment variables still win over these presets.
 */
export const Environment = {
  /** Public testnet (`wss://api.godark-dex.com`) with the published HPKE pin. */
  Testnet: 'testnet',
  /**
   * Devnet (`wss://api.devnet.godark-dex.com`) with its own published HPKE pin
   * (not shared with Testnet).
   */
  Devnet: 'devnet',
  /**
   * Local edge (`ws://127.0.0.1:4000`). No baked-in HPKE pin — set via
   * `hpkeStaticPublicKeyHex` or `GDX_HPKE_STATIC_PUBLIC_KEY`.
   */
  Localnet: 'localnet',
} as const;

export type Environment = (typeof Environment)[keyof typeof Environment];

/** Default edge base URL for this environment (host only). */
export function edgeBaseUrlForEnvironment(environment: Environment): string {
  switch (environment) {
    case Environment.Testnet:
      return DEFAULT_TESTNET_EDGE_BASE_URL;
    case Environment.Devnet:
      return DEFAULT_DEVNET_EDGE_BASE_URL;
    case Environment.Localnet:
      return 'ws://127.0.0.1:4000';
    default: {
      const _exhaustive: never = environment;
      return _exhaustive;
    }
  }
}

/** Baked-in sequencer HPKE static public key (64 hex), when known. */
export function hpkeStaticPublicKeyHexForEnvironment(
  environment: Environment,
): string | undefined {
  switch (environment) {
    case Environment.Testnet:
      return TESTNET_HPKE_STATIC_PUBLIC_KEY_HEX;
    case Environment.Devnet:
      return DEVNET_HPKE_STATIC_PUBLIC_KEY_HEX;
    case Environment.Localnet:
      return undefined;
    default: {
      const _exhaustive: never = environment;
      return _exhaustive;
    }
  }
}
function resolveHpkeStaticPublicKeyEnv(): string | undefined {
  const keys = [
    'GDX_HPKE_STATIC_PUBLIC_KEY',
    'GDX_HPKE_STATIC_PUBKEY',
    'VITE_GDX_HPKE_STATIC_PUBKEY',
    'GODARK_HPKE_STATIC_PUBLIC_KEY',
  ];
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}


function inferEnvironmentFromEdgeUrl(base: string): Environment {
  let host = base.trim().toLowerCase();
  for (const prefix of ['https://', 'http://', 'wss://', 'ws://'] as const) {
    if (host.startsWith(prefix)) {
      host = host.slice(prefix.length);
      break;
    }
  }
  host = host.split('/')[0] ?? host;
  host = host.split(':')[0] ?? host;
  if (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost')) {
    return Environment.Localnet;
  }
  if (host.includes('devnet')) {
    return Environment.Devnet;
  }
  if (host.includes('godark-dex.com')) {
    return Environment.Testnet;
  }
  return Environment.Testnet;
}

/**
 * Resolve HPKE pin: explicit config → env vars → environment preset.
 */
export function resolveHpkeStaticPublicKeyHex(
  explicit: string | undefined,
  environment: Environment = Environment.Testnet,
): string | undefined {
  const fromOpts = explicit?.trim();
  if (fromOpts) return fromOpts;
  const fromEnv = resolveHpkeStaticPublicKeyEnv();
  if (fromEnv) return fromEnv;
  return hpkeStaticPublicKeyHexForEnvironment(environment);
}
const ORDER_STATUS_VALUES = new Set<string>([
  'NEW',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELLED',
  'REJECTED',
]);
const ORDER_UPDATE_TYPE_VALUES = new Set<string>([
  'OPEN',
  'FILLED',
  'PARTIALLY_FILLED',
  'CANCELLED',
  'REJECTED',
  'MODIFIED',
  'CANCEL_REJECTED',
  'MODIFY_REJECTED',
]);
const POSITION_UPDATE_TYPE_VALUES = new Set<string>([
  'SNAPSHOT',
  'OPEN',
  'INCREASE',
  'DECREASE',
  'CLOSE',
  'FUNDING_APPLIED',
]);
const SIDE_VALUES = new Set<string>(['BUY', 'SELL']);

/**
 * Resolve edge base URL: explicit arg → env vars → environment preset.
 */
export function resolveEdgeBaseUrl(
  explicit?: string,
  environment: Environment = Environment.Testnet,
): string {
  if (explicit && explicit.trim() !== '') return explicit.trim();
  const godarkUrl = process.env.GODARK_EDGE_URL?.trim();
  if (godarkUrl) return godarkUrl;
  const gdxUrl = process.env.GDX_EDGE_URL?.trim();
  if (gdxUrl) return gdxUrl;
  return edgeBaseUrlForEnvironment(environment);
}

function resolveConfigUserUuid(explicit?: string): string | undefined {
  if (explicit && explicit.trim() !== '') return explicit.trim();
  const godarkUuid = process.env.GODARK_USER_UUID?.trim();
  if (godarkUuid) return godarkUuid;
  const gdxUuid = process.env.GDX_USER_UUID?.trim();
  if (gdxUuid) return gdxUuid;
  return undefined;
}

/** Resolve passphrase: constructor arg wins, then GODARK_PASSPHRASE, then GDX_PASSPHRASE. */
export function resolvePassphrase(explicit?: string): string | undefined {
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();
  const godark = process.env.GODARK_PASSPHRASE?.trim();
  if (godark) return godark;
  const gdx = process.env.GDX_PASSPHRASE?.trim();
  if (gdx) return gdx;
  return undefined;
}

/**
 * Resolve the trading WebSocket URL from a base URL.
 *
 * Canonical suffix is `/ws/v1` (matches the public docs at
 * `wss://api.godarkdex.com/ws/v1` / `wss://api.godarkdex-testnet.com/ws/v1`).
 *
 * - If `baseUrl` already ends with `/ws/v1` → returned unchanged.
 * - If `baseUrl` ends with the legacy `/ws` suffix → upgraded to `/ws/v1`.
 * - Otherwise → `/ws/v1` is appended.
 *
 * Trailing slashes are always stripped first.
 */
export function wsUrl(baseUrl: string): string {
  let url = baseUrl.replace(/\/+$/, '');
  if (url.startsWith('http://')) url = 'ws://' + url.slice('http://'.length);
  else if (url.startsWith('https://')) url = 'wss://' + url.slice('https://'.length);
  if (url.endsWith('/ws/v1')) return url;
  if (url.endsWith('/ws')) return url + '/v1';
  return url + '/ws/v1';
}

function timestampNs(): number {
  return Math.floor(Date.now() * 1_000_000);
}

/** Default max buffered items per {@link GodarkClient.orderUpdates} / {@link GodarkClient.positionUpdates} iterator. */
export const DEFAULT_STREAM_BUFFER_SIZE = 1024;

export interface GodarkClientOptions {
  apiKey?: string;
  apiKeyId?: string;
  apiSecret?: string;
  /** User-chosen API key passphrase (required with key pair; also reads GODARK_PASSPHRASE / GDX_PASSPHRASE). */
  passphrase?: string;
  /**
   * Named deployment. Defaults to {@link Environment.Testnet}, which supplies
   * the public testnet edge URL and HPKE pin when those are not set
   * explicitly or via environment variables.
   */
  environment?: Environment;
  baseUrl?: string;
  /** User UUID fallback when the edge auth response omits it. Also read from GODARK_USER_UUID / GDX_USER_UUID env vars. */
  userUuid?: string;
  autoReconnect?: boolean;
  symbolMap?: Record<string, number>;
  /** Called for rekey failures, decrypt/parse failures on encrypted pushes, and similar non-fatal errors. */
  onError?: (err: GodarkError) => void;
  /** TLS, custom headers, timeouts for the trading WebSocket (`ws` client options). */
  transportOptions?: TransportOptions;
  /** Max items to buffer per async iterator; oldest dropped when full (default {@link DEFAULT_STREAM_BUFFER_SIZE}). */
  streamBufferSize?: number;
  /**
   * How long `placeOrder` waits for a terminal order update after the fast ack
   * when `confirmation` is `"book"` (`OPEN` / `REJECTED` / fill / cancel).
   * Default: transport `commandTimeout` or 10s.
   */
  placeOrderTerminalTimeoutMs?: number;
  /**
   * Sequencer HPKE static public key (64 hex chars). Preference order:
   * this option → `GDX_HPKE_STATIC_PUBLIC_KEY` / aliases → baked-in pin from
   * {@link GodarkClientOptions.environment}.
   */
  hpkeStaticPublicKeyHex?: string;
}

/** Confirmation boundary used by {@link GodarkClient.placeOrder}. */
export type PlaceOrderConfirmation = 'ack' | 'book';

export interface PlaceOrderOptions extends PlaceOrderFlags {
  symbol: string;
  side: string;
  orderType: string;
  quantity: number;
  price?: number;
  timeInForce?: string;
  aon?: boolean;
  minFillSize?: number;
  expiryTime?: number;
  /**
   * `"book"` (default) waits for a definitive order update and throws when the
   * order is rejected. `"ack"` returns as soon as the sequencer acknowledges
   * the order; callers must then consume the order-update stream themselves.
   */
  confirmation?: PlaceOrderConfirmation;
}

const PLACE_TERMINAL_UPDATE_TYPES = new Set<OrderUpdateType>([
  'OPEN',
  'REJECTED',
  'FILLED',
  'PARTIALLY_FILLED',
  'CANCELLED',
]);

interface PlaceOutcomeWaiter {
  orderId?: string;
  resolve: (update: OrderUpdate) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

export interface ModifyOrderOptions {
  newPrice?: number;
  newQuantity?: number;
}

export interface AmendTpslOptions {
  symbol: string;
  orderId: string | number | bigint;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  positionSide?: Side;
}

export interface CancelTpslOptions {
  symbol: string;
  orderId: string | number | bigint;
  positionSide?: Side;
}

export class GodarkClient {
  private _authToken: string;
  private _baseUrl: string;
  private _configUserUuid: string | undefined;
  private _autoReconnect: boolean;
  private _symbolMap: Record<string, number>;
  private readonly _userProvidedSymbolMap: boolean;
  private _transport: EdgeTransport;
  private _session = new CryptoSession();
  private _connId = 0n;
  private _hpkeStaticPublicKeyHex: string | undefined;
  private _userUuid: string | undefined;
  private _accountId: string | undefined;
  private _loginSessionId: string | undefined;
  private _tokenExpiresAt: string | undefined;
  private _cancelOnDisconnect = false;
  private _connected = false;
  private _desiredChannels = new Set<string>();
  private _orderCallbacks: Array<(update: OrderUpdate) => void> = [];
  private _positionCallbacks: Array<(update: PositionUpdate) => void> = [];
  // Extended push surface — mirrors Python (`prod-readiness`), Go (main),
  // Rust (PR #3), C++ (PR #4). One callback array per `SequencerToEdgeMessage`
  // inner case that isn't order_update / position_update.
  private _positionsSnapshotCallbacks: Array<
    (snapshot: PositionsSnapshot) => void
  > = [];
  private _systemHealthCallbacks: Array<
    (health: SystemHealthUpdate) => void
  > = [];
  private _balanceCallbacks: Array<(update: BalanceUpdate) => void> = [];
  private _marginAlertCallbacks: Array<(alert: MarginAlert) => void> = [];
  private _fundingRateCallbacks: Array<
    (update: FundingRateUpdate) => void
  > = [];
  private _settlementCallbacks: Array<
    (update: SettlementUpdate) => void
  > = [];
  private _leverageSettingsCallbacks: Array<
    (settings: LeverageSettings) => void
  > = [];
  private _errorCallbacks: Array<(err: GodarkError) => void> = [];
  private _transportOptions: TransportOptions | undefined;
  private _streamBufferSize: number;
  private _reconnectCallbacks: Array<() => void> = [];
  private _reconnectAttempts = 0;
  private _maxBackoff = 15_000;
  private _intentionalClose = false;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _disconnectPromise!: Promise<void>;
  private _resolveDisconnect!: () => void;
  private _placeOrderTerminalTimeoutMs: number;
  private _placeOutcomeWaiters: PlaceOutcomeWaiter[] = [];
  /** Recent terminal updates for push-before-ack races. */
  private _recentTerminalUpdates: OrderUpdate[] = [];
  /**
   * Correlation-keyed waiters for encrypted command acks (Rust parity).
   * Enables multiple in-flight encrypted orders on one session.
   */
  private _encryptedAckWaiters = new Map<
    string,
    {
      resolve: (msg: any) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      expectedAckType: string;
    }
  >();
  /** Serialize HPKE encrypt + send-nonce assignment. */
  private _encryptChain: Promise<void> = Promise.resolve();

  constructor(opts: GodarkClientOptions) {
    if (opts.apiKeyId !== undefined || opts.apiSecret !== undefined) {
      if (!opts.apiKeyId || !opts.apiSecret)
        throw new Error('apiKeyId and apiSecret must be provided together');
      if (opts.apiKey !== undefined)
        throw new Error('use either apiKey or (apiKeyId, apiSecret), not both');
      const resolvedPassphrase = resolvePassphrase(opts.passphrase);
      if (!resolvedPassphrase) {
        throw new Error('passphrase is required when using apiKeyId and apiSecret');
      }
      this._authToken = `${opts.apiKeyId}:${opts.apiSecret}:${resolvedPassphrase}`;
    } else if (opts.apiKey !== undefined) {
      if (opts.passphrase !== undefined && opts.passphrase.trim() !== '') {
        throw new Error('passphrase must not be set when using legacy apiKey');
      }
      this._authToken = opts.apiKey;
    } else {
      throw new Error('provide apiKey or both apiKeyId and apiSecret');
    }

    const environment = opts.environment ?? Environment.Testnet;
    this._baseUrl = resolveEdgeBaseUrl(opts.baseUrl, environment);
    this._configUserUuid = resolveConfigUserUuid(opts.userUuid);
    this._autoReconnect = opts.autoReconnect ?? true;
    this._userProvidedSymbolMap = opts.symbolMap !== undefined;
    this._symbolMap = opts.symbolMap ?? { ...DEFAULT_SYMBOLS };
    this._transportOptions = opts.transportOptions;
    const sbs = opts.streamBufferSize ?? DEFAULT_STREAM_BUFFER_SIZE;
    if (!Number.isFinite(sbs) || sbs < 1) {
      throw new RangeError('streamBufferSize must be a finite number >= 1');
    }
    this._streamBufferSize = sbs;
    const terminalTimeout = opts.placeOrderTerminalTimeoutMs;
    this._placeOrderTerminalTimeoutMs =
      terminalTimeout !== undefined
        ? terminalTimeout
        : (opts.transportOptions?.commandTimeout ?? 10_000);
    if (
      !Number.isFinite(this._placeOrderTerminalTimeoutMs) ||
      this._placeOrderTerminalTimeoutMs <= 0
    ) {
      throw new RangeError(
        'placeOrderTerminalTimeoutMs must be a finite number greater than 0',
      );
    }
    if (opts.onError) this._errorCallbacks.push(opts.onError);
    const pinEnv =
      opts.baseUrl !== undefined && opts.baseUrl.trim() !== ''
        ? inferEnvironmentFromEdgeUrl(opts.baseUrl)
        : environment;
    this._hpkeStaticPublicKeyHex = resolveHpkeStaticPublicKeyHex(
      opts.hpkeStaticPublicKeyHex,
      pinEnv,
    );
    this._transport = new EdgeTransport(
      wsUrl(this._baseUrl),
      this._transportOptions,
    );
    this._resetDisconnectPromise();
  }

  get userUuid(): string | undefined {
    return this._userUuid;
  }

  get accountId(): string | undefined {
    return this._accountId;
  }

  get loginSessionId(): string | undefined {
    return this._loginSessionId;
  }

  get tokenExpiresAt(): string | undefined {
    return this._tokenExpiresAt;
  }

  get cancelOnDisconnect(): boolean {
    return this._cancelOnDisconnect;
  }

  async connect(): Promise<void> {
    this._intentionalClose = false;
    if (!this._userProvidedSymbolMap) {
      Object.assign(this._symbolMap, await loadSymbolMapFromEdge(this._baseUrl));
    }
    await this._transport.connect();

    this._transport.onEncryptedPush = (msg) => this._handleEncryptedPush(msg);
    this._transport.onPublicMessage = (msg) => this._handlePublicMessage(msg);
    this._transport.onOrderUpdate = (msg) =>
      this._handleCleartextOrderUpdate(msg);
    this._transport.onPositionUpdate = (msg) =>
      this._handleCleartextPositionUpdate(msg);
    this._transport.onRekeyRequired = () => this._handleRekey();
    this._transport.onDisconnect = () => this._onTransportDisconnect();

    const authResult = await this._transport.authenticate(this._authToken);
    if (!authResult.success) {
      await this._transport.disconnect();
      throw new AuthenticationError(
        authResult.error ?? 'authentication failed',
      );
    }

    const rawUuid = authResult.user_uuid ?? authResult.user_id;
    if (rawUuid !== undefined && rawUuid !== null) {
      this._userUuid = String(rawUuid);
    } else if (this._configUserUuid) {
      this._userUuid = this._configUserUuid;
    } else {
      await this._transport.disconnect();
      throw new AuthenticationError(
        'auth response did not include user_uuid and no userUuid was provided via config or GODARK_USER_UUID / GDX_USER_UUID env vars',
      );
    }
    this._accountId =
      authResult.account_id !== undefined && authResult.account_id !== null
        ? String(authResult.account_id)
        : undefined;
    this._loginSessionId =
      authResult.session_id !== undefined && authResult.session_id !== null
        ? String(authResult.session_id)
        : undefined;
    this._tokenExpiresAt =
      authResult.token_expires_at !== undefined && authResult.token_expires_at !== null
        ? String(authResult.token_expires_at)
        : undefined;
    this._cancelOnDisconnect = Boolean(authResult.cancel_on_disconnect ?? false);

    const connId = proto.parseWireU64(authResult.conn_id);
    if (connId === 0n) {
      await this._transport.disconnect();
      throw new AuthenticationError(
        'auth response did not include a non-zero conn_id (required for HPKE)',
      );
    }
    this._connId = connId;

    await this._setupHpkeSession();
    this._connected = true;
    this._reconnectAttempts = 0;
    this._resetDisconnectPromise();
  }

  async disconnect(): Promise<void> {
    this._intentionalClose = true;
    this._connected = false;
    this._resolveIteratorDisconnect();
    this._rejectPlaceOutcomeWaiters(
      new ConnectionError('disconnected while waiting for order confirmation'),
    );
    this._rejectEncryptedAckWaiters(
      new ConnectionError('disconnected while waiting for encrypted command ack'),
    );
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    await this._transport.disconnect();
    this._session.reset();
  }

  async logout(): Promise<void> {
    this._intentionalClose = true;
    try {
      if (this._connected && this._transport.useDocsWire) {
        await this._transport.sendCommand({
          id: randomUUID(),
          op: 'logout',
          args: {},
        });
      }
    } finally {
      await this.disconnect();
    }
  }

  // ------------------------------------------------------------------
  // Trading
  // ------------------------------------------------------------------

  async placeOrder(opts: PlaceOrderOptions): Promise<OrderAck> {
    this._ensureReady();
    const symbolId = this._resolveSymbol(opts.symbol);
    const corr = proto.newCorrelationIdWire();
    const confirmation = opts.confirmation ?? 'book';
    if (confirmation !== 'ack' && confirmation !== 'book') {
      throw new RangeError('confirmation must be "ack" or "book"');
    }

    // Register before send so a terminal push that races the ack is not lost.
    const outcomePromise =
      confirmation === 'book' ? this._registerPlaceOutcomeWaiter() : null;

    const plaintext = proto.buildPlaceOrderProto({
      symbolId,
      side: opts.side,
      orderType: opts.orderType,
      quantity: opts.quantity,
      userUuid: proto.uuidStringToBytes(this._userUuid!),
      price: opts.price,
      timeInForce: opts.timeInForce ?? 'GTC',
      aon: opts.aon,
      minFillSize: opts.minFillSize,
      expiryTime: opts.expiryTime,
      correlationIdBytes: corr.bodyBytes,
      timestamp: timestampNs(),
      reduceOnly: opts.reduceOnly,
      postOnly: opts.postOnly,
      stpMode: opts.stpMode,
    });

    let ack: OrderAck;
    try {
      ack = await this._sendEncryptedOrder(
        'place',
        symbolId,
        Buffer.from(plaintext),
        corr,
      );
    } catch (e) {
      this._cancelPlaceOutcomeWaiter(outcomePromise);
      throw e;
    }

    if (!outcomePromise) return ack;

    const update = await this._awaitPlaceOutcome(ack.orderId, outcomePromise);
    if (update.updateType === 'REJECTED' || update.status === 'REJECTED') {
      const codeRaw = update.rejectReason;
      const numeric =
        codeRaw != null && /^-?\d+$/.test(codeRaw) ? Number(codeRaw) : null;
      const symbolic =
        codeRaw != null && !/^-?\d+$/.test(codeRaw) ? codeRaw : null;
      if (symbolic) {
        throw makeOrderErrorFromJson(update.msg ?? null, symbolic);
      }
      throw makeOrderErrorFromCode(numeric, update.msg);
    }
    return ack;
  }

  async cancelOrder(
    orderId: string,
    symbol = 'BTC-USDC-PERP',
  ): Promise<OrderAck> {
    this._ensureReady();
    const symbolId = this._resolveSymbol(symbol);
    const corr = proto.newCorrelationIdWire();

    const plaintext = proto.buildCancelOrderProto({
      // Pass through as string. u64 order ids exceed 2^53 so converting
      // to Number here truncated the low bits and the cancel was sent
      // for a different (rounded) id than the one the user received.
      orderId,
      userUuid: proto.uuidStringToBytes(this._userUuid!),
      symbolId,
      correlationIdBytes: corr.bodyBytes,
    });

    return this._sendEncryptedOrder(
      'cancel',
      symbolId,
      Buffer.from(plaintext),
      corr,
    );
  }

  async modifyOrder(
    orderId: string,
    symbol = 'BTC-USDC-PERP',
    opts?: ModifyOrderOptions,
  ): Promise<OrderAck> {
    this._ensureReady();
    const symbolId = this._resolveSymbol(symbol);
    const corr = proto.newCorrelationIdWire();

    const plaintext = proto.buildModifyOrderProto({
      // Pass through as string. Same rationale as cancelOrder.
      orderId,
      userUuid: proto.uuidStringToBytes(this._userUuid!),
      symbolId,
      newPrice: opts?.newPrice,
      newQuantity: opts?.newQuantity,
      correlationIdBytes: corr.bodyBytes,
    });

    return this._sendEncryptedOrder(
      'modify',
      symbolId,
      Buffer.from(plaintext),
      corr,
    );
  }

  /** Set per-symbol account leverage over encrypted WebSocket (HPKE). */
  async updateLeverage(symbol: string, leverage: number): Promise<OrderAck> {
    this._ensureReady();
    const symbolId = this._resolveSymbol(symbol);
    const corr = proto.newCorrelationIdWire();
    const plaintext = proto.buildUpdateLeverageProto({
      userUuid: proto.uuidStringToBytes(this._userUuid!),
      symbolId,
      leverage,
      correlationIdBytes: corr.bodyBytes,
    });
    const response = await this._sendEncryptedCommand(
      'update_leverage',
      'update_leverage',
      symbolId,
      Buffer.from(plaintext),
      corr,
    );
    return this._parseOrderResponse(response);
  }

  /** Cancel all open orders. Omit `symbol` to cancel across every market. */
  async cancelAllOrders(symbol?: string): Promise<CountAck> {
    this._ensureReady();
    const headerSymbolId = symbol !== undefined ? this._resolveSymbol(symbol) : 0;
    const bodySymbolId =
      symbol !== undefined ? this._resolveSymbol(symbol) : undefined;
    const corr = proto.newCorrelationIdWire();
    const plaintext = proto.buildCancelAllProto({
      symbolId: bodySymbolId,
      userUuid: proto.uuidStringToBytes(this._userUuid!),
      correlationIdBytes: corr.bodyBytes,
    });
    const response = await this._sendEncryptedCommand(
      'cancel_all',
      'cancel_all',
      headerSymbolId,
      Buffer.from(plaintext),
      corr,
    );
    return this._parseCountAckResponse(response, 'cancel_all_ack');
  }

  /**
   * Close all positions at market (reduce-only IOC). Omit `symbol` to close
   * every market.
   */
  async closeAll(symbol?: string): Promise<CountAck> {
    this._ensureReady();
    const headerSymbolId = symbol !== undefined ? this._resolveSymbol(symbol) : 0;
    const bodySymbolId =
      symbol !== undefined ? this._resolveSymbol(symbol) : undefined;
    const corr = proto.newCorrelationIdWire();
    const plaintext = proto.buildCloseAllProto({
      symbolId: bodySymbolId,
      userUuid: proto.uuidStringToBytes(this._userUuid!),
      correlationIdBytes: corr.bodyBytes,
    });
    const response = await this._sendEncryptedCommand(
      'close_all',
      'close_all',
      headerSymbolId,
      Buffer.from(plaintext),
      corr,
    );
    return this._parseCountAckResponse(response, 'close_all_ack');
  }

  /** Reverse the open position on `symbol` (flatten + open opposite side). */
  async reversePosition(symbol: string): Promise<CountAck> {
    this._ensureReady();
    const symbolId = this._resolveSymbol(symbol);
    const corr = proto.newCorrelationIdWire();
    const plaintext = proto.buildReverseProto({
      symbolId,
      userUuid: proto.uuidStringToBytes(this._userUuid!),
      correlationIdBytes: corr.bodyBytes,
    });
    const response = await this._sendEncryptedCommand(
      'reverse',
      'reverse',
      symbolId,
      Buffer.from(plaintext),
      corr,
    );
    return this._parseCountAckResponse(response, 'reverse_ack');
  }

  /** Amend / attach TP-SL on a resting order or open position. */
  async amendTpsl(opts: AmendTpslOptions): Promise<TpslAck> {
    this._ensureReady();
    const symbolId = this._resolveSymbol(opts.symbol);
    const orderId = BigInt(opts.orderId);
    if (orderId === 0n && opts.positionSide === undefined) {
      throw new RangeError('positionSide is required when orderId is 0');
    }
    const corr = proto.newCorrelationIdWire();
    const plaintext = proto.buildAmendTpslProto({
      userUuid: proto.uuidStringToBytes(this._userUuid!),
      orderId: opts.orderId,
      correlationIdBytes: corr.bodyBytes,
      takeProfitPrice: opts.takeProfitPrice,
      stopLossPrice: opts.stopLossPrice,
      symbolId: orderId === 0n ? symbolId : undefined,
      positionSide: opts.positionSide,
    });
    const response = await this._sendEncryptedCommand(
      'amend_tpsl',
      'amend_tpsl',
      symbolId,
      Buffer.from(plaintext),
      corr,
    );
    return this._parseTpslAckResponse(response);
  }

  /** Cancel TP/SL without cancelling the parent entry or flattening the position. */
  async cancelTpsl(opts: CancelTpslOptions): Promise<TpslAck> {
    this._ensureReady();
    const symbolId = this._resolveSymbol(opts.symbol);
    const orderId = BigInt(opts.orderId);
    if (orderId === 0n && opts.positionSide === undefined) {
      throw new RangeError('positionSide is required when orderId is 0');
    }
    const corr = proto.newCorrelationIdWire();
    const plaintext = proto.buildCancelTpslProto({
      userUuid: proto.uuidStringToBytes(this._userUuid!),
      orderId: opts.orderId,
      correlationIdBytes: corr.bodyBytes,
      symbolId: orderId === 0n ? symbolId : undefined,
      positionSide: opts.positionSide,
    });
    const response = await this._sendEncryptedCommand(
      'cancel_tpsl',
      'cancel_tpsl',
      symbolId,
      Buffer.from(plaintext),
      corr,
    );
    return this._parseTpslAckResponse(response);
  }

  /**
   * Bulk cancel-replace (market-maker mass quote). Up to 20 legs, single
   * symbol, fused into one MPC round on the backend. Resolves to a
   * {@link MassQuoteAck} with one result per submitted leg.
   *
   * `postOnly` selects the batch matching mode. Leave it `undefined` (the
   * default) and every replacement is post-only: a leg that would cross is
   * returned as `failed`. Pass `postOnly: false` for the relaxed path, where a
   * crossing leg instead takes liquidity up to its limit and rests the
   * remainder; the per-leg taker fill count is surfaced as `fillCount`.
   */
  async massQuote(
    symbol: string,
    legs: proto.MassQuoteLegInput[],
    postOnly?: boolean,
  ): Promise<MassQuoteAck> {
    this._ensureReady();
    const symbolId = this._resolveSymbol(symbol);
    const corr = proto.newCorrelationIdWire();

    const plaintext = proto.buildMassQuoteProto({
      symbolId,
      userUuid: proto.uuidStringToBytes(this._userUuid!),
      legs,
      correlationIdBytes: corr.bodyBytes,
      postOnly,
    });

    const response = await this._sendEncryptedCommand(
      'mass_quote',
      'order.mass_quote',
      symbolId,
      Buffer.from(plaintext),
      corr,
    );
    return this._parseMassQuoteResponse(response);
  }

  /**
   * Cancel up to 20 resting orders on one symbol in a single request. Pure
   * index removals on the backend (zero online MPC rounds). Resolves to a
   * {@link BatchCancelAck} with one result per submitted order id.
   */
  async batchCancel(
    symbol: string,
    orderIds: Array<string | bigint | number>,
  ): Promise<BatchCancelAck> {
    this._ensureReady();
    const symbolId = this._resolveSymbol(symbol);
    const corr = proto.newCorrelationIdWire();

    const plaintext = proto.buildBatchCancelProto({
      symbolId,
      userUuid: proto.uuidStringToBytes(this._userUuid!),
      orderIds,
      correlationIdBytes: corr.bodyBytes,
    });

    const response = await this._sendEncryptedCommand(
      'batch_cancel',
      'order.batch_cancel',
      symbolId,
      Buffer.from(plaintext),
      corr,
    );
    return this._parseBatchCancelResponse(response, orderIds);
  }

  /**
   * Amend up to 20 resting orders on one symbol in a single post-only batch,
   * fused into a constant number of online MPC rounds. A leg whose amended
   * order would cross the book is rejected (returned as `modified: false`).
   * Resolves to a {@link BatchModifyAck} with one result per submitted leg.
   */
  async batchModify(
    symbol: string,
    legs: proto.BatchModifyLegInput[],
  ): Promise<BatchModifyAck> {
    this._ensureReady();
    const symbolId = this._resolveSymbol(symbol);
    const corr = proto.newCorrelationIdWire();

    const plaintext = proto.buildBatchModifyProto({
      symbolId,
      userUuid: proto.uuidStringToBytes(this._userUuid!),
      legs,
      correlationIdBytes: corr.bodyBytes,
    });

    const response = await this._sendEncryptedCommand(
      'batch_modify',
      'order.batch_modify',
      symbolId,
      Buffer.from(plaintext),
      corr,
    );
    return this._parseBatchModifyResponse(response);
  }

  // ------------------------------------------------------------------
  // Subscriptions & callbacks
  // ------------------------------------------------------------------

  async subscribe(
    channels: string[] = ['orders', 'positions'],
  ): Promise<void> {
    this._ensureReady();
    for (const c of channels) this._desiredChannels.add(c);
    await this._transport.sendSubscribe(channels);
  }

  async unsubscribe(
    channels: string[] = ['orders', 'positions'],
  ): Promise<void> {
    for (const c of channels) this._desiredChannels.delete(c);
    if (this._transport.isConnected) {
      await this._transport.sendSubscribe(channels, 'unsubscribe');
    }
  }

  onOrderUpdate(callback: (update: OrderUpdate) => void): void {
    this._orderCallbacks.push(callback);
  }

  onPositionUpdate(callback: (update: PositionUpdate) => void): void {
    this._positionCallbacks.push(callback);
  }

  /**
   * Register a callback for `PositionsSnapshot` pushes (full-user position
   * batches; emitted on subscribe, periodic 5s sweeps, and on
   * position-changing events). Inspect `snapshot.source` to distinguish.
   */
  onPositionsSnapshot(callback: (snapshot: PositionsSnapshot) => void): void {
    this._positionsSnapshotCallbacks.push(callback);
  }

  /** Register a callback for unified `HealthReport` pushes. */
  onSystemHealth(callback: (health: SystemHealthUpdate) => void): void {
    this._systemHealthCallbacks.push(callback);
  }

  /** Register a callback for `BalanceUpdateMessage` pushes (shielded balance). */
  onBalanceUpdate(callback: (update: BalanceUpdate) => void): void {
    this._balanceCallbacks.push(callback);
  }

  /**
   * Register a callback for `MarginAlertMessage` pushes. Inspect
   * `alert.recovered` to differentiate tier-up transitions from
   * health-recovery clears.
   */
  onMarginAlert(callback: (alert: MarginAlert) => void): void {
    this._marginAlertCallbacks.push(callback);
  }

  /** Register a callback for `FundingRateUpdateMessage` pushes. */
  onFundingRateUpdate(callback: (update: FundingRateUpdate) => void): void {
    this._fundingRateCallbacks.push(callback);
  }

  /** Register a callback for `SettlementUpdateMessage` pushes. */
  onSettlementUpdate(callback: (update: SettlementUpdate) => void): void {
    this._settlementCallbacks.push(callback);
  }

  /** Register a callback for `LeverageSettings` pushes. */
  onLeverageSettings(callback: (settings: LeverageSettings) => void): void {
    this._leverageSettingsCallbacks.push(callback);
  }

  onReconnect(callback: () => void): void {
    this._reconnectCallbacks.push(callback);
  }

  /** Register a callback for non-fatal errors (rekey/decrypt failures, etc.). */
  onError(callback: (err: GodarkError) => void): void {
    this._errorCallbacks.push(callback);
  }

  /** Yields each order update (same feed as {@link onOrderUpdate}). Break the loop to stop. */
  async *orderUpdates(): AsyncIterableIterator<OrderUpdate> {
    const queue = new BoundedQueue<OrderUpdate>(this._streamBufferSize);
    let notify: (() => void) | undefined;
    const handler = (u: OrderUpdate) => {
      if (queue.enqueue(u)) {
        console.warn(
          `Stream buffer full (maxsize=${this._streamBufferSize}), oldest order update dropped`,
        );
      }
      notify?.();
    };
    this._orderCallbacks.push(handler);
    try {
      while (this._connected || queue.length > 0) {
        while (queue.length > 0) {
          yield queue.dequeue()!;
        }
        if (!this._connected) break;
        await Promise.race([
          new Promise<void>((r) => {
            notify = r;
          }),
          this._disconnectPromise,
        ]);
      }
    } finally {
      const i = this._orderCallbacks.indexOf(handler);
      if (i >= 0) this._orderCallbacks.splice(i, 1);
    }
  }

  /** Yields each position update (same feed as {@link onPositionUpdate}). */
  async *positionUpdates(): AsyncIterableIterator<PositionUpdate> {
    const queue = new BoundedQueue<PositionUpdate>(this._streamBufferSize);
    let notify: (() => void) | undefined;
    const handler = (u: PositionUpdate) => {
      if (queue.enqueue(u)) {
        console.warn(
          `Stream buffer full (maxsize=${this._streamBufferSize}), oldest position update dropped`,
        );
      }
      notify?.();
    };
    this._positionCallbacks.push(handler);
    try {
      while (this._connected || queue.length > 0) {
        while (queue.length > 0) {
          yield queue.dequeue()!;
        }
        if (!this._connected) break;
        await Promise.race([
          new Promise<void>((r) => {
            notify = r;
          }),
          this._disconnectPromise,
        ]);
      }
    } finally {
      const i = this._positionCallbacks.indexOf(handler);
      if (i >= 0) this._positionCallbacks.splice(i, 1);
    }
  }

  /**
   * Yields each `PositionsSnapshot` (same feed as
   * {@link onPositionsSnapshot}). Bounded by `streamBufferSize`.
   */
  async *positionsSnapshots(): AsyncIterableIterator<PositionsSnapshot> {
    yield* this._makeStreamingIterator<PositionsSnapshot>(
      this._positionsSnapshotCallbacks,
      'positions snapshot',
    );
  }

  /** Yields each `SystemHealthUpdate` (same feed as {@link onSystemHealth}). */
  async *systemHealthUpdates(): AsyncIterableIterator<SystemHealthUpdate> {
    yield* this._makeStreamingIterator<SystemHealthUpdate>(
      this._systemHealthCallbacks,
      'system health update',
    );
  }

  /** Yields each `BalanceUpdate` (same feed as {@link onBalanceUpdate}). */
  async *balanceUpdates(): AsyncIterableIterator<BalanceUpdate> {
    yield* this._makeStreamingIterator<BalanceUpdate>(
      this._balanceCallbacks,
      'balance update',
    );
  }

  /** Yields each `MarginAlert` (same feed as {@link onMarginAlert}). */
  async *marginAlerts(): AsyncIterableIterator<MarginAlert> {
    yield* this._makeStreamingIterator<MarginAlert>(
      this._marginAlertCallbacks,
      'margin alert',
    );
  }

  /**
   * Yields each `FundingRateUpdate` (same feed as
   * {@link onFundingRateUpdate}).
   */
  async *fundingRateUpdates(): AsyncIterableIterator<FundingRateUpdate> {
    yield* this._makeStreamingIterator<FundingRateUpdate>(
      this._fundingRateCallbacks,
      'funding rate update',
    );
  }

  /**
   * Yields each `SettlementUpdate` (same feed as
   * {@link onSettlementUpdate}).
   */
  async *settlementUpdates(): AsyncIterableIterator<SettlementUpdate> {
    yield* this._makeStreamingIterator<SettlementUpdate>(
      this._settlementCallbacks,
      'settlement update',
    );
  }

  /**
   * Yields each `LeverageSettings` push (same feed as
   * {@link onLeverageSettings}).
   */
  async *leverageSettingsUpdates(): AsyncIterableIterator<LeverageSettings> {
    yield* this._makeStreamingIterator<LeverageSettings>(
      this._leverageSettingsCallbacks,
      'leverage settings update',
    );
  }

  /**
   * Shared backpressure-bounded async iterator helper. Registers a callback
   * on the given `callbacks` array, drains items via a `BoundedQueue`, and
   * unregisters on iterator completion (caller `break`s out of the loop)
   * or client disconnect. Mirrors the loop shape of
   * {@link orderUpdates} / {@link positionUpdates} so the 8 streams behave
   * identically with respect to `streamBufferSize` drops + disconnect.
   */
  private async *_makeStreamingIterator<T>(
    callbacks: Array<(item: T) => void>,
    label: string,
  ): AsyncIterableIterator<T> {
    const queue = new BoundedQueue<T>(this._streamBufferSize);
    let notify: (() => void) | undefined;
    const handler = (item: T) => {
      if (queue.enqueue(item)) {
        console.warn(
          `Stream buffer full (maxsize=${this._streamBufferSize}), oldest ${label} dropped`,
        );
      }
      notify?.();
    };
    callbacks.push(handler);
    try {
      while (this._connected || queue.length > 0) {
        while (queue.length > 0) {
          yield queue.dequeue()!;
        }
        if (!this._connected) break;
        await Promise.race([
          new Promise<void>((r) => {
            notify = r;
          }),
          this._disconnectPromise,
        ]);
      }
    } finally {
      const i = callbacks.indexOf(handler);
      if (i >= 0) callbacks.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------
  // HPKE session setup
  // ------------------------------------------------------------------

  private async _setupHpkeSession(): Promise<void> {
    if (!this._userUuid) {
      throw new SessionError('user_uuid required before HPKE setup');
    }
    if (this._connId === 0n) {
      throw new SessionError('conn_id required before HPKE setup');
    }

    let recipientPublic: Uint8Array;
    try {
      const pinHex = this._hpkeStaticPublicKeyHex;
      if (!pinHex) {
        throw new Error(
          'HPKE static public key unset — pass hpkeStaticPublicKeyHex or set GDX_HPKE_STATIC_PUBLIC_KEY',
        );
      }
      recipientPublic = parsePinnedStaticPublicKeyHex(pinHex);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SessionError(msg);
    }

    const userUuidBytes = proto.uuidStringToBytes(this._userUuid);
    let encapped: Uint8Array;
    try {
      encapped = await this._session.setup(recipientPublic, userUuidBytes, this._connId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SessionError(`HPKE setup failed: ${msg}`);
    }

    const frame = encodeHpkeSetup(userUuidBytes, this._connId, encapped);
    let reply: Record<string, unknown>;
    try {
      reply = await Promise.race([
        this._transport.sendHpkeSetup(frame),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new SessionError('HPKE setup timed out')),
            HPKE_SETUP_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (e: unknown) {
      this._session.abortSetup();
      const msg = e instanceof Error ? e.message : String(e);
      throw e instanceof SessionError ? e : new SessionError(msg);
    }

    const replyConnId = proto.parseWireU64(reply.conn_id);
    if (replyConnId !== this._connId) {
      this._session.abortSetup();
      throw new SessionError(
        `hpke_setup_reply conn_id mismatch: ${replyConnId} != ${this._connId}`,
      );
    }
    if (!reply.established) {
      this._session.abortSetup();
      throw new SessionError('HPKE setup not established');
    }
    this._session.confirmSetup();
  }

  // ------------------------------------------------------------------
  // Encrypted order pipeline
  // ------------------------------------------------------------------

  private async _sendEncryptedOrder(
    requestType: string,
    symbolId: number,
    plaintext: Buffer,
    corr?: proto.CorrelationIdWire,
  ): Promise<OrderAck> {
    const docsOp =
      requestType === 'place'
        ? 'order.place'
        : requestType === 'cancel'
          ? 'order.cancel'
          : 'order.modify';
    const response = await this._sendEncryptedCommand(
      requestType,
      docsOp,
      symbolId,
      plaintext,
      corr,
    );
    return this._parseOrderResponse(response);
  }

  /**
   * Encrypt one edge command and await its raw transport response. Shared by
   * order place/cancel/modify, mass quote and batch cancel/modify.
   * `requestType` sets the encrypted OrderHeader request type (also bound AEAD
   * AAD); `docsOp` is the WS docs op.
   */
  private async _sendEncryptedCommand(
    requestType: string,
    _docsOp: string,
    symbolId: number,
    plaintext: Buffer,
    corr?: proto.CorrelationIdWire,
  ): Promise<any> {
    if (!corr || corr.value === 0n) {
      throw new Error('encrypted command requires non-zero correlation_id');
    }

    const bodyLength = CryptoSession.bodyLengthForPlaintext(plaintext.length);
    const userUuidBytes = proto.uuidStringToBytes(this._userUuid!);

    const { actualNonce, ciphertext } = await this._withEncryptLock(() => {
      const nonceCounter = this._session.nextNonce;
      const aad = Buffer.from(
        proto.buildOrderHeaderAad({
          userUuid: userUuidBytes,
          symbolId,
          requestType,
          nonce: nonceCounter,
          bodyLength,
          correlationId: corr.aadBytes,
          connId: this._connId,
        }),
      );
      try {
        const [n, ct] = this._session.encryptOrder(aad, plaintext);
        return { actualNonce: n, ciphertext: ct };
      } catch (e: any) {
        throw new EncryptionError(`Failed to encrypt order: ${e.message}`);
      }
    });

    const header = create(OrderHeaderSchema, {
      userUuid: userUuidBytes,
      symbolId: BigInt(symbolId),
      requestType:
        REQUEST_TYPE_TO_PROTO[requestType as keyof typeof REQUEST_TYPE_TO_PROTO],
      nonce: BigInt(actualNonce),
      bodyLength,
      correlationId: corr.aadBytes,
      connId: BigInt(this._connId),
    });

    const frame = encodeEncryptedOrder(
      encryptedOrderRequest(header, ciphertext),
    );

    const expectedAckType = INFLIGHT_ACK_TYPE[requestType] ?? 'ack';
    const responsePromise = this._registerEncryptedAckWaiter(
      corr.headerHex,
      expectedAckType,
    );
    try {
      await this._transport.sendBinary(frame);
    } catch (err) {
      this._cancelEncryptedAckWaiter(corr.headerHex);
      throw err;
    }
    return responsePromise;
  }

  private async _withEncryptLock<T>(fn: () => T): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const prev = this._encryptChain;
    this._encryptChain = prev.then(() => gate);
    await prev;
    try {
      return fn();
    } finally {
      release();
    }
  }

  private _registerEncryptedAckWaiter(
    corrKeyHex: string,
    expectedAckType: string,
  ): Promise<any> {
    const corrKey = corrKeyHex.toLowerCase();
    if (this._encryptedAckWaiters.has(corrKey)) {
      throw new Error(`duplicate encrypted ack waiter for correlation_id ${corrKey}`);
    }
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._encryptedAckWaiters.delete(corrKey);
        reject(
          new TimeoutError(
            `Command timed out after ${this._transport.commandTimeoutMs}ms`,
          ),
        );
      }, this._transport.commandTimeoutMs);
      this._encryptedAckWaiters.set(corrKey, {
        resolve,
        reject,
        timer,
        expectedAckType,
      });
    });
    // Avoid unhandledRejection if disconnect rejects after the caller stopped awaiting.
    void p.catch(() => {});
    return p;
  }

  private _cancelEncryptedAckWaiter(corrKeyHex: string): void {
    const corrKey = corrKeyHex.toLowerCase();
    const w = this._encryptedAckWaiters.get(corrKey);
    if (!w) return;
    clearTimeout(w.timer);
    this._encryptedAckWaiters.delete(corrKey);
  }

  private _rejectEncryptedAckWaiters(err: Error): void {
    const waiters = [...this._encryptedAckWaiters.values()];
    this._encryptedAckWaiters.clear();
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  /** ResponseHeader correlation id as canonical lowercase hex (Go/Rust parity). */
  private _correlationKeyFromPushWire(msg: any): string | null {
    const raw = msg.correlation_id;
    if (raw === undefined || raw === null || raw === '') return null;
    const s = String(raw).trim().toLowerCase();
    if (!s || s === '0') return null;
    if (/^[0-9a-f]{32}$/.test(s)) return s;
    const wireBytes = proto.correlationIdFromPushWire(raw);
    if (!wireBytes || wireBytes.length === 0) return null;
    let n = 0n;
    for (const b of wireBytes) n = (n << 8n) | BigInt(b);
    return n === 0n ? null : proto.correlationIdToWireHex(n);
  }

  /** Whether an encrypted_push ack may resolve an in-flight command waiter. */
  private _ackTypeMatchesExpected(messageType: string, expectedAckType: string): boolean {
    if (messageType === expectedAckType) return true;
    // Some deployments echo generic `ack` on the wire for batch commands; the
    // plaintext may still be batch_*_ack or a success Ack for the same corr id.
    if (
      messageType === 'ack' &&
      (expectedAckType === 'batch_cancel_ack' ||
        expectedAckType === 'batch_modify_ack' ||
        expectedAckType === 'mass_quote_ack')
    ) {
      return true;
    }
    return false;
  }

  private _deliverEncryptedAckToWaiter(msg: any): boolean {
    const key = this._correlationKeyFromPushWire(msg);
    if (key === null) return false;

    const w = this._encryptedAckWaiters.get(key);
    if (!w) return false;

    const messageType: string = msg.message_type ?? '';
    if (!this._ackTypeMatchesExpected(messageType, w.expectedAckType)) {
      return false;
    }

    clearTimeout(w.timer);
    this._encryptedAckWaiters.delete(key);
    w.resolve(msg);
    return true;
  }

  private _parseOrderResponse(msg: any): OrderAck {
    const msgType = msg.type;

    if (msgType === 'error') {
      throw new OrderError(msg.message ?? 'unknown error');
    }

    if (msgType === 'ack') {
      if (!msg.success) {
        throw makeOrderErrorFromJson(
          msg.error ?? null,
          msg.error_code != null ? String(msg.error_code) : null,
        );
      }
      return createOrderAck({
        orderId: String(msg.order_id ?? ''),
        success: true,
        sequence: String(msg.sequence ?? ''),
      });
    }

    if (msgType === 'encrypted_push') {
      return this._decryptAckPush(msg);
    }

    throw new OrderError(`Unexpected response type: ${msgType}`);
  }

  private _decryptAckPush(msg: any): OrderAck {
    if (msg._decryptError) {
      throw new EncryptionError(`Failed to decrypt ack: ${msg._decryptError}`);
    }

    let plaintext: Buffer;
    if (Buffer.isBuffer(msg._decryptedPlaintext)) {
      plaintext = msg._decryptedPlaintext;
    } else {
      const ct = Buffer.from(msg.encrypted_body ?? '', 'base64');
      const nonce: number = msg.nonce ?? 0;
      const messageType: string = msg.message_type ?? 'ack';
      const fencingEpoch: number = msg.fencing_epoch ?? 0;

      const aad = Buffer.from(
        proto.buildResponseHeaderAad({
          userUuid: proto.uuidStringToBytes(this._userUuid!),
          messageType,
          bodyLength: ct.length,
          nonce,
          fencingEpoch,
          correlationIdBytes: proto.correlationIdFromPushWire(msg.correlation_id),
          sessionSeq: proto.sessionSeqFromPushWire(msg.session_seq),
          connId: proto.parseWireU64(msg.conn_id ?? this._connId),
        }),
      );

      try {
        plaintext = this._session.decryptPush(nonce, aad, ct);
      } catch (e: any) {
        throw new EncryptionError(`Failed to decrypt ack: ${e.message}`);
      }
    }

    const ackDict = proto.parseNodeResponse(plaintext);
    if (ackDict.type !== 'ack') {
      throw new OrderError(`Expected ack, got ${ackDict.type}`);
    }
    if (!ackDict.success) {
      const raw = ackDict.error_code;
      const detail =
        typeof ackDict.reject_text === 'string' ? ackDict.reject_text : null;
      throw makeOrderErrorFromCode(
        typeof raw === 'number' ? raw : raw != null ? Number(raw) : null,
        detail,
      );
    }

    return createOrderAck({
      orderId: String(ackDict.order_id ?? ''),
      success: true,
      sequence: String(ackDict.sequence ?? ''),
    });
  }

  /**
   * Decrypt the body of an `encrypted_push` ack (mass quote / batch). Shared
   * by the batch response parsers; returns the AES-GCM plaintext.
   */
  private _decryptPushBody(msg: any, defaultMessageType: string): Buffer {
    if (Buffer.isBuffer(msg._decryptedPlaintext)) {
      return msg._decryptedPlaintext;
    }
    const ct = Buffer.from(msg.encrypted_body ?? '', 'base64');
    const nonce: number = msg.nonce ?? 0;
    const aad = Buffer.from(
      proto.buildResponseHeaderAad({
        userUuid: proto.uuidStringToBytes(this._userUuid!),
        messageType: msg.message_type ?? defaultMessageType,
        bodyLength: ct.length,
        nonce,
        fencingEpoch: msg.fencing_epoch ?? 0,
        correlationIdBytes: proto.correlationIdFromPushWire(msg.correlation_id),
        sessionSeq: proto.sessionSeqFromPushWire(msg.session_seq),
        connId: proto.parseWireU64(msg.conn_id ?? this._connId),
      }),
    );
    try {
      return this._session.decryptPush(nonce, aad, ct);
    } catch (e: any) {
      throw new EncryptionError(`Failed to decrypt ack: ${e.message}`);
    }
  }

  private _parseMassQuoteResponse(msg: any): MassQuoteAck {
    if (msg.type === 'error') {
      throw new OrderError(msg.message ?? 'unknown error');
    }
    if (msg.type !== 'encrypted_push') {
      throw new OrderError(`Unexpected mass quote response type: ${msg.type}`);
    }

    const plaintext = this._decryptPushBody(msg, 'mass_quote_ack');
    const parsed = proto.parseMassQuoteAck(plaintext);
    if (parsed.type !== 'mass_quote_ack') {
      const reject = proto.parseNodeResponse(plaintext);
      if (reject.type === 'ack' && reject.success === false) {
        throw makeOrderErrorFromJson(
          (reject.reject_text as string | undefined) ?? null,
          reject.error_code != null ? String(reject.error_code) : null,
        );
      }
      throw new OrderError(`Expected mass_quote_ack, got ${parsed.type}`);
    }

    const rawResults = (parsed.results ?? []) as Array<Record<string, unknown>>;
    const results: MassQuoteLegResult[] = rawResults.map(r => ({
      legIndex: Number(r.leg_index),
      status: r.status as MassQuoteLegResult['status'],
      cancelledOrderId:
        r.cancelled_order_id !== undefined
          ? String(r.cancelled_order_id)
          : undefined,
      newOrderId: r.new_order_id !== undefined ? String(r.new_order_id) : undefined,
      errorCode: r.error_code !== undefined ? Number(r.error_code) : undefined,
      fillCount: r.fill_count !== undefined ? Number(r.fill_count) : 0,
    }));
    const success = results.length > 0 && results.every(r => r.status !== 'failed');
    return createMassQuoteAck({
      success,
      sequence: String(parsed.sequence ?? ''),
      results,
    });
  }

  private _parseBatchCancelResponse(
    msg: any,
    orderIds: Array<string | bigint | number> = [],
  ): BatchCancelAck {
    if (msg.type === 'error') {
      throw new OrderError(msg.message ?? 'unknown error');
    }
    if (msg.type !== 'encrypted_push') {
      throw new OrderError(`Unexpected batch cancel response type: ${msg.type}`);
    }

    const plaintext = this._decryptPushBody(msg, 'batch_cancel_ack');
    const parsed = proto.parseBatchCancelAck(plaintext);
    if (parsed.type !== 'batch_cancel_ack') {
      const reject = proto.parseNodeResponse(plaintext);
      if (reject.type === 'ack' && reject.success === false) {
        throw makeOrderErrorFromJson(
          (reject.reject_text as string | undefined) ?? null,
          reject.error_code != null ? String(reject.error_code) : null,
        );
      }
      if (reject.type === 'ack' && reject.success !== false && orderIds.length > 0) {
        const results: BatchCancelLegResult[] = orderIds.map(orderId => ({
          orderId: String(orderId),
          cancelled: true,
        }));
        return createBatchCancelAck({
          success: true,
          sequence: String(reject.sequence ?? ''),
          results,
        });
      }
      throw new OrderError(`Expected batch_cancel_ack, got ${parsed.type}`);
    }

    const rawResults = (parsed.results ?? []) as Array<Record<string, unknown>>;
    const results: BatchCancelLegResult[] = rawResults.map(r => ({
      orderId: String(r.order_id ?? ''),
      cancelled: Boolean(r.cancelled),
      errorCode: r.error_code !== undefined ? Number(r.error_code) : undefined,
    }));
    const success = results.length > 0 && results.every(r => r.cancelled);
    return createBatchCancelAck({
      success,
      sequence: String(parsed.sequence ?? ''),
      results,
    });
  }

  private _parseBatchModifyResponse(msg: any): BatchModifyAck {
    if (msg.type === 'error') {
      throw new OrderError(msg.message ?? 'unknown error');
    }
    if (msg.type !== 'encrypted_push') {
      throw new OrderError(`Unexpected batch modify response type: ${msg.type}`);
    }

    const plaintext = this._decryptPushBody(msg, 'batch_modify_ack');
    const parsed = proto.parseBatchModifyAck(plaintext);
    if (parsed.type !== 'batch_modify_ack') {
      const reject = proto.parseNodeResponse(plaintext);
      if (reject.type === 'ack' && reject.success === false) {
        throw makeOrderErrorFromJson(
          (reject.reject_text as string | undefined) ?? null,
          reject.error_code != null ? String(reject.error_code) : null,
        );
      }
      throw new OrderError(`Expected batch_modify_ack, got ${parsed.type}`);
    }

    const rawResults = (parsed.results ?? []) as Array<Record<string, unknown>>;
    const results: BatchModifyLegResult[] = rawResults.map(r => ({
      orderId: String(r.order_id ?? ''),
      modified: Boolean(r.modified),
      errorCode: r.error_code !== undefined ? Number(r.error_code) : undefined,
    }));
    const success = results.length > 0 && results.every(r => r.modified);
    return createBatchModifyAck({
      success,
      sequence: String(parsed.sequence ?? ''),
      results,
    });
  }

  private _parseCountAckResponse(msg: any, messageType: string): CountAck {
    if (msg.type === 'error') {
      throw new OrderError(msg.message ?? 'unknown error');
    }
    if (msg.type !== 'encrypted_push') {
      throw new OrderError(`Unexpected count ack response type: ${msg.type}`);
    }

    const plaintext = this._decryptPushBody(msg, messageType);
    let parsed: CountAck;
    try {
      parsed = proto.parseCountAck(plaintext, messageType);
    } catch {
      const reject = proto.parseNodeResponse(plaintext);
      if (reject.type === 'ack' && reject.success === false) {
        throw makeOrderErrorFromJson(
          (reject.reject_text as string | undefined) ?? null,
          reject.error_code != null ? String(reject.error_code) : null,
        );
      }
      throw new OrderError(`Expected ${messageType}, got ${reject.type}`);
    }
    if (parsed.errorCode !== undefined) {
      throw makeOrderErrorFromCode(parsed.errorCode, parsed.rejectText ?? null);
    }
    return parsed;
  }

  private _parseTpslAckResponse(msg: any): TpslAck {
    if (msg.type === 'error') {
      throw new OrderError(msg.message ?? 'unknown error');
    }
    if (msg.type !== 'encrypted_push') {
      throw new OrderError(`Unexpected tpsl ack response type: ${msg.type}`);
    }

    const plaintext = this._decryptPushBody(msg, 'tpsl_ack');
    let parsed: TpslAck;
    try {
      parsed = proto.parseTpslAck(plaintext);
    } catch {
      const reject = proto.parseNodeResponse(plaintext);
      if (reject.type === 'ack' && reject.success === false) {
        throw makeOrderErrorFromJson(
          (reject.reject_text as string | undefined) ?? null,
          reject.error_code != null ? String(reject.error_code) : null,
        );
      }
      throw new OrderError('Expected tpsl_ack');
    }
    if (parsed.errorCode !== undefined) {
      throw makeOrderErrorFromCode(parsed.errorCode, parsed.rejectText ?? null);
    }
    return parsed;
  }

  // ------------------------------------------------------------------
  // Push message handlers
  // ------------------------------------------------------------------

  private _handleEncryptedPush(msg: any): void {
    this._dispatchEncryptedPushInOrder(msg);
  }

  private _handlePublicMessage(msg: Record<string, unknown>): void {
    for (const update of proto.parseFundingRateSnapshotJson(msg)) {
      if (!update.fundingRate) continue;
      this._fanout(this._fundingRateCallbacks, update);
    }
  }

  private _dispatchEncryptedPushInOrder(msg: any): void {
    const messageType: string = msg.message_type ?? '';

    // Synchronous request/response acks (single-order + batch ops) resolve the
    // awaiting command rather than being dispatched to the push callbacks.
    // Decrypt here (before resolve) so HPKE recv nonces stay ordered against
    // any later order_update frames on the same tick — otherwise the waiter
    // may decrypt the ack after an update already advanced the counter.
    if (
      messageType === 'ack' ||
      messageType === 'mass_quote_ack' ||
      messageType === 'batch_cancel_ack' ||
      messageType === 'batch_modify_ack' ||
      messageType === 'cancel_all_ack' ||
      messageType === 'close_all_ack' ||
      messageType === 'reverse_ack' ||
      messageType === 'tpsl_ack'
    ) {
      try {
        msg._decryptedPlaintext = this._decryptPushBody(msg, messageType);
      } catch (e: unknown) {
        const errMsg =
          e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
        this._emitError(new EncryptionError(`Failed to decrypt ack: ${errMsg}`));
        // Still resolve so the waiter surfaces the encryption failure.
        msg._decryptError = errMsg;
      }
      if (!this._deliverEncryptedAckToWaiter(msg)) {
        // Encrypted orders use sendBinary (no transport pending slot). Do not
        // fall back to resolveCommand — that would complete an unrelated
        // subscribe/auth sendCommand waiter with this ack payload.
      }
      return;
    }

    // Skip push types we don't have an AAD enum value for. The sequencer may
    // legitimately add new response message types ahead of the SDK; logging
    // and returning is the right behaviour (matches python's
    // `_handle_encrypted_push` guard). Without this guard an unknown type
    // would fall through to `buildResponseHeaderAad`, serialize a
    // ResponseHeader with `message_type=0`, and surface as an
    // `EncryptionError` from the subsequent AES-GCM decrypt.
    if (!(messageType in RESPONSE_MESSAGE_TYPE_TO_PROTO)) {
      console.warn(
        `[godark] ignoring encrypted push with unknown message_type: ${messageType}`,
      );
      return;
    }

    const ct = Buffer.from(msg.encrypted_body ?? '', 'base64');
    const nonce: number = msg.nonce ?? 0;
    const fencingEpoch: number = msg.fencing_epoch ?? 0;

    const aad = Buffer.from(
      proto.buildResponseHeaderAad({
        userUuid: proto.uuidStringToBytes(this._userUuid!),
        messageType,
        bodyLength: ct.length,
        nonce,
        fencingEpoch,
        correlationIdBytes: proto.correlationIdFromPushWire(msg.correlation_id),
        sessionSeq: proto.sessionSeqFromPushWire(msg.session_seq),
        connId: proto.parseWireU64(msg.conn_id ?? this._connId),
      }),
    );

    let plaintext: Buffer;
    try {
      plaintext = this._session.decryptPush(nonce, aad, ct);
    } catch (e: unknown) {
      const errMsg =
        e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
      this._emitError(new EncryptionError(`Failed to decrypt push: ${errMsg}`));
      return;
    }

    // The outer message_type drove AAD reconstruction above; routing the
    // decrypted plaintext is now the proto envelope's job. Every push the
    // sequencer encrypts ships a `SequencerToEdgeMessage`, so dispatch by
    // the parsed `inner` case rather than the outer string label. This
    // matches python (`_dispatch_sequencer_push`), go
    // (`dispatchSequencerPush`), rust (`route_envelope`), and c++
    // (`dispatch_sequencer_push`). Before this refactor, JS gated on
    // `messageType in {order_update, position_update}` and silently dropped
    // every other decrypted push (positions_snapshot / system_health /
    // balance_update / margin_alert / funding_rate_update /
    // settlement_update).
    let parsed: SequencerPush;
    try {
      if (messageType === 'open_orders_snapshot') {
        return;
      }
      parsed = proto.parseSequencerToEdgeMessage(plaintext);
    } catch (e: unknown) {
      const errMsg =
        e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
      this._emitError(
        new GodarkError(`Failed to parse sequencer push message: ${errMsg}`),
      );
      return;
    }

    this._dispatchSequencerPush(parsed);
  }

  /**
   * Route a parsed `SequencerToEdgeMessage` to the appropriate per-type
   * callback queue. The `unknown` arm is the forward-compat contract:
   * inner cases the SDK doesn't yet recognize are silently ignored
   * here, matching python's `_dispatch_sequencer_push` and go's
   * `UnknownSequencerPush` no-op branch.
   */
  private _dispatchSequencerPush(parsed: SequencerPush): void {
    switch (parsed.kind) {
      case 'order_update':
        this._observeOrderUpdate(parsed.value);
        this._fanout(this._orderCallbacks, parsed.value);
        return;
      case 'position_update':
        this._fanout(this._positionCallbacks, parsed.value);
        return;
      case 'positions_snapshot':
        this._fanout(this._positionsSnapshotCallbacks, parsed.value);
        return;
      case 'system_health':
        this._fanout(this._systemHealthCallbacks, parsed.value);
        return;
      case 'balance_update':
        this._fanout(this._balanceCallbacks, parsed.value);
        return;
      case 'margin_alert':
        this._fanout(this._marginAlertCallbacks, parsed.value);
        return;
      case 'funding_rate_update':
        this._fanout(this._fundingRateCallbacks, parsed.value);
        return;
      case 'settlement_update':
        this._fanout(this._settlementCallbacks, parsed.value);
        return;
      case 'leverage_settings':
        this._fanout(this._leverageSettingsCallbacks, parsed.value);
        return;
      case 'unknown':
        return;
    }
  }

  private _fanout<T>(callbacks: Array<(item: T) => void>, item: T): void {
    for (const cb of callbacks) {
      try {
        cb(item);
      } catch {
        // Swallow user-callback errors — one bad subscriber must not
        // sink the dispatch loop for the other subscribers. Matches
        // the `with contextlib.suppress(Exception)` pattern in python
        // and the `safeCallX` helpers in go.
      }
    }
  }

  private _handleCleartextOrderUpdate(msg: any): void {
    try {
      const sideRaw = String(msg.side ?? 'BUY');
      const statusRaw = String(msg.order_status ?? 'NEW');
      const utRaw = String(msg.message_type ?? 'OPEN');
      const side: Side = SIDE_VALUES.has(sideRaw)
        ? (sideRaw as Side)
        : 'BUY';
      const status: OrderStatus = ORDER_STATUS_VALUES.has(statusRaw)
        ? (statusRaw as OrderStatus)
        : 'NEW';
      const updateType: OrderUpdateType = ORDER_UPDATE_TYPE_VALUES.has(utRaw)
        ? (utRaw as OrderUpdateType)
        : 'OPEN';

      let cancelReason: CancelReason | undefined;
      if (msg.cancel_reason !== undefined && msg.cancel_reason !== null) {
        const cr = Number(msg.cancel_reason);
        if (!Number.isNaN(cr) && cr in CANCEL_REASON_FROM_PROTO) {
          cancelReason =
            CANCEL_REASON_FROM_PROTO[cr as keyof typeof CANCEL_REASON_FROM_PROTO];
        }
      }

      let rejectReason: string | undefined;
      if (msg.reject_reason !== undefined && msg.reject_reason !== null) {
        rejectReason = String(msg.reject_reason);
      } else if (msg.reject_reason_code !== undefined && msg.reject_reason_code !== null) {
        rejectReason = String(msg.reject_reason_code);
      }

      const update = createOrderUpdate({
        orderId: String(msg.order_id ?? ''),
        userUuid: String(msg.user_uuid ?? msg.user_id ?? ''),
        symbolId: msg.symbol_id ?? 0,
        side,
        status,
        updateType,
        price: String(msg.price ?? '0'),
        quantity: String(msg.quantity ?? '0'),
        filledQty: String(msg.filled_qty ?? '0'),
        remainingQty: String(msg.remaining_qty ?? '0'),
        cumFill: String(msg.cum_fill ?? '0'),
        cancelReason,
        rejectReason,
        msg:
          typeof msg.msg === 'string' && msg.msg.length > 0
            ? msg.msg
            : undefined,
        correlationId:
          msg.correlation_id != null ? Number(msg.correlation_id) : 0,
        timestamp: msg.timestamp ?? 0,
      });

      this._observeOrderUpdate(update);
      for (const cb of this._orderCallbacks) {
        try {
          cb(update);
        } catch (e) {
          console.error('onOrderUpdate callback error:', e);
        }
      }
    } catch (e) {
      console.error('cleartext order_update parse error:', e);
    }
  }

  private _isTerminalPlaceUpdate(update: OrderUpdate): boolean {
    return (
      PLACE_TERMINAL_UPDATE_TYPES.has(update.updateType) ||
      update.status === 'REJECTED' ||
      update.status === 'FILLED' ||
      update.status === 'CANCELLED'
    );
  }

  private _registerPlaceOutcomeWaiter(): {
    promise: Promise<OrderUpdate>;
    waiter: PlaceOutcomeWaiter;
  } {
    let resolve!: (update: OrderUpdate) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<OrderUpdate>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const waiter: PlaceOutcomeWaiter = {
      resolve,
      reject,
      settled: false,
      timer: null,
    };
    this._placeOutcomeWaiters.push(waiter);
    return { promise, waiter };
  }

  private _cancelPlaceOutcomeWaiter(
    handle: { promise: Promise<OrderUpdate>; waiter: PlaceOutcomeWaiter } | null,
  ): void {
    if (!handle || handle.waiter.settled) return;
    handle.waiter.settled = true;
    if (handle.waiter.timer) clearTimeout(handle.waiter.timer);
    this._placeOutcomeWaiters = this._placeOutcomeWaiters.filter(
      (w) => w !== handle.waiter,
    );
  }

  private async _awaitPlaceOutcome(
    orderId: string,
    handle: { promise: Promise<OrderUpdate>; waiter: PlaceOutcomeWaiter },
  ): Promise<OrderUpdate> {
    handle.waiter.orderId = orderId;
    const buffered = this._recentTerminalUpdates.find(
      (u) => u.orderId === orderId,
    );
    if (buffered) {
      this._settlePlaceOutcomeWaiter(handle.waiter, buffered);
      return buffered;
    }
    handle.waiter.timer = setTimeout(() => {
      if (handle.waiter.settled) return;
      handle.waiter.settled = true;
      this._placeOutcomeWaiters = this._placeOutcomeWaiters.filter(
        (w) => w !== handle.waiter,
      );
      handle.waiter.reject(
        new TimeoutError(
          `placeOrder timed out waiting for book confirmation after ${this._placeOrderTerminalTimeoutMs}ms`,
        ),
      );
    }, this._placeOrderTerminalTimeoutMs);
    return handle.promise;
  }

  private _settlePlaceOutcomeWaiter(
    waiter: PlaceOutcomeWaiter,
    update: OrderUpdate,
  ): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    this._placeOutcomeWaiters = this._placeOutcomeWaiters.filter(
      (w) => w !== waiter,
    );
    waiter.resolve(update);
  }

  private _rejectPlaceOutcomeWaiters(err: Error): void {
    const waiters = this._placeOutcomeWaiters;
    this._placeOutcomeWaiters = [];
    this._recentTerminalUpdates = [];
    for (const waiter of waiters) {
      if (waiter.settled) continue;
      waiter.settled = true;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  private _observeOrderUpdate(update: OrderUpdate): void {
    if (!this._isTerminalPlaceUpdate(update)) return;

    this._recentTerminalUpdates.push(update);
    if (this._recentTerminalUpdates.length > 64) {
      this._recentTerminalUpdates.shift();
    }

    const waiter = this._placeOutcomeWaiters.find(
      (w) => !w.settled && w.orderId != null && w.orderId === update.orderId,
    );
    if (waiter) {
      this._settlePlaceOutcomeWaiter(waiter, update);
    }
  }

  private _handleCleartextPositionUpdate(msg: any): void {
    try {
      const sideRaw = String(msg.side ?? 'BUY');
      const utRaw = String(msg.update_type ?? 'SNAPSHOT');
      const side: Side = SIDE_VALUES.has(sideRaw)
        ? (sideRaw as Side)
        : 'BUY';
      const updateType: PositionUpdateType = POSITION_UPDATE_TYPE_VALUES.has(utRaw)
        ? (utRaw as PositionUpdateType)
        : 'SNAPSHOT';

      const update = createPositionUpdate({
        userUuid: String(msg.user_uuid ?? msg.user_id ?? ''),
        symbolId: msg.symbol_id ?? 0,
        side,
        updateType,
        size: String(msg.size ?? '0'),
        entryPrice: String(msg.entry_price ?? '0'),
        previousSize: String(msg.previous_size ?? '0'),
        fillPrice: String(msg.fill_price ?? '0'),
        fillQty: String(msg.fill_qty ?? '0'),
        timestamp: msg.timestamp ?? 0,
      });

      for (const cb of this._positionCallbacks) {
        try {
          cb(update);
        } catch (e) {
          console.error('onPositionUpdate callback error:', e);
        }
      }
    } catch (e) {
      console.error('cleartext position_update parse error:', e);
    }
  }

  // ------------------------------------------------------------------
  // Reconnect & rekey
  // ------------------------------------------------------------------

  private _handleRekey(): void {
    this._rejectEncryptedAckWaiters(
      new SessionError('rekey invalidated in-flight encrypted commands'),
    );
    this._session.reset();
    this._setupHpkeSession().catch((e: unknown) => {
      const msg =
        e instanceof SessionError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      this._emitError(
        e instanceof SessionError
          ? e
          : new SessionError(`HPKE re-setup failed: ${msg}`),
      );
    });
  }

  private _onTransportDisconnect(): void {
    this._connected = false;
    this._resolveIteratorDisconnect();
    this._rejectPlaceOutcomeWaiters(
      new ConnectionError('connection lost while waiting for order confirmation'),
    );
    this._rejectEncryptedAckWaiters(
      new ConnectionError('connection lost while waiting for encrypted command ack'),
    );
    if (this._intentionalClose || !this._autoReconnect) return;
    this._scheduleReconnect();
  }

  private _resetDisconnectPromise(): void {
    this._disconnectPromise = new Promise<void>((r) => {
      this._resolveDisconnect = r;
    });
  }

  /** Wake async iterators waiting on `orderUpdates` / `positionUpdates` when the connection drops. */
  private _resolveIteratorDisconnect(): void {
    if (this._resolveDisconnect) this._resolveDisconnect();
  }

  private _scheduleReconnect(): void {
    const delay = Math.min(
      1000 * 2 ** this._reconnectAttempts,
      this._maxBackoff,
    );
    this._reconnectAttempts++;
    this._reconnectTimer = setTimeout(() => this._reconnectLoop(), delay);
  }

  private async _reconnectLoop(): Promise<void> {
    if (!this._autoReconnect || this._intentionalClose) return;

    try {
      this._transport = new EdgeTransport(
        wsUrl(this._baseUrl),
        this._transportOptions,
      );
      this._session.reset();
      await this.connect();

      if (this._desiredChannels.size > 0) {
        await this.subscribe([...this._desiredChannels]);
      }

      for (const cb of this._reconnectCallbacks) {
        try {
          cb();
        } catch {
          /* noop */
        }
      }
    } catch {
      this._scheduleReconnect();
    }
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private _ensureReady(): void {
    if (!this._connected) throw new ConnectionError('Not connected');
    if (this._userUuid === undefined)
      throw new ConnectionError('Not authenticated');
    if (!this._session.isEstablished)
      throw new SessionError('HPKE session not established');
  }

  private _resolveSymbol(symbol: string): number {
    return resolveSymbolId(symbol, this._symbolMap);
  }

  private _emitError(err: GodarkError): void {
    for (const cb of this._errorCallbacks) {
      try {
        cb(err);
      } catch {
        /* ignore callback errors */
      }
    }
  }
}
