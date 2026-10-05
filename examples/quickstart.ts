/**
 * GoDark SDK — Quickstart
 *
 * WebSocket login (REST access token), subscribe to orders, place a
 * post-only limit sell at least 500 above the live mark, then cancel.
 * Read positions with `npm run full-trader-rest` (`getPositions`) or the
 * `positions` channel.
 *
 *   npm run quickstart
 *
 * Environment:
 *   GODARK_API_KEY_ID, GODARK_API_SECRET, GODARK_PASSPHRASE
 *   (legacy GDX_* aliases accepted when GODARK_* is unset)
 *   GODARK_EDGE_URL (optional; default Environment.Testnet)
 *   GODARK_ACCOUNT / GDX_ACCOUNT (optional account fallback for local auth)
 *   GODARK_HPKE_STATIC_PUBLIC_KEY / GDX_HPKE_STATIC_PUBLIC_KEY (optional)
 *   GODARK_E2E_PRICE / GDX_E2E_PRICE / GDX_LIVE_PRICE (optional mark override)
 */
import {
  ConnectionError,
  Environment,
  GodarkClient,
  SessionError,
} from '@godark/sdk';

import {
  CANCEL_DELAY_MS,
  MAX_DEMO_QTY,
  envFirst,
  loadDotenv,
  postOnlySellPrice,
  printOrderError,
  resolveLiveMark,
  sleep,
} from './dotenv.js';

const SYMBOL = 'BTC-USDC-PERP';

/** Stop auto-reconnect, then open a fresh authenticated + HPKE session. */
async function recoverSession(client: GodarkClient): Promise<void> {
  await client.disconnect().catch(() => {});
  await sleep(1500);
  await client.connect();
  await client.subscribe(['orders']);
}

/** Run once; on transient disconnect/session loss, recover and retry once. */
async function withOneRetry<T>(
  label: string,
  fn: () => Promise<T>,
  recover: () => Promise<void>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const retriable =
      err instanceof ConnectionError ||
      (err instanceof SessionError &&
        err.message.toLowerCase().includes('not established'));
    if (!retriable) throw err;
    console.warn(`${label}: ${err.name} — recovering and retrying once...`);
    await recover();
    return await fn();
  }
}

async function main(): Promise<void> {
  loadDotenv();

  const legacyKey = envFirst(['GODARK_API_KEY', 'GDX_API_KEY']);
  const edge = envFirst(['GODARK_EDGE_URL', 'GDX_EDGE_URL']);
  const account = envFirst(['GODARK_ACCOUNT', 'GDX_ACCOUNT']);
  const clientOpts: ConstructorParameters<typeof GodarkClient>[0] = {
    environment: Environment.Testnet,
    autoReconnect: true,
    onError: (err) => console.warn('SDK (non-fatal):', err.name, err.message),
    ...(edge ? { baseUrl: edge } : {}),
    ...(account ? { account } : {}),
  };
  if (legacyKey) {
    Object.assign(clientOpts, {
      apiKey: legacyKey,
    });
  } else {
    const apiKeyId = envFirst(['GODARK_API_KEY_ID', 'GDX_API_KEY_ID']);
    const apiSecret = envFirst(['GODARK_API_SECRET', 'GDX_API_SECRET']);
    const passphrase = envFirst(['GODARK_PASSPHRASE', 'GDX_PASSPHRASE']);
    if (!apiKeyId || !apiSecret || !passphrase) {
      console.error(
        'Set GODARK_API_KEY_ID/GODARK_API_SECRET/GODARK_PASSPHRASE or legacy GODARK_API_KEY',
      );
      process.exit(1);
    }
    Object.assign(clientOpts, { apiKeyId, apiSecret, passphrase });
  }

  let mark: number;
  try {
    mark = await resolveLiveMark(SYMBOL);
  } catch (err) {
    printOrderError('quickstart', err);
    process.exit(1);
  }

  const client = new GodarkClient(clientOpts);
  client.onReconnect(() => console.warn('RECONNECTED — channels restored'));
  let orderId: string | undefined;
  let failed = false;

  try {
    await client.connect();
    console.log(`Connected as account ${client.account}`);

    await client.subscribe(['orders']);

    const sellPx = postOnlySellPrice(mark);
    const recover = () => recoverSession(client);

    const ack = await withOneRetry(
      'placeOrder',
      () =>
        client.placeOrder({
          symbol: SYMBOL,
          side: 'SELL',
          orderType: 'LIMIT',
          price: sellPx,
          quantity: MAX_DEMO_QTY,
          postOnly: true,
          confirmation: 'ack',
        }),
      recover,
    );
    if (!ack.success || !ack.orderId) {
      throw new Error('placeOrder did not return an order id');
    }
    orderId = ack.orderId;
    console.log(`Place OK -- order_id=${ack.orderId} (post-only SELL @ ${sellPx}, mark=${mark})`);

    await sleep(CANCEL_DELAY_MS);

    const cancel = await withOneRetry(
      'cancelOrder',
      () => client.cancelOrder(ack.orderId, SYMBOL),
      recover,
    );
    if (!cancel.success) {
      throw new Error(`cancelOrder failed for ${ack.orderId}`);
    }
    orderId = undefined;
    console.log(`cancel OK -- order_id=${cancel.orderId}`);
  } catch (err) {
    failed = true;
    printOrderError('quickstart', err);
    if (orderId) {
      try {
        await sleep(CANCEL_DELAY_MS);
        await client.cancelOrder(orderId, SYMBOL);
        orderId = undefined;
      } catch (cancelErr) {
        printOrderError('quickstart cleanup cancel', cancelErr);
      }
    }
  } finally {
    await client.disconnect().catch(() => {});
    console.log('Disconnected');
  }
  if (failed || orderId) process.exit(1);
}

main();
