# GoDark JavaScript SDK Reference (MM Distribution)

This reference describes the API surface used by the two example scripts shipped in this distribution. They exercise the WebSocket encrypted-trading path via `GodarkClient` (HPKE WebSocket) plus the public market-data feed via `MarketDataClient`. Encrypted REST trading is not supported — all order flow (place / modify / cancel / mass-quote) runs over the WebSocket client.

Order placement support in this MM distribution is limited to `MARKET` and `LIMIT`.

## Quick Start

```typescript
import { GodarkClient } from '@godark/sdk';

const client = new GodarkClient({
  apiKeyId:  process.env.GODARK_API_KEY_ID!,
  apiSecret: process.env.GODARK_API_SECRET!,
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
- `GDX_NOISE_STATIC_PUBLIC_KEY` (required for encrypted WebSocket trading) — 64 hex chars; aliases `GDX_NOISE_STATIC_PUBKEY`, `GODARK_NOISE_STATIC_PUBLIC_KEY`
- `GODARK_EDGE_URL` (optional, defaults to `wss://api.godark-dex.com`)

Use `.env.example` as the template for your local `.env`. The OS environment always wins over `.env`.

## GodarkClient API

**Package:** `@godark/sdk`

### Core lifecycle

| Method        | Signature                                                   | Purpose                                              |
|---------------|-------------------------------------------------------------|------------------------------------------------------|
| constructor   | `new GodarkClient(opts: GodarkClientOptions)`               | Construct the client                                 |
| `connect`     | `connect(): Promise<void>`                                  | Authenticate + HPKE setup handshake + encrypted session           |
| `disconnect`  | `disconnect(): Promise<void>`                               | Graceful disconnect                                  |
| `userUuid`    | `readonly userUuid: string \| undefined`                    | Authenticated user id (populated after `connect`)    |

### Trading commands

| Method         | Signature (abridged)                                                                                                  | Purpose                                      |
|----------------|-----------------------------------------------------------------------------------------------------------------------|----------------------------------------------|
| `placeOrder`   | `placeOrder(opts: PlaceOrderOptions) -> Promise<OrderAck>`                                                            | Encrypted order placement                    |
| `cancelOrder`  | `cancelOrder(orderId: string, symbol: string) -> Promise<OrderAck>`                                                   | Cancel an open order                         |
| `modifyOrder`  | `modifyOrder(orderId: string, symbol: string, opts: ModifyOrderOptions) -> Promise<OrderAck>`                         | Modify an open order's price / quantity      |

### Subscriptions

| Method                                       | Purpose                                  |
|----------------------------------------------|------------------------------------------|
| `subscribe(['orders', 'positions'])`         | Subscribe to private push streams        |
| `unsubscribe([...])`                         | Unsubscribe from one or more streams     |

### Push callbacks + async iterators

The SDK exposes both **callback** and **async-iterator** forms for each push stream. Pick one shape per stream:

| Callback                                      | Iterator                              | Stream                                              |
|-----------------------------------------------|---------------------------------------|-----------------------------------------------------|
| `onOrderUpdate((u: OrderUpdate) => void)`     | `orderUpdates(): AsyncIterableIterator<OrderUpdate>`     | Order lifecycle (open / filled / cancelled / ...)   |
| `onPositionUpdate((u: PositionUpdate) => void)` | `positionUpdates(): AsyncIterableIterator<PositionUpdate>` | Per-fill position deltas                            |
| `onReconnect(() => void)`                     | (no iterator form)                    | Fired after auto-reconnect re-subscribes channels   |

### Error handling

`onError: (err: GodarkError) => void` is set on construction and surfaces non-fatal SDK errors. Fatal errors are thrown from the awaited methods (`connect`, `placeOrder`, `cancelOrder`, `modifyOrder`, `subscribe`, `disconnect`).

### Concurrency rule

Only one trading command (`placeOrder`, `cancelOrder`, `modifyOrder`) should be in flight at a time. The example scripts await each call in sequence; do the same in your own code.

## MarketDataClient API

Public order-book and trades feed. No authentication required.

