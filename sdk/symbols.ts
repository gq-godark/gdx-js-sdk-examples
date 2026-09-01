import { OrderError } from './errors.js';

/** Offline fallback symbol map (tests / edge unreachable). Production clients fetch from edge. */
export const DEFAULT_SYMBOLS: Readonly<Record<string, number>> = Object.freeze({
  'BTC-USDC-PERP': 1,
  'ETH-USDC-PERP': 2,
  'SOL-USDC-PERP': 5,
});

/** Resolve a symbol string to `symbol_id`, or throw {@link OrderError} if unknown. */
export function resolveSymbol(
  symbol: string,
  map: Record<string, number> = { ...DEFAULT_SYMBOLS },
): number {
  const sid = map[symbol];
  if (sid === undefined) {
    throw new OrderError(
      `Unknown symbol '${symbol}'. Known: ${Object.keys(map).join(', ')}`,
    );
  }
  return sid;
}

/** Reverse lookup: first matching name for `symbolId`, or `undefined` if none. */
export function getSymbolName(
  symbolId: number,
  map: Record<string, number> = { ...DEFAULT_SYMBOLS },
): string | undefined {
  for (const [name, id] of Object.entries(map)) {
    if (id === symbolId) return name;
  }
  return undefined;
}
