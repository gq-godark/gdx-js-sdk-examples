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

export function loadDotenv(): void {
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
    if (key && process.env[key] === undefined) {
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
