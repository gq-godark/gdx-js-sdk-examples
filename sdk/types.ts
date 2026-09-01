import type {
  Side,
  OrderStatus,
  OrderUpdateType,
  PositionUpdateType,
  CancelReason,
  StpMode,
} from './enums.js';
import type { HealthReport } from './generated/gdx/health/v1/health_pb.js';

/**
 * Reason the sequencer emitted a {@link PositionsSnapshot}.
 *
 * Mirrors `gdx.common.v1.PositionsSnapshotSource` so the JS SDK can carry
 * the same hint Python / Go / Rust / Java surface to downstream consumers
 * (e.g. demuxing an initial `SubscribePositions` reply from a periodic
 * sweep refresh).
 */
export type PositionsSnapshotSource =
  | 'UNSPECIFIED'
  | 'INITIAL'
  | 'PERIODIC'
  | 'EVENT';

/**
 * Lifecycle status of a settlement batch reported via
 * {@link SettlementUpdate}. Mirrors `gdx.sequencer.v1.SettlementBatchStatus`.
 */
export type SettlementBatchStatus =
  | 'UNSPECIFIED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'FAILED';

export interface OrderAck {
  readonly orderId: string;
  readonly success: boolean;
  readonly sequence: string;
  readonly errorCode?: string;
  readonly error?: string;
}

export type MassQuoteLegStatusName =
  | 'open'
  | 'filled'
  | 'failed'
  | 'unspecified'
  | 'unknown';

export interface MassQuoteLegResult {
  readonly legIndex: number;
  readonly status: MassQuoteLegStatusName;
  readonly cancelledOrderId?: string;
  readonly newOrderId?: string;
  readonly errorCode?: number;
  /**
   * Number of taker fills this leg produced in relaxed (postOnly=false) mode;
   * 0 for a pure rest or a post-only leg.
   */
  readonly fillCount: number;
}

export interface MassQuoteAck {
  readonly success: boolean;
  readonly sequence: string;
  readonly results: readonly MassQuoteLegResult[];
}

export interface BatchCancelLegResult {
  readonly orderId: string;
  readonly cancelled: boolean;
  readonly errorCode?: number;
}

export interface BatchCancelAck {
  readonly success: boolean;
  readonly sequence: string;
  readonly results: readonly BatchCancelLegResult[];
}

export interface BatchModifyLegResult {
  readonly orderId: string;
  readonly modified: boolean;
  readonly errorCode?: number;
}

export interface BatchModifyAck {
  readonly success: boolean;
  readonly sequence: string;
  readonly results: readonly BatchModifyLegResult[];
}

/** Ack for account-wide `cancel_all` / `close_all` or per-symbol `reverse`. */
export interface CountAck {
  readonly sequence: string;
  readonly count: number;
  readonly orderIds: readonly string[];
  readonly errorCode?: number;
  readonly rejectText?: string;
}

/** RPC reply for amend / cancel TP-SL (`NodeResponse.tpsl_ack`). */
export interface TpslAck {
  readonly parentOrderId: string;
  readonly takeProfit?: string;
  readonly stopLoss?: string;
  readonly errorCode?: number;
  readonly rejectText?: string;
}

/** Optional place-order flags mirrored from gdx-web / `PlaceOrderInput`. */
export interface PlaceOrderOptions {
  readonly reduceOnly?: boolean;
  readonly postOnly?: boolean;
  readonly stpMode?: StpMode;
  /** Signed bps vs Pyth mark for `PEG` orders (mutually exclusive with absolute `price` offset). */
  readonly pegOffsetBps?: number;
  /** Mark trigger for `STOP_MARKET` / `STOP_LIMIT` orders. */
  readonly triggerPrice?: number;
}

export function createCountAck(params: {
  sequence: string;
  count: number;
  orderIds?: readonly string[];
  errorCode?: number;
  rejectText?: string;
}): CountAck {
  return Object.freeze({
    sequence: params.sequence,
    count: params.count,
    orderIds: Object.freeze([...(params.orderIds ?? [])]),
    ...(params.errorCode !== undefined ? { errorCode: params.errorCode } : {}),
    ...(params.rejectText !== undefined ? { rejectText: params.rejectText } : {}),
  });
}

