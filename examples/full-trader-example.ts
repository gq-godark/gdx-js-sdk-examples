/**
 * Full trader demo
 *
 *   npm run full-trader
 *
 * Environment (optional overrides; GODARK_* first, then GDX_*):
 *   GODARK_EDGE_URL / GDX_EDGE_URL (default Environment.Testnet)
 *   GODARK_API_KEY_ID / GDX_API_KEY_ID, GODARK_API_SECRET / GDX_API_SECRET
 *   GODARK_PASSPHRASE / GDX_PASSPHRASE
 *   GODARK_HPKE_STATIC_PUBLIC_KEY / GDX_HPKE_STATIC_PUBLIC_KEY (optional
 *   GODARK_TLS_SKIP_VERIFY / GDX_TLS_SKIP_VERIFY
 */
import {
  Environment,
  GodarkClient,
  GodarkError,
  type FundingRateUpdate,
  type LeverageSettings,
  type MassQuoteLegInput,
  type OrderAck,
  type OrderUpdate,
  type PositionUpdate,
  type TransportOptions,
} from '@godark/sdk';

import { envFirst, loadDotenv, printOrderError } from './dotenv.js';

loadDotenv();

const SYMBOL = 'BTC-USDC-PERP';
const STREAM_BUFFER = 256;

const DEFAULT_API_KEY_ID = 'YOUR_API_KEY_ID';
const DEFAULT_API_SECRET = 'YOUR_API_SECRET';
const DEFAULT_API_PASSPHRASE = 'YOUR_API_PASSPHRASE';

