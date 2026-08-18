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

import { OrderError } from '@godark/sdk';

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
