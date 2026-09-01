/**
 * Canonical numeric order error codes.
 *
 * The numeric codes mirror the wire format defined in `gdx-protocol`'s
 * `OrderErrorCode` enum; the SCREAMING_SNAKE_CASE `symbolic` names match
 * `OrderErrorCode::as_json_str` on the server.
 */

import { OrderError } from './errors.js';

export interface OrderErrorEntry {
  /** Wire code from the sequencer protobuf. */
  readonly code: number;
  /** SCREAMING_SNAKE_CASE name (matches JSON `OrderErrorCode::as_json_str`). */
  readonly symbolic: string;
  /** Human reason from the canonical protocol definition. */
  readonly reason: string;
}

export const ORDER_ERROR_CODES: readonly OrderErrorEntry[] = Object.freeze([
  // 1xxx — Node / MPC
  { code: 1001, symbolic: 'TRIPLE_EXHAUSTED', reason: 'Beaver triple store exhausted' },
  { code: 1002, symbolic: 'RANDOM_BIT_EXHAUSTED', reason: 'random bit store exhausted' },
  { code: 1003, symbolic: 'MPC_PROTOCOL_ERROR', reason: 'MPC protocol error' },
  { code: 1004, symbolic: 'MPC_TIMEOUT', reason: 'MPC session timeout' },
  { code: 1005, symbolic: 'MPC_CONFIG_ERROR', reason: 'MPC configuration error' },
  { code: 1006, symbolic: 'MPC_OPS_LIMIT_EXCEEDED', reason: 'MPC ops limit exceeded' },
  // 2xxx — Risk / validation
  { code: 2001, symbolic: 'RISK_CHECK_FAILED', reason: 'pre-trade risk check failed' },
  { code: 2002, symbolic: 'INSUFFICIENT_COLLATERAL', reason: 'insufficient collateral' },
  { code: 2003, symbolic: 'ORDER_NOT_FOUND', reason: 'order not found in book' },
  { code: 2004, symbolic: 'DUPLICATE_ORDER_ID', reason: 'duplicate order ID' },
  { code: 2005, symbolic: 'INSUFFICIENT_LIQUIDITY', reason: 'insufficient liquidity' },
  { code: 2006, symbolic: 'POSITION_UNDER_LIQUIDATION', reason: 'position is under active liquidation' },
  { code: 2007, symbolic: 'PRICE_DEVIATION_TOO_LARGE', reason: 'order price too far from oracle price' },
  { code: 2008, symbolic: 'LEVERAGE_EXCEEDS_MAX', reason: 'leverage exceeds instrument max' },
  { code: 2009, symbolic: 'INSTRUMENT_HALTED', reason: 'instrument halted -- not currently accepting orders' },
  { code: 2010, symbolic: 'LIQUIDITY_POOL_WITHDRAW_COOLDOWN', reason: 'withdrawal cooldown active' },
  { code: 2011, symbolic: 'LIQUIDITY_POOL_PAUSED', reason: 'liquidity pool paused' },
  { code: 2012, symbolic: 'LIQUIDITY_POOL_ILLIQUID', reason: 'insufficient pool liquidity for withdrawal' },
  { code: 2013, symbolic: 'BELOW_MIN_NOTIONAL', reason: 'order notional below tier minimum' },
  { code: 2014, symbolic: 'ORDER_EXCEEDS_COLLATERAL', reason: 'order size exceeds collateral value limits' },
  { code: 2015, symbolic: 'MARGIN_INSUFFICIENT', reason: 'insufficient margin for this trade' },
  // 3xxx — Sequencer
  { code: 3001, symbolic: 'ACK_TIMEOUT', reason: 'ACK collection timed out' },
  { code: 3002, symbolic: 'ACK_THRESHOLD_NOT_MET', reason: 'ACK threshold not met' },
  { code: 3003, symbolic: 'SEQUENCER_NOT_PRIMARY', reason: 'sequencer is standby, not primary' },
  { code: 3004, symbolic: 'INSUFFICIENT_MASKS', reason: 'insufficient input masks for authenticated split' },
  { code: 3005, symbolic: 'FANOUT_FAILED', reason: 'fanout delivery failed' },
  { code: 3006, symbolic: 'DESERIALIZATION_FAILED', reason: 'message deserialization failed' },
  { code: 3007, symbolic: 'ALL_NODES_EXHAUSTED', reason: 'all MPC nodes have exhausted precompute pools' },
  { code: 3008, symbolic: 'SESSION_EXPIRED', reason: 'E2E session expired or not established' },
  { code: 3009, symbolic: 'E2E_DECRYPTION_FAILED', reason: 'E2E decryption failed (session key mismatch)' },
  { code: 3010, symbolic: 'SHIELD_SUBMIT_RPC_FAILED', reason: 'shield transaction rejected by Solana RPC' },
  { code: 3011, symbolic: 'SEQUENCER_BUSY', reason: 'sequencer busy -- try again' },
  // 4xxx — Fencing / hot standby
  { code: 4001, symbolic: 'EPOCH_STALE', reason: 'fencing epoch is stale' },
  // 9xxx — catch-all
  { code: 9999, symbolic: 'INTERNAL_ERROR', reason: 'internal processing error' },
]);

