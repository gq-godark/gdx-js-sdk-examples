# @godark/sdk

TypeScript SDK for encrypted trading on the GoDark DEX over WebSocket.

## WebSocket endpoints

The trading WebSocket lives at `/ws/v1`. The SDK appends this suffix to the
configured base URL (and upgrades a legacy `/ws` to `/ws/v1` automatically).

| Environment | Canonical URL |
|---|---|
| Testnet (default) | `wss://api.godark-dex.com/ws/v1` |
| Localnet | `ws://127.0.0.1:4000/ws/v1` |

Set the host via `GODARK_EDGE_URL` / `GDX_EDGE_URL` or the client `baseUrl`
option. The market-data feed uses `/ws/gomarket` and is not affected by the
`/ws/v1` suffix.

## Install

This distribution ships as a local tarball:

```bash
npm install ./sdk/godark-sdk-0.1.0.tgz
```

Or reference it from your own `package.json`:

```json
{
  "dependencies": {
    "@godark/sdk": "file:path/to/godark-sdk-0.1.0.tgz"
  }
}
```
