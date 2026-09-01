import { create, toBinary, fromBinary } from '@bufbuild/protobuf';
import {
  PlaceOrderInputSchema,
  CancelOrderInputSchema,
  ModifyOrderInputSchema,
  AckOutcomeKind,
  UpdateLeverageRequestSchema,
  GetOpenOrdersRequestSchema,
  GetPositionsRequestSchema,
  GetAccountRequestSchema,
  OpenOrdersSnapshotSchema,
  AccountMarginUpdateSchema,
  MassQuoteInputSchema,
  MassQuoteLegStatus,
  BatchCancelInputSchema,
  BatchModifyInputSchema,
  EdgeSequencerRequestSchema,
  AckMessageSchema,
  TradeMessageSchema,
  MassQuoteAckSchema,
  BatchCancelAckSchema,
  BatchModifyAckSchema,
  CancelAllInputSchema,
  CloseAllInputSchema,
  ReverseInputSchema,
  CancelAllAckSchema,
  CloseAllAckSchema,
  ReverseAckSchema,
  AmendTpslRequestSchema,
  CancelTpslRequestSchema,
  TpslAckSchema,
  OrderUpdateMessageSchema,
  PositionsSnapshotSchema,
  BalanceUpdateMessageSchema,
  FundingRateUpdateMessageSchema,
  SequencerToEdgeMessageSchema,
} from './generated/gdx/sequencer/v1/sequencer_pb.js';
import type {
  CancelAllAck,
  CloseAllAck,
  ReverseAck,
  TpslAck as TpslAckProto,
  LeverageSettings as LeverageSettingsProto,
  PositionRow as PositionRowProto,
  PositionsSnapshot as PositionsSnapshotProto,
  BalanceUpdateMessage as BalanceUpdateProto,
  FundingRateUpdateMessage as FundingRateProto,
} from './generated/gdx/sequencer/v1/sequencer_pb.js';
import { HealthReportSchema } from './generated/gdx/health/v1/health_pb.js';
import {
  PositionsSnapshotSource as PositionsSnapshotSourceProto,
  StpMode as StpModeProto,
} from './generated/gdx/common/v1/types_pb.js';
import {
  OrderHeaderSchema,
  ResponseHeaderSchema,
} from './generated/gdx/edge/v1/edge_pb.js';
import {
  SIDE_TO_PROTO,
  SIDE_FROM_PROTO,
  ORDER_TYPE_TO_PROTO,
  TIME_IN_FORCE_TO_PROTO,
  REQUEST_TYPE_TO_PROTO,
  RESPONSE_MESSAGE_TYPE_TO_PROTO,
  ORDER_STATUS_FROM_PROTO,
  ORDER_UPDATE_TYPE_FROM_PROTO,
  CANCEL_REASON_FROM_PROTO,
  STP_MODE_TO_PROTO,
} from './enums.js';
import type { StpMode } from './enums.js';
import type {
  BalanceUpdate,
  CountAck,
  FundingRateUpdate,
  LeverageSettings,
  OrderUpdate,
  PositionRow,
  PositionsSnapshot,
  PositionsSnapshotSource,
  OpenOrdersSnapshot,
  AccountMarginUpdate,
  AccountMarginSummary,
  SequencerPush,
  SystemHealthUpdate,
} from './types.js';
import {
  createBalanceUpdate,
  createCountAck,
  createTpslAck,
  createFundingRateUpdate,
  createLeverageSettings,
  createOrderUpdate,
  createPositionRow,
  createPositionsSnapshot,
  createOpenOrdersSnapshot,
  createOpenOrderRow,
  createAccountMarginUpdate,
  createAccountMarginSummary,
} from './types.js';

