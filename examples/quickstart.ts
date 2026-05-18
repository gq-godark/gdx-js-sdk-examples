/**
 * GoDark SDK — Quickstart (mirrors gdx-cpp-sdk-examples quickstart.cpp)
 *
 * Place a far limit sell, then cancel.
 *
 *   npm run quickstart
 *
 * Environment:
 *   GODARK_API_KEY_ID, GODARK_API_SECRET
 *   GODARK_EDGE_URL (optional; default wss://api.godark-dex.com)
 */
import { GodarkClient } from '@godark/sdk';

const SYMBOL = 'BTC-USDC-PERP';

async function main(): Promise<void> {
  const apiKeyId = process.env.GODARK_API_KEY_ID?.trim();
  const apiSecret = process.env.GODARK_API_SECRET?.trim();
  const baseUrl = process.env.GODARK_EDGE_URL?.trim();

  if (!apiKeyId || !apiSecret) {
    console.error('Set GODARK_API_KEY_ID and GODARK_API_SECRET');
    process.exit(1);
  }

  const client = new GodarkClient({
    apiKeyId,
    apiSecret,
    ...(baseUrl ? { baseUrl } : {}),
  });

  try {
    await client.connect();
    console.log(`Connected as user ${client.userUuid}`);

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
    console.error('Error:', err);
    process.exit(1);
  }
}

main();