export function createTpslAck(params: {
  parentOrderId: string;
  takeProfit?: string;
  stopLoss?: string;
  errorCode?: number;
  rejectText?: string;
}): TpslAck {
  return Object.freeze({
    parentOrderId: params.parentOrderId,
    ...(params.takeProfit !== undefined ? { takeProfit: params.takeProfit } : {}),
    ...(params.stopLoss !== undefined ? { stopLoss: params.stopLoss } : {}),
    ...(params.errorCode !== undefined ? { errorCode: params.errorCode } : {}),
    ...(params.rejectText !== undefined ? { rejectText: params.rejectText } : {}),
  });
}

export interface OrderUpdate {
  readonly orderId: string;
  readonly userUuid: string;
  readonly symbolId: number;
  readonly side: Side;
  readonly status: OrderStatus;
  readonly updateType: OrderUpdateType;
  readonly price: string;
  readonly quantity: string;
  readonly filledQty: string;
  readonly remainingQty: string;
  readonly cumFill: string;
  readonly cancelReason?: CancelReason;
  readonly rejectReason?: string;
  /** Optional human reject detail from `OrderUpdateMessage.msg` / ack `reject_text`. */
  readonly msg?: string;
  readonly reduceOnly?: boolean;
  readonly postOnly?: boolean;
  readonly correlationId: number;
  readonly timestamp: number;
}

export interface PositionUpdate {
  readonly userUuid: string;
  readonly symbolId: number;
  readonly side: Side;
  readonly updateType: PositionUpdateType;
  readonly size: string;
  readonly entryPrice: string;
  readonly previousSize: string;
  readonly fillPrice: string;
  readonly fillQty: string;
  readonly correlationId: number;
  readonly timestamp: number;
}

export function createOrderAck(params: {
  orderId: string;
  success: boolean;
  sequence: string;
  errorCode?: string;
  error?: string;
}): OrderAck {
  return Object.freeze({ ...params });
}

export function createMassQuoteAck(params: {
  success: boolean;
  sequence: string;
  results: MassQuoteLegResult[];
}): MassQuoteAck {
  return Object.freeze({
    success: params.success,
    sequence: params.sequence,
    results: Object.freeze([...params.results]),
  });
}

export function createBatchCancelAck(params: {
  success: boolean;
  sequence: string;
  results: BatchCancelLegResult[];
}): BatchCancelAck {
  return Object.freeze({
    success: params.success,
    sequence: params.sequence,
    results: Object.freeze([...params.results]),
  });
}

export function createBatchModifyAck(params: {
  success: boolean;
  sequence: string;
  results: BatchModifyLegResult[];
}): BatchModifyAck {
  return Object.freeze({
    success: params.success,
    sequence: params.sequence,
    results: Object.freeze([...params.results]),
  });
}

export function createOrderUpdate(params: {
  orderId: string;
  userUuid: string;
  symbolId: number;
  side: Side;
  status: OrderStatus;
  updateType: OrderUpdateType;
  price: string;
  quantity: string;
  filledQty: string;
  remainingQty: string;
  cumFill: string;
  cancelReason?: CancelReason;
  rejectReason?: string;
  msg?: string;
  reduceOnly?: boolean;
  postOnly?: boolean;
  correlationId?: number;
  timestamp?: number;
}): OrderUpdate {
  return Object.freeze({
    ...params,
    reduceOnly: params.reduceOnly ?? false,
    postOnly: params.postOnly ?? false,
    correlationId: params.correlationId ?? 0,
    timestamp: params.timestamp ?? 0,
  });
}

export function createPositionUpdate(params: {
  userUuid: string;
  symbolId: number;
  side: Side;
  updateType: PositionUpdateType;
  size: string;
  entryPrice: string;
  previousSize: string;
  fillPrice: string;
  fillQty: string;
  correlationId?: number;
  timestamp?: number;
}): PositionUpdate {
  return Object.freeze({
    ...params,
    correlationId: params.correlationId ?? 0,
    timestamp: params.timestamp ?? 0,
  });
}

