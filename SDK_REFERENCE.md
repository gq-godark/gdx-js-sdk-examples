# GoDark JavaScript SDK Reference (developer / maintainer)

This is the comprehensive reference for maintainers and developers working *inside* this repository (writing examples, reviewing the vendored `sdk/`, refreshing pins, etc.).

A trimmed, recipient-facing copy is maintained at [`bundle/SDK_REFERENCE.md`](bundle/SDK_REFERENCE.md) and is the one copied into the root of released ZIP bundles as `SDK_REFERENCE.md`. The bundle version intentionally omits sections that recipients don't need (refresh / parity / pin discipline, error-code internals, forward-compat strategy, SDK sourcing options).

> Scope: the MM examples use **WebSocket encrypted trading** via `GodarkClient` plus the public **market-data** feed via `MarketDataClient`. Encrypted REST trading is not supported — all order flow (place / modify / cancel / massQuote) runs over the Noise XK WebSocket client. Order placement support is limited to `MARKET` and `LIMIT`.

## Quick Start

```typescript
import { GodarkClient } from '@godark/sdk';

const client = new GodarkClient({
  apiKeyId:   process.env.GODARK_API_KEY_ID!,
  apiSecret:  process.env.GODARK_API_SECRET!,
  passphrase: process.env.GODARK_PASSPHRASE!,
  // baseUrl defaults to wss://api.godark-dex.com when omitted
});

await client.connect();

const ack = await client.placeOrder({
  symbol: 'BTC-USDC-PERP',
  side: 'SELL',
  orderType: 'LIMIT',
  price: 999_999,
  quantity: 0.01,
  timeInForce: 'GTC',
});

await client.cancelOrder(ack.orderId, 'BTC-USDC-PERP');
await client.disconnect();
```

## Configuration

The MM examples expect:

- `GODARK_API_KEY_ID` (required)
- `GODARK_API_SECRET` (required)
- `GODARK_PASSPHRASE` (required for API key-pair auth)
- `GODARK_EDGE_URL` (optional, defaults to `wss://api.godark-dex.com`)

Use `.env.example` as the template for your local `.env`. The shared helper `examples/dotenv.ts` (`loadDotenv` + `printOrderError`) is reused by both example scripts.

## Installing the SDK

In this repository, the example scripts depend on the vendored tarball via the `file:` protocol:

```json
{
  "dependencies": {
    "@godark/sdk": "file:./sdk/godark-sdk-0.1.0.tgz"
  }
}
```

The exact tarball filename is recorded in [`sdk/TARBALL_NAME`](sdk/TARBALL_NAME) and the upstream commit it was packed from is in [`sdk/UPSTREAM_REF`](sdk/UPSTREAM_REF). The lockfile (`package-lock.json`) records the content hash of the tarball so installs are fully reproducible — `npm install` will refuse to silently substitute a different tarball.

To consume `@godark/sdk` from your own project outside this repo:

1. Copy the vendored tarball and depend on it the same way (`"@godark/sdk": "file:path/to/godark-sdk-X.Y.Z.tgz"`), or
2. Depend on the public upstream repo by git URL pinned to the SHA recorded in `sdk/UPSTREAM_REF`:

   ```json
   {
     "dependencies": {
       "@godark/sdk": "git+ssh://git@github.com/gq-godark/gdx-js-sdk.git#<sha from sdk/UPSTREAM_REF>"
     }
   }
   ```

   Note that consuming `gdx-js-sdk` directly (option 2) builds the SDK from its own source tree, which clones `gdx-proto` as a submodule and re-runs `buf generate`; you'll need `buf` and the protobuf toolchain available.

## GodarkClient API

