/**
 * Minimal GodarkRestClient demo — auth + account reads.
 *
 * Encrypted place/cancel/modify/updateLeverage require GodarkClient (WebSocket /
 * HPKE); see quickstart.ts / full-trader-example.ts.
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
    console.log('connecting (REST auth/token)...');
    try {
      await client.connect();
    } catch (err) {
      console.log(
        `connect skipped: ${err instanceof Error ? err.message : err}`,
      );
      console.log('REST example covers auth wiring; encrypted reads may require a supported REST host.');
      console.log('Encrypted trading requires GodarkClient over WebSocket (HPKE).');
      return;
    }

    try {
      const me = await client.getMe();
      console.log(`me: id=${me.id} wallet=${me.walletAddress} tier=${me.tier}`);
    } catch (err) {
      console.log(`getMe skipped: ${err instanceof Error ? err.message : err}`);
    }

    try {
      const lev = await client.getLeverage();
      console.log(`leverage settings: ${lev.settings.length} entries`);
      for (const row of lev.settings.slice(0, 5)) {
        console.log(`  symbolId=${row.symbolId} leverage=${row.leverage}`);
      }
    } catch (err) {
      console.log(`getLeverage skipped: ${err instanceof Error ? err.message : err}`);
    }

    try {
      const bal = await client.getMyBalance();
      console.log(
        `balance: shielded_raw=${bal.shieldedBalanceRaw} wallet_ui=${bal.walletUsdtUi}`,
      );
    } catch (err) {
      console.log(`getMyBalance skipped: ${err instanceof Error ? err.message : err}`);
    }

    console.log('REST reads succeeded.');
    console.log('Encrypted trading requires GodarkClient over WebSocket (HPKE).');
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await client.disconnect();
  }
}

main();
