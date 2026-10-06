/**
 * Minimal `.env` loader shared by the example scripts (stdlib-only).
 *
 *   - `loadDotenv()` reads `.env` from the bundle root if present and copies
 *     unset keys into `process.env`. The OS environment always wins over the
 *     file, matching standard dotenv behaviour.
 *   - `printOrderError()` pretty-prints `OrderError` rejections with the
 *     symbolic `errorCode` (e.g. `PRICE_DEVIATION_TOO_LARGE`) so MMs can spot
 *     the canonical reject reason at a glance.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SYMBOLS, GodarkRestClient, OrderError } from '@godark/sdk';

/** Demo size cap: at most 0.001 and at most 4 decimal places. */
export const MAX_DEMO_QTY = '0.001';
/** Rest at least this long after a place before cancel. */
export const CANCEL_DELAY_MS = 1000;

/** Keys that were non-blank in the real process env before `.env` merge. */
const osPresent = new Set<string>();
const fileVals = new Map<string, string>();
let osSnapshotted = false;

function nonempty(v: string | undefined): string {
  return v?.trim() ?? '';
}

/** OS `GODARK_*` then OS `GDX_*`, then the same order from `.env`. */
export function envFirst(names: readonly string[], fallback = ''): string {
  if (osSnapshotted) {
    for (const n of names) {
      if (osPresent.has(n)) {
        const v = nonempty(process.env[n]);
        if (v) return v;
      }
    }
    for (const n of names) {
      const v = nonempty(fileVals.get(n));
      if (v) return v;
    }
    return fallback;
  }
  for (const n of names) {
    const v = nonempty(process.env[n]);
    if (v) return v;
  }
  return fallback;
}

export function loadDotenv(): void {
  if (osSnapshotted) return;
  osPresent.clear();
  fileVals.clear();
  for (const [k, v] of Object.entries(process.env)) {
    if (nonempty(v)) osPresent.add(k);
  }
  osSnapshotted = true;
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, '..', '.env');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!key) continue;
    fileVals.set(key, val);
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toHttpOrigin(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (u.endsWith('/ws/v1')) u = u.slice(0, -'/ws/v1'.length);
  else if (u.endsWith('/ws')) u = u.slice(0, -'/ws'.length);
  if (u.startsWith('wss://')) return `https://${u.slice('wss://'.length)}`;
  if (u.startsWith('ws://')) return `http://${u.slice('ws://'.length)}`;
  return u;
}

/** REST origin from GODARK_REST_URL / GDX_REST_URL, else the edge URL. */
export function restBaseFromEnv(): string {
  const rest = envFirst(['GODARK_REST_URL', 'GDX_REST_URL'], '');
  if (rest) return toHttpOrigin(rest);
  const edge = envFirst(['GODARK_EDGE_URL', 'GDX_EDGE_URL'], '');
  if (edge) return toHttpOrigin(edge);
  return '';
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Mark used to price post-only limits.
 * An explicit GODARK_E2E_PRICE / GDX_E2E_PRICE / GDX_LIVE_PRICE wins.
 * Otherwise the mark is open-interest notional divided by size for `symbol`.
 * Throws when no positive mark is available so callers place nothing.
 */
export async function resolveLiveMark(symbol: string): Promise<number> {
  const raw = envFirst(['GODARK_E2E_PRICE', 'GDX_E2E_PRICE', 'GDX_LIVE_PRICE'], '');
  if (raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`Price override is not a positive number; refusing to place`);
    }
    return n;
  }
  const symbolId = DEFAULT_SYMBOLS[symbol];
  const base = restBaseFromEnv();
  const rest = new GodarkRestClient(base ? { restBaseUrl: base } : {});
  let rows: unknown[];
  try {
    rows = await rest.getOpenInterest();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `No live mark for ${symbol}: open interest read failed (${detail}). Refusing to place.`,
    );
  }
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    const id = asNumber(rec.symbol_id ?? rec.symbolId);
    const sym = typeof rec.symbol === 'string' ? rec.symbol : '';
    if (sym !== symbol && id !== symbolId) continue;
    const size = asNumber(rec.open_interest ?? rec.openInterest);
    const notional = asNumber(rec.oi_ccy ?? rec.oiCcy ?? rec.notional);
    if (size !== undefined && size > 0 && notional !== undefined && notional > 0) {
      const mark = notional / size;
      if (Number.isFinite(mark) && mark > 0) return mark;
    }
  }
  throw new Error(
    `No live mark for ${symbol} in open interest notional/size. Refusing to place.`,
  );
}

/** Post-only sell at least 500 above the mark, 1 decimal place (BTC perp). */
export function postOnlySellPrice(mark: number): string {
  const ticks = Math.ceil((mark + 500) * 10 - 1e-6);
  return (ticks / 10).toFixed(1);
}

/** Post-only buy at least 500 below the mark. `extraBelow` widens the gap. */
export function postOnlyBuyPrice(mark: number, extraBelow = 0): string {
  const ticks = Math.floor((mark - 500 - extraBelow) * 10 + 1e-6);
  return (ticks / 10).toFixed(1);
}

export function printOrderError(operation: string, err: unknown): void {
  if (err instanceof OrderError) {
    const code = err.errorCode ?? '<none>';
    console.error(`${operation}: OrderError code=${code} reason=${err.message}`);
  } else if (err instanceof Error) {
    console.error(`${operation}: ${err.name}: ${err.message}`);
  } else {
    console.error(`${operation}:`, err);
  }
}
