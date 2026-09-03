/**
 * GoDark SDK — Quickstart
 *
 * Place a far limit sell, then cancel.
 *
 *   npm run quickstart
 *
 * Environment:
 *   GODARK_API_KEY_ID, GODARK_API_SECRET, GODARK_PASSPHRASE
 *   (legacy GDX_* aliases accepted when GODARK_* is unset)
 *   GODARK_EDGE_URL (optional; default Environment.Testnet)
 *   GODARK_HPKE_STATIC_PUBLIC_KEY / GDX_HPKE_STATIC_PUBLIC_KEY (optional)
 */
import {
  ConnectionError,
  Environment,
  GodarkClient,
  SessionError,
} from '@godark/sdk';

import { envFirst, loadDotenv, printOrderError } from './dotenv.js';

const SYMBOL = 'BTC-USDC-PERP';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
  const clientOpts: ConstructorParameters<typeof GodarkClient>[0] = {
    environment: Environment.Testnet,
    autoReconnect: true,
    onError: (err) => console.warn('SDK (non-fatal):', err.name, err.message),
    ...(edge ? { baseUrl: edge } : {}),
  };
  if (legacyKey) {
    Object.assign(clientOpts, {
      apiKey: legacyKey,
      ...(envFirst(['GODARK_USER_UUID', 'GDX_USER_UUID'])
        ? { userUuid: envFirst(['GODARK_USER_UUID', 'GDX_USER_UUID']) }
        : {}),
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

  const client = new GodarkClient(clientOpts);
  client.onReconnect(() => console.warn('RECONNECTED — channels restored'));

  try {
    await client.connect();
    console.log(`Connected as user ${client.userUuid}`);

    await client.subscribe(['orders']);

    const mark = Number(
      envFirst(['GODARK_E2E_PRICE', 'GDX_E2E_PRICE', 'GDX_LIVE_PRICE'], '79000'),
    );
    const sellPx = Math.round(mark * 1.03 * 10) / 10;
    const recover = () => recoverSession(client);

    const ack = await withOneRetry(
      'placeOrder',
      () =>
        client.placeOrder({
          symbol: SYMBOL,
          side: 'SELL',
          orderType: 'LIMIT',
          price: sellPx,
          quantity: 0.01,
          postOnly: true,
          confirmation: 'ack',
        }),
      recover,
    );
    console.log(`Place OK -- order_id=${ack.orderId} (limit SELL @ ${sellPx}, mark=${mark})`);

    // Allow the resting order to settle before cancel (avoids CANCEL_TOO_SOON).
    await sleep(500);

    const cancel = await withOneRetry(
      'cancelAllOrders',
      () => client.cancelAllOrders(SYMBOL),
      recover,
    );
    console.log(`cancel_all OK -- count=${cancel.count} ids=[${cancel.orderIds.join(', ')}]`);

    await client.disconnect();
    console.log('Disconnected');
  } catch (err) {
    printOrderError('quickstart', err);
    process.exit(1);
  }
}

main();