// ---------------------------------------------------------------------------
// NodeResponse push surface (encrypted, non-SequencerToEdgeMessage)
//
// Wire definition:
//   - OpenOrdersSnapshot — gdx.sequencer.v1.OpenOrdersSnapshot inside NodeResponse
// ---------------------------------------------------------------------------

/** One resting order row inside an {@link OpenOrdersSnapshot}. */
export interface OpenOrderRow {
  readonly orderId: string;
  readonly symbolId: number;
  readonly leverage: number;
  readonly price: string;
  readonly quantity: string;
  readonly remainingQty: string;
}

/**
 * Encrypted `NodeResponse::OpenOrdersSnapshot` push (subscribe / UpdateLeverage
 * refresh). Carries the caller's working orders so the UI can reconcile resting
 * orders after leverage changes.
 */
export interface OpenOrdersSnapshot {
  readonly rows: ReadonlyArray<OpenOrderRow>;
  readonly serverTimestamp: number;
  readonly correlationId: number;
}

export function createOpenOrderRow(params: {
  orderId: string;
  symbolId: number;
  leverage: number;
  price?: string;
  quantity?: string;
  remainingQty?: string;
}): OpenOrderRow {
  return Object.freeze({
    orderId: params.orderId,
    symbolId: params.symbolId,
    leverage: params.leverage,
    price: params.price ?? '',
    quantity: params.quantity ?? '',
    remainingQty: params.remainingQty ?? '',
  });
}

export function createOpenOrdersSnapshot(params: {
  rows: ReadonlyArray<OpenOrderRow>;
  serverTimestamp?: number;
  correlationId?: number;
}): OpenOrdersSnapshot {
  return Object.freeze({
    rows: Object.freeze(params.rows.slice()),
    serverTimestamp: params.serverTimestamp ?? 0,
    correlationId: params.correlationId ?? 0,
  });
}

// ---------------------------------------------------------------------------
// Extended push surface
//
// The following types mirror the new `SequencerToEdgeMessage` inner cases
// surfaced by Python (`prod-readiness`), Go (`main`), Rust (PR #3), and
// C++ (PR #4). Before this batch, the JS SDK only typed `OrderUpdate` and
// `PositionUpdate`; the sequencer was already emitting these other push
// variants, but the JS handler silently dropped their decrypted payloads.
//
// Wire definitions:
//   - PositionsSnapshot        — gdx.sequencer.v1.PositionsSnapshot
//   - PositionRow              — gdx.sequencer.v1.PositionRow
//   - SystemHealthUpdate       — gdx.health.v1.HealthReport
//   - BalanceUpdate            — gdx.sequencer.v1.BalanceUpdateMessage
//   - MarginAlert              — gdx.sequencer.v1.MarginAlertMessage
//   - FundingRateUpdate        — gdx.sequencer.v1.FundingRateUpdateMessage
//   - SettlementUpdate         — gdx.sequencer.v1.SettlementUpdateMessage
// ---------------------------------------------------------------------------

/**
 * One position inside a {@link PositionsSnapshot} batch. All decimal fields
 * are stringified at `2 * decimal_places` precision. The optional
 * `markPrice` / `unrealizedPnl` / `notional` / `markPublishTimeSec` are
 * absent when no Pyth tick has yet been observed for this symbol — the
 * frontend should render dependent columns as "—" in that case.
 */
export interface PositionRow {
  readonly symbolId: number;
  readonly side: Side;
  readonly size: string;
  readonly entryPrice: string;
  readonly leverage: number;
  readonly markPrice?: string;
  readonly unrealizedPnl?: string;
  readonly notional?: string;
  readonly markPublishTimeSec?: number;
}

/**
 * Full-user positions batch. Emitted on subscribe (`source = INITIAL`),
 * every 5s (`source = PERIODIC`), and on fill / flip / close events
 * (`source = EVENT`). The `correlationId` is echoed only for `INITIAL`
 * snapshots so the client can demux against a pending
 * `SubscribePositions` request.
 */
export interface PositionsSnapshot {
  readonly userUuid: string;
  readonly rows: ReadonlyArray<PositionRow>;
  readonly serverTimestamp: number;
  readonly source: PositionsSnapshotSource;
  readonly correlationId?: number;
}

