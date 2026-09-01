// Main clients
export {
  GodarkClient,
  DEFAULT_STREAM_BUFFER_SIZE,
  Environment,
  TESTNET_HPKE_STATIC_PUBLIC_KEY_HEX,
  DEVNET_HPKE_STATIC_PUBLIC_KEY_HEX,
  hpkeStaticPublicKeyHexForEnvironment,
  resolveHpkeStaticPublicKeyHex,
  resolvePassphrase,
  wsUrl,
} from './client.js';
export type {
  GodarkClientOptions,
  PlaceOrderConfirmation,
  PlaceOrderOptions,
  ModifyOrderOptions,
  AmendTpslOptions,
  CancelTpslOptions,
} from './client.js';
export { GodarkRestClient } from './restClient.js';
export type { GodarkRestClientOptions } from './restClient.js';
export { RestTransport, unwrapEnvelope, RestEnvelopeError } from './restTransport.js';
export {
  MarketDataClient,
  gomarketWsUrl,
  resolveMarketDataWsUrl,
  subscriptionCallbackKey,
  isDocsWireUrl,
} from './market-data.js';
export type { TransportOptions } from './transport.js';
export { mergeWebSocketOptions } from './transport.js';
export {
  DEFAULT_SYMBOLS,
  resolveSymbol,
  getSymbolName,
} from './symbols.js';
export { BoundedQueue } from './bounded-queue.js';

// Types
export type {
  OrderAck,
  OrderUpdate,
  PositionUpdate,
  PositionRow,
  OpenOrderRow,
  OpenOrdersSnapshot,
  PositionsSnapshot,
  PositionsSnapshotSource,
  SystemHealthUpdate,
  BalanceUpdate,
  MarginAlert,
  FundingRateUpdate,
  AccountMarginSummary,
  AccountMarginUpdate,
  SettlementUpdate,
  SettlementBatchStatus,
  SequencerPush,
  MeProfile,
  Balance,
  LeverageSetting,
  LeverageSettings,
  CountAck,
  TpslAck,
  MassQuoteLegStatusName,
  MassQuoteLegResult,
  MassQuoteAck,
  BatchCancelLegResult,
  BatchCancelAck,
  BatchModifyLegResult,
  BatchModifyAck,
} from './types.js';
export {
  createOrderAck,
  createOrderUpdate,
  createPositionUpdate,
  createPositionRow,
  createOpenOrderRow,
  createOpenOrdersSnapshot,
  createPositionsSnapshot,
  createBalanceUpdate,
  createMarginAlert,
  createFundingRateUpdate,
  createAccountMarginSummary,
  createAccountMarginUpdate,
  createSettlementUpdate,
  createLeverageSettings,
  createCountAck,
  createTpslAck,
  createMassQuoteAck,
  createBatchCancelAck,
  createBatchModifyAck,
} from './types.js';
export type { MassQuoteLegInput, BatchModifyLegInput, CorrelationIdWire } from './proto.js';
export {
  newCorrelationIdWire,
  correlationIdToLeBytes,
  correlationIdToBeBytes,
  correlationIdToWireHex,
  correlationIdFromPushWire,
  sessionSeqFromPushWire,
} from './proto.js';

// Enums
export type {
  Side, OrderType, TimeInForce, OrderStatus,
  OrderUpdateType, PositionUpdateType, CancelReason, StpMode,
} from './enums.js';

// Errors
export {
  GodarkError,
  AuthenticationError,
  SessionError,
  OrderError,
  ConnectionError,
  EncryptionError,
  TimeoutError,
} from './errors.js';

// Order error code registry
export {
  ORDER_ERROR_CODES,
  find as findOrderErrorEntry,
  findSymbolic as findOrderErrorSymbolic,
  makeOrderErrorFromCode,
  makeOrderErrorFromJson,
} from './orderErrorCode.js';
export type { OrderErrorEntry } from './orderErrorCode.js';
