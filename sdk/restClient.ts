import { userUuidFromAccessTokenJwt } from './accessToken.js';
import { RestTransport } from './restTransport.js';
import { resolvePassphrase, resolveHpkeStaticPublicKeyHex, Environment } from './client.js';
import { DEFAULT_SYMBOLS } from './symbols.js';
import { loadSymbolMapFromEdge } from './edgeInstruments.js';
import {
  EncryptionError,
  OrderError,
  SessionError,
  TimeoutError,
} from './errors.js';
import {
  infoForRestRequest,
  nonceFromU64,
  parsePinnedStaticPublicKeyHex,
  setupSession,
  TAG_LEN,
  type SealedSession,
} from './hpke.js';
import * as proto from './proto.js';
import type { BatchModifyLegInput, MassQuoteLegInput } from './proto.js';
import {
  makeOrderErrorFromCode,
  makeOrderErrorFromJson,
} from './orderErrorCode.js';
import type {
  AccountMarginUpdate,
  BatchCancelAck,
  BatchCancelLegResult,
  BatchModifyAck,
  BatchModifyLegResult,
  LeverageSetting,
  LeverageSettings,
  MassQuoteAck,
  MassQuoteLegResult,
  OpenOrdersSnapshot,
  OrderAck,
  PositionsSnapshot,
} from './types.js';
import {
  createBatchCancelAck,
  createBatchModifyAck,
  createLeverageSettings,
  createMassQuoteAck,
} from './types.js';
import type { OrderType, Side, TimeInForce } from './enums.js';

const GCM_TAG_LEN = TAG_LEN;

function resolveRestBaseUrl(explicit?: string): string {
  if (explicit && explicit.trim() !== '') return explicit.trim().replace(/\/+$/, '');
  const r = process.env.GODARK_REST_URL?.trim() || process.env.GDX_REST_URL?.trim();
  if (r) return r.replace(/\/+$/, '');
  const ws = process.env.GODARK_EDGE_URL?.trim() || process.env.GDX_EDGE_URL?.trim();
  if (ws) return wsOriginToHttp(ws);
  return 'https://api.godark-dex.com';
}

function wsOriginToHttp(wsUrl: string): string {
  let u = wsUrl.replace(/\/+$/, '');
  if (u.endsWith('/ws/v1')) u = u.slice(0, -'/ws/v1'.length);
  else if (u.endsWith('/ws')) u = u.slice(0, -'/ws'.length);
  if (u.startsWith('ws://')) return `http://${u.slice('ws://'.length)}`;
  if (u.startsWith('wss://')) return `https://${u.slice('wss://'.length)}`;
  return u;
}

/**
 * Infer Environment from REST origin host (testnet/devnet pins; localnet none).
 */
