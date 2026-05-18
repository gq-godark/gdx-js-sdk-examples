/**
 * Public gomarket feed (mirrors gdx-cpp-sdk-examples market_data_example.cpp)
 *
 *   npm run market-data
 *
 * Environment:
 *   GODARK_EDGE_URL / GDX_EDGE_URL (optional; default wss://api.godark-dex.com)
 *   GDX_TLS_SKIP_VERIFY / GODARK_TLS_SKIP_VERIFY = 1|true|yes (optional)
 */
import { MarketDataClient } from '@godark/sdk';

const SYMBOL = 'BTC-USDC-PERP';

function edgeBaseUrl(): string {
  return (
    process.env.GODARK_EDGE_URL?.trim() ||
    process.env.GDX_EDGE_URL?.trim() ||
    'wss://api.godark-dex.com'
  );
}

function tlsSkipVerify(): boolean {
  const truthy = (v: string | undefined): boolean => {
    if (!v) return false;
    const s = v.toLowerCase();
    return s === '1' || s === 'true' || s === 'yes';
  };
  return (
    truthy(process.env.GDX_TLS_SKIP_VERIFY) ||
    truthy(process.env.GODARK_TLS_SKIP_VERIFY)
  );
}

async function main(): Promise<void> {
  const skip = tlsSkipVerify();
  const client = new MarketDataClient(edgeBaseUrl(), {
    wsOptions: skip ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();
  console.log('Connected to GoMarket feed. Press Ctrl+C to exit.');

  await client.subscribeOrderbook(SYMBOL, (msg: Record<string, unknown>) => {
    console.log('[orderbook]', JSON.stringify(msg));
  });

  await client.subscribeTrades(SYMBOL, (msg: Record<string, unknown>) => {
    console.log('[trades]', JSON.stringify(msg));
  });

  const shutdown = async () => {
    console.log('\nDisconnecting...');
    await client.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
}

main().catch((e) => {
  console.error('market_data_example failed:', e);
  process.exit(1);
});
