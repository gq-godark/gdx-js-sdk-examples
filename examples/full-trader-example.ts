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
  ConnectionError,
  Environment,
  GodarkClient,
  GodarkError,
  GodarkRestClient,
  type FundingRateUpdate,
  type LeverageSettings,
  type MassQuoteLegInput,
  type OrderAck,
  type OrderUpdate,
  type PositionUpdate,
  type TransportOptions,
} from '@godark/sdk';

import {
  CANCEL_DELAY_MS,
  MAX_DEMO_QTY,
  envFirst,
  loadDotenv,
  postOnlyBuyPrice,
  postOnlySellPrice,
  printOrderError,
  resolveLiveMark,
  sleep,
} from './dotenv.js';

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
    maxPayload: 1_048_576,
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
      ...(envFirst(['GODARK_ACCOUNT', 'GDX_ACCOUNT'], '')
        ? { account: envFirst(['GODARK_ACCOUNT', 'GDX_ACCOUNT'], '') }
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

function waitForReconnect(client: GodarkClient, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ConnectionError('reconnect timed out')),
      ms,
    );
    client.onReconnect(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** One retry after auto-reconnect when the socket drops between commands. */
async function withReconnect<T>(
  client: GodarkClient,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof ConnectionError)) throw err;
    console.warn('connection dropped — waiting for reconnect...');
    await waitForReconnect(client, 8_000);
    return await fn();
  }
}

