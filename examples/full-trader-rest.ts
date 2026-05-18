/**
 * REST-only place + cancel (mirrors gdx-cpp-sdk-examples full_trader_rest.cpp)
 *
 *   npm run full-trader-rest
 *
 * Environment:
 *   GDX_REST_URL (optional; default https://api.godark-dex.com)
 *   GDX_API_KEY_ID + GDX_API_SECRET, or GDX_API_KEY, or default test-key-1
 */
import { GodarkRestClient } from '@godark/sdk';

const SYMBOL = 'BTC-USDC-PERP';

async function main(): Promise<void> {
  const rest =
    process.env.GDX_REST_URL?.trim() || 'https://api.godark-dex.com';
  const kid = process.env.GDX_API_KEY_ID?.trim();
  const secret = process.env.GDX_API_SECRET?.trim();
  const legacy = process.env.GDX_API_KEY?.trim();

  const client =
    kid && secret
      ? new GodarkRestClient({ apiKeyId: kid, apiSecret: secret, restBaseUrl: rest })
      : new GodarkRestClient({
          apiKey: legacy ?? 'test-key-1',
          restBaseUrl: rest,
        });

  await client.connect();

  const ack = await client.placeOrder(SYMBOL, 'BUY', {
    quantity: 0.01,
    type: 'LIMIT',
    price: 10_000,
    timeInForce: 'GTC',
  });
  console.log(`place ok order_id=${ack.orderId} seq=${ack.sequence}`);

  const cx = await client.cancelOrder(ack.orderId, SYMBOL);
  console.log(`cancel ok seq=${cx.sequence}`);

  await client.disconnect();
}

main().catch((e) => {
  console.error('error:', e);
  process.exit(1);
});
