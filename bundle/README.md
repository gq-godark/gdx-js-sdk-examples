# GoDark JavaScript SDK

This package provides the GoDark JavaScript SDK and minimal examples for
encrypted darkpool trading.

These examples place post-only `LIMIT` orders priced off the live mark.

## Package contents

- `examples/` — WebSocket and REST examples plus the shared `dotenv.ts` helper
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

```bash
cp .env.example .env
$EDITOR .env       # fill in your testnet creds
```

Optional override:

- `GODARK_EDGE_URL` — override the edge URL (default: public testnet `wss://api.godark-dex.com` via the SDK Testnet environment preset).
- `GDX_HPKE_STATIC_PUBLIC_KEY` — sequencer HPKE static public key (64 hex). Required for localnet. Aliases: `GDX_HPKE_STATIC_PUBKEY`, `GODARK_HPKE_STATIC_PUBLIC_KEY`, `VITE_GDX_HPKE_STATIC_PUBKEY`.

The OS environment always wins over `.env`.

## 4) Run in this order

1. **Install** — `npm install`.
2. **Environment names** — `GODARK_API_KEY_ID`, `GODARK_API_SECRET`, `GODARK_PASSPHRASE` (optional `GODARK_EDGE_URL`, `GODARK_REST_URL`).
3. **REST auth** — `npm run rest-client` (`client_credentials` token).
4. **WebSocket login** — `npm run quickstart` logs in with that access token, not `key:secret:passphrase`.
5. **Subscribe** — `orders`, `positions`, `volume`, `open_interest`, `funding_rate`. Trades and L2 order book are not on `/ws/v1`.
6. **Place** — decimal strings only (`"0.001"`, `"67500.5"`). Samples use post-only `LIMIT` orders at least 500 away from the live mark, then cancel. `slippageBps` only on `MARKET` and `STOP_MARKET`. Peg is incompatible with post-only.
7. **Read a position** — `npm run full-trader-rest` (`getPositions`) or the `positions` channel in `npm run full-trader`.
8. **Cancel** — by the returned order id.

Client-order ids register only after a successful WebSocket place. REST place does not register them. A 400 from `POST /orders/_register_coid` is a failure.

## 5) Scripts

```bash
npm install
npm run quickstart
```

Available scripts (see `package.json`):

| Script                    | Source                              | What it does                                                                    |
|---------------------------|-------------------------------------|---------------------------------------------------------------------------------|
| `npm run quickstart`      | `examples/quickstart.ts`            | Token login → subscribe orders → decimal-string limit sell → cancel             |
| `npm run full-trader`     | `examples/full-trader-example.ts`   | `orders` / `positions` / `funding_rate`, place/modify/cancel, mass-quote / batch-cancel |
| `npm run rest-client`     | `examples/rest-client-example.ts`   | Public REST reads, auth, and encrypted snapshots                                |
| `npm run full-trader-rest` | `examples/full-trader-rest.ts`     | One-shot HPKE REST snapshots plus place/modify/cancel                           |
| `npm run typecheck`       | (all)                               | `tsc --noEmit` — catches API drift after editing your own scripts               |

## npm integration (your own bot)

Add the tarball from `sdk/` to your `package.json`:

```json
// package.json — your own bot
{
  "type": "module",
  "dependencies": {
    "@godark/sdk": "file:path/to/this-bundle/sdk/godark-sdk-0.2.0.tgz"
  }
}
```

Then in `src/main.ts`:

```typescript
import { GodarkClient } from '@godark/sdk';

const client = new GodarkClient({
  apiKeyId: process.env.GODARK_API_KEY_ID!,
  apiSecret: process.env.GODARK_API_SECRET!,
  passphrase: process.env.GODARK_PASSPHRASE!,
});

await client.connect();
const ack = await client.placeOrder({
  symbol: 'BTC-USDC-PERP',
  side: 'SELL',
  orderType: 'LIMIT',
  price: '999999', // decimal string only — numbers are rejected
  quantity: '0.001',
  postOnly: true,
});
await client.cancelOrder(ack.orderId, 'BTC-USDC-PERP');
await client.disconnect();
```

See `SDK_REFERENCE.md` for the full client API.
