# GoDark JavaScript Examples (Darkpool MM Distribution)

This repository is a market-maker-facing distribution for GoDark's JavaScript / TypeScript SDK. It includes:

- two reference TypeScript examples (`quickstart` + `full-trader-example`) plus a shared `.env` helper
- the full **`@godark/sdk` npm tarball vendored under `sdk/`** — no private npm registry required to install
- a Node.js `.zip` release pre-built on every push to `main` (no GitHub access required to install from the zip)
- a simple **`.env`** workflow (no shell `export` required)

Third-party packages (`tsx`, `typescript`, `@types/node`, `ws` — the latter pulled in transitively by the SDK) are still fetched from the public npm registry when you `npm install`; only `@godark/sdk` itself comes entirely from this repo.

## Prerequisites

| Item    | Requirement                                                                                                |
|---------|------------------------------------------------------------------------------------------------------------|
| Node.js | ≥ 18 (tested on 20 + 22)                                                                                   |
| npm     | ≥ 9 (ships with the Node versions above)                                                                   |
| OS      | Linux / macOS / Windows — the tarball is platform-independent JavaScript                                   |

## Testnet onboarding

Before running the examples, complete this setup flow:

1. Open the testnet frontend: `https://app.godark-dex.com`
2. Create an account using email sign-up.
3. Fund your testnet account using the faucet: `https://faucet.godark-dex.com`
4. In the frontend, go to **Settings → API Key Management** and click **Create API Key**.
5. Use the generated key ID and secret for your local `.env`.

## Configure credentials

Copy `.env.example` to `.env` and fill in your API credentials:

```bash
cp .env.example .env
```

Required keys:

- `GODARK_API_KEY_ID`
- `GODARK_API_SECRET`
- `GODARK_PASSPHRASE` — required for API key-pair auth.

Optional:

- `GODARK_EDGE_URL` — local testing only; if unset, examples use `wss://api.godark-dex.com`.

The OS environment always wins over `.env`.

## Install

### From a released ZIP (recommended for MMs)

