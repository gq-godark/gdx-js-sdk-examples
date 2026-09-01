import { unwrapEnvelope } from './restTransport.js';
import { DEFAULT_SYMBOLS } from './symbols.js';

/** Parse `GET /api/v1/instruments` data into a symbol → symbol_id map. */
export function parseInstrumentsSymbolMap(data: Record<string, unknown>): Record<string, number> {
  const list = data.instruments;
  if (!Array.isArray(list)) {
    throw new Error('instruments response missing instruments array');
  }
  const map: Record<string, number> = {};
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const obj = row as Record<string, unknown>;
    const symbol = obj.symbol;
    const symbolId = obj.symbol_id;
    if (typeof symbol === 'string' && typeof symbolId === 'number' && Number.isFinite(symbolId)) {
      map[symbol] = symbolId;
    }
  }
  if (Object.keys(map).length === 0) {
    throw new Error('instruments response contained no usable symbol rows');
  }
  return map;
}

function wsOriginToHttp(baseUrl: string): string {
  let u = baseUrl.trim().replace(/\/+$/, '');
  if (u.endsWith('/ws/v1')) u = u.slice(0, -'/ws/v1'.length);
  else if (u.endsWith('/ws')) u = u.slice(0, -'/ws'.length);
  if (u.startsWith('ws://')) return `http://${u.slice('ws://'.length)}`;
  if (u.startsWith('wss://')) return `https://${u.slice('wss://'.length)}`;
  return u;
}

/** Resolve HTTP origin for public `/api/v1/instruments` from WS or REST base URL. */
export function httpOriginForInstruments(baseUrl: string): string {
  if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
    return baseUrl.replace(/\/+$/, '');
  }
  return wsOriginToHttp(baseUrl);
}

/** Fetch symbol map from edge public instruments endpoint. */
export async function fetchSymbolMapFromEdge(baseUrl: string): Promise<Record<string, number>> {
  const origin = httpOriginForInstruments(baseUrl);
  const r = await fetch(`${origin}/api/v1/instruments`);
  if (!r.ok) throw new Error(`GET /api/v1/instruments ${r.status}`);
  const raw: unknown = await r.json();
  const data = unwrapEnvelope(raw);
  return parseInstrumentsSymbolMap(data);
}

/** Load symbol map from edge, falling back to bundled defaults when offline. */
export async function loadSymbolMapFromEdge(
  baseUrl: string,
): Promise<Record<string, number>> {
  try {
    return await fetchSymbolMapFromEdge(baseUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `Could not load instruments from edge (${msg}); using bundled offline symbol fallback`,
    );
    return { ...DEFAULT_SYMBOLS };
  }
}