async function cancelViaRest(orderId: string): Promise<void> {
  const kid = envFirst(['GODARK_API_KEY_ID', 'GDX_API_KEY_ID']);
  const secret = envFirst(['GODARK_API_SECRET', 'GDX_API_SECRET']);
  const passphrase = envFirst(['GODARK_PASSPHRASE', 'GDX_PASSPHRASE']);
  const legacy = envFirst(['GODARK_API_KEY', 'GDX_API_KEY']);
  const restBase = envFirst(['GODARK_REST_URL', 'GDX_REST_URL'], '') || undefined;
  const edge = envFirst(['GODARK_EDGE_URL', 'GDX_EDGE_URL'], '');
  const restBaseUrl =
    restBase ||
    (edge
      ? edge.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '')
      : undefined);
  const account = envFirst(['GODARK_ACCOUNT', 'GDX_ACCOUNT'], '') || undefined;
  const rest =
    kid && secret && passphrase
      ? new GodarkRestClient({
          apiKeyId: kid,
          apiSecret: secret,
          passphrase,
          ...(restBaseUrl ? { restBaseUrl } : {}),
          ...(account ? { account } : {}),
        })
      : legacy
        ? new GodarkRestClient({
            apiKey: legacy,
            ...(restBaseUrl ? { restBaseUrl } : {}),
            ...(account ? { account } : {}),
          })
        : null;
  if (!rest) throw new Error('no credentials for REST cleanup cancel');
  try {
    await rest.connect();
    const ack = await rest.cancelOrder(orderId, SYMBOL);
    if (!ack.success) throw new Error(`REST cancel failed for ${orderId}`);
  } finally {
    await rest.disconnect().catch(() => {});
  }
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

  let mark: number;
  try {
    mark = await resolveLiveMark(SYMBOL);
  } catch (e: unknown) {
    printOrderError('live mark', e);
    throw e;
  }
  console.log(`Live mark=${mark}`);

  console.log('Connecting...');
  try {
    await client.connect();
  } catch (e: unknown) {
    if (e instanceof GodarkError) {
      console.error('Failed to connect:', e.message);
    }
    await client.disconnect().catch(() => {});
    throw e;
  }

  console.log(
    `Authenticated as account=${client.account}  (HPKE session, buffer=${STREAM_BUFFER})`,
  );

  const open = new Set<string>();

  const note = (id: string | undefined): void => {
    if (id) open.add(id);
  };
  const forget = (id: string | undefined): void => {
    if (id) open.delete(id);
  };

  try {
    await client.subscribe(['orders', 'positions', 'funding_rate']);
    console.log('Subscribed to order + position + funding updates');

    // `client.updateLeverage(SYMBOL, leverage)` is available over this encrypted
    // WebSocket. This reference flow avoids changing account configuration.
    console.log('Skipping leverage mutation in the reference flow.');

    const buyPx = postOnlyBuyPrice(mark);
    console.log(`Placing post-only BUY @ ${buyPx} qty=${MAX_DEMO_QTY} (mark=${mark})...`);
    const buyAck: OrderAck = await client.placeOrder({
      symbol: SYMBOL,
      side: 'BUY',
      orderType: 'LIMIT',
      price: buyPx,
      quantity: MAX_DEMO_QTY,
      postOnly: true,
      timeInForce: 'GTC',
    });
    if (!buyAck.success || !buyAck.orderId) {
      throw new Error('BUY place did not return an order id');
    }
    note(buyAck.orderId);
    console.log(`BUY placed: order_id=${buyAck.orderId}  sequence=${buyAck.sequence}`);

    await sleep(CANCEL_DELAY_MS);
    const modifyPx = postOnlyBuyPrice(mark, 100);
    console.log(`Modifying order price to ${modifyPx}...`);
    const modAck = await client.modifyOrder(buyAck.orderId, SYMBOL, {
      newPrice: modifyPx,
    });
    if (!modAck.success) throw new Error(`modify failed for ${buyAck.orderId}`);
    console.log(`Modified: order_id=${modAck.orderId}`);

    await sleep(CANCEL_DELAY_MS);
    const sellPx = postOnlySellPrice(mark);
    console.log(`Placing post-only SELL @ ${sellPx}...`);
    const sellAck = await client.placeOrder({
      symbol: SYMBOL,
      side: 'SELL',
      orderType: 'LIMIT',
      price: sellPx,
      quantity: MAX_DEMO_QTY,
      postOnly: true,
    });
    if (!sellAck.success || !sellAck.orderId) {
      throw new Error('SELL place did not return an order id');
    }
    note(sellAck.orderId);
    console.log(`SELL placed: order_id=${sellAck.orderId}`);

    await sleep(CANCEL_DELAY_MS);
    const cancelAck = await withReconnect(client, () =>
      client.cancelOrder(sellAck.orderId, SYMBOL),
    );
    if (!cancelAck.success) throw new Error(`SELL cancel failed for ${sellAck.orderId}`);
    forget(sellAck.orderId);
    console.log(`SELL cancelled: order_id=${cancelAck.orderId}`);

    // Post-only bids at least 500 / 700 / 900 below the mark. Every leg is
    // cancelled below, including via batchCancel.
    console.log(`Mass-quoting a 3-level post-only BUY ladder, mark=${mark.toFixed(2)}...`);
    const ladder: MassQuoteLegInput[] = [
      { side: 'BUY', price: postOnlyBuyPrice(mark, 0), quantity: MAX_DEMO_QTY },
      { side: 'BUY', price: postOnlyBuyPrice(mark, 200), quantity: MAX_DEMO_QTY },
      { side: 'BUY', price: postOnlyBuyPrice(mark, 400), quantity: MAX_DEMO_QTY },
    ];
    const mq = await withReconnect(client, () =>
      client.massQuote(SYMBOL, ladder, true),
    );
    console.log(
      `Mass quote: success=${mq.success} sequence=${mq.sequence} legs=${mq.results.length}`,
    );
    const quoteIds: string[] = [];
    for (const r of mq.results) {
      console.log(
        `  leg ${r.legIndex}: status=${r.status} new_order_id=${r.newOrderId ?? '-'} fills=${r.fillCount} err=${r.errorCode ?? '-'}`,
      );
      if (r.fillCount > 0) {
        note(r.newOrderId);
        throw new Error(`mass-quote leg ${r.legIndex} filled`);
      }
      if (r.status !== 'open' || !r.newOrderId) {
        throw new Error(
          `mass-quote leg ${r.legIndex} status=${r.status} err=${r.errorCode ?? '-'}`,
        );
      }
      note(r.newOrderId);
      quoteIds.push(r.newOrderId);
    }

    await sleep(CANCEL_DELAY_MS);
    console.log(`Batch-cancelling ${quoteIds.length} ladder order(s)...`);
    const bc = await withReconnect(client, () =>
      client.batchCancel(SYMBOL, quoteIds),
    );
    if (!bc.success) throw new Error('batchCancel reported failure');
    for (const r of bc.results) {
      console.log(`  cancel id=${r.orderId}: cancelled=${r.cancelled} err=${r.errorCode ?? '-'}`);
      if (!r.cancelled) throw new Error(`batchCancel did not cancel ${r.orderId}`);
      forget(r.orderId);
    }

    await sleep(CANCEL_DELAY_MS);
    console.log('Cancelling original BUY...');
    const buyCancel = await withReconnect(client, () =>
      client.cancelOrder(buyAck.orderId, SYMBOL),
    );
    if (!buyCancel.success) throw new Error(`BUY cancel failed for ${buyAck.orderId}`);
    forget(buyAck.orderId);
    console.log('Original BUY cancelled');

    console.log('='.repeat(60));
    console.log('  Session complete');
    console.log(`  Order updates received (via callback): ${orderLog.length}`);
    console.log(`  Position updates received:             ${positionLog.length}`);
    console.log(`  Funding updates received:              ${fundingCount}`);
    console.log(`  Leverage settings received:            ${leverageCount}`);
    console.log('='.repeat(60));
  } catch (err) {
    printOrderError('full-trader', err);
    throw err;
  } finally {
    if (open.size > 0) {
      console.error(`Cleaning up ${open.size} order(s) before disconnect`);
      await sleep(CANCEL_DELAY_MS);
      for (const id of [...open]) {
        try {
          const ack = await client.cancelOrder(id, SYMBOL);
          if (!ack.success) throw new Error('cancel not successful');
          open.delete(id);
        } catch (e: unknown) {
          printOrderError(`cleanup cancel ${id}`, e);
          try {
            await cancelViaRest(id);
            open.delete(id);
            console.log(`REST cleanup cancel ok ${id}`);
          } catch (restErr) {
            printOrderError(`REST cleanup cancel ${id}`, restErr);
          }
        }
      }
    }
    await client.disconnect().catch(() => {});
    console.log('Disconnected cleanly');
    if (open.size > 0) {
      throw new Error(`left ${open.size} order(s) open`);
    }
  }
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
