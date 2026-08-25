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
 *   GODARK_HPKE_STATIC_PUBLIC_KEY / GDX_HPKE_STATIC_PUBLIC_KEY (optional; legacy GDX_NOISE_* accepted)
 */
import { Environment, GodarkClient } from '@godark/sdk';

import { envFirst, loadDotenv, printOrderError } from './dotenv.js';

const SYMBOL = 'BTC-USDC-PERP';

async function main(): Promise<void> {
  loadDotenv();

  const apiKeyId = envFirst(['GODARK_API_KEY_ID', 'GDX_API_KEY_ID']);
  const apiSecret = envFirst(['GODARK_API_SECRET', 'GDX_API_SECRET']);
  const passphrase = envFirst(['GODARK_PASSPHRASE', 'GDX_PASSPHRASE']);

  if (!apiKeyId || !apiSecret || !passphrase) {
    console.error('Set GODARK_API_KEY_ID, GODARK_API_SECRET and GODARK_PASSPHRASE');
    process.exit(1);
  }

  const edge = envFirst(['GODARK_EDGE_URL', 'GDX_EDGE_URL']);
  const client = new GodarkClient({
    apiKeyId,
    apiSecret,
    passphrase,
    environment: Environment.Testnet,
    ...(edge ? { baseUrl: edge } : {}),
  });

  try {
    await client.connect();
    console.log(`Connected as user ${client.userUuid}`);

    // Book confirmation waits on private order updates; subscribe first.
    await client.subscribe(['orders']);

    const mark = Number(
      envFirst(['GODARK_E2E_PRICE', 'GDX_E2E_PRICE', 'GDX_LIVE_PRICE'], '79000'),
    );
    const sellPx = Math.round(mark * 1.03 * 10) / 10;
    const ack = await client.placeOrder({
      symbol: SYMBOL,
      side: 'SELL',
      orderType: 'LIMIT',
      price: sellPx,
      quantity: 0.01,
    });
    console.log(`Place OK -- order_id=${ack.orderId} (limit SELL @ ${sellPx}, mark=${mark})`);

    // Allow the resting order to settle before cancel (avoids CANCEL_TOO_SOON).
    await new Promise((r) => setTimeout(r, 500));

    const cancel = await client.cancelOrder(ack.orderId, SYMBOL);
    console.log(`Cancel OK -- order_id=${cancel.orderId}`);

    await client.disconnect();
    console.log('Disconnected');
  } catch (err) {
    printOrderError('quickstart', err);
    process.exit(1);
  }
}

main();