/** Parse u64 wire values without IEEE-754 precision loss (auth conn_id, push headers). */
export function parseWireU64(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return 0n;
    try {
      return BigInt(trimmed);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

export function uuidBytesToString(bytes: Uint8Array): string {
  if (bytes.length !== 16) return '00000000-0000-0000-0000-000000000000';
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidStringToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

/**
 * Dual-encoded correlation id matching gdx-web / gdx-wire conventions:
 * - body protobuf: little-endian u128 (`correlation_id_to_bytes`)
 * - OrderHeader AAD: big-endian u128 (`correlation_id_to_proto_bytes`)
 * - JSON `header.correlation_id`: 32-char hex of the same u128
 */
export type CorrelationIdWire = {
  value: bigint;
  bodyBytes: Uint8Array;
  aadBytes: Uint8Array;
  headerHex: string;
};

/** 16-byte little-endian u128 — must match `gdx_wire::convert::correlation_id_to_bytes`. */
export function correlationIdToLeBytes(id: bigint): Uint8Array {
  const out = new Uint8Array(16);
  let v = id & ((1n << 128n) - 1n);
  for (let i = 0; i < 16; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** 16-byte big-endian u128 — must match edge OrderHeader / ResponseHeader proto AAD. */
export function correlationIdToBeBytes(id: bigint): Uint8Array {
  if (id === 0n) return new Uint8Array();
  const out = new Uint8Array(16);
  let v = id & ((1n << 128n) - 1n);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** 32-char lowercase hex for JSON `header.correlation_id` (edge `parse_client_correlation_id`). */
export function correlationIdToWireHex(id: bigint): string {
  const be = correlationIdToBeBytes(id);
  if (be.length === 0) return '0'.repeat(32);
  return Array.from(be)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomU128(): bigint {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n === 0n ? 1n : n;
}

/** Fresh correlation id with body/AAD/header encodings for encrypted orders. */
export function newCorrelationIdWire(): CorrelationIdWire {
  const value = randomU128();
  const aadBytes = correlationIdToBeBytes(value);
  return {
    value,
    bodyBytes: correlationIdToLeBytes(value),
    aadBytes,
    headerHex: correlationIdToWireHex(value),
  };
}

export function correlationIdToNumber(raw: Uint8Array): number {
  if (!raw || raw.length === 0) return 0;
  let n = BigInt(0);
  for (const byte of raw) {
    n = (n << 8n) | BigInt(byte);
  }
  return Number(n);
}

// Legacy NodeResponse oneof field numbers (pre hotpath-edge-frames REST replies).
const LEGACY_NODE_RESPONSE_FIELD_NUM: Record<string, number> = {
  ack: 1,
  fill: 2,
  open_orders_snapshot: 3,
  node_ready: 4,
  mass_quote_ack: 5,
  batch_cancel_ack: 6,
  batch_modify_ack: 7,
  positions_snapshot: 8,
  account_margin_update: 9,
  cancel_all_ack: 10,
  close_all_ack: 11,
  reverse_ack: 12,
};

const LEGACY_NODE_RESPONSE_FIELD_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(LEGACY_NODE_RESPONSE_FIELD_NUM).map(([k, v]) => [v, k]),
);

function readVarint(data: Uint8Array, i: number): [number, number] {
  let shift = 0;
  let result = 0;
  while (i < data.length) {
    const b = data[i]!;
    i += 1;
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) {
      return [result, i];
    }
    shift += 7;
    if (shift >= 64) {
      throw new Error('varint overflow');
    }
  }
  throw new Error('truncated varint');
}

function writeVarint(value: number): Uint8Array {
  const out: number[] = [];
  while (true) {
    let b = value & 0x7f;
    value >>>= 7;
    if (value) {
      b |= 0x80;
    }
    out.push(b);
    if (!value) {
      break;
    }
  }
  return Uint8Array.from(out);
}

/** Wrap ``inner`` as a legacy ``NodeResponse`` oneof (test / mock helper). */
export function wrapLegacyNodeResponse(variant: string, inner: Uint8Array): Uint8Array {
  const fieldNum = LEGACY_NODE_RESPONSE_FIELD_NUM[variant];
  if (fieldNum === undefined) {
    throw new Error(`unknown legacy NodeResponse variant: ${variant}`);
  }
  const tag = (fieldNum << 3) | 2;
  const len = writeVarint(inner.length);
  const out = new Uint8Array(1 + len.length + inner.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(inner, 1 + len.length);
  return out;
}

function unwrapLegacyNodeResponse(data: Uint8Array): [string, Uint8Array] | null {
  if (!data.length) {
    return null;
  }
  const tag = data[0]!;
  const wireType = tag & 0x07;
  const fieldNum = tag >> 3;
  const variant = LEGACY_NODE_RESPONSE_FIELD_NAME[fieldNum];
  if (variant === undefined || wireType !== 2) {
    return null;
  }
  try {
    const [length, i] = readVarint(data, 1);
    const end = i + length;
    if (end !== data.length) {
      return null;
    }
    return [variant, data.subarray(i, end)];
  } catch {
    return null;
  }
}

const DIRECT_HOTPATH_COUNT_ACKS = new Set([
  'cancel_all_ack',
  'close_all_ack',
  'reverse_ack',
]);

function resolveRestPayload(data: Uint8Array, expected?: string): [string, Uint8Array] {
  // Hotpath count acks are usually direct protobuf; field 3 collides with legacy snapshot wrap.
  if (expected && DIRECT_HOTPATH_COUNT_ACKS.has(expected)) {
    const unwrapped = unwrapLegacyNodeResponse(data);
    if (unwrapped !== null && unwrapped[0] === expected) {
      return unwrapped;
    }
    return [expected, data];
  }
  const unwrapped = unwrapLegacyNodeResponse(data);
  if (unwrapped !== null) {
    return unwrapped;
  }
  if (expected) {
    return [expected, data];
  }
  return ['ack', data];
}

export function buildPlaceOrderProto(params: {
  symbolId: number;
  side: string;
  orderType: string;
  quantity: number;
  userUuid: Uint8Array;
  price?: number;
  timeInForce?: string;
  aon?: boolean;
  minFillSize?: number;
  expiryTime?: number;
  correlationIdBytes?: Uint8Array;
  timestamp?: number;
  reduceOnly?: boolean;
  postOnly?: boolean;
  stpMode?: StpMode;
  pegOffsetBps?: number;
  triggerPrice?: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
}): Uint8Array {
  let minFillSize = params.minFillSize;
  if (params.aon && minFillSize === undefined) {
    minFillSize = params.quantity;
  }
  const stpProto =
    params.stpMode !== undefined
      ? STP_MODE_TO_PROTO[params.stpMode]
      : StpModeProto.UNSPECIFIED;
  const place = create(PlaceOrderInputSchema, {
    symbolId: BigInt(params.symbolId),
    side: SIDE_TO_PROTO[params.side as keyof typeof SIDE_TO_PROTO],
    orderType: ORDER_TYPE_TO_PROTO[params.orderType as keyof typeof ORDER_TYPE_TO_PROTO],
    quantity: params.quantity,
    userUuid: params.userUuid,
    timeInForce: TIME_IN_FORCE_TO_PROTO[(params.timeInForce ?? 'GTC') as keyof typeof TIME_IN_FORCE_TO_PROTO],
    stpMode: stpProto,
    reduceOnly: params.reduceOnly ?? false,
    postOnly: params.postOnly ?? false,
    correlationId: params.correlationIdBytes ?? new Uint8Array(),
    ...(params.price !== undefined ? { price: params.price } : {}),
    ...(minFillSize !== undefined ? { minFillSize } : {}),
    ...(params.expiryTime !== undefined ? { expiryTime: BigInt(params.expiryTime) } : {}),
    ...(params.pegOffsetBps !== undefined ? { pegOffsetBps: params.pegOffsetBps } : {}),
    ...(params.triggerPrice !== undefined ? { triggerPrice: params.triggerPrice } : {}),
    ...(params.takeProfitPrice !== undefined
      ? { takeProfitPrice: params.takeProfitPrice }
      : {}),
    ...(params.stopLossPrice !== undefined ? { stopLossPrice: params.stopLossPrice } : {}),
  });

  const req = create(EdgeSequencerRequestSchema, {
    inner: { case: 'place' as const, value: place },
  });

  return toBinary(EdgeSequencerRequestSchema, req);
}

export function buildCancelOrderProto(params: {
  // u64 order ids exceed 2^53, so accept string/bigint here too. Coercing
  // through Number(...) loses precision; we always go through BigInt.
  orderId: number | bigint | string;
  userUuid: Uint8Array;
  symbolId: number;
  correlationIdBytes: Uint8Array;
}): Uint8Array {
  const cancel = create(CancelOrderInputSchema, {
    orderId: BigInt(params.orderId),
    symbolId: BigInt(params.symbolId),
    correlationId: params.correlationIdBytes,
    userUuid: params.userUuid,
  });

  const req = create(EdgeSequencerRequestSchema, {
    inner: { case: 'cancel' as const, value: cancel },
  });

  return toBinary(EdgeSequencerRequestSchema, req);
}

export function buildCancelAllProto(params: {
  symbolId?: number;
  userUuid: Uint8Array;
  correlationIdBytes: Uint8Array;
}): Uint8Array {
  const cancelAll = create(CancelAllInputSchema, {
    userUuid: params.userUuid,
    correlationId: params.correlationIdBytes,
    ...(params.symbolId !== undefined ? { symbolId: BigInt(params.symbolId) } : {}),
  });
  const req = create(EdgeSequencerRequestSchema, {
    inner: { case: 'cancelAll' as const, value: cancelAll },
  });
  return toBinary(EdgeSequencerRequestSchema, req);
}

export function buildCloseAllProto(params: {
  symbolId?: number;
  userUuid: Uint8Array;
  correlationIdBytes: Uint8Array;
}): Uint8Array {
  const closeAll = create(CloseAllInputSchema, {
    userUuid: params.userUuid,
    correlationId: params.correlationIdBytes,
    ...(params.symbolId !== undefined ? { symbolId: BigInt(params.symbolId) } : {}),
  });
  const req = create(EdgeSequencerRequestSchema, {
    inner: { case: 'closeAll' as const, value: closeAll },
  });
  return toBinary(EdgeSequencerRequestSchema, req);
}

export function buildReverseProto(params: {
  symbolId: number;
  userUuid: Uint8Array;
  correlationIdBytes: Uint8Array;
}): Uint8Array {
  const reverse = create(ReverseInputSchema, {
    symbolId: BigInt(params.symbolId),
    userUuid: params.userUuid,
    correlationId: params.correlationIdBytes,
  });
  const req = create(EdgeSequencerRequestSchema, {
    inner: { case: 'reverse' as const, value: reverse },
  });
  return toBinary(EdgeSequencerRequestSchema, req);
}

export function buildAmendTpslProto(params: {
  userUuid: Uint8Array;
  orderId: number | bigint | string;
  correlationIdBytes: Uint8Array;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  symbolId?: number;
  positionSide?: string;
}): Uint8Array {
  const amend = create(AmendTpslRequestSchema, {
    userUuid: params.userUuid,
    orderId: BigInt(params.orderId),
    correlationId: params.correlationIdBytes,
    ...(params.takeProfitPrice !== undefined
      ? { takeProfitPrice: params.takeProfitPrice }
      : {}),
    ...(params.stopLossPrice !== undefined ? { stopLossPrice: params.stopLossPrice } : {}),
    ...(params.symbolId !== undefined ? { symbolId: BigInt(params.symbolId) } : {}),
    ...(params.positionSide !== undefined
      ? { positionSide: SIDE_TO_PROTO[params.positionSide as keyof typeof SIDE_TO_PROTO] }
      : {}),
  });
  const req = create(EdgeSequencerRequestSchema, {
    inner: { case: 'amendTpsl' as const, value: amend },
  });
  return toBinary(EdgeSequencerRequestSchema, req);
}

export function buildCancelTpslProto(params: {
  userUuid: Uint8Array;
  orderId: number | bigint | string;
  correlationIdBytes: Uint8Array;
  symbolId?: number;
  positionSide?: string;
}): Uint8Array {
  const cancel = create(CancelTpslRequestSchema, {
    userUuid: params.userUuid,
    orderId: BigInt(params.orderId),
    correlationId: params.correlationIdBytes,
    ...(params.symbolId !== undefined ? { symbolId: BigInt(params.symbolId) } : {}),
    ...(params.positionSide !== undefined
      ? { positionSide: SIDE_TO_PROTO[params.positionSide as keyof typeof SIDE_TO_PROTO] }
      : {}),
  });
  const req = create(EdgeSequencerRequestSchema, {
    inner: { case: 'cancelTpsl' as const, value: cancel },
  });
  return toBinary(EdgeSequencerRequestSchema, req);
}

export function buildModifyOrderProto(params: {
  // u64 order ids exceed 2^53; same rationale as buildCancelOrderProto.
  orderId: number | bigint | string;
  userUuid: Uint8Array;
  symbolId: number;
  newPrice?: number;
  newQuantity?: number;
  newTriggerPrice?: number;
  correlationIdBytes?: Uint8Array;
}): Uint8Array {
  const modify = create(ModifyOrderInputSchema, {
    orderId: BigInt(params.orderId),
    userUuid: params.userUuid,
    symbolId: BigInt(params.symbolId),
    correlationId: params.correlationIdBytes ?? new Uint8Array(),
    ...(params.newPrice !== undefined ? { newPrice: params.newPrice } : {}),
    ...(params.newQuantity !== undefined ? { newQuantity: params.newQuantity } : {}),
    ...(params.newTriggerPrice !== undefined
      ? { newTriggerPrice: params.newTriggerPrice }
      : {}),
  });

  const req = create(EdgeSequencerRequestSchema, {
    inner: { case: 'modify' as const, value: modify },
  });

  return toBinary(EdgeSequencerRequestSchema, req);
}

export function buildGetOpenOrdersProto(params: {
  userUuid: Uint8Array;
  correlationIdBytes?: Uint8Array;
}): Uint8Array {
  const inner = create(GetOpenOrdersRequestSchema, {
    userUuid: params.userUuid,
    correlationId: params.correlationIdBytes ?? new Uint8Array(),
  });
  const req = create(EdgeSequencerRequestSchema, {
    inner: { case: 'getOpenOrders' as const, value: inner },
  });
  return toBinary(EdgeSequencerRequestSchema, req);
}

export function buildGetPositionsProto(params: {
  userUuid: Uint8Array;
  correlationIdBytes?: Uint8Array;
}): Uint8Array {
  const inner = create(GetPositionsRequestSchema, {
    userUuid: params.userUuid,
    correlationId: params.correlationIdBytes ?? new Uint8Array(),
  });
  const req = create(EdgeSequencerRequestSchema, {
    inner: { case: 'getPositions' as const, value: inner },
  });
  return toBinary(EdgeSequencerRequestSchema, req);
}

export function buildGetAccountProto(params: {
  userUuid: Uint8Array;
  correlationIdBytes?: Uint8Array;
}): Uint8Array {
  const inner = create(GetAccountRequestSchema, {
    userUuid: params.userUuid,
    correlationId: params.correlationIdBytes ?? new Uint8Array(),
  });
  const req = create(EdgeSequencerRequestSchema, {
    inner: { case: 'getAccount' as const, value: inner },
  });
  return toBinary(EdgeSequencerRequestSchema, req);
}

export function buildUpdateLeverageProto(params: {
  userUuid: Uint8Array;
  symbolId: number;
  leverage: number;
  correlationIdBytes?: Uint8Array;
}): Uint8Array {
  const updateLeverage = create(UpdateLeverageRequestSchema, {
    userUuid: params.userUuid,
    symbolId: BigInt(params.symbolId),
    leverage: Math.max(1, Math.floor(params.leverage)),
    correlationId: params.correlationIdBytes ?? new Uint8Array(),
  });

  const req = create(EdgeSequencerRequestSchema, {
    inner: { case: 'updateLeverage' as const, value: updateLeverage },
  });

  return toBinary(EdgeSequencerRequestSchema, req);
}

/** Fresh random 16-byte leg correlation id (raw UUID-style bytes; Python/Rust parity). */
function randomCorrelationId(): Uint8Array {
  const out = new Uint8Array(16);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export interface MassQuoteLegInput {
  side: string;
  price: number;
  quantity: number;
  /** Resting order to cancel-replace. Omit or 0 = pure place (no cancel). */
  cancelOrderId?: number | bigint | string;
  timeInForce?: string;
  expiryTime?: number;
  correlationIdBytes?: Uint8Array;
}

// The node fans batches out at ~constant MPC cost only up to this bound; larger
// or empty batches are rejected client-side before reaching the wire.
const MAX_BATCH_LEGS = 20;

function validateBatchSize(op: string, count: number): void {
  if (count === 0) {
    throw new Error(`${op} requires at least one leg`);
  }
  if (count > MAX_BATCH_LEGS) {
    throw new Error(`${op} accepts at most ${MAX_BATCH_LEGS} legs, got ${count}`);
  }
}

function lookupSide(side: string, ctx: string): number {
  const v = SIDE_TO_PROTO[side as keyof typeof SIDE_TO_PROTO];
  if (v === undefined) {
    throw new Error(`${ctx}: unknown side ${JSON.stringify(side)} (expected BUY or SELL)`);
  }
  return v;
}

function lookupTimeInForce(tif: string, ctx: string): number {
  const v = TIME_IN_FORCE_TO_PROTO[tif as keyof typeof TIME_IN_FORCE_TO_PROTO];
  if (v === undefined) {
    throw new Error(`${ctx}: unknown timeInForce ${JSON.stringify(tif)}`);
  }
  return v;
}

export function buildMassQuoteProto(params: {
  symbolId: number;
  userUuid: Uint8Array;
  legs: MassQuoteLegInput[];
  correlationIdBytes?: Uint8Array;
  // Batch-level flag. Undefined defaults to post-only (true); pass false to
  // enable the relaxed path where a crossing leg takes liquidity up to its
  // limit and rests the remainder.
  postOnly?: boolean;
}): Uint8Array {
  validateBatchSize('mass quote', params.legs.length);
  const mq = create(MassQuoteInputSchema, {
    symbolId: BigInt(params.symbolId),
    userUuid: params.userUuid,
    stpMode: StpModeProto.UNSPECIFIED,
    correlationId: params.correlationIdBytes ?? new Uint8Array(),
    postOnly: params.postOnly ?? true,
    legs: params.legs.map((leg, i) => ({
      // cancel_order_id is a plain uint64; 0 means "pure place" (no cancel).
      cancelOrderId: BigInt(leg.cancelOrderId ?? 0),
      side: lookupSide(leg.side, `mass quote leg ${i}`),
      price: leg.price,
      quantity: leg.quantity,
      timeInForce: lookupTimeInForce(leg.timeInForce ?? 'GTC', `mass quote leg ${i}`),
      // Each leg becomes its own order, so it carries a unique 16-byte
      // correlation_id (the wire requires exactly 16 bytes per leg).
      correlationId: leg.correlationIdBytes ?? randomCorrelationId(),
      ...(leg.expiryTime !== undefined
        ? { expiryTime: BigInt(leg.expiryTime) }
        : {}),
    })),
  });

  const req = create(EdgeSequencerRequestSchema, {
    inner: { case: 'massQuote' as const, value: mq },
  });

  return toBinary(EdgeSequencerRequestSchema, req);
}

const MASS_QUOTE_LEG_STATUS_NAME: Record<number, string> = {
  [MassQuoteLegStatus.UNSPECIFIED]: 'unspecified',
  [MassQuoteLegStatus.OPEN]: 'open',
  [MassQuoteLegStatus.FILLED]: 'filled',
  [MassQuoteLegStatus.FAILED]: 'failed',
};

export function parseMassQuoteAck(data: Uint8Array): Record<string, unknown> {
  const [variant, payload] = resolveRestPayload(data, 'mass_quote_ack');
  if (variant !== 'mass_quote_ack') {
    return { type: variant || 'unknown' };
  }
  const a = fromBinary(MassQuoteAckSchema, payload);
  const results = a.results.map(r => ({
    leg_index: r.legIndex,
    // u64 ids returned as strings; 0 -> undefined (no cancel target / failed).
    cancelled_order_id: r.cancelledOrderId ? String(r.cancelledOrderId) : undefined,
    new_order_id: r.newOrderId ? String(r.newOrderId) : undefined,
    status: MASS_QUOTE_LEG_STATUS_NAME[r.status] ?? 'unknown',
    error_code: r.errorCode !== undefined ? r.errorCode : undefined,
    // Taker fills produced by a relaxed (post_only=false) leg; 0 otherwise.
    fill_count: r.fillCount,
  }));
  return {
    type: 'mass_quote_ack',
    node_id: Number(a.nodeId),
    sequence: String(a.sequence),
    correlation_id: a.correlationId,
    results,
  };
}

export function buildBatchCancelProto(params: {
  symbolId: number;
  userUuid: Uint8Array;
  // u64 order ids exceed 2^53; accept string/bigint/number and coerce via BigInt.
  orderIds: Array<number | bigint | string>;
  correlationIdBytes?: Uint8Array;
}): Uint8Array {
  validateBatchSize('batch cancel', params.orderIds.length);
  const bc = create(BatchCancelInputSchema, {
    symbolId: BigInt(params.symbolId),
    userUuid: params.userUuid,
    correlationId: params.correlationIdBytes ?? new Uint8Array(),
    orderIds: params.orderIds.map(id => BigInt(id)),
  });

  const req = create(EdgeSequencerRequestSchema, {
    inner: { case: 'batchCancel' as const, value: bc },
  });

  return toBinary(EdgeSequencerRequestSchema, req);
}

export function parseBatchCancelAck(data: Uint8Array): Record<string, unknown> {
  const [variant, payload] = resolveRestPayload(data, 'batch_cancel_ack');
  if (variant !== 'batch_cancel_ack') {
    return { type: variant || 'unknown' };
  }
  const a = fromBinary(BatchCancelAckSchema, payload);
  const results = a.results.map(r => ({
    order_id: String(r.orderId),
    cancelled: r.cancelled,
    error_code: r.errorCode !== undefined ? r.errorCode : undefined,
  }));
  return {
    type: 'batch_cancel_ack',
    node_id: Number(a.nodeId),
    sequence: String(a.sequence),
    correlation_id: a.correlationId,
    results,
  };
}

export interface BatchModifyLegInput {
  // u64 order ids exceed 2^53; accept string/bigint/number.
  orderId: number | bigint | string;
  newPrice?: number;
  newQuantity?: number;
  correlationIdBytes?: Uint8Array;
}

export function buildBatchModifyProto(params: {
  symbolId: number;
  userUuid: Uint8Array;
  legs: BatchModifyLegInput[];
  correlationIdBytes?: Uint8Array;
}): Uint8Array {
  validateBatchSize('batch modify', params.legs.length);
  const noopLeg = params.legs.findIndex(
    leg => leg.newPrice === undefined && leg.newQuantity === undefined
  );
  if (noopLeg !== -1) {
    throw new Error(
      `batch modify leg ${noopLeg} must set newPrice and/or newQuantity`
    );
  }
  const bm = create(BatchModifyInputSchema, {
    symbolId: BigInt(params.symbolId),
    userUuid: params.userUuid,
    correlationId: params.correlationIdBytes ?? new Uint8Array(),
    legs: params.legs.map(leg => ({
      orderId: BigInt(leg.orderId),
      // Each leg carries a unique 16-byte correlation_id (wire requires 16 bytes).
      correlationId: leg.correlationIdBytes ?? randomCorrelationId(),
      ...(leg.newPrice !== undefined ? { newPrice: leg.newPrice } : {}),
      ...(leg.newQuantity !== undefined ? { newQuantity: leg.newQuantity } : {}),
    })),
  });

  const req = create(EdgeSequencerRequestSchema, {
    inner: { case: 'batchModify' as const, value: bm },
  });

  return toBinary(EdgeSequencerRequestSchema, req);
}

export function parseBatchModifyAck(data: Uint8Array): Record<string, unknown> {
  const [variant, payload] = resolveRestPayload(data, 'batch_modify_ack');
  if (variant !== 'batch_modify_ack') {
    return { type: variant || 'unknown' };
  }
  const a = fromBinary(BatchModifyAckSchema, payload);
  const results = a.results.map(r => ({
    order_id: String(r.orderId),
    modified: r.modified,
    error_code: r.errorCode !== undefined ? r.errorCode : undefined,
  }));
  return {
    type: 'batch_modify_ack',
    node_id: Number(a.nodeId),
    sequence: String(a.sequence),
    correlation_id: a.correlationId,
    results,
  };
}

export function buildOrderHeaderAad(params: {
  userUuid: Uint8Array;
  symbolId: number;
  requestType: string;
  nonce: number;
  bodyLength: number;
  correlationId?: Uint8Array;
  /** WebSocket connection id (OrderHeader field 7). */
  connId?: number | bigint;
}): Uint8Array {
  const header = create(OrderHeaderSchema, {
    userUuid: params.userUuid,
    symbolId: BigInt(params.symbolId),
    requestType: REQUEST_TYPE_TO_PROTO[params.requestType as keyof typeof REQUEST_TYPE_TO_PROTO],
    nonce: BigInt(params.nonce),
    bodyLength: params.bodyLength,
    correlationId: params.correlationId ?? new Uint8Array(),
    connId: BigInt(params.connId ?? 0),
  });

  return toBinary(OrderHeaderSchema, header);
}

export function buildResponseHeaderAad(params: {
  userUuid: Uint8Array;
  messageType: string;
  bodyLength: number;
  nonce: number;
  fencingEpoch?: number;
  /** Big-endian u128 bytes; omit or empty for CorrelationId(0). */
  correlationIdBytes?: Uint8Array;
  /** Stage 15 session sequence; omit when zero (prost omits default scalar). */
  sessionSeq?: number | bigint;
  /** WebSocket connection id (ResponseHeader field 8). */
  connId?: number | bigint;
}): Uint8Array {
  const base = {
    userUuid: params.userUuid,
    messageType:
      RESPONSE_MESSAGE_TYPE_TO_PROTO[params.messageType as keyof typeof RESPONSE_MESSAGE_TYPE_TO_PROTO],
    bodyLength: params.bodyLength,
    nonce: BigInt(params.nonce),
    fencingEpoch: BigInt(params.fencingEpoch ?? 0),
    connId: BigInt(params.connId ?? 0),
  };
  const cid = params.correlationIdBytes;
  const sessionSeq = BigInt(params.sessionSeq ?? 0);
  const withCorrelation =
    cid !== undefined && cid.length > 0 ? { ...base, correlationId: cid } : base;
  const header =
    sessionSeq !== 0n
      ? create(ResponseHeaderSchema, { ...withCorrelation, sessionSeq })
      : create(ResponseHeaderSchema, withCorrelation);
  return toBinary(ResponseHeaderSchema, header);
}

/**
 * Parse cleartext `encrypted_push.correlation_id` (decimal / hex / UUID) to BE AAD bytes.
 * Returns undefined when absent or zero (matches Rust empty CorrelationId(0)).
 */
export function correlationIdFromPushWire(
  raw: string | number | bigint | undefined | null,
): Uint8Array | undefined {
  if (raw === undefined || raw === null || raw === '' || raw === 0 || raw === '0') {
    return undefined;
  }
  const s = String(raw).trim();
  if (s.includes('-')) {
    const bytes = uuidStringToBytes(s);
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    return n === 0n ? undefined : correlationIdToBeBytes(n);
  }
  const hex = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
  if (/^[0-9a-fA-F]{32}$/.test(hex)) {
    const n = BigInt('0x' + hex);
    return n === 0n ? undefined : correlationIdToBeBytes(n);
  }
  const n = BigInt(s);
  return n === 0n ? undefined : correlationIdToBeBytes(n);
}

/** Parse cleartext `encrypted_push.session_seq` for ResponseHeader AAD. */
export function sessionSeqFromPushWire(
  raw: string | number | bigint | undefined | null,
): bigint | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = BigInt(String(raw).trim());
  return n === 0n ? undefined : n;
}

function parseAckMessage(ack: import('./generated/gdx/sequencer/v1/sequencer_pb.js').AckMessage): Record<string, unknown> {
  const outcome = ack.ackOutcome;
  let success = false;
  let errorCode: number | undefined;
  let orderStatus: string | undefined;
  if (outcome !== undefined && outcome.kind !== AckOutcomeKind.UNSPECIFIED) {
    success = outcome.kind === AckOutcomeKind.APPLIED;
    errorCode = outcome.businessErrorCode ?? outcome.systemErrorCode;
    if (errorCode !== undefined) {
      success = false;
    }
    if (outcome.orderStatus !== undefined) {
      orderStatus = ORDER_STATUS_FROM_PROTO[outcome.orderStatus];
    }
  }
  // u64 ids are returned as strings to preserve full precision. Callers
  // that need numeric arithmetic should use BigInt(...) on the string.
  const result: Record<string, unknown> = {
    type: 'ack',
    sequence: Number(ack.sequence),
    order_id: String(ack.orderId),
    success,
    correlation_id: ack.correlationId,
  };
  if (errorCode !== undefined) {
    result.error_code = errorCode;
  }
  if (ack.rejectText !== undefined && ack.rejectText.length > 0) {
    result.reject_text = ack.rejectText;
  }
  if (orderStatus !== undefined) {
    result.order_status = orderStatus;
  }
  return result;
}

export function parseNodeResponse(data: Uint8Array): Record<string, unknown> {
  const [variant, payload] = resolveRestPayload(data, 'ack');
  if (variant === 'ack') {
    const ack = fromBinary(AckMessageSchema, payload);
    return parseAckMessage(ack);
  }
  if (variant === 'fill') {
    const fill = fromBinary(TradeMessageSchema, payload);
    return {
      type: 'fill',
      trade_id: String(fill.tradeId),
      taker_order_id: String(fill.takerOrderId),
      maker_order_id: String(fill.makerOrderId),
      symbol_id: Number(fill.symbolId),
      timestamp: Number(fill.timestamp),
      correlation_id: fill.correlationId,
    };
  }
  return { type: variant || 'unknown' };
}

function countAckFromCancelAll(ack: CancelAllAck): CountAck {
  return createCountAck({
    sequence: String(ack.sequence),
    count: ack.cancelled,
    orderIds: ack.cancelledOrderIds.map((id) => String(id)),
    errorCode: ack.errorCode,
    rejectText: ack.rejectText,
  });
}

function countAckFromCloseAll(ack: CloseAllAck): CountAck {
  return createCountAck({
    sequence: String(ack.sequence),
    count: ack.closed,
    orderIds: ack.closeOrderIds.map((id) => String(id)),
    errorCode: ack.errorCode,
    rejectText: ack.rejectText,
  });
}

function countAckFromReverse(ack: ReverseAck): CountAck {
  return createCountAck({
    sequence: String(ack.sequence),
    count: ack.reversed,
    orderIds: ack.reverseOrderIds.map((id) => String(id)),
    errorCode: ack.errorCode,
    rejectText: ack.rejectText,
  });
}

function parseCountAckPayload(data: Uint8Array, expected: string): CountAck | null {
  const [variant, payload] = resolveRestPayload(data, expected);
  switch (variant) {
    case 'cancel_all_ack':
      return countAckFromCancelAll(fromBinary(CancelAllAckSchema, payload));
    case 'close_all_ack':
      return countAckFromCloseAll(fromBinary(CloseAllAckSchema, payload));
    case 'reverse_ack':
      return countAckFromReverse(fromBinary(ReverseAckSchema, payload));
    default:
      return null;
  }
}

/** Decode a `cancel_all_ack` / `close_all_ack` / `reverse_ack` plaintext body. */
export function parseCountAck(data: Uint8Array, expected: string): CountAck {
  const ack = parseCountAckPayload(data, expected);
  if (ack !== null) {
    return ack;
  }
  throw new Error(`Expected count ack (${expected})`);
}

function tpslAckFromProto(ack: TpslAckProto) {
  return createTpslAck({
    parentOrderId: String(ack.parentOrderId),
    takeProfit: ack.takeProfit,
    stopLoss: ack.stopLoss,
    errorCode: ack.errorCode,
    rejectText: ack.rejectText,
  });
}

/** Decode a `tpsl_ack` plaintext body. */
export function parseTpslAck(data: Uint8Array) {
  const [variant, payload] = resolveRestPayload(data, 'tpsl_ack');
  if (variant !== 'tpsl_ack') {
    throw new Error('Expected tpsl_ack');
  }
  return tpslAckFromProto(fromBinary(TpslAckSchema, payload));
}

export function parseLeverageSettings(msg: LeverageSettingsProto): LeverageSettings {
  const userUuidRaw = msg.userUuid;
  const userUuid =
    userUuidRaw.length > 0 ? uuidBytesToString(userUuidRaw) : undefined;
  const serverTimestamp =
    msg.serverTimestamp !== undefined && msg.serverTimestamp !== 0n
      ? Number(msg.serverTimestamp)
      : undefined;
  return createLeverageSettings({
    settings: msg.settings.map((row) => ({
      symbolId: Number(row.symbolId),
      leverage: row.leverage,
    })),
    userUuid,
    serverTimestamp,
  });
}

export function parseOpenOrdersSnapshotProto(data: Uint8Array): OpenOrdersSnapshot {
  const msg = fromBinary(OpenOrdersSnapshotSchema, data);
  return _openOrdersSnapshotFromMessage(msg);
}

function _openOrdersSnapshotFromMessage(msg: import('./generated/gdx/sequencer/v1/sequencer_pb.js').OpenOrdersSnapshot): OpenOrdersSnapshot {
  const rows = msg.rows.map((r) =>
    createOpenOrderRow({
      orderId: String(r.orderId),
      symbolId: Number(r.symbolId),
      leverage: r.leverage,
      price: r.price ?? '',
      quantity: r.quantity ?? '',
      remainingQty: r.remainingQty ?? '',
    }),
  );
  return createOpenOrdersSnapshot({
    rows,
    serverTimestamp: Number(msg.serverTimestamp),
    correlationId:
      msg.correlationId !== undefined && msg.correlationId !== null
        ? correlationIdToNumber(msg.correlationId)
        : 0,
  });
}

export function parseAccountMarginUpdateProto(data: Uint8Array): AccountMarginUpdate {
  const msg = fromBinary(AccountMarginUpdateSchema, data);
  return _accountMarginUpdateFromMessage(msg);
}

function _accountMarginUpdateFromMessage(
  msg: import('./generated/gdx/sequencer/v1/sequencer_pb.js').AccountMarginUpdate,
): AccountMarginUpdate {
  let account: AccountMarginSummary | undefined;
  if (msg.account !== undefined && msg.account !== null) {
    const a = msg.account;
    account = createAccountMarginSummary({
      totalCollateral: a.totalCollateral ?? '',
      positionMargin: a.positionMargin ?? '',
      reservedOrderMargin: a.reservedOrderMargin ?? '',
      freeCollateral: a.freeCollateral ?? '',
      isolatedMargin: a.isolatedMargin ?? '',
      isolatedEquity: a.isolatedEquity ?? '',
      crossIm: a.crossIm ?? '',
    });
  }
  return createAccountMarginUpdate({
    userUuid: uuidBytesToString(msg.userUuid),
    serverTimestamp: Number(msg.serverTimestamp),
    account,
  });
}

export function parseNodeResponseSnapshot(
  data: Uint8Array,
  messageType?: string | null,
): [string, OpenOrdersSnapshot | PositionsSnapshot | AccountMarginUpdate | Record<string, unknown>] {
  let expected = messageType?.replace(/-/g, '_') ?? undefined;
  if (expected === 'account_margin' || expected === 'account_update') {
    expected = 'account_margin_update';
  }
  const [variant, payload] = resolveRestPayload(data, expected);
  switch (variant) {
    case 'open_orders_snapshot':
      return ['open_orders_snapshot', _openOrdersSnapshotFromMessage(fromBinary(OpenOrdersSnapshotSchema, payload))];
    case 'positions_snapshot':
      return ['positions_snapshot', _positionsSnapshotFromMessage(fromBinary(PositionsSnapshotSchema, payload))];
    case 'account_margin_update':
    case 'account_update':
      return ['account_margin_update', _accountMarginUpdateFromMessage(fromBinary(AccountMarginUpdateSchema, payload))];
    case 'ack':
      return ['ack', parseNodeResponse(data)];
    default:
      return [variant || 'unknown', { type: variant || 'unknown' }];
  }
}

export function parseOrderUpdateProto(data: Uint8Array): OrderUpdate {
  const msg = fromBinary(OrderUpdateMessageSchema, data);

  let cancelReason;
  if (msg.cancelReason !== undefined) {
    cancelReason = CANCEL_REASON_FROM_PROTO[msg.cancelReason];
  }

  let rejectReason;
  if (msg.rejectReasonCode !== undefined) {
    rejectReason = String(msg.rejectReasonCode);
  }

  return createOrderUpdate({
    orderId: String(msg.orderId),
    userUuid: uuidBytesToString(msg.userUuid),
    symbolId: Number(msg.symbolId),
    side: SIDE_FROM_PROTO[msg.side] ?? 'BUY',
    status: ORDER_STATUS_FROM_PROTO[msg.orderStatus] ?? 'NEW',
    updateType: ORDER_UPDATE_TYPE_FROM_PROTO[msg.messageType] ?? 'OPEN',
    price: msg.price,
    quantity: msg.quantity,
    filledQty: msg.filledQty,
    remainingQty: msg.remainingQty,
    cumFill: msg.cumFill,
    cancelReason,
    rejectReason,
    msg: msg.msg && msg.msg.length > 0 ? msg.msg : undefined,
    reduceOnly: msg.reduceOnly,
    postOnly: msg.postOnly,
    correlationId: correlationIdToNumber(msg.correlationId),
    timestamp: Number(msg.timestamp),
  });
}

// ---------------------------------------------------------------------------
// Extended push surface parsers.
//
// One parser per `SequencerToEdgeMessage` inner case beyond order_update.
// The same payloads ship in Python (`_proto.py`), Go (`proto.go`), Rust
// (`proto_bridge.rs`), C++ (`proto_codec.cpp`); the pattern is the same in
// every SDK: take the protobuf message, return a frozen typed wrapper.
//
// Discriminant strings (`UNSPECIFIED` / `INITIAL` / ...) deliberately omit
// the proto prefix (`POSITIONS_SNAPSHOT_SOURCE_*`) to match the wire-level
// JSON contract surfaced by the other SDKs.
// ---------------------------------------------------------------------------

function _parsePositionsSnapshotSource(
  v: PositionsSnapshotSourceProto,
): PositionsSnapshotSource {
  switch (v) {
    case PositionsSnapshotSourceProto.INITIAL:
      return 'INITIAL';
    case PositionsSnapshotSourceProto.PERIODIC:
      return 'PERIODIC';
    case PositionsSnapshotSourceProto.EVENT:
      return 'EVENT';
    default:
      return 'UNSPECIFIED';
  }
}

export function parsePositionRowProto(row: PositionRowProto): PositionRow {
  return createPositionRow({
    symbolId: Number(row.symbolId),
    side: SIDE_FROM_PROTO[row.side] ?? 'BUY',
    size: row.size,
    entryPrice: row.entryPrice,
    leverage: row.leverage,
    markPrice: row.markPrice ?? undefined,
    unrealizedPnl: row.unrealizedPnl ?? undefined,
    notional: row.notional ?? undefined,
    markPublishTimeSec:
      row.markPublishTimeSec !== undefined && row.markPublishTimeSec !== null
        ? Number(row.markPublishTimeSec)
        : undefined,
  });
}

export function parsePositionsSnapshotProto(data: Uint8Array): PositionsSnapshot {
  const msg = fromBinary(PositionsSnapshotSchema, data);
  return _positionsSnapshotFromMessage(msg);
}

function _positionsSnapshotFromMessage(
  msg: PositionsSnapshotProto,
): PositionsSnapshot {
  return createPositionsSnapshot({
    userUuid: uuidBytesToString(msg.userUuid),
    rows: msg.rows.map(parsePositionRowProto),
    serverTimestamp: Number(msg.serverTimestamp),
    source: _parsePositionsSnapshotSource(msg.source),
    correlationId:
      msg.correlationId !== undefined && msg.correlationId !== null
        ? correlationIdToNumber(msg.correlationId)
        : undefined,
  });
}

export function parseSystemHealthProto(data: Uint8Array): SystemHealthUpdate {
  return fromBinary(HealthReportSchema, data);
}

export function parseBalanceUpdateProto(data: Uint8Array): BalanceUpdate {
  const msg = fromBinary(BalanceUpdateMessageSchema, data);
  return _balanceUpdateFromMessage(msg);
}

function _balanceUpdateFromMessage(msg: BalanceUpdateProto): BalanceUpdate {
  return createBalanceUpdate({
    userUuid: uuidBytesToString(msg.userUuid),
    balanceRaw: msg.balanceRaw,
    timestamp: Number(msg.timestamp),
    balance: msg.balance,
    signedBalance8dp: msg.signedBalance8dp,
    freeCollateral8dp: msg.freeCollateral8dp,
  });
}

export function parseFundingRateUpdateProto(
  data: Uint8Array,
): FundingRateUpdate {
  const msg = fromBinary(FundingRateUpdateMessageSchema, data);
  return _fundingRateFromMessage(msg);
}

function _fundingRateFromMessage(msg: FundingRateProto): FundingRateUpdate {
  return createFundingRateUpdate({
    symbolId: Number(msg.symbolId),
    fundingRate: msg.fundingRate,
    timestamp: Number(msg.timestamp),
    lastFundingRate: msg.lastFundingRate,
  });
}

/**
 * Decode a `SequencerToEdgeMessage` envelope and return a discriminated
 * union (`SequencerPush`). Unrecognized inner cases are returned as
 * `{ kind: 'unknown' }`.
 *
 * Callers consume this via `GodarkClient`'s `on*` callbacks / per-type
 * async iterators (these in turn switch on `kind` exhaustively); the
 * function is also exported standalone for tests + downstream wrappers
 * that want to drive their own dispatch.
 */
export function parseSequencerToEdgeMessage(data: Uint8Array): SequencerPush {
  const msg = fromBinary(SequencerToEdgeMessageSchema, data);

  switch (msg.inner.case) {
    case 'orderUpdate':
      return {
        kind: 'order_update',
        value: parseOrderUpdateProto(
          toBinary(OrderUpdateMessageSchema, msg.inner.value),
        ),
      };
    case 'positionsSnapshot':
      return {
        kind: 'positions_snapshot',
        value: _positionsSnapshotFromMessage(msg.inner.value),
      };
    case 'healthReport':
      return {
        kind: 'system_health',
        value: msg.inner.value,
      };
    case 'balanceUpdate':
      return {
        kind: 'balance_update',
        value: _balanceUpdateFromMessage(msg.inner.value),
      };
    case 'fundingRateUpdate':
      return {
        kind: 'funding_rate_update',
        value: _fundingRateFromMessage(msg.inner.value),
      };
    case 'leverageSettings':
      return {
        kind: 'leverage_settings',
        value: parseLeverageSettings(msg.inner.value),
      };
    default:
      return { kind: 'unknown' };
  }
}

/** Decode public WS `funding_rate_snapshot` rows (trading subscribe channel). */
export function parseFundingRateSnapshotJson(
  obj: Record<string, unknown>,
): FundingRateUpdate[] {
  if (obj.type !== 'funding_rate_snapshot') return [];
  const rows = obj.rows;
  if (!Array.isArray(rows)) return [];
  const out: FundingRateUpdate[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const fundingRate = String(r.funding_rate ?? '');
    if (!fundingRate) continue;
    out.push(
      createFundingRateUpdate({
        symbolId: Number(r.symbol_id ?? 0),
        fundingRate,
        timestamp: Number(r.timestamp ?? 0),
        lastFundingRate: String(r.last_funding_rate ?? ''),
      }),
    );
  }
  return out;
}