/** Unified health report emitted by the sequencer. */
export type SystemHealthUpdate = HealthReport;

/** Trading-collateral balance snapshot. Mirrors `BalanceUpdateMessage`. */
export interface BalanceUpdate {
  readonly userUuid: string;
  /** Collateral in SPL raw token units (6 dp). */
  readonly balanceRaw: bigint;
  readonly timestamp: number;
  /** Human-readable internal USDT collateral. */
  readonly balance: string;
  /** Signed internal 8dp balance (can be negative). */
  readonly signedBalance8dp: bigint;
  /** Committed residual in internal 8dp (no uPnL). */
  readonly freeCollateral8dp: bigint;
}

/**
 * Margin-tier transition. Mirrors `MarginAlertMessage`. When `recovered`
 * is true the position returned to `Healthy` and the UI should clear the
 * tier badge for this `(owner, symbolId)`; `tier` is the unspecified
 * sentinel in that case.
 */
export interface MarginAlert {
  readonly owner: string;
  readonly symbolId: number;
  readonly tier: number;
  readonly marginRatioBps: number;
  readonly markPrice: string;
  readonly liquidationPrice: string;
  readonly ts: bigint;
  readonly stateVersion: bigint;
  readonly recovered: boolean;
}

/** Per-symbol funding-rate tick. Mirrors `FundingRateUpdateMessage`. */
export interface FundingRateUpdate {
  readonly symbolId: number;
  /** In-progress hourly rate (TWAP / 8), decimal fraction. */
  readonly fundingRate: string;
  readonly timestamp: number;
  /** Last applied hourly rate, decimal fraction. */
  readonly lastFundingRate: string;
}

/** Authoritative account-level margin summary (decimal strings). */
export interface AccountMarginSummary {
  readonly totalCollateral: string;
  readonly positionMargin: string;
  readonly reservedOrderMargin: string;
  readonly freeCollateral: string;
  /** Isolated cash locks (no UPL). */
  readonly isolatedMargin: string;
  /** Isolated cash + isolated UPL, floored per position. */
  readonly isolatedEquity: string;
  /** Cross position IM (no order holds). */
  readonly crossIm: string;
}

/** Account-margin push / snapshot for a user. */
export interface AccountMarginUpdate {
  readonly userUuid: string;
  readonly serverTimestamp: number;
  readonly account?: AccountMarginSummary;
}

/**
 * Settlement-batch lifecycle event. Mirrors `SettlementUpdateMessage`.
 * `affectedUserUuids` is the canonical list the batch operated on so the
 * SDK can route filters by UUID without re-reading the batch contents.
 */
export interface SettlementUpdate {
  readonly batchId: bigint;
  readonly status: SettlementBatchStatus;
  readonly txSignature: string;
  readonly timestamp: number;
  readonly affectedUserUuids: ReadonlyArray<string>;
}

/**
 * Tagged union covering every parsed `SequencerToEdgeMessage` inner case
 * the SDK currently understands. Returned by
 * {@link parseSequencerToEdgeMessage}; clients consume it via the
 * per-type `on*` callbacks or the per-type async iterators on
 * `GodarkClient`.
 *
 * `kind: 'unknown'` is emitted for inner cases the SDK doesn't yet
 * recognize — forward-compatible by construction. Adding a new case
 * here is a non-breaking change for callers using the per-type
 * callbacks; it's a *breaking* change for callers exhaustively matching
 * on `parsed.kind` (the explicit reason to use a tagged union: TS will
 * flag the missing arm at the call site).
 */
export type SequencerPush =
  | { readonly kind: 'order_update'; readonly value: OrderUpdate }
  | { readonly kind: 'position_update'; readonly value: PositionUpdate }
  | { readonly kind: 'positions_snapshot'; readonly value: PositionsSnapshot }
  | { readonly kind: 'system_health'; readonly value: SystemHealthUpdate }
  | { readonly kind: 'balance_update'; readonly value: BalanceUpdate }
  | { readonly kind: 'margin_alert'; readonly value: MarginAlert }
  | { readonly kind: 'funding_rate_update'; readonly value: FundingRateUpdate }
  | { readonly kind: 'account_margin_update'; readonly value: AccountMarginUpdate }
  | { readonly kind: 'settlement_update'; readonly value: SettlementUpdate }
  | { readonly kind: 'leverage_settings'; readonly value: LeverageSettings }
  | { readonly kind: 'unknown' };

