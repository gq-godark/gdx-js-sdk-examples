# GoDark JavaScript SDK

This package provides the GoDark JavaScript SDK and minimal examples for
encrypted darkpool trading.

Supported order types in this distribution: `MARKET`, `LIMIT`.

## Package contents

- `examples/` — `quickstart.ts`, `full-trader-example.ts`, `dotenv.ts`
- `sdk/` — `@godark/sdk` npm tarball (`godark-sdk-*.tgz`)
- `package.json`, `package-lock.json`, `tsconfig.json`
- `README.md`, `SDK_REFERENCE.md` — recipient docs
- `.env.example` — environment template

## 1) Prerequisites

| Item    | Requirement                                                                 |
|---------|-----------------------------------------------------------------------------|
| Node.js | ≥ 18 (tested on 20 + 22)                                                    |
| npm     | ≥ 9 (ships with the Node versions above)                                    |
| OS      | Linux / macOS / Windows                                                    |

## 2) Create testnet credentials

1. Open the testnet frontend: `https://app.godark-dex.com`
2. Create an account using email sign-up.
3. Fund the account using the faucet: `https://faucet.godark-dex.com`
4. In the frontend, go to **Settings → API Key Management** and click **Create API Key**.

## 3) Configure environment

Copy `.env.example` to `.env` and set:

- `GODARK_API_KEY_ID`
- `GODARK_API_SECRET`
- `GODARK_PASSPHRASE`
- `GDX_NOISE_STATIC_PUBLIC_KEY` (64 hex chars; aliases `GDX_NOISE_STATIC_PUBKEY`, `GODARK_NOISE_STATIC_PUBLIC_KEY`)

```bash
cp .env.example .env
$EDITOR .env       # fill in your testnet creds
```

Optional override:

- `GODARK_EDGE_URL` — defaults to `wss://api.godark-dex.com` if unset.

The OS environment always wins over `.env`.

## 4) Install + run

```bash
npm install
npm run quickstart
```

Available scripts (see `package.json`):

| Script                    | Source                              | What it does                                                                    |
|---------------------------|-------------------------------------|---------------------------------------------------------------------------------|
| `npm run quickstart`      | `examples/quickstart.ts`            | Minimal connect → far limit sell → cancel                                       |
| `npm run full-trader`     | `examples/full-trader-example.ts`   | Reference bot loop: callbacks, market data, place/modify/cancel, mass-quote / batch-cancel |
| `npm run typecheck`       | (all)                               | `tsc --noEmit` — catches API drift after editing your own scripts               |

## npm integration (your own bot)

Add the tarball from `sdk/` to your `package.json`:

```json
// package.json — your own bot
{
  "type": "module",
  "dependencies": {
    "@godark/sdk": "file:path/to/this-bundle/sdk/godark-sdk-0.1.0.tgz"
  }
}
```

Then in `src/main.ts`:

```typescript
import { GodarkClient } from '@godark/sdk';

const client = new GodarkClient({
  apiKeyId: process.env.GODARK_API_KEY_ID!,
  apiSecret: process.env.GODARK_API_SECRET!,
});

await client.connect();
const ack = await client.placeOrder({
  symbol: 'BTC-USDC-PERP',
  side: 'SELL',
  orderType: 'LIMIT',
  price: 999_999,
  quantity: 0.01,
});
await client.cancelOrder(ack.orderId, 'BTC-USDC-PERP');
await client.disconnect();
```

See `SDK_REFERENCE.md` for the full client API.
