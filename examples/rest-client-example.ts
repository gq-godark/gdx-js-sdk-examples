/**
 * Minimal GodarkRestClient demo — public market-data GETs + REST auth + encrypted snapshots.
 *
 * For encrypted place/modify/cancel over REST (one-shot HPKE), see full-trader-rest.ts.
 *
 *   npm run rest-client
 *
 * Environment:
 *   GODARK_API_KEY_ID, GODARK_API_SECRET, GODARK_PASSPHRASE
 *   GODARK_REST_URL (optional; default https://api.godark-dex.com)
 */
import { GodarkRestClient } from '@godark/sdk';

import { loadDotenv } from './dotenv.js';

async function main(): Promise<void> {
  loadDotenv();

  const apiKeyId = process.env.GODARK_API_KEY_ID?.trim();
  const apiSecret = process.env.GODARK_API_SECRET?.trim();
  const passphrase = process.env.GODARK_PASSPHRASE?.trim();
  if (!apiKeyId || !apiSecret || !passphrase) {
    console.error('Set GODARK_API_KEY_ID, GODARK_API_SECRET and GODARK_PASSPHRASE');
    process.exit(1);
  }

  const restBaseUrl = process.env.GODARK_REST_URL?.trim();
  const client = new GodarkRestClient({
    apiKeyId,
    apiSecret,
    passphrase,
    ...(restBaseUrl ? { restBaseUrl } : {}),
  });

  try {
    const rates = await client.getFundingRates();
    const oi = await client.getOpenInterest();
    const vol = (await client.getVolume()) as Record<string, unknown>;
    console.log(`funding_rates: ${rates.length} symbols`);
    console.log(`open_interest: ${oi.length} symbols`);
    const syms = vol.symbols;
    const symCount = Array.isArray(syms) ? syms.length : 0;
    console.log(`volume: total_24h=${vol.total_volume_24h ?? '?'} symbols=${symCount}`);

    console.log('connecting (REST auth/token)...');
    await client.connect();
    console.log('identity', {
      userUuid: client.authenticatedUserUuid,
      tokenScope: client.tokenScope,
    });

    try {
      const open = await client.getOpenOrders();
      console.log(`open_orders: ${open.rows.length} rows`);
    } catch (err) {
      console.log(`getOpenOrders skipped: ${err instanceof Error ? err.message : err}`);
    }

    try {
      const account = await client.getAccount();
      console.log('account', account.account?.totalCollateral);
    } catch (err) {
      console.log(`getAccount skipped: ${err instanceof Error ? err.message : err}`);
    }

    console.log('REST reads succeeded.');
    console.log('For REST trading (place/modify/cancel), see full-trader-rest.ts.');
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await client.disconnect();
  }
}

main();