```typescript
import { MarketDataClient } from '@godark/sdk';

const md = new MarketDataClient('wss://api.godark-dex.com');
await md.connect();
await md.subscribeOrderbook('BTC-USDC-PERP', (msg) => { /* ... */ });
await md.subscribeTrades('BTC-USDC-PERP', (msg) => { /* ... */ });
// ...
await md.disconnect();
```

## Core Types

| Type             | Notable fields                                                                                                                                                |
|------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `OrderAck`       | `orderId`, `success`, `sequence`, `errorCode?: string`, `error?: string`                                                                                      |
| `OrderUpdate`    | `orderId`, `userUuid`, `symbolId`, `side`, `status`, `updateType`, `price`, `quantity`, `filledQty`, `remainingQty`, `cumFill`, `cancelReason?`, `timestamp`  |
| `PositionUpdate` | `userUuid`, `symbolId`, `side`, `updateType`, `size`, `entryPrice`, `previousSize`, `fillPrice`, `fillQty`, `correlationId`, `timestamp`                      |

All numeric fields that may overflow `Number.MAX_SAFE_INTEGER` (e.g. `orderId`, `price`, `quantity`, `filledQty`) are returned as decimal strings; convert with `BigInt(...)` when you need arithmetic.

## Enums

String unions used by the public API:

- `Side`: `'BUY'`, `'SELL'`
- `OrderType`: `'MARKET'`, `'LIMIT'`, `'PEG_TO_MID'`, `'PEG_TO_BID'`, `'PEG_TO_ASK'`
- `TimeInForce`: `'GTC'`, `'IOC'`, `'FOK'`, `'GTD'`
- `OrderStatus`: `'NEW'`, `'PARTIALLY_FILLED'`, `'FILLED'`, `'CANCELLED'`, `'REJECTED'`
- `OrderUpdateType`: `'OPEN'`, `'FILLED'`, `'PARTIALLY_FILLED'`, `'CANCELLED'`, `'REJECTED'`, `'MODIFIED'`, `'CANCEL_REJECTED'`, `'MODIFY_REJECTED'`
- `PositionUpdateType`: `'SNAPSHOT'`, `'OPEN'`, `'INCREASE'`, `'DECREASE'`, `'CLOSE'`
- `CancelReason`: `'USER_REQUESTED'`, `'IOC_REMAINDER'`, `'FOK_NOT_FILLED'`, `'EXPIRED'`, `'SYSTEM'`

Note: the SDK accepts additional order types (`PEG_TO_*`) for compatibility with future variants, but this MM distribution supports placing only `MARKET` and `LIMIT` orders.

## Errors

`GodarkError` is the base class for every error type the SDK throws. Concrete subclasses (all in the public exports):

- `AuthenticationError` — API key auth failed
- `SessionError` — HPKE setup handshake or rekey failed
- `OrderError` — server rejected the order; carries `errorCode?: string` for the symbolic reason (e.g. `'PRICE_DEVIATION_TOO_LARGE'`, `'MARGIN_INSUFFICIENT'`). The shared `examples/dotenv.ts` has a `printOrderError(op, err)` helper that surfaces this.
- `ConnectionError` — WebSocket transport failure
- `EncryptionError` — AES-GCM encrypt / decrypt failed
- `TimeoutError` — command timed out waiting for an ack

## Example files in this distribution

| File                                  | What it does                                                                                          |
|---------------------------------------|-------------------------------------------------------------------------------------------------------|
| `examples/quickstart.ts`              | Minimal flow: connect → place limit sell → cancel → disconnect                                        |
| `examples/full-trader-example.ts`     | Reference bot loop: private streams, market data, place / modify / cancel, mass-quote / batch-cancel |
| `examples/dotenv.ts`                  | Shared `.env` loader + `OrderError` pretty-printer used by both example mains                         |

Both example scripts run under `tsx` (a TypeScript runner for Node) via the `npm run quickstart` and `npm run full-trader` scripts. To rebuild your own `.ts` against the bundled SDK, `npm run typecheck` exercises a strict `tsc --noEmit` pass.

## npm integration (your own bot)

Add `@godark/sdk` from the tarball under `sdk/`:

```json
{
  "type": "module",
  "dependencies": {
    "@godark/sdk": "file:path/to/this-bundle/sdk/godark-sdk-<version>.tgz"
  }
}
```