**Package:** `@godark/sdk` (vendored under `sdk/` in this repo; upstream at [`gq-godark/gdx-js-sdk`](https://github.com/gq-godark/gdx-js-sdk)).

### Core lifecycle

| Method       | Signature                                                       | Purpose                                       |
|--------------|-----------------------------------------------------------------|-----------------------------------------------|
| constructor  | `new GodarkClient(opts: GodarkClientOptions)`                   | Construct the client                          |
| `connect`    | `connect(): Promise<void>`                                      | Authenticate + establish encrypted session    |
| `disconnect` | `disconnect(): Promise<void>`                                   | Graceful disconnect                           |
| `userUuid`   | `readonly userUuid: string \| undefined`                        | Authenticated user id (set after `connect`)   |

### Trading commands

| Method        | Signature (abridged)                                                                                                  | Purpose                                  |
|---------------|-----------------------------------------------------------------------------------------------------------------------|------------------------------------------|
| `placeOrder`  | `placeOrder(opts: PlaceOrderOptions) -> Promise<OrderAck>`                                                            | Encrypted order placement                |
| `cancelOrder` | `cancelOrder(orderId: string, symbol: string) -> Promise<OrderAck>`                                                   | Cancel an open order                     |
| `modifyOrder` | `modifyOrder(orderId: string, symbol: string, opts: ModifyOrderOptions) -> Promise<OrderAck>`                         | Modify an open order's price / quantity  |

### Subscriptions

| Method                                       | Purpose                                  |
|----------------------------------------------|------------------------------------------|
| `subscribe(['orders', 'positions'])`         | Subscribe to private push streams        |
| `unsubscribe([...])`                         | Unsubscribe from one or more streams     |

### Push streams — callbacks + iterators

The SDK exposes both **callback** and **async-iterator** forms for each private push stream. Pick one shape per stream; mixing both forms on the same stream is supported but not idiomatic.

| Callback                                          | Iterator                                                        | Stream                                              |
|---------------------------------------------------|-----------------------------------------------------------------|-----------------------------------------------------|
| `onOrderUpdate((u: OrderUpdate) => void)`         | `orderUpdates(): AsyncIterableIterator<OrderUpdate>`            | Order lifecycle (`OPEN` / `FILLED` / ...)           |
| `onPositionUpdate((u: PositionUpdate) => void)`   | `positionUpdates(): AsyncIterableIterator<PositionUpdate>`      | Per-fill position deltas                            |
| `onReconnect(() => void)`                         | (no iterator form)                                              | Fired after auto-reconnect re-subscribes channels   |

The iterator form uses an internal **bounded ring buffer** (size controlled by `streamBufferSize` on the constructor; default `256`). When the buffer is full, the oldest item is dropped — see the queue semantics described in the source. The callback form has no buffer and runs synchronously on the transport task, so callbacks should never block.

### Error sink

```typescript
const client = new GodarkClient({
  apiKeyId, apiSecret,
  onError: (err) => console.error('non-fatal SDK error:', err),
});
```

`onError` surfaces non-fatal SDK errors (rekey failures, decrypt failures on stray frames, queue overruns). Fatal errors are **thrown** from the awaited methods (`connect`, `placeOrder`, `cancelOrder`, `modifyOrder`, `subscribe`, `disconnect`); they are not delivered via `onError`.

### Concurrency rule

`GodarkClient` routes trading commands by correlation id, so multiple commands
(`placeOrder`, `cancelOrder`, `modifyOrder`, `massQuote`, `batchCancel`, …) can
be in flight concurrently. Encrypted REST trading is not supported; all order
flow goes over the WebSocket client. The push streams are independent and may
be consumed concurrently — that's the intended pattern in
`full-trader-example.ts`, which combines a callback consumer with a short
`orderUpdates()` drain.

## MarketDataClient

Public market data is served on the same edge endpoint as the trading WebSocket but uses no auth and no encryption.

```typescript
import { MarketDataClient } from '@godark/sdk';

const md = new MarketDataClient('wss://api.godark-dex.com', {
  headers: { 'X-Trader-Tag': 'js-md-demo' },
});

await md.connect();
await md.subscribeOrderbook('BTC-USDC-PERP', (msg) => { /* ... */ });
await md.subscribeTrades('BTC-USDC-PERP', (msg) => { /* ... */ });
// ...
await md.disconnect();
```

The same `TransportOptions` shape used by `GodarkClient` is accepted by the `MarketDataClient` constructor; reuse it for proxy / TLS options.

## Encrypted REST trading (unsupported)

Encrypted REST trading is not supported under Noise XK. Prefer `GodarkClient`
over the WebSocket. Public REST reads (if present in the upstream SDK) remain
available separately; they are not exercised by these examples.

## Core Types

### OrderAck

| Field         | Type                | Notes                                                                |
|---------------|---------------------|----------------------------------------------------------------------|
| `orderId`     | `string`            | Server-assigned id; use for subsequent `cancel` / `modify`           |
| `success`     | `boolean`           | `false` ⇒ order was rejected; inspect `errorCode` and `error`        |
| `sequence`    | `string`            | Sequencer ack ordering token (decimal string for u64 safety)         |
| `errorCode?`  | `string`            | Symbolic code, e.g. `'PRICE_DEVIATION_TOO_LARGE'`                    |
| `error?`      | `string`            | Human-readable message                                               |

### OrderUpdate

| Field                                                   | Type                          | Notes                                                |
|---------------------------------------------------------|-------------------------------|------------------------------------------------------|
| `orderId`, `userUuid`, `symbolId`                       | identifiers                   | —                                                    |
| `side`                                                  | `Side`                        | `'BUY'` / `'SELL'`                                   |
| `status`, `updateType`                                  | `OrderStatus`, `OrderUpdateType` | Final state vs. lifecycle event                   |
| `price`, `quantity`, `filledQty`, `remainingQty`, `cumFill` | `string`                  | Decimal strings to preserve precision                |
| `cancelReason?`                                         | `CancelReason`                | Set on cancel updates                                |
| `rejectReason?`                                         | `string`                      | Set on `'REJECTED'` updates                          |
| `correlationId`                                         | `number`                      | Echoes the client-side request id                    |
| `timestamp`                                             | `number`                      | Server-side event time (epoch nanos)                 |

### PositionUpdate

Per-fill delta. Use this stream to drive incremental P&L / position accounting between snapshot refreshes.

| Field                                                          | Type                  |
|----------------------------------------------------------------|-----------------------|
| `userUuid`, `symbolId`, `side`                                 | identifiers           |
| `updateType`                                                   | `PositionUpdateType`  |
| `size`, `entryPrice`, `previousSize`, `fillPrice`, `fillQty`   | `string` (decimal)    |
| `correlationId`, `timestamp`                                   | `number`              |

## Enums

String unions exposed by the public API:

- `Side`: `'BUY'`, `'SELL'`
- `OrderType`: `'MARKET'`, `'LIMIT'`, `'PEG_TO_MID'`, `'PEG_TO_BID'`, `'PEG_TO_ASK'`
- `TimeInForce`: `'GTC'`, `'IOC'`, `'FOK'`, `'GTD'`
- `OrderStatus`: `'NEW'`, `'PARTIALLY_FILLED'`, `'FILLED'`, `'CANCELLED'`, `'REJECTED'`
- `OrderUpdateType`: `'OPEN'`, `'FILLED'`, `'PARTIALLY_FILLED'`, `'CANCELLED'`, `'REJECTED'`, `'MODIFIED'`, `'CANCEL_REJECTED'`, `'MODIFY_REJECTED'`
- `PositionUpdateType`: `'SNAPSHOT'`, `'OPEN'`, `'INCREASE'`, `'DECREASE'`, `'CLOSE'`
- `CancelReason`: `'USER_REQUESTED'`, `'IOC_REMAINDER'`, `'FOK_NOT_FILLED'`, `'EXPIRED'`, `'SYSTEM'`

`OrderType` includes the `PEG_TO_*` variants for API completeness, but this MM distribution only exercises `'MARKET'` and `'LIMIT'` from the examples.

Note: the SDK additionally exposes parallel `*_FROM_PROTO` / `*_TO_PROTO` lookup tables (e.g. `RESPONSE_MESSAGE_TYPE_TO_PROTO`) for advanced users who want to construct or parse encrypted-edge frames directly. These are stable, but ordinary callers should not need them.

## Errors

`GodarkError` is the base class for every error type the SDK throws:

| Class                  | When                                                                                       |
|------------------------|--------------------------------------------------------------------------------------------|
| `AuthenticationError`  | API key rejection at session bring-up                                                      |
| `SessionError`         | ECDH session setup or rekey failed                                                         |
| `OrderError`           | Order rejected by the sequencer; carries `errorCode?: string` (symbolic reason)            |
| `ConnectionError`      | WebSocket transport failure                                                                |
| `EncryptionError`      | AES-GCM encrypt / decrypt failure                                                          |
| `TimeoutError`         | Per-command response timeout                                                               |

Idiomatic order-rejection handling:

```typescript
try {
  const ack = await client.placeOrder(opts);
} catch (e) {
  if (e instanceof OrderError) {
    // e.errorCode is the symbolic reason (e.g. 'PRICE_DEVIATION_TOO_LARGE')
    // e.message is the human-readable description
    printOrderError('placeOrder', e);
  } else {
    throw e;
  }
}
```

### Order error codes

The sequencer's numeric ack codes are mapped to symbolic strings (e.g. `PRICE_DEVIATION_TOO_LARGE`, `MARGIN_INSUFFICIENT`) by the SDK's `orderErrorCode` module. The following items are re-exported from `@godark/sdk`:

| Item                                          | Purpose                                                |
|-----------------------------------------------|--------------------------------------------------------|
| `ORDER_ERROR_CODES: readonly OrderErrorEntry[]` | Frozen list of every known entry                     |
| `OrderErrorEntry { code, symbolic, reason }`  | Type of the registry entries                           |
| `findOrderErrorEntry(code: number)`           | Lookup by numeric wire code                            |
| `findOrderErrorSymbolic(name: string)`        | Reverse lookup by symbolic name                        |
| `makeOrderErrorFromCode(code)`                | Build a rich `OrderError` from a numeric code          |
| `makeOrderErrorFromJson(reason, code)`        | Build a rich `OrderError` from a JSON ack              |

The `OrderError.errorCode` field already carries the symbolic string for thrown errors, so most callers won't need the lookup helpers directly — they're primarily useful for renderers that want the human reason alongside the symbolic name.

## Example files in this distribution

| File                                     | Purpose                                                                                           |
|------------------------------------------|---------------------------------------------------------------------------------------------------|
| `examples/quickstart.ts`                 | Minimal connect, place, cancel                                                                    |
| `examples/full-trader-example.ts`        | Reference bot flow with private streams (callbacks + iterator drain), market data, place/modify/cancel/mass-quote/batch-cancel |
| `examples/dotenv.ts`                     | Shared helper (`loadDotenv` + `printOrderError`)                                                  |

## SDK source layout (vendored)

The `@godark/sdk` package is vendored under `sdk/` as a single npm tarball:

```text
sdk/
├── UPSTREAM_REF             # exact upstream commit SHA the vendored copy was cut from
├── TARBALL_NAME             # filename of the tarball (for deterministic lookups)
└── godark-sdk-X.Y.Z.tgz     # npm pack output (dist/index.js + dist/index.cjs + .d.ts files + package.json)
```

The tarball contents are produced by `npm pack` and contain:

- `package/package.json` — package manifest, with `exports`, `main`, `module`, `types`
- `package/dist/index.js` — ESM build (target node18)
- `package/dist/index.cjs` — CJS build
- `package/dist/index.d.ts` + `package/dist/index.d.cts` — TypeScript declarations
- `package/README.md`, `package/LICENSE`

## Refreshing the vendored SDK (maintainers)

From a sibling development checkout of the upstream SDK at the commit you want to ship:

```bash
./scripts/refresh_sdk.sh /path/to/gdx-js-sdk
git add sdk/ package.json package-lock.json
git commit -m "refresh: sync vendored SDK tarball with upstream"
```

The script:

1. Refuses to run if the upstream worktree is dirty (so the recorded SHA matches reality).
2. Runs `npm ci && npm run build && npm pack` inside the upstream checkout.
3. Wipes and repopulates the local `sdk/` directory atomically with the new tarball.
4. Writes the upstream HEAD SHA (or tag) into `sdk/UPSTREAM_REF` and the filename into `sdk/TARBALL_NAME`.
5. Rewrites this repo's `package.json` so `@godark/sdk` resolves to the new tarball via `file:`.

After running it, you need to `npm install` once more to regenerate `package-lock.json` against the new tarball's content hash.

The CI release pipeline (`scripts/package.sh` + `release.yml`) parity-checks the vendored tarball by re-packing upstream and `diff -r --brief`-ing the unpacked contents (`npm pack` is not byte-deterministic because of gzip mtimes; the tarball *contents* are).

## Automation chain

The full upstream-change chain (proto → SDK → examples → release zip):

1. A push to `gdx-proto` (`v1/devnet`) dispatches `gdx-proto-changed` to `gdx-js-sdk`.
2. `gdx-js-sdk/.github/workflows/auto-regen-protos.yml` regenerates the committed proto bindings and opens a rolling PR. Merging it dispatches `gdx-sdk-changed` to **this** repo.
3. `.github/workflows/auto-bump-sdk-pin.yml` here refreshes `sdk/`, bumps `sdk/UPSTREAM_REF`, refreshes `package-lock.json`, and opens its own rolling PR.
4. Merging that PR triggers `release.yml`, which rebuilds the bundle zip from the new pin and publishes a tagged GitHub Release.
