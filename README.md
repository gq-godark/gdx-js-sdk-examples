# Godark JavaScript examples

Sample programs that consume **`@godark/sdk`** from **npm** only (no Git or source dependency on the SDK repo).

## Prerequisites

- Node.js ≥ 18
- npm; registry access for **`@godark/sdk`** (use **`.npmrc`** if the scope is on a private host)

## Build

From the **repository root**:

```bash
npm install
```

Run examples via **`npm run <script>`** (see table) or **`npx tsx examples/<file>.ts`**.

## Binaries (npm scripts / public API)

| Script | Source | What it does |
|--------|--------|--------------|
| `quickstart` | `examples/quickstart.ts` | Minimal connect → limit sell → cancel. Needs `GODARK_API_KEY_ID` + `GODARK_API_SECRET`. |
| `e2e` | `examples/e2e-trading-smoke.ts` | E2E smoke; `npm run e2e:auth-only` for connect-only; exit codes for CI. |
| `market-data` | `examples/market-data.ts` | Public gomarket order book + trades (no keys). |
| `full-trader` | `examples/full-trader-example.ts` | Larger demo: callbacks, MD client, place/modify/cancel, queue drain. |
| `full-trader-rest` | `examples/full-trader-rest.ts` | REST `GodarkRestClient`: session + encrypted place + cancel (`GDX_REST_URL`, keys). |

### Environment quick reference

- **Trading (most WS examples):** `GODARK_API_KEY_ID`, `GODARK_API_SECRET`, optional `GODARK_EDGE_URL` / `GDX_EDGE_URL`.
- **REST (`full-trader-rest`):** `GDX_REST_URL`, `GDX_API_KEY_ID` / `GDX_API_SECRET` or `GDX_API_KEY` (see sample fallbacks).
- **Market data:** `GODARK_EDGE_URL` or `GDX_EDGE_URL`; optional `GDX_TLS_SKIP_VERIFY` / `GODARK_TLS_SKIP_VERIFY`.

## Layout

| Path | Purpose |
|------|---------|
| `package.json` | Depends on **`@godark/sdk`**; npm scripts for each example |
| `tsconfig.json` | `tsc --noEmit` via **`npm run typecheck`** |
| `types/godark-sdk.d.ts` | Optional ambient types if the npm tarball omits `dist/index.d.ts` |
| `examples/*.ts` | Sources |

## `package.json`

Edit the **`@godark/sdk`** version range to match what your registry provides.