Download the latest `gdx-js-sdk-examples-*-node.zip` from [GitHub Releases](https://github.com/gq-godark/gdx-js-sdk-examples/releases) and unzip it. The bundle contains the example sources, the vendored npm tarball, and a `package.json` + `package-lock.json` already wired up.

```bash
unzip gdx-js-sdk-examples-*-node.zip
cd gdx-js-sdk-examples-node/
cp .env.example .env
# fill in GODARK_API_KEY_ID, GODARK_API_SECRET, GODARK_PASSPHRASE

npm install              # hydrates devDeps + the vendored @godark/sdk
npm run quickstart       # examples/quickstart.ts
npm run full-trader      # examples/full-trader-example.ts
```

`@godark/sdk` is resolved via `file:./sdk/godark-sdk-<version>.tgz`, so `npm install` only needs the public npm registry for the small dev-dependency set (`tsx`, `typescript`, `@types/node`).

### From a git clone (development)

```bash
git clone https://github.com/gq-godark/gdx-js-sdk-examples.git
cd gdx-js-sdk-examples
cp .env.example .env
# fill in credentials

npm install
npm run quickstart
npm run full-trader
```

## Examples

| Sample                | Source                              | Purpose                                                                                                                              |
|-----------------------|-------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| `quickstart`          | `examples/quickstart.ts`            | Minimal connect → LIMIT sell far from touch → cancel; surfaces the symbolic `OrderError.errorCode` reason on rejection               |
| `full-trader-example` | `examples/full-trader-example.ts`   | Reference bot flow: private streams via callbacks **and** the `orderUpdates()` async iterator, `MarketDataClient` on a second port, place / modify / cancel cycle, queue drain |

Order-type support in this MM distribution is limited to **`MARKET`** and **`LIMIT`**.

## Packaging for market makers

Build a release zip locally:

```bash
# Uses a sibling ../gdx-js-sdk if present, else clones at the pinned ref:
./scripts/package.sh

# Or explicitly point at an upstream checkout:
UPSTREAM_SRC=/path/to/gdx-js-sdk ./scripts/package.sh gdx-js-sdk-examples-vX.Y.Z-node
```

Output lands in the repo root as `<bundle>-node.zip`. The zip includes:

- `examples/quickstart.ts`, `examples/full-trader-example.ts`, `examples/dotenv.ts` — example sources
- `sdk/godark-sdk-<version>.tgz` + `sdk/UPSTREAM_REF` + `sdk/TARBALL_NAME` — vendored SDK and pin metadata
- `package.json`, `package-lock.json`, `tsconfig.json` — install + typecheck manifests
- `README.md`, `SDK_REFERENCE.md` — recipient-facing docs from `bundle/`
- `.env.example` — credential template

Maintainer-only paths (`scripts/`, `bundle/`, `node_modules/`, `.git/`, local `.env`) are **not** included in the zip.

The CI release pipeline additionally runs a recipient smoke step that unzips the bundle and runs `npm install && npm run typecheck` against the included tarball, confirming the bundle is install-complete on its own.

**Release contract**: hand-edits to the vendored `sdk/` tarball must never leak into a release. Every release build:

1. Reads the pinned upstream `gdx-js-sdk` commit from `sdk/UPSTREAM_REF`.
2. Checks out `gq-godark/gdx-js-sdk` at that exact ref into `./upstream/`.
3. Parity check — `npm ci && npm run build && npm pack`s the upstream, extracts both that tarball and the vendored one, and runs `diff -r --brief` over their unpacked contents. The check **fails loudly** on any difference (`npm pack` is not byte-deterministic because of gzip mtimes; the tarball *contents* are).
4. Stages the parity-verified tarball, example sources, and bundle docs into the recipient zip.

The source of truth for what ships is always `gdx-js-sdk@<sdk/UPSTREAM_REF>`.

CI publishes a tagged `gdx-js-sdk-examples-*-node.zip` on every push to `main` via `.github/workflows/release.yml`; download from [GitHub Releases](https://github.com/gq-godark/gdx-js-sdk-examples/releases).

## Layout

| Path                                          | Purpose                                                                                                                              |
|-----------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| `examples/`                                   | Source for runnable MM examples (`quickstart.ts`, `full-trader-example.ts`, `dotenv.ts` helper)                                      |
| `package.json`                                | Examples package; depends on the vendored `@godark/sdk` tarball via `file:./sdk/<tarball>`                                           |
| `package-lock.json`                           | Lockfile (records the content hash of the vendored tarball; install is fully reproducible)                                           |
| `tsconfig.json`                               | Strict `tsc --noEmit` typecheck gate                                                                                                 |
| `sdk/`                                        | Vendored `@godark/sdk` npm tarball + pin metadata                                                                                    |
| `sdk/UPSTREAM_REF`                            | Pinned upstream `gdx-js-sdk` commit; CI re-packs against this exact ref for parity                                                   |
| `sdk/TARBALL_NAME`                            | Filename of the vendored tarball (for deterministic lookups in scripts and CI)                                                       |
| `bundle/README.md`                            | Recipient-facing README packaged into the release zip                                                                                |
| `bundle/SDK_REFERENCE.md`                     | Recipient-facing API reference packaged into the release zip                                                                         |
| `SDK_REFERENCE.md`                            | Maintainer-grade API reference; mirrored in trimmed form at `bundle/SDK_REFERENCE.md`                                                |
| `.env.example`                                | Credential template copied to `.env`                                                                                                 |
| `scripts/refresh_sdk.sh`                      | Re-pack the upstream SDK + write `sdk/UPSTREAM_REF` + bump `package.json` (maintainers only; not shipped)                            |
| `scripts/package.sh`                          | Produce the release zip (CI + local)                                                                                                 |
| `.github/workflows/release.yml`               | Build / smoke / publish the release zip on every push and PR                                                                         |
| `.github/workflows/auto-bump-sdk-pin.yml`     | Layer 2 listener that auto-PRs vendored SDK refreshes when upstream `gdx-js-sdk` ships                                               |

## Refreshing `sdk/` (internal)

From a sibling development checkout of the upstream SDK at the commit you want to ship:

```bash
./scripts/refresh_sdk.sh /path/to/gdx-js-sdk
git add sdk/ package.json package-lock.json
git commit -m "refresh: sync vendored SDK tarball with upstream"
```

The script refuses to run if the sibling SDK checkout is dirty, runs `npm ci && npm run build && npm pack` inside it, drops the resulting tarball under `sdk/`, writes the upstream HEAD commit (or tag, if HEAD is on one) to `sdk/UPSTREAM_REF`, and rewrites `package.json` so `@godark/sdk` resolves to the new tarball via `file:`.

The Layer 2 listener (`auto-bump-sdk-pin.yml`) wraps this loop into a rolling auto-PR triggered by `gdx-js-sdk` pushes to `main`. The full upstream-change chain (proto → SDK → examples → release zip) is:

1. A push to `gdx-proto` (`v1/devnet`) dispatches `gdx-proto-changed` to `gdx-js-sdk`.
2. `gdx-js-sdk/.github/workflows/auto-regen-protos.yml` regenerates the committed proto bindings and opens a rolling PR. Merging it dispatches `gdx-sdk-changed` to this repo.
3. `auto-bump-sdk-pin.yml` here refreshes `sdk/`, bumps `sdk/UPSTREAM_REF`, refreshes `package-lock.json`, and opens its own rolling PR.
4. Merging that PR triggers `release.yml`, which rebuilds the bundle zip from the new pin and publishes a tagged GitHub Release.