export function createPositionRow(params: {
  symbolId: number;
  side: Side;
  size: string;
  entryPrice: string;
  leverage: number;
  markPrice?: string;
  unrealizedPnl?: string;
  notional?: string;
  markPublishTimeSec?: number;
}): PositionRow {
  return Object.freeze({ ...params });
}

export function createPositionsSnapshot(params: {
  userUuid: string;
  rows: ReadonlyArray<PositionRow>;
  serverTimestamp: number;
  source: PositionsSnapshotSource;
  correlationId?: number;
}): PositionsSnapshot {
  return Object.freeze({
    ...params,
    rows: Object.freeze(params.rows.slice()),
  });
}

export function createBalanceUpdate(params: {
  userUuid: string;
  balanceRaw: bigint;
  timestamp: number;
  balance: string;
  signedBalance8dp: bigint;
  freeCollateral8dp: bigint;
}): BalanceUpdate {
  return Object.freeze({ ...params });
}

export function createMarginAlert(params: {
  owner: string;
  symbolId: number;
  tier: number;
  marginRatioBps: number;
  markPrice: string;
  liquidationPrice: string;
  ts: bigint;
  stateVersion: bigint;
  recovered: boolean;
}): MarginAlert {
  return Object.freeze({ ...params });
}

export function createFundingRateUpdate(params: {
  symbolId: number;
  fundingRate: string;
  timestamp: number;
  lastFundingRate: string;
}): FundingRateUpdate {
  return Object.freeze({ ...params });
}

export function createAccountMarginSummary(params: {
  totalCollateral: string;
  positionMargin: string;
  reservedOrderMargin: string;
  freeCollateral: string;
  isolatedMargin: string;
  isolatedEquity: string;
  crossIm: string;
}): AccountMarginSummary {
  return Object.freeze({ ...params });
}

export function createAccountMarginUpdate(params: {
  userUuid: string;
  serverTimestamp: number;
  account?: AccountMarginSummary;
}): AccountMarginUpdate {
  return Object.freeze({ ...params });
}

export function createSettlementUpdate(params: {
  batchId: bigint;
  status: SettlementBatchStatus;
  txSignature: string;
  timestamp: number;
  affectedUserUuids: ReadonlyArray<string>;
}): SettlementUpdate {
  return Object.freeze({
    ...params,
    affectedUserUuids: Object.freeze(params.affectedUserUuids.slice()),
  });
}

// ---------------------------------------------------------------------------
// REST identity & balance
// ---------------------------------------------------------------------------

/** User profile returned by `GET /api/v1/auth/me`. */
export interface MeProfile {
  readonly id: string;
  readonly dynamicUserId: string;
  readonly email: string;
  readonly walletAddress: string;
  readonly referralCode: string;
  readonly tier: string;
}

/**
 * On-chain balance snapshot returned by
 * `GET /api/v1/shielded-pool/balances/{owner}`. Raw amounts are uint64
 * lamport values; `walletUsdtUi` is the human-readable USDT amount.
 */
export interface Balance {
  readonly walletUsdtRaw: bigint;
  readonly pendingDepositsRaw: number;
  readonly shieldedBalanceRaw: bigint;
  readonly walletUsdtUi: number;
}

/** One per-user-per-symbol leverage setting from `GET /api/v1/leverage`. */
export interface LeverageSetting {
  readonly symbolId: number;
  readonly leverage: number;
}

/** Cached leverage settings returned by `GET /api/v1/leverage` or WS push. */
export interface LeverageSettings {
  readonly settings: ReadonlyArray<LeverageSetting>;
  readonly userUuid?: string;
  readonly serverTimestamp?: number;
}

export function createLeverageSettings(params: {
  settings: ReadonlyArray<LeverageSetting>;
  userUuid?: string;
  serverTimestamp?: number;
}): LeverageSettings {
  return Object.freeze({
    ...params,
    settings: Object.freeze(params.settings.slice()),
  });
}
