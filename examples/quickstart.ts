/**
 * GoDark SDK — Quickstart
 *
 * Place a far limit sell, then cancel.
 *
 *   npm run quickstart
 *
 * Environment:
 *   GODARK_API_KEY_ID, GODARK_API_SECRET, GODARK_PASSPHRASE
 *   GODARK_EDGE_URL (optional; default Environment.Testnet)
 *   GDX_NOISE_STATIC_PUBLIC_KEY (optional override; baked into Testnet)
 */
import { Environment, GodarkClient } from '@godark/sdk';

import { loadDotenv, printOrderError } from './dotenv.js';

const SYMBOL = 'BTC-USDC-PERP';

async function main(): Promise<void> {
  loadDotenv();

  const apiKeyId = process.env.GODARK_API_KEY_ID?.trim();
  const apiSecret = process.env.GODARK_API_SECRET?.trim();
  const passphrase = process.env.GODARK_PASSPHRASE?.trim();

  if (!apiKeyId || !apiSecret || !passphrase) {
    console.error('Set GODARK_API_KEY_ID, GODARK_API_SECRET and GODARK_PASSPHRASE');
    process.exit(1);
  }

  const edge = process.env.GODARK_EDGE_URL?.trim() || process.env.GDX_EDGE_URL?.trim();
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

    const ack = await client.placeOrder({
      symbol: SYMBOL,
      side: 'SELL',
      orderType: 'LIMIT',
      price: 999_999,
      quantity: 0.01,
    });
    console.log(`Place OK -- order_id=${ack.orderId}`);

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
