/**
 * End-to-end trading smoke
 *
 *   npm run e2e
 *   npm run e2e:auth-only
 *
 * Environment:
 *   GODARK_API_KEY_ID / GDX_API_KEY_ID
 *   GODARK_API_SECRET / GDX_API_SECRET
 *   GODARK_EDGE_URL / GDX_EDGE_URL (optional)
 *
 * Exit codes: 0 ok, 1 config, 2 connect/auth, 3 place, 4 cancel
 */
import {
  AuthenticationError,
  ConnectionError,
  EncryptionError,
  GodarkClient,
  OrderError,
  SessionError,
  TimeoutError,
} from '@godark/sdk';

const SYMBOL = 'BTC-USDC-PERP';

function envFirst(primary: string, fallback: string): string | undefined {
  const a = process.env[primary]?.trim();
  if (a) return a;
  return process.env[fallback]?.trim() || undefined;
}

function usage(): void {
  console.error(
    [
      'e2e-trading-smoke — GoDark JS SDK end-to-end check',
      '',
      'Environment:',
      '  GODARK_API_KEY_ID / GDX_API_KEY_ID',
      '  GODARK_API_SECRET / GDX_API_SECRET',
      '  GODARK_EDGE_URL / GDX_EDGE_URL (optional)',
      '',
      'Options:',
      '  --auth-only   Connect + ECDH only (no orders)',
      '  --help        Show this message',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): { authOnly: boolean } {
  let authOnly = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--auth-only') {
      authOnly = true;
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(1);
  }
  return { authOnly };
}

async function main(): Promise<void> {
  const { authOnly } = parseArgs(process.argv.slice(2));

  const apiKeyId = envFirst('GODARK_API_KEY_ID', 'GDX_API_KEY_ID');
  const apiSecret = envFirst('GODARK_API_SECRET', 'GDX_API_SECRET');
  const baseUrl = envFirst('GODARK_EDGE_URL', 'GDX_EDGE_URL');

  if (!apiKeyId || !apiSecret) {
    console.error(
      'Missing credentials. Set GODARK_API_KEY_ID and GODARK_API_SECRET (or GDX_* aliases).',
    );
    process.exit(1);
  }

  const started = Date.now();
  const client = new GodarkClient({ apiKeyId, apiSecret, baseUrl });

  try {
    console.error(`[e2e] Connecting to ${baseUrl ?? 'default edge URL'} …`);
    await client.connect();

    console.error(
      `[e2e] Auth + ECDH OK — user_uuid=${client.userUuid} (${Date.now() - started} ms)`,
    );

    if (authOnly) {
      await client.disconnect();
      console.error('[e2e] --auth-only: skipping orders. Done.');
      process.exit(0);
    }

    await client.subscribe();
    console.error('[e2e] Subscribed to orders and positions');

    console.error('[e2e] Placing LIMIT SELL 0.01 @ 999999 …');
    const ack = await client.placeOrder({
      symbol: SYMBOL,
      side: 'SELL',
      orderType: 'LIMIT',
      price: 999_999,
      quantity: 0.01,
    });

    if (!ack.success) {
      console.error('[e2e] ERROR: placeOrder rejected');
      process.exit(3);
    }
    console.error(`[e2e] Place OK — order_id=${ack.orderId} sequence=${ack.sequence}`);

    console.error('[e2e] Cancelling order …');
    const cancelAck = await client.cancelOrder(ack.orderId, SYMBOL);
    if (!cancelAck.success) {
      console.error('[e2e] ERROR: cancelOrder rejected');
      process.exit(4);
    }
    console.error(`[e2e] Cancel OK — order_id=${cancelAck.orderId}`);

    await client.disconnect();
    console.error(
      `[e2e] Full encrypted trading path validated (${Date.now() - started} ms total).`,
    );
    process.exit(0);
  } catch (err: unknown) {
    if (err instanceof AuthenticationError) {
      console.error(`[e2e] ${err.name}: ${err.message}`);
      process.exit(2);
    }
    if (err instanceof ConnectionError) {
      console.error(`[e2e] ${err.name}: ${err.message}`);
      process.exit(2);
    }
    if (err instanceof SessionError) {
      console.error(`[e2e] ${err.name}: ${err.message}`);
      process.exit(2);
    }
    if (err instanceof TimeoutError) {
      console.error(`[e2e] ${err.name}: ${err.message}`);
      process.exit(2);
    }
    if (err instanceof EncryptionError) {
      console.error(`[e2e] ${err.name}: ${err.message}`);
      process.exit(2);
    }
    if (err instanceof OrderError) {
      console.error(`[e2e] ${err.name}: ${err.message}`);
      process.exit(3);
    }
    console.error('[e2e] Error:', err);
    process.exit(2);
  }
}

await main();
