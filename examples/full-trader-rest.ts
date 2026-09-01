/**
 * REST-only trader demo — auth + encrypted place/modify/cancel + snapshots.
 *
 * ``npm run full-trader-rest``
 */
import { GodarkRestClient } from '@godark/sdk';

import { loadDotenv } from './dotenv.js';

async function main(): Promise<void> {
  loadDotenv();

  const rest =
    process.env.GODARK_REST_URL?.trim() ||
    process.env.GDX_REST_URL?.trim() ||
    'https://api.godark-dex.com';
  const kid = process.env.GODARK_API_KEY_ID?.trim() || process.env.GDX_API_KEY_ID?.trim();
  const secret = process.env.GODARK_API_SECRET?.trim() || process.env.GDX_API_SECRET?.trim();
  const passphrase =
    process.env.GODARK_PASSPHRASE?.trim() || process.env.GDX_PASSPHRASE?.trim();
  const legacy =
    process.env.GODARK_API_KEY?.trim() || process.env.GDX_API_KEY?.trim();

  const client =
    kid && secret && passphrase
      ? new GodarkRestClient({
          apiKeyId: kid,
          apiSecret: secret,
          passphrase,
          restBaseUrl: rest,
        })
      : legacy
        ? new GodarkRestClient({ apiKey: legacy, restBaseUrl: rest })
        : null;
  if (!client) {
    console.error(
      'Set GODARK_API_KEY_ID, GODARK_API_SECRET and GODARK_PASSPHRASE (or GODARK_API_KEY for localnet)',
    );
    process.exit(1);
  }

  await client.connect();
  console.log('identity', {
    userUuid: client.authenticatedUserUuid,
    tokenScope: client.tokenScope,
  });

  const openOrders = await client.getOpenOrders();
  console.log('open_orders', openOrders.rows.length);
  const positions = await client.getPositions();
  console.log('positions', positions.rows.length);
  const account = await client.getAccount();
  console.log('account', account.account?.totalCollateral);

  const mark = Number(process.env.GDX_LIVE_PRICE ?? '78000');
  const price = mark - 5000;
  const ack = await client.placeOrder('BTC-USDC-PERP', 'BUY', {
    type: 'LIMIT',
    quantity: 0.01,
    price,
    clientOrderId: 'sdk-js-rest-demo',
  });
  console.log('placed', ack);

  await new Promise((r) => setTimeout(r, 500));

  const modifyAck = await client.modifyOrder(ack.orderId, 'BTC-USDC-PERP', {
    newPrice: price - 64,
  });
  console.log('modified', modifyAck);

  const cancelAck = await client.cancelOrder(ack.orderId, 'BTC-USDC-PERP');
  console.log('cancelled', cancelAck);

  await client.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