export function inferEnvironmentFromRestUrl(restBaseUrl: string): Environment {
  let host = restBaseUrl.trim().toLowerCase();
  for (const prefix of ['https://', 'http://', 'wss://', 'ws://'] as const) {
    if (host.startsWith(prefix)) {
      host = host.slice(prefix.length);
      break;
    }
  }
  host = host.split('/')[0]?.split(':')[0] ?? '';
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

function resolveConfigUserUuid(explicit?: string): string | undefined {
  if (explicit && explicit.trim() !== '') return explicit.trim();
  return process.env.GODARK_USER_UUID?.trim() || process.env.GDX_USER_UUID?.trim();
}

function correlationIdHeaderHex(correlationId: Uint8Array): string {
  if (correlationId.length !== 16) {
    return correlationId.length > 0 ? Buffer.from(correlationId).toString('hex') : '';
  }
  let value = 0n;
  for (const b of correlationId) value = (value << 8n) | BigInt(b);
  return value === 0n ? '' : value.toString(16).padStart(32, '0');
}

function hasEncrypted(raw: Record<string, unknown>): boolean {
  if (raw.encrypted === true) return true;
  if (typeof raw.encrypted_body === 'string' && raw.encrypted_body.length > 0) return true;
  if (typeof raw.ciphertext === 'string' && raw.ciphertext.length > 0) {
    return raw.header !== undefined || raw.message_type !== undefined;
  }
  return false;
}

function timestampNs(): number {
  return Number(process.hrtime.bigint());
}

export interface GodarkRestClientOptions {
  apiKey?: string;
  apiKeyId?: string;
  apiSecret?: string;
  /** User-chosen API key passphrase (required with key pair; also reads GODARK_PASSPHRASE / GDX_PASSPHRASE). */
  passphrase?: string;
  restBaseUrl?: string;
  /** Fallback when JWT omits sub (local edge). Also reads GODARK_USER_UUID / GDX_USER_UUID. */
  userUuid?: string;
  /** HPKE static public key hex pin; also reads GDX_HPKE_STATIC_PUBLIC_KEY / aliases. */
  hpkeStaticPublicKeyHex?: string;
  /**
   * Named deployment. When omitted, inferred from `restBaseUrl` via
   * {@link inferEnvironmentFromRestUrl} (localhost → Localnet, devnet host → Devnet, else Testnet).
   */
  environment?: Environment;
  symbolMap?: Record<string, number>;
}

type EncryptedRoute =
  | { kind: 'post_orders' }
  | { kind: 'post_leverage' }
  | { kind: 'post_path'; path: string }
  | { kind: 'delete'; orderId: string }
  | { kind: 'patch'; orderId: string };

export class GodarkRestClient {
  private readonly legacyAuthToken?: string;
  private readonly apiKeyId?: string;
  private readonly apiSecret?: string;
  private readonly passphrase?: string;
  private readonly http: RestTransport;
  private readonly symbolMap: Record<string, number>;
  private readonly userProvidedSymbolMap: boolean;
  private readonly configUserUuid?: string;
  private readonly hpkePinHex?: string;
  private bearer: string | undefined;
  private userUuid: string | undefined;
  private _tokenScope: string | undefined;
  private nextRequestId = 1;
  /** Populated after decrypting successful place ACKs; drives cancel-by-client without sentinel bodies. */
  private localCoidIndex = new Map<string, string>();

  constructor(opts: GodarkRestClientOptions) {
    if (opts.apiKeyId != null || opts.apiSecret != null) {
      if (!opts.apiKeyId || !opts.apiSecret) {
        throw new Error('apiKeyId and apiSecret must be provided together');
      }
      if (opts.apiKey != null) throw new Error('use apiKey or apiKeyId+apiSecret');
      const resolvedPassphrase = resolvePassphrase(opts.passphrase);
      if (!resolvedPassphrase) {
        throw new Error('passphrase is required when using apiKeyId and apiSecret');
      }
      this.apiKeyId = opts.apiKeyId;
      this.apiSecret = opts.apiSecret;
      this.passphrase = resolvedPassphrase;
    } else if (opts.apiKey != null) {
      if (opts.passphrase != null && opts.passphrase.trim() !== '') {
        throw new Error('passphrase must not be set when using legacy apiKey');
      }
      this.legacyAuthToken = opts.apiKey;
    } else {
      throw new Error('provide apiKey or apiKeyId+apiSecret');
    }
    const resolvedRestBase = resolveRestBaseUrl(opts.restBaseUrl);
    this.http = new RestTransport(resolvedRestBase);
    this.userProvidedSymbolMap = opts.symbolMap !== undefined;
    this.symbolMap = opts.symbolMap ?? { ...DEFAULT_SYMBOLS };
    this.configUserUuid = resolveConfigUserUuid(opts.userUuid);
    const environment =
      opts.environment ?? inferEnvironmentFromRestUrl(resolvedRestBase);
    this.hpkePinHex = resolveHpkeStaticPublicKeyHex(
      opts.hpkeStaticPublicKeyHex,
      environment,
    );
  }

  /** Load symbol map from edge when caller did not supply `symbolMap`. */
  async loadInstrumentsFromEdge(): Promise<void> {
    if (this.userProvidedSymbolMap) return;
    Object.assign(this.symbolMap, await loadSymbolMapFromEdge(this.http.origin));
  }

  async connect(): Promise<void> {
    await this.loadInstrumentsFromEdge();
    let auth: Record<string, unknown>;
    if (this.apiKeyId != null) {
      auth = await this.http.authTokenDocs({
        grant_type: 'client_credentials',
        client_id: this.apiKeyId,
        client_secret: this.apiSecret!,
        passphrase: this.passphrase!,
      });
    } else {
      auth = await this.http.authTokenLegacy(this.legacyAuthToken!);
    }
    const tok =
      (typeof auth.access_token === 'string' && auth.access_token) ||
      (typeof auth.token === 'string' && auth.token);
    if (!tok) throw new SessionError('auth/token missing token');
    this.bearer = tok;
    this._tokenScope = typeof auth.scope === 'string' ? auth.scope : undefined;

    let uid: string | undefined;
    if (typeof auth.user_uuid === 'string' && auth.user_uuid.trim()) {
      uid = auth.user_uuid.trim();
    } else {
      uid = userUuidFromAccessTokenJwt(tok);
    }
    if (!uid && this.configUserUuid) {
      uid = this.configUserUuid;
    }
    if (!uid) {
      throw new SessionError(
        'REST auth succeeded but user identity missing; JWT sub and fallback UUID both absent',
      );
    }
    this.userUuid = uid;
  }

  /** Authenticated user UUID from JWT `sub` or auth response. */
  get authenticatedUserUuid(): string | undefined {
    return this.userUuid;
  }

  /** JWT scope from auth/token (e.g. `read` or `trade`). */
  get tokenScope(): string | undefined {
    return this._tokenScope;
  }

  async disconnect(): Promise<void> {
    try {
      if (this.bearer) await this.http.revokeToken(this.bearer);
    } finally {
      this.bearer = undefined;
      this.userUuid = undefined;
      this._tokenScope = undefined;
      this.nextRequestId = 1;
      this.localCoidIndex.clear();
    }
  }

  private ensureAuthenticated(): void {
    if (!this.bearer) throw new SessionError('Not connected');
    if (!this.userUuid) throw new SessionError('Not authenticated');
  }

  private ensureReady(): void {
    this.ensureAuthenticated();
    if (!this.hpkePinHex?.trim()) {
      throw new SessionError(
        'HPKE static public key unset — pass hpkeStaticPublicKeyHex or set GDX_HPKE_STATIC_PUBLIC_KEY',
      );
    }
  }

  private userUuidBytes(): Uint8Array {
    if (!this.userUuid) throw new SessionError('Not authenticated');
    return proto.uuidStringToBytes(this.userUuid);
  }

  private resolveSymbol(symbol: string): number {
    const sid = this.symbolMap[symbol];
    if (sid === undefined) throw new OrderError(`unknown symbol: ${symbol}`);
    return sid;
  }

  private headerSymbolIdForSnapshots(): number {
    if (this.symbolMap['BTC-USDC-PERP'] !== undefined) return this.symbolMap['BTC-USDC-PERP'];
    for (const id of Object.values(this.symbolMap)) return id;
    return 1;
  }

  private async setupOneShotHpke(): Promise<{
    encappedKey: Uint8Array;
    sealed: SealedSession;
    requestId: number;
  }> {
    const pin = this.hpkePinHex!.trim();
    const recipient = parsePinnedStaticPublicKeyHex(pin);
    const requestId = this.nextRequestId++;
    const info = infoForRestRequest(this.userUuidBytes(), requestId);
    const { encappedKey, session } = await setupSession(recipient, info);
    return { encappedKey, sealed: session, requestId };
  }

  private decryptRestBody(sealed: SealedSession, msg: Record<string, unknown>): Uint8Array {
    const ctB64 =
      (typeof msg.encrypted_body === 'string' && msg.encrypted_body) ||
      (typeof msg.ciphertext === 'string' && msg.ciphertext) ||
      '';
    const ct = Buffer.from(ctB64, 'base64');
    const nonce = Number(msg.nonce ?? 0);
    const messageType = typeof msg.message_type === 'string' ? msg.message_type : 'ack';
    const fencingEpoch = Number(msg.fencing_epoch ?? 0);
    const aad = proto.buildResponseHeaderAad({
      userUuid: this.userUuidBytes(),
      messageType,
      bodyLength: ct.length,
      nonce,
      fencingEpoch,
      correlationIdBytes: proto.correlationIdFromPushWire(
        msg.correlation_id as string | number | bigint | undefined,
      ),
      sessionSeq: proto.sessionSeqFromPushWire(
        msg.session_seq as string | number | bigint | undefined,
      ),
      connId: 0,
    });
    try {
      return sealed.openS2c(nonceFromU64(nonce), aad, ct);
    } catch (e) {
      throw new EncryptionError(`Failed to decrypt REST reply: ${String(e)}`);
    }
  }

  private decryptRestAck(sealed: SealedSession, msg: Record<string, unknown>): OrderAck {
    const plaintext = this.decryptRestBody(sealed, msg);
    const ackDict = proto.parseNodeResponse(plaintext);
    if (ackDict.type !== 'ack') {
      throw new OrderError(`Expected ack, got ${String(ackDict.type)}`);
    }
    if (!ackDict.success || (ackDict.error_code !== undefined && ackDict.order_id === '0')) {
      if (ackDict.error_code !== undefined) {
        throw makeOrderErrorFromCode(Number(ackDict.error_code), String(ackDict.reject_text ?? ''));
      }
      throw makeOrderErrorFromJson(String(ackDict.reject_text ?? 'order rejected'), undefined);
    }
    return {
      orderId: String(ackDict.order_id ?? ''),
      success: true,
      sequence: String(ackDict.sequence ?? ''),
    };
  }

  private parseAck(raw: Record<string, unknown>, sealed?: SealedSession): OrderAck {
    if (hasEncrypted(raw)) {
      if (!sealed) throw new EncryptionError('encrypted REST ack requires one-shot HPKE session');
      return this.decryptRestAck(sealed, raw);
    }
    if (raw.success === false) {
      throw makeOrderErrorFromJson(
        String(raw.error ?? 'order rejected'),
        typeof raw.error_code === 'string' ? raw.error_code : undefined,
      );
    }
    return {
      orderId: String(raw.order_id ?? ''),
      success: true,
      sequence: String(raw.sequence ?? ''),
    };
  }

  private async sendEncryptedEnvelope(
    requestType: string,
    symbolId: number,
    plaintext: Uint8Array,
    correlationId: Uint8Array,
    route: EncryptedRoute,
    opts?: { clientOrderId?: string; headerLeverage?: number },
  ): Promise<{ sealed: SealedSession; raw: Record<string, unknown> }> {
    this.ensureReady();
    const { encappedKey, sealed, requestId } = await this.setupOneShotHpke();
    const nonce = 0;
    const bodyLength = plaintext.length + GCM_TAG_LEN;
    const aad = proto.buildOrderHeaderAad({
      userUuid: this.userUuidBytes(),
      symbolId,
      requestType,
      nonce,
      bodyLength,
      correlationId,
      connId: 0,
    });
    const ciphertext = sealed.sealC2s(nonceFromU64(nonce), aad, plaintext);
    const header: Record<string, unknown> = {
      symbol_id: symbolId,
      request_type: requestType,
      nonce,
      body_length: bodyLength,
    };
    const corrHex = correlationIdHeaderHex(correlationId);
    if (corrHex) header.correlation_id = corrHex;
    if (opts?.headerLeverage !== undefined) header.leverage = opts.headerLeverage;

    const body: Record<string, unknown> = {
      header,
      encrypted_body: Buffer.from(ciphertext).toString('base64'),
      encapped_key: Buffer.from(encappedKey).toString('base64'),
      request_id: requestId,
    };
    if (opts?.clientOrderId) body.client_order_id = opts.clientOrderId;

    let raw: Record<string, unknown>;
    switch (route.kind) {
      case 'post_orders':
        raw = await this.http.postOrdersEncrypted(this.bearer!, body);
        break;
      case 'post_leverage':
        raw = await this.http.postLeverageEncrypted(this.bearer!, body);
        break;
      case 'post_path':
        raw = await this.http.postEncrypted(this.bearer!, route.path, body);
        break;
      case 'delete':
        raw = await this.http.deleteOrdersEncrypted(this.bearer!, route.orderId, body);
        break;
      case 'patch':
        raw = await this.http.patchOrdersEncrypted(this.bearer!, route.orderId, body);
        break;
    }
    return { sealed, raw };
  }

  private async sendEncrypted(
    requestType: string,
    symbolId: number,
    plaintext: Uint8Array,
    correlationId: Uint8Array,
    route: EncryptedRoute,
    opts?: { clientOrderId?: string; headerLeverage?: number },
  ): Promise<OrderAck> {
    const { sealed, raw } = await this.sendEncryptedEnvelope(
      requestType,
      symbolId,
      plaintext,
      correlationId,
      route,
      opts,
    );
    return this.parseAck(raw, sealed);
  }

  private decryptRestNodeResponse(sealed: SealedSession, msg: Record<string, unknown>) {
    const plaintext = this.decryptRestBody(sealed, msg);
    const messageType = typeof msg.message_type === 'string' ? msg.message_type : undefined;
    return proto.parseNodeResponseSnapshot(plaintext, messageType);
  }

  private async snapshotRpc<T>(
    requestType: string,
    buildProto: (userUuid: Uint8Array, correlationId: Uint8Array) => Uint8Array,
    path: string,
    expectedVariant: string,
  ): Promise<T> {
    this.ensureReady();
    const corr = proto.newCorrelationIdWire();
    const plaintext = buildProto(this.userUuidBytes(), corr.bodyBytes);
    const symbolId = this.headerSymbolIdForSnapshots();
    const { sealed, raw } = await this.sendEncryptedEnvelope(
      requestType,
      symbolId,
      plaintext,
      corr.aadBytes,
      { kind: 'post_path', path },
    );
    if (!hasEncrypted(raw)) {
      throw new OrderError(`expected encrypted snapshot reply for ${requestType}`);
    }
    const [variant, parsed] = this.decryptRestNodeResponse(sealed, raw);
    const ok =
      variant === expectedVariant ||
      (expectedVariant === 'account_margin_update' && variant === 'account_update');
    if (!ok) {
      throw new OrderError(`expected ${expectedVariant}, got ${variant}`);
    }
    return parsed as T;
  }

  async getOpenOrders(): Promise<OpenOrdersSnapshot> {
    return this.snapshotRpc(
      'get_open_orders',
      (userUuid, correlationIdBytes) =>
        proto.buildGetOpenOrdersProto({ userUuid, correlationIdBytes }),
      '/api/v1/openOrders',
      'open_orders_snapshot',
    );
  }

  async getPositions(): Promise<PositionsSnapshot> {
    return this.snapshotRpc(
      'get_positions',
      (userUuid, correlationIdBytes) =>
        proto.buildGetPositionsProto({ userUuid, correlationIdBytes }),
      '/api/v1/positions',
      'positions_snapshot',
    );
  }

  async getAccount(): Promise<AccountMarginUpdate> {
    return this.snapshotRpc(
      'get_account',
      (userUuid, correlationIdBytes) =>
        proto.buildGetAccountProto({ userUuid, correlationIdBytes }),
      '/api/v1/account',
      'account_margin_update',
    );
  }

  async placeOrder(
    symbol: string,
    side: Side | string,
    opts: {
      quantity: number;
      type?: OrderType | string;
      orderType?: OrderType | string;
      price?: number;
      timeInForce?: TimeInForce | string;
      aon?: boolean;
      minFillSize?: number;
      expiryTime?: number;
      clientOrderId?: string;
    },
  ): Promise<OrderAck> {
    const symbolId = this.resolveSymbol(symbol);
    const corr = proto.newCorrelationIdWire();
    const orderType = opts.orderType ?? opts.type ?? 'LIMIT';
    const plaintext = proto.buildPlaceOrderProto({
      symbolId,
      side: String(side),
      orderType: String(orderType),
      quantity: opts.quantity,
      userUuid: this.userUuidBytes(),
      price: opts.price,
      timeInForce: opts.timeInForce,
      aon: opts.aon,
      minFillSize: opts.minFillSize,
      expiryTime: opts.expiryTime,
      correlationIdBytes: corr.bodyBytes,
      timestamp: timestampNs(),
    });
    const ack = await this.sendEncrypted('place', symbolId, plaintext, corr.aadBytes, { kind: 'post_orders' }, {
      clientOrderId: opts.clientOrderId,
    });
    if (opts.clientOrderId && ack.success && ack.orderId) {
      this.localCoidIndex.set(opts.clientOrderId, ack.orderId);
      try {
        await this.http.registerClientOrderMapping(this.bearer!, opts.clientOrderId, ack.orderId);
      } catch {
        // best-effort
      }
    }
    return ack;
  }

  async cancelOrder(orderId: string, symbol = 'BTC-USDC-PERP'): Promise<OrderAck> {
    const symbolId = this.resolveSymbol(symbol);
    const corr = proto.newCorrelationIdWire();
    const plaintext = proto.buildCancelOrderProto({
      orderId,
      userUuid: this.userUuidBytes(),
      symbolId,
      correlationIdBytes: corr.bodyBytes,
    });
    return this.sendEncrypted('cancel', symbolId, plaintext, corr.aadBytes, {
      kind: 'delete',
      orderId,
    });
  }

  async cancelOrderByClientId(clientOrderId: string, symbol = 'BTC-USDC-PERP'): Promise<OrderAck> {
    const cached = this.localCoidIndex.get(clientOrderId);
    if (cached) return this.cancelOrder(cached, symbol);
    const row = await this.getOrderByClientOrderId(clientOrderId);
    const orderId = String(row.order_id ?? row.orderId ?? '');
    if (!orderId) throw new OrderError('unknown client_order_id');
    this.localCoidIndex.set(clientOrderId, orderId);
    return this.cancelOrder(orderId, symbol);
  }

  async modifyOrder(
    orderId: string,
    symbol = 'BTC-USDC-PERP',
    mod: { newPrice?: number; newQuantity?: number },
  ): Promise<OrderAck> {
    const symbolId = this.resolveSymbol(symbol);
    const corr = proto.newCorrelationIdWire();
    const plaintext = proto.buildModifyOrderProto({
      orderId,
      userUuid: this.userUuidBytes(),
      symbolId,
      newPrice: mod.newPrice,
      newQuantity: mod.newQuantity,
      correlationIdBytes: corr.bodyBytes,
    });
    return this.sendEncrypted('modify', symbolId, plaintext, corr.aadBytes, {
      kind: 'patch',
      orderId,
    });
  }

  async getOrder(orderId: string): Promise<Record<string, unknown>> {
    this.ensureAuthenticated();
    return this.http.getOrder(this.bearer!, orderId);
  }

  async getOrderByClientOrderId(clientOrderId: string): Promise<Record<string, unknown>> {
    this.ensureAuthenticated();
    return this.http.getOrderByClientOrderId(this.bearer!, clientOrderId);
  }

  /** `GET /api/v1/market-data/funding-rates` — public; no connect required. */
  async getFundingRates(): Promise<unknown[]> {
    return this.http.getFundingRates();
  }

  /** `GET /api/v1/market-data/open-interest` — public; no connect required. */
  async getOpenInterest(): Promise<unknown[]> {
    return this.http.getOpenInterest();
  }

  /** `GET /api/v1/market-data/volume` — public; no connect required. */
  async getVolume(): Promise<Record<string, unknown>> {
    return this.http.getVolume();
  }

  /** `GET /api/v1/leverage` — per-symbol leverage settings snapshot. */
  async getLeverage(): Promise<LeverageSettings> {
    this.ensureAuthenticated();
    const raw = await this.http.getLeverage(this.bearer!);
    const rows = Array.isArray(raw.settings) ? raw.settings : [];
    const settings: LeverageSetting[] = rows
      .map((row) => {
        if (!row || typeof row !== 'object') return null;
        const m = row as Record<string, unknown>;
        const symbolId = Number(m.symbol_id ?? m.symbolId);
        const leverage = Number(m.leverage);
        if (!Number.isFinite(symbolId) || !Number.isFinite(leverage)) return null;
        return { symbolId, leverage };
      })
      .filter((row): row is LeverageSetting => row !== null);
    return createLeverageSettings({ settings });
  }

  async updateLeverage(symbol: string, leverage: number): Promise<OrderAck> {
    const symbolId = this.resolveSymbol(symbol);
    const corr = proto.newCorrelationIdWire();
    const plaintext = proto.buildUpdateLeverageProto({
      userUuid: this.userUuidBytes(),
      symbolId,
      leverage,
      correlationIdBytes: corr.bodyBytes,
    });
    return this.sendEncrypted(
      'update_leverage',
      symbolId,
      plaintext,
      corr.aadBytes,
      { kind: 'post_leverage' },
      { headerLeverage: Math.max(1, Math.floor(leverage)) },
    );
  }

  private parseMassQuoteRest(sealed: SealedSession, raw: Record<string, unknown>): MassQuoteAck {
    const plaintext = this.decryptRestBody(sealed, raw);
    const parsed = proto.parseMassQuoteAck(plaintext);
    if (parsed.type !== 'mass_quote_ack') {
      const reject = proto.parseNodeResponse(plaintext);
      if (reject.type === 'ack' && reject.success === false) {
        throw makeOrderErrorFromJson(
          String(reject.reject_text ?? 'order rejected'),
          reject.error_code != null ? String(reject.error_code) : undefined,
        );
      }
      throw new OrderError(`Expected mass_quote_ack, got ${String(parsed.type)}`);
    }
    const rawResults = (parsed.results ?? []) as Array<Record<string, unknown>>;
    const results: MassQuoteLegResult[] = rawResults.map((r) => ({
      legIndex: Number(r.leg_index),
      status: r.status as MassQuoteLegResult['status'],
      cancelledOrderId:
        r.cancelled_order_id !== undefined ? String(r.cancelled_order_id) : undefined,
      newOrderId: r.new_order_id !== undefined ? String(r.new_order_id) : undefined,
      errorCode: r.error_code !== undefined ? Number(r.error_code) : undefined,
      fillCount: r.fill_count !== undefined ? Number(r.fill_count) : 0,
    }));
    const success = results.length > 0 && results.every((r) => r.status !== 'failed');
    return createMassQuoteAck({
      success,
      sequence: String(parsed.sequence ?? ''),
      results,
    });
  }

  private parseBatchCancelRest(sealed: SealedSession, raw: Record<string, unknown>): BatchCancelAck {
    const plaintext = this.decryptRestBody(sealed, raw);
    const parsed = proto.parseBatchCancelAck(plaintext);
    if (parsed.type !== 'batch_cancel_ack') {
      const reject = proto.parseNodeResponse(plaintext);
      if (reject.type === 'ack' && reject.success === false) {
        throw makeOrderErrorFromJson(
          String(reject.reject_text ?? 'order rejected'),
          reject.error_code != null ? String(reject.error_code) : undefined,
        );
      }
      throw new OrderError(`Expected batch_cancel_ack, got ${String(parsed.type)}`);
    }
    const rawResults = (parsed.results ?? []) as Array<Record<string, unknown>>;
    const results: BatchCancelLegResult[] = rawResults.map((r) => ({
      orderId: String(r.order_id ?? ''),
      cancelled: Boolean(r.cancelled),
      errorCode: r.error_code !== undefined ? Number(r.error_code) : undefined,
    }));
    const success = results.length > 0 && results.every((r) => r.cancelled);
    return createBatchCancelAck({ success, sequence: String(parsed.sequence ?? ''), results });
  }

  private parseBatchModifyRest(sealed: SealedSession, raw: Record<string, unknown>): BatchModifyAck {
    const plaintext = this.decryptRestBody(sealed, raw);
    const parsed = proto.parseBatchModifyAck(plaintext);
    if (parsed.type !== 'batch_modify_ack') {
      const reject = proto.parseNodeResponse(plaintext);
      if (reject.type === 'ack' && reject.success === false) {
        throw makeOrderErrorFromJson(
          String(reject.reject_text ?? 'order rejected'),
          reject.error_code != null ? String(reject.error_code) : undefined,
        );
      }
      throw new OrderError(`Expected batch_modify_ack, got ${String(parsed.type)}`);
    }
    const rawResults = (parsed.results ?? []) as Array<Record<string, unknown>>;
    const results: BatchModifyLegResult[] = rawResults.map((r) => ({
      orderId: String(r.order_id ?? ''),
      modified: Boolean(r.modified),
      errorCode: r.error_code !== undefined ? Number(r.error_code) : undefined,
    }));
    const success = results.length > 0 && results.every((r) => r.modified);
    return createBatchModifyAck({ success, sequence: String(parsed.sequence ?? ''), results });
  }

  async massQuote(
    symbol: string,
    legs: MassQuoteLegInput[],
    postOnly?: boolean,
  ): Promise<MassQuoteAck> {
    const symbolId = this.resolveSymbol(symbol);
    const corr = proto.newCorrelationIdWire();
    const plaintext = proto.buildMassQuoteProto({
      symbolId,
      userUuid: this.userUuidBytes(),
      legs,
      correlationIdBytes: corr.bodyBytes,
      postOnly,
    });
    const { sealed, raw } = await this.sendEncryptedEnvelope(
      'mass_quote',
      symbolId,
      plaintext,
      corr.aadBytes,
      { kind: 'post_path', path: '/api/v1/orders/massQuote' },
    );
    return this.parseMassQuoteRest(sealed, raw);
  }

  async batchCancel(symbol: string, orderIds: Array<number | bigint | string>): Promise<BatchCancelAck> {
    const symbolId = this.resolveSymbol(symbol);
    const corr = proto.newCorrelationIdWire();
    const plaintext = proto.buildBatchCancelProto({
      symbolId,
      userUuid: this.userUuidBytes(),
      orderIds,
      correlationIdBytes: corr.bodyBytes,
    });
    const { sealed, raw } = await this.sendEncryptedEnvelope(
      'batch_cancel',
      symbolId,
      plaintext,
      corr.aadBytes,
      { kind: 'post_orders' },
    );
    return this.parseBatchCancelRest(sealed, raw);
  }

  async batchModify(symbol: string, legs: BatchModifyLegInput[]): Promise<BatchModifyAck> {
    const symbolId = this.resolveSymbol(symbol);
    const corr = proto.newCorrelationIdWire();
    const plaintext = proto.buildBatchModifyProto({
      symbolId,
      userUuid: this.userUuidBytes(),
      legs,
      correlationIdBytes: corr.bodyBytes,
    });
    const { sealed, raw } = await this.sendEncryptedEnvelope(
      'batch_modify',
      symbolId,
      plaintext,
      corr.aadBytes,
      { kind: 'post_orders' },
    );
    return this.parseBatchModifyRest(sealed, raw);
  }

  async awaitTerminalStatus(orderId: string, timeoutSec = 120): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutSec * 1000;
    const terminal = new Set(['FILLED', 'CANCELLED', 'REJECTED']);
    while (Date.now() < deadline) {
      const row = await this.getOrder(orderId);
      const st = String(row.status ?? '').toUpperCase();
      if (terminal.has(st)) return row;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new TimeoutError(`order ${orderId} did not reach terminal status`);
  }
}