const ORDER_BY_CODE: ReadonlyMap<number, OrderErrorEntry> = new Map(
  ORDER_ERROR_CODES.map((e) => [e.code, e]),
);

/** Look up an entry by its numeric wire code. */
export function find(code: number): OrderErrorEntry | undefined {
  return ORDER_BY_CODE.get(code);
}

/** Look up by SCREAMING_SNAKE_CASE symbolic name. */
export function findSymbolic(symbolic: string): OrderErrorEntry | undefined {
  for (const entry of ORDER_ERROR_CODES) {
    if (entry.symbolic === symbolic) return entry;
  }
  return undefined;
}

/**
 * Map protobuf `AckMessage.error_code` → rich {@link OrderError}.
 */
export function makeOrderErrorFromCode(
  numeric: number | null | undefined,
  detail?: string | null,
): OrderError {
  const detailSuffix =
    detail && detail.trim().length > 0 ? `: ${detail.trim()}` : '';
  if (numeric === null || numeric === undefined) {
    return new OrderError(`order rejected${detailSuffix}`);
  }
  if (numeric >= 0 && numeric <= 65535) {
    const entry = find(numeric);
    if (entry) {
      return new OrderError(
        `${entry.reason} (${entry.symbolic}, code=${entry.code})${detailSuffix}`,
        entry.symbolic,
      );
    }
  }
  return new OrderError(`order rejected${detailSuffix}`, String(numeric));
}

/**
 * JSON ack path — wire may carry numeric or symbolic `error_code` strings.
 *
 * Behavioral contract:
 *   - empty / null reason defaults to "order rejected"
 *   - if the wire code parses as a number in [0, 65535] and matches an
 *     entry, the symbolic name is preferred for `errorCode` and the
 *     human reason is upgraded UNLESS the caller already supplied a
 *     non-default reason
 *   - unknown symbolic strings pass through verbatim
 */
export function makeOrderErrorFromJson(
  reason: string | null | undefined,
  code: string | null | undefined,
): OrderError {
  let finalReason = reason && reason.length > 0 ? reason : 'order rejected';
  let finalCode = code ?? undefined;

  if (code && code.trim().length > 0) {
    const stripped = code.trim();
    const parsed = /^-?\d+$/.test(stripped) ? Number(stripped) : undefined;
    if (parsed !== undefined) {
      if (parsed >= 0 && parsed <= 65535) {
        const entry = find(parsed);
        if (entry) {
          finalCode = entry.symbolic;
          if (!reason || reason === '' || reason === 'order rejected') {
            finalReason = `${entry.reason} (${entry.symbolic}, code=${entry.code})`;
          }
        }
      } else {
        finalCode = String(parsed);
      }
    } else {
      const entry = findSymbolic(stripped);
      if (entry && (!reason || reason === '' || reason === 'order rejected')) {
        finalReason = `${entry.reason} (${entry.symbolic}, code=${entry.code})`;
      }
    }
  }

  return new OrderError(finalReason, finalCode);
}
