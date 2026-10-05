/**
 * Minimal GodarkRestClient demo — public market-data GETs + REST auth + encrypted snapshots.
 *
 * Read-only. For encrypted place/modify/cancel over REST (one-shot HPKE), see full-trader-rest.ts.
 *
 *   npm run rest-client
 *
 * Environment (GODARK_* wins, then GDX_*):
 *   GODARK_API_KEY_ID / GDX_API_KEY_ID
 *   GODARK_API_SECRET / GDX_API_SECRET
 *   GODARK_PASSPHRASE / GDX_PASSPHRASE
 *   GODARK_REST_URL / GDX_REST_URL (optional; else GODARK_EDGE_URL / GDX_EDGE_URL)
 *   GODARK_ACCOUNT / GDX_ACCOUNT (optional account fallback for local auth)
 */
import { GodarkRestClient } from '@godark/sdk';

import { envFirst, loadDotenv, restBaseFromEnv } from './dotenv.js';

async function main(): Promise<void> {
  loadDotenv();

  const apiKeyId = envFirst(['GODARK_API_KEY_ID', 'GDX_API_KEY_ID']);
  const apiSecret = envFirst(['GODARK_API_SECRET', 'GDX_API_SECRET']);
  const passphrase = envFirst(['GODARK_PASSPHRASE', 'GDX_PASSPHRASE']);
  if (!apiKeyId || !apiSecret || !passphrase) {
    console.error(
      'Set GODARK_API_KEY_ID, GODARK_API_SECRET and GODARK_PASSPHRASE (GDX_* aliases accepted)',
    );
    process.exit(1);
  }

  const restBaseUrl = restBaseFromEnv();
  const account = envFirst(['GODARK_ACCOUNT', 'GDX_ACCOUNT']);
  const client = new GodarkRestClient({
    apiKeyId,
    apiSecret,
    passphrase,
    ...(restBaseUrl ? { restBaseUrl } : {}),
    ...(account ? { account } : {}),
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
      account: client.authenticatedAccount,
      tokenScope: client.tokenScope,
    });

    const positions = await client.getPositions();
    const open = await client.getOpenOrders();
    const accountSnap = await client.getAccount();
    console.log(`positions: ${positions.rows.length} rows`);
    console.log(`open_orders: ${open.rows.length} rows`);
    console.log(`account total_collateral=${accountSnap.summary?.totalCollateral ?? '?'}`);

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