function envTruthy(names: readonly string[]): boolean {
  const v = envFirst(names, '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const EDGE_OVERRIDE = envFirst(['GODARK_EDGE_URL', 'GDX_EDGE_URL'], '');
/** Resolved edge for logging (Testnet default when unset). */
const EDGE_URL = EDGE_OVERRIDE || 'wss://api.godark-dex.com';

const tlsSkip = envTruthy(['GODARK_TLS_SKIP_VERIFY', 'GDX_TLS_SKIP_VERIFY']);

const transportOptions: TransportOptions = {
  headers: { 'X-Trader-Tag': 'js-full-trader-demo' },
  commandTimeout: 10_000,
  heartbeatInterval: 30_000,
  staleTimeout: 120_000,
  missedHeartbeatLimit: 2,
  wsOptions: {
    maxPayload: 65_536,
    handshakeTimeout: 10_000,
    ...(tlsSkip ? { rejectUnauthorized: false } : {}),
  },
};

const orderLog: OrderUpdate[] = [];
const positionLog: PositionUpdate[] = [];
let fundingCount = 0;
let leverageCount = 0;

function onFunding(update: FundingRateUpdate): void {
  fundingCount += 1;
  console.log(
    `FUND   symbol=${update.symbolId}  rate=${update.fundingRate}  last=${update.lastFundingRate}`,
  );
}

function onLeverageSettings(settings: LeverageSettings): void {
  leverageCount += 1;
  const rows = settings.settings
    .slice(0, 5)
    .map((r) => `${r.symbolId}=${r.leverage}x`)
    .join(', ');
  const suffix = settings.settings.length > 5 ? '...' : '';
  console.log(`LEVERAGE settings=[${rows}${suffix}]`);
}

function onOrder(update: OrderUpdate): void {
  orderLog.push(update);
  const badges = [
    update.cancelReason ? `cancel_reason=${update.cancelReason}` : "",
    update.reduceOnly ? "reduce_only=true" : "",
    update.postOnly ? "post_only=true" : "",
  ]
    .filter(Boolean)
    .join("  ");
  console.log(
    `ORDER  ${update.updateType.padEnd(6)}  id=${update.orderId.padEnd(8)}  status=${update.status.padEnd(10)}  filled=${update.filledQty}  remaining=${update.remainingQty}${badges ? `  ${badges}` : ""}`,
  );
}

function onPosition(update: PositionUpdate): void {
  positionLog.push(update);
  console.log(
    `POS    side=${update.side.padEnd(4)}  size=${update.size.padEnd(8)}  entry=${update.entryPrice}`,
  );
}

function onReconnect(): void {
  console.warn('RECONNECTED -- channels restored automatically');
}

function onError(err: GodarkError): void {
  console.error('SDK ERROR (non-fatal):', err.name, err.message);
}

function makeClient(): GodarkClient {
  const legacyKey = envFirst(['GODARK_API_KEY', 'GDX_API_KEY']);
  const hpkePin = envFirst(
    [
      'GODARK_HPKE_STATIC_PUBLIC_KEY',
      'GDX_HPKE_STATIC_PUBLIC_KEY',
      'GDX_HPKE_STATIC_PUBKEY',
      'GODARK_HPKE_STATIC_PUBLIC_KEY',
      'GDX_HPKE_STATIC_PUBLIC_KEY',
      'GDX_HPKE_STATIC_PUBKEY',
    ],
    '',
  );
  const common = {
    environment: Environment.Testnet,
    ...(EDGE_OVERRIDE ? { baseUrl: EDGE_OVERRIDE } : {}),
    ...(hpkePin ? { hpkeStaticPublicKeyHex: hpkePin } : {}),
    transportOptions,
    streamBufferSize: STREAM_BUFFER,
    autoReconnect: true,
    onError,
  };
  if (legacyKey) {
    return new GodarkClient({
      ...common,
      apiKey: legacyKey,
      ...(envFirst(['GODARK_USER_UUID', 'GDX_USER_UUID'], '')
        ? { userUuid: envFirst(['GODARK_USER_UUID', 'GDX_USER_UUID'], '') }
        : {}),
    });
  }
  const kid = envFirst(['GODARK_API_KEY_ID', 'GDX_API_KEY_ID'], DEFAULT_API_KEY_ID);
  const secret = envFirst(['GODARK_API_SECRET', 'GDX_API_SECRET'], DEFAULT_API_SECRET);
  const passphrase = envFirst(['GODARK_PASSPHRASE', 'GDX_PASSPHRASE'], DEFAULT_API_PASSPHRASE);
  if (kid === DEFAULT_API_KEY_ID || secret === DEFAULT_API_SECRET || passphrase === DEFAULT_API_PASSPHRASE) {
    throw new GodarkError(
      'Set GODARK_API_KEY_ID/GODARK_API_SECRET/GODARK_PASSPHRASE or legacy GODARK_API_KEY',
    );
  }
  return new GodarkClient({
    ...common,
    apiKeyId: kid,
    apiSecret: secret,
    passphrase,
  });
}

async function drainOrderUpdatesForMs(
  client: GodarkClient,
  ms: number,
): Promise<number> {
  let count = 0;
  const iter = client.orderUpdates();
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const step = await Promise.race([
        iter.next(),
        new Promise<IteratorResult<OrderUpdate>>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 80),
        ),
      ]);
      if (step.done || !('value' in step) || step.value === undefined) break;
      count += 1;
      const u = step.value;
      console.log(`  (queued) order_id=${u.orderId} status=${u.status}`);
    }
  } finally {
    await iter.return?.();
  }
  return count;
}

