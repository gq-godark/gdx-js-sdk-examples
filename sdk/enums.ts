export type Side = 'BUY' | 'SELL';

export type OrderType =
  | 'MARKET'
  | 'LIMIT'
  | 'PEG'
  | 'STOP_MARKET'
  | 'STOP_LIMIT';

export type TimeInForce = 'GTC' | 'IOC' | 'FOK' | 'GTD';

export type OrderStatus =
  | 'NEW'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED';

export type OrderUpdateType =
  | 'OPEN'
  | 'FILLED'
  | 'PARTIALLY_FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'MODIFIED'
  | 'CANCEL_REJECTED'
  | 'MODIFY_REJECTED';

export type PositionUpdateType =
  | 'SNAPSHOT'
  | 'OPEN'
  | 'INCREASE'
  | 'DECREASE'
  | 'CLOSE'
  | 'FUNDING_APPLIED';

export type CancelReason =
  | 'USER_REQUESTED'
  | 'IOC_REMAINDER'
  | 'FOK_NOT_FILLED'
  | 'EXPIRED'
  | 'SYSTEM'
  | 'ADL'
  | 'LIQUIDATED_CANCELED'
  | 'MARGIN_CANCELED'
  | 'REDUCE_ONLY'
  | 'STP_EXPIRE_TAKER'
  | 'STP_CANCEL_RESTING';

export type StpMode =
  | 'UNSPECIFIED'
  | 'CANCEL_RESTING'
  | 'CANCEL_AGGRESSOR'
  | 'CANCEL_BOTH';

export type RequestType =
  | 'place'
  | 'cancel'
  | 'modify'
  | 'subscribe'
  | 'signing'
  | 'get_open_orders'
  | 'get_order_history'
  | 'adjust_margin'
  | 'update_leverage'
  | 'mass_quote'
  | 'batch_cancel'
  | 'batch_modify'
  | 'cancel_tpsl'
  | 'amend_tpsl'
  | 'update_margin_mode'
  | 'get_positions'
  | 'get_account'
  | 'cancel_all'
  | 'close_all'
  | 'reverse';

export type ResponseMessageType =
  | 'order_update'
  | 'system_health'
  | 'ack'
  | 'open_orders_snapshot'
  | 'positions_snapshot'
  | 'balance_and_position'
  | 'account_margin_update'
  | 'account_update'
  | 'mass_quote_ack'
  | 'batch_cancel_ack'
  | 'batch_modify_ack'
  | 'tpsl_update'
  | 'leverage_settings'
  | 'cancel_all_ack'
  | 'close_all_ack'
  | 'reverse_ack'
  | 'tpsl_ack';

export const SIDE_TO_PROTO: Record<Side, number> = { BUY: 1, SELL: 2 };

export const SIDE_FROM_PROTO: Record<number, Side> = {
  1: 'BUY',
  2: 'SELL',
};

export const ORDER_TYPE_TO_PROTO: Record<OrderType, number> = {
  MARKET: 1,
  LIMIT: 2,
  PEG: 3,
  STOP_MARKET: 4,
  STOP_LIMIT: 5,
};

export const ORDER_TYPE_FROM_PROTO: Record<number, OrderType> = {
  1: 'MARKET',
  2: 'LIMIT',
  3: 'PEG',
  4: 'STOP_MARKET',
  5: 'STOP_LIMIT',
};

export const TIME_IN_FORCE_TO_PROTO: Record<TimeInForce, number> = {
  GTC: 1,
  IOC: 2,
  FOK: 3,
  GTD: 4,
};

export const TIME_IN_FORCE_FROM_PROTO: Record<number, TimeInForce> = {
  1: 'GTC',
  2: 'IOC',
  3: 'FOK',
  4: 'GTD',
};

export const ORDER_STATUS_FROM_PROTO: Record<number, OrderStatus> = {
  1: 'NEW',
  2: 'PARTIALLY_FILLED',
  3: 'FILLED',
  4: 'CANCELLED',
  5: 'REJECTED',
};

export const ORDER_UPDATE_TYPE_FROM_PROTO: Record<number, OrderUpdateType> = {
  1: 'OPEN',
  2: 'FILLED',
  3: 'PARTIALLY_FILLED',
  4: 'CANCELLED',
  5: 'REJECTED',
  6: 'MODIFIED',
  7: 'CANCEL_REJECTED',
  8: 'MODIFY_REJECTED',
};

export const POSITION_UPDATE_TYPE_FROM_PROTO: Record<
  number,
  PositionUpdateType
> = {
  1: 'SNAPSHOT',
  2: 'OPEN',
  3: 'INCREASE',
  4: 'DECREASE',
  5: 'CLOSE',
  6: 'FUNDING_APPLIED',
};

export const STP_MODE_TO_PROTO: Record<StpMode, number> = {
  UNSPECIFIED: 0,
  CANCEL_RESTING: 1,
  CANCEL_AGGRESSOR: 2,
  CANCEL_BOTH: 3,
};

export const CANCEL_REASON_FROM_PROTO: Record<number, CancelReason> = {
  1: 'USER_REQUESTED',
  2: 'IOC_REMAINDER',
  3: 'FOK_NOT_FILLED',
  4: 'EXPIRED',
  5: 'SYSTEM',
  6: 'ADL',
  7: 'LIQUIDATED_CANCELED',
  8: 'MARGIN_CANCELED',
  9: 'REDUCE_ONLY',
  10: 'STP_EXPIRE_TAKER',
  11: 'STP_CANCEL_RESTING',
};

export const REQUEST_TYPE_TO_PROTO: Record<RequestType, number> = {
  place: 1,
  cancel: 2,
  modify: 3,
  subscribe: 4,
  // Legacy alias retained for older call sites; wire value is GET_OPEN_ORDERS.
  signing: 5,
  get_open_orders: 5,
  // Legacy alias; wire value is ADJUST_MARGIN.
  get_order_history: 7,
  adjust_margin: 7,
  update_leverage: 6,
  mass_quote: 8,
  batch_cancel: 9,
  batch_modify: 10,
  cancel_tpsl: 11,
  amend_tpsl: 12,
  update_margin_mode: 13,
  get_positions: 14,
  get_account: 15,
  cancel_all: 16,
  close_all: 17,
  reverse: 18,
};

// Wire values must match the proto enum `gdx.common.v1.ResponseMessageType`
// in `v1/devnet`. These ints are used to build the AAD that protects every
// encrypted response from the sequencer — a wrong int here causes AES-GCM
// authentication failures on the affected push type.
//
// Slot 2 (the retired `position_update`) is intentionally omitted; positions
// now flow as `positions_snapshot = 7`.
export const RESPONSE_MESSAGE_TYPE_TO_PROTO: Record<
  ResponseMessageType,
  number
> = {
  order_update: 1,
  system_health: 2,
  ack: 3,
  open_orders_snapshot: 4,
  positions_snapshot: 5,
  balance_and_position: 6,
  account_margin_update: 7,
  account_update: 7,
  mass_quote_ack: 8,
  batch_cancel_ack: 9,
  batch_modify_ack: 10,
  tpsl_update: 11,
  leverage_settings: 12,
  cancel_all_ack: 13,
  close_all_ack: 14,
  reverse_ack: 15,
  tpsl_ack: 16,
};
