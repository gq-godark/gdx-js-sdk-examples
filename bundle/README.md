# GoDark JavaScript SDK

This package provides two reference scripts for the GoDark JavaScript / TypeScript SDK, **plus the vendored `@godark/sdk` npm tarball**, so you can run the examples or scaffold your own bot without a private npm registry.

The SDK is shipped as a single npm tarball (`sdk/godark-sdk-<version>.tgz`) and wired into `package.json` via the `file:` protocol; `npm install` resolves it locally and records its content hash in the lockfile.

Supported order types in this distribution: `MARKET`, `LIMIT`.

## Package contents

- `examples/quickstart.ts` — minimal connect → far limit sell → cancel
- `examples/full-trader-example.ts` — reference bot loop: callbacks, market-data client, place / modify / cancel, queue drain
- `examples/dotenv.ts` — shared `.env` loader and symbolic-error printer used by both example mains
- `sdk/` — **vendored `@godark/sdk` npm tarball**; `sdk/UPSTREAM_REF` records the upstream commit the tarball was packed from
- `package.json`, `package-lock.json` — depend on `@godark/sdk` via `file:./sdk/<tarball>`, ready for `npm install`
- `tsconfig.json` — strict `tsc --noEmit` typecheck gate
- `README.md`, `SDK_REFERENCE.md` — recipient docs
- `.env.example` — environment template

## 1) Prerequisites

| Item    | Requirement                                                                 |
|---------|-----------------------------------------------------------------------------|
| Node.js | ≥ 18 (tested on 20 + 22)                                                    |
| npm     | ≥ 9 (ships with the Node versions above)                                    |
| OS      | Linux / macOS / Windows — the tarball is platform-independent JavaScript    |

No private npm registry, no `protoc`, no GitHub access required to install — the SDK is fully self-contained in `sdk/`.

## 2) Create testnet credentials

1. Open the testnet frontend: `https://app.godark-dex.com`
2. Create an account using email sign-up.
3. Fund the account using the faucet: `https://faucet.godark-dex.com`
4. In the frontend, go to **Settings → API Key Management** and click **Create API Key**.

## 3) Configure environment

Copy `.env.example` to `.env` and set:

- `GODARK_API_KEY_ID`
- `GODARK_API_SECRET`

```bash
cp .env.example .env
$EDITOR .env       # fill in your testnet creds
```

Optional override:

- `GODARK_EDGE_URL` — defaults to `wss://api.godark-dex.com` if unset.

The OS environment always wins over `.env`.

## 4) Install + run

```bash
npm install           # hydrates devDeps + the vendored @godark/sdk
npm run quickstart    # examples/quickstart.ts
```

Available scripts (see `package.json`):

| Script                    | Source                              | What it does                                                                    |
|---------------------------|-------------------------------------|---------------------------------------------------------------------------------|
| `npm run quickstart`      | `examples/quickstart.ts`            | Minimal connect → far limit sell → cancel                                       |
| `npm run full-trader`     | `examples/full-trader-example.ts`   | Reference bot loop: callbacks, market-data client, place/modify/cancel, drain   |
| `npm run typecheck`       | (all)                               | `tsc --noEmit` — catches API drift after editing your own scripts               |

## npm integration (your own bot)

The bundle includes a vendored `@godark/sdk` tarball under `sdk/`. To build your own bot against the same SDK revision, install it the same way the examples do:

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

If you'd rather pin against the upstream `gdx-js-sdk` repository directly (useful if you're tracking a moving branch rather than a release pin), the bundled `sdk/UPSTREAM_REF` file records the exact commit this distribution was packed from:

```json
{
  "dependencies": {
    "@godark/sdk": "git+ssh://git@github.com/gq-godark/gdx-js-sdk.git#<contents of sdk/UPSTREAM_REF>"
  }
}
```

See `SDK_REFERENCE.md` for the full client API.