async function runStrategy(): Promise<void> {

  console.log('='.repeat(60));
  console.log('  GoDark SDK — Complete Trader Example');
  console.log('='.repeat(60));
  console.log(
    `Endpoint: ${EDGE_URL}  (TLS skip verify=${tlsSkip ? 'true' : 'false'})`,
  );

  const client = makeClient();
  client.onOrderUpdate(onOrder);
  client.onPositionUpdate(onPosition);
  client.onFundingRateUpdate(onFunding);
  client.onLeverageSettings(onLeverageSettings);
  client.onReconnect(onReconnect);

  console.log('Connecting...');
  try {
    await client.connect();
  } catch (e: unknown) {
    if (e instanceof GodarkError) {
      console.error('Failed to connect:', e.message);
      return;
    }
    throw e;
  }

  console.log(
    `Authenticated as user_uuid=${client.userUuid}  (HPKE session, buffer=${STREAM_BUFFER})`,
  );

  await client.subscribe(['orders', 'positions', 'funding_rate']);
  console.log('Subscribed to order + position + funding updates');

  // Leverage updates are available via GodarkRestClient.updateLeverage (REST one-shot HPKE).
  console.log('Skipping leverage update in WS example (use full-trader-rest for REST leverage).');

  const mark = Number(envFirst(['GODARK_E2E_PRICE', 'GDX_E2E_PRICE', 'GDX_LIVE_PRICE'], '79000'));
  const buyPx = Math.round(mark * 0.997 * 10) / 10;
  console.log(`Placing limit BUY @ ${buyPx} (mark=${mark})...`);
  let buyAck: OrderAck;
  try {
    buyAck = await client.placeOrder({
      symbol: SYMBOL,
      side: 'BUY',
      orderType: 'LIMIT',
      price: buyPx,
      quantity: 0.1,
      timeInForce: 'GTC',
    });
    console.log(`BUY placed: order_id=${buyAck.orderId}  sequence=${buyAck.sequence}`);
  } catch (e: unknown) {
    if (e instanceof GodarkError) {
      printOrderError('BUY', e);
      await client.disconnect();
      return;
    }
    throw e;
  }

  await new Promise((r) => setTimeout(r, 1000));

  const modifyPx = Math.round(mark * 0.996 * 10) / 10;
  console.log(`Modifying order price to ${modifyPx}...`);
  try {
    const modAck = await client.modifyOrder(buyAck.orderId, SYMBOL, {
      newPrice: modifyPx,
    });
    console.log(`Modified: order_id=${modAck.orderId}`);
  } catch (e: unknown) {
    printOrderError('MODIFY (may have filled before modify took)', e);
  }

  await new Promise((r) => setTimeout(r, 1000));

  const sellPx = Math.round(mark * 1.03 * 10) / 10;
  console.log(`Placing limit SELL @ ${sellPx}...`);
  try {
    const sellAck = await client.placeOrder({
      symbol: SYMBOL,
      side: 'SELL',
      orderType: 'LIMIT',
      price: sellPx,
      quantity: 0.05,
      postOnly: true,
    });
    console.log(`SELL placed: order_id=${sellAck.orderId}`);

    await new Promise((r) => setTimeout(r, 500));

    const cancelAck = await client.cancelOrder(sellAck.orderId, SYMBOL);
    console.log(`SELL cancelled: order_id=${cancelAck.orderId}`);
  } catch (e: unknown) {
    printOrderError('SELL/CANCEL', e);
  }

  await new Promise((r) => setTimeout(r, 1000));

  console.log('Draining any remaining queued updates (short window)...');
  const drained = await drainOrderUpdatesForMs(client, 400);
  console.log(`Drained ${drained} queued order update(s)`);

  // --- Bulk quote (mass quote) ---
  // Place a whole ladder of resting quotes in one batched request. Leaving
  // postOnly undefined (or true) keeps post-only behaviour: a leg that would
  // cross is rejected as "failed" so the batch fuses into a single MPC round.
  // Pass postOnly: false for the relaxed path, where a crossing leg takes
  // liquidity up to its limit and rests the remainder (the number of taker
  // fills is reported per leg as fillCount).
  // Anchor ladder/cross prices to GODARK_E2E_PRICE / GDX_LIVE_PRICE (or GDX_BASE).
  const base = Number(process.env.GDX_BASE ?? String(mark)) || mark;
  const round1 = (x: number) => Math.round(x * 10) / 10;
  console.log(`Mass-quoting a 3-level BUY ladder (post-only), base=${base.toFixed(2)}...`);
  const ladder: MassQuoteLegInput[] = [
    { side: 'BUY', price: round1(base * (1 - 0.003)), quantity: 0.02 },
    { side: 'BUY', price: round1(base * (1 - 0.006)), quantity: 0.02 },
    { side: 'BUY', price: round1(base * (1 - 0.009)), quantity: 0.02 },
  ];
  const restingIds: string[] = [];
  try {
    const mq = await client.massQuote(SYMBOL, ladder);
    console.log(
      `Mass quote: success=${mq.success} sequence=${mq.sequence} legs=${mq.results.length}`,
    );
    for (const r of mq.results) {
      console.log(
        `  leg ${r.legIndex}: status=${r.status} new_order_id=${r.newOrderId ?? '-'} fills=${r.fillCount} err=${r.errorCode ?? '-'}`,
      );
      if (r.status === 'open' && r.newOrderId) restingIds.push(r.newOrderId);
    }
  } catch (e: unknown) {
    printOrderError('MASS QUOTE', e);
  }

  await new Promise((r) => setTimeout(r, 1000));

  if (restingIds.length > 0) {
    console.log('cancel_all_orders (cleanup ladder)...');
    try {
      const ca = await client.cancelAllOrders(SYMBOL);
      console.log(
        `  cancel_all: count=${ca.count} ids=[${ca.orderIds.join(', ')}]`,
      );
    } catch (e: unknown) {
      printOrderError('cancel_all rejected', e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // Demonstrate the batch-level postOnly flag on a crossing leg.
  const crossPx = round1(base * 1.05);
  // postOnly=true: a crossing leg is rejected (would-cross, error_code 2018).
  console.log('Mass-quoting a crossing BUY with postOnly=true (expect rejected/2018)...');
  try {
    const mq = await client.massQuote(
      SYMBOL,
      [{ side: 'BUY', price: crossPx, quantity: 0.001 }],
      true,
    );
    for (const r of mq.results) {
      console.log(`  leg ${r.legIndex}: status=${r.status} err=${r.errorCode ?? '-'} fills=${r.fillCount}`);
    }
  } catch (e: unknown) {
    printOrderError('MASS QUOTE postOnly=true', e);
  }
  await new Promise((r) => setTimeout(r, 500));

  // postOnly=false (relaxed): crossing leg takes liquidity, then rests remainder.
  console.log('Mass-quoting a crossing BUY with postOnly=false (expect filled, fills>0)...');
  // The relaxed leg may rest a remainder after taking liquidity; track its id so
  // it gets cleaned up below instead of leaking onto the book.
  const strayIds: string[] = [];
  try {
    const mq = await client.massQuote(
      SYMBOL,
      [{ side: 'BUY', price: crossPx, quantity: 0.003 }],
      false,
    );
    for (const r of mq.results) {
      console.log(
        `  leg ${r.legIndex}: status=${r.status} new_order_id=${r.newOrderId ?? '-'} err=${r.errorCode ?? '-'} fills=${r.fillCount}`,
      );
      if (r.status === 'open' && r.newOrderId) strayIds.push(r.newOrderId);
    }
  } catch (e: unknown) {
    printOrderError('MASS QUOTE postOnly=false', e);
  }
  await new Promise((r) => setTimeout(r, 1000));

  if (strayIds.length > 0) {
    console.log(`Batch-cancelling ${strayIds.length} relaxed-leg remainder(s) (cleanup)...`);
    try {
      const bc = await client.batchCancel(SYMBOL, strayIds);
      for (const r of bc.results) {
        console.log(`  cancel id=${r.orderId}: cancelled=${r.cancelled} err=${r.errorCode ?? '-'}`);
      }
    } catch (e: unknown) {
      printOrderError('BATCH CANCEL (remainder)', e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log('Cancelling original BUY (cleanup)...');
  try {
    await client.cancelOrder(buyAck.orderId, SYMBOL);
    console.log('Original BUY cancelled');
  } catch {
    console.log('Original BUY already filled or cancelled');
  }

  console.log('='.repeat(60));
  console.log('  Session complete');
  console.log(`  Order updates received (via callback): ${orderLog.length}`);
  console.log(`  Position updates received:             ${positionLog.length}`);
  console.log(`  Funding updates received:              ${fundingCount}`);
  console.log(`  Leverage settings received:            ${leverageCount}`);
  console.log('='.repeat(60));

  await client.disconnect();
  console.log('Disconnected cleanly');
}

function main(): void {
  const shutdown = () => {
    console.log('\nCaught interrupt, exiting...');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  runStrategy()
    .then(() => process.exit(0))
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}

main();
