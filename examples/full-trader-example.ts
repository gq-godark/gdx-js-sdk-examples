/**
 * Full trader demo
 *
 *   npm run full-trader
 *
 * Environment (optional overrides):
 *   GDX_EDGE_URL / GODARK_EDGE_URL (default wss://api.godark-dex.com)
 *   GDX_API_KEY_ID / GODARK_API_KEY_ID, GDX_API_SECRET / GODARK_API_SECRET
 *   GDX_TLS_SKIP_VERIFY / GODARK_TLS_SKIP_VERIFY
 */
import {
  GodarkClient,
  GodarkError,
  GodarkRestClient,
  MarketDataClient,
  type OrderAck,
  type OrderUpdate,
  type PositionUpdate,
  type TransportOptions,
} from '@godark/sdk';

import { loadDotenv, printOrderError } from './dotenv.js';

const SYMBOL = 'BTC-USDC-PERP';
const STREAM_BUFFER = 256;

const DEFAULT_API_KEY_ID = 'YOUR_API_KEY_ID';
const DEFAULT_API_SECRET = 'YOUR_API_SECRET';

function envFirst(
  names: readonly string[],
  fallback: string,
): string {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) return v;
  }
  return fallback;
}

function envTruthy(names: readonly string[]): boolean {
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (!v) continue;
    const s = v.toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  }
  return false;
}

const EDGE_URL = envFirst(
  ['GDX_EDGE_URL', 'GODARK_EDGE_URL'],
  'wss://api.godark-dex.com',
);

const tlsSkip = envTruthy(['GDX_TLS_SKIP_VERIFY', 'GODARK_TLS_SKIP_VERIFY']);

const transportOptions: TransportOptions = {
  headers: { 'X-Trader-Tag': 'js-full-trader-demo' },
  commandTimeout: 10_000,
  heartbeatInterval: 30_000,
  staleTimeout: 60_000,
  wsOptions: {
    maxPayload: 65_536,
    handshakeTimeout: 10_000,
    ...(tlsSkip ? { rejectUnauthorized: false } : {}),
  },
};

const orderLog: OrderUpdate[] = [];
const positionLog: PositionUpdate[] = [];

let bestAsk: number | null = null;

function onOrder(update: OrderUpdate): void {
  orderLog.push(update);
  console.log(
    `ORDER  ${update.updateType.padEnd(6)}  id=${update.orderId.padEnd(8)}  status=${update.status.padEnd(10)}  filled=${update.filledQty}  remaining=${update.remainingQty}`,
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

function onOrderbook(msg: Record<string, unknown>): void {
  const asks = msg.asks as unknown;
  if (Array.isArray(asks) && asks.length > 0) {
    const first = asks[0] as unknown;
    if (Array.isArray(first)) {
      bestAsk = Number(first[0]);
    } else if (first && typeof first === 'object' && 'price' in (first as object)) {
      bestAsk = Number((first as { price?: string }).price);
    }
  }
}

function onTrade(msg: Record<string, unknown>): void {
  console.log(
    `TRADE  price=${String(msg.price)}  size=${String(msg.size)}  side=${String(msg.side)}`,
  );
}

function makeClient(): GodarkClient {
  const kid = envFirst(['GDX_API_KEY_ID', 'GODARK_API_KEY_ID'], DEFAULT_API_KEY_ID);
  const secret = envFirst(['GDX_API_SECRET', 'GODARK_API_SECRET'], DEFAULT_API_SECRET);
  return new GodarkClient({
    apiKeyId: kid,
    apiSecret: secret,
    baseUrl: EDGE_URL,
    transportOptions,
    streamBufferSize: STREAM_BUFFER,
    autoReconnect: true,
    onError,
  });
}

async function drainOrderUpdatesForMs(
  client: GodarkClient,
  ms: number,
): Promise<number> {
  let count = 0;
  const iter = client.orderUpdates();
  const deadline = Date.now() + ms;
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
  return count;
}

async function runStrategy(): Promise<void> {
  loadDotenv();

  console.log('='.repeat(60));
  console.log('  GoDark SDK — Complete Trader Example');
  console.log('='.repeat(60));
  console.log(
    `Endpoint: ${EDGE_URL}  (TLS skip verify=${tlsSkip ? 'true' : 'false'})`,
  );

  {
    const rest = new GodarkRestClient({
      apiKeyId: envFirst(['GDX_API_KEY_ID', 'GODARK_API_KEY_ID'], DEFAULT_API_KEY_ID),
      apiSecret: envFirst(['GDX_API_SECRET', 'GODARK_API_SECRET'], DEFAULT_API_SECRET),
    });
    await rest.connect();
    try {
      const bal = await rest.getMyBalance();
      console.log(`Balance: shielded_raw=${bal.shieldedBalanceRaw.toString()}`);
    } finally {
      await rest.disconnect();
    }
  }

  const client = makeClient();
  client.onOrderUpdate(onOrder);
  client.onPositionUpdate(onPosition);
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
    `Authenticated as user_uuid=${client.userUuid}  (session encrypted, buffer=${STREAM_BUFFER})`,
  );

  await client.subscribe(['orders', 'positions']);
  console.log('Subscribed to order + position updates');

  const md = new MarketDataClient(EDGE_URL, {
    headers: { 'X-Trader-Tag': 'js-md-demo' },
    wsOptions: tlsSkip ? { rejectUnauthorized: false } : undefined,
  });
  try {
    await md.connect();
    await md.subscribeOrderbook(SYMBOL, onOrderbook);
    await md.subscribeTrades(SYMBOL, onTrade);
    console.log(`Market data streaming for ${SYMBOL}`);
    if (bestAsk !== null) console.log(`  (best ask snapshot) ${bestAsk}`);
  } catch (e: unknown) {
    console.warn('Market data unavailable (continuing without):', e);
  }

  console.log('Placing limit BUY...');
  let buyAck: OrderAck;
  try {
    buyAck = await client.placeOrder({
      symbol: SYMBOL,
      side: 'BUY',
      orderType: 'LIMIT',
      price: 67_500,
      quantity: 0.1,
      timeInForce: 'GTC',
    });
    console.log(`BUY placed: order_id=${buyAck.orderId}  sequence=${buyAck.sequence}`);
  } catch (e: unknown) {
    if (e instanceof GodarkError) {
      printOrderError('BUY', e);
      await md.disconnect().catch(() => {});
      await client.disconnect();
      return;
    }
    throw e;
  }

  await new Promise((r) => setTimeout(r, 1000));

  console.log('Modifying order price to $68,000...');
  try {
    const modAck = await client.modifyOrder(buyAck.orderId, SYMBOL, {
      newPrice: 68_000,
    });
    console.log(`Modified: order_id=${modAck.orderId}`);
  } catch (e: unknown) {
    printOrderError('MODIFY (may have filled before modify took)', e);
  }

  await new Promise((r) => setTimeout(r, 1000));

  console.log('Placing limit SELL...');
  try {
    const sellAck = await client.placeOrder({
      symbol: SYMBOL,
      side: 'SELL',
      orderType: 'LIMIT',
      price: 95_000,
      quantity: 0.05,
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
  console.log('='.repeat(60));

  await md.disconnect().catch(() => {});
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

  runStrategy().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}

main();
