/**
 * REST-only trader demo — auth + encrypted place/modify/cancel + snapshots.
 *
 * Places one post-only BUY at least 500 below the live mark (qty 0.001),
 * modifies it further away, waits, then cancels. A failed place or cancel
 * exits non-zero and disconnects.
 *
 * ``npm run full-trader-rest``
 */
import { GodarkRestClient } from '@godark/sdk';

import {
  CANCEL_DELAY_MS,
  MAX_DEMO_QTY,
  envFirst,
  loadDotenv,
  postOnlyBuyPrice,
  printOrderError,
  resolveLiveMark,
  sleep,
} from './dotenv.js';

const SYMBOL = 'BTC-USDC-PERP';

async function main(): Promise<void> {
  loadDotenv();

  const rest = envFirst(['GODARK_REST_URL', 'GDX_REST_URL'], '') || undefined;
  const edge = envFirst(['GODARK_EDGE_URL', 'GDX_EDGE_URL'], '');
  const restBaseUrl =
    rest ||
    (edge
      ? edge.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '')
      : 'https://api.godark-dex.com');
  const kid = envFirst(['GODARK_API_KEY_ID', 'GDX_API_KEY_ID']);
  const secret = envFirst(['GODARK_API_SECRET', 'GDX_API_SECRET']);
  const passphrase = envFirst(['GODARK_PASSPHRASE', 'GDX_PASSPHRASE']);
  const legacy = envFirst(['GODARK_API_KEY', 'GDX_API_KEY']);

  const client =
    kid && secret && passphrase
      ? new GodarkRestClient({
          apiKeyId: kid,
          apiSecret: secret,
          passphrase,
          restBaseUrl,
        })
      : legacy
        ? new GodarkRestClient({ apiKey: legacy, restBaseUrl })
        : null;
  if (!client) {
    console.error(
      'Set GODARK_API_KEY_ID, GODARK_API_SECRET and GODARK_PASSPHRASE (or GODARK_API_KEY for localnet)',
    );
    process.exit(1);
  }

  let orderId: string | undefined;
  let failed = false;
  try {
    const mark = await resolveLiveMark(SYMBOL);
    await client.connect();
    console.log('identity', {
      account: client.authenticatedAccount,
      tokenScope: client.tokenScope,
    });

    const openOrders = await client.getOpenOrders();
    console.log('open_orders', openOrders.rows.length);
    const positions = await client.getPositions();
    console.log('positions', positions.rows.length);
    const account = await client.getAccount();
    console.log('account', account.summary?.totalCollateral);

    const price = postOnlyBuyPrice(mark);
    const ack = await client.placeOrder(SYMBOL, 'BUY', {
      type: 'LIMIT',
      quantity: MAX_DEMO_QTY,
      price,
      postOnly: true,
    });
    if (!ack.success || !ack.orderId) {
      throw new Error('REST place did not return an order id');
    }
    orderId = ack.orderId;
    console.log('placed', ack.orderId, `post-only BUY @ ${price} mark=${mark}`);

    await sleep(CANCEL_DELAY_MS);

    const modifiedPx = postOnlyBuyPrice(mark, 100);
    const modifyAck = await client.modifyOrder(ack.orderId, SYMBOL, {
      newPrice: modifiedPx,
    });
    if (!modifyAck.success) {
      throw new Error(`REST modify failed for ${ack.orderId}`);
    }
    console.log('modified', modifyAck.orderId, modifiedPx);

    await sleep(CANCEL_DELAY_MS);

    const cancelAck = await client.cancelOrder(ack.orderId, SYMBOL);
    if (!cancelAck.success) {
      throw new Error(`REST cancel failed for ${ack.orderId}`);
    }
    orderId = undefined;
    console.log('cancelled', cancelAck.orderId);
  } catch (err) {
    failed = true;
    printOrderError('full-trader-rest', err);
    if (orderId) {
      try {
        await sleep(CANCEL_DELAY_MS);
        await client.cancelOrder(orderId, SYMBOL);
        orderId = undefined;
      } catch (cancelErr) {
        printOrderError('full-trader-rest cleanup cancel', cancelErr);
      }
    }
  } finally {
    await client.disconnect().catch(() => {});
  }
  if (failed || orderId) process.exit(1);
}

main();
