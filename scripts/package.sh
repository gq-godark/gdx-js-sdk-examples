#!/usr/bin/env bash
# Examples bundle packager - Node.js zip distribution, built strictly
# from the pinned upstream gdx-js-sdk commit recorded in
# `sdk/UPSTREAM_REF`. Produces a self-contained zip:
#
#   <DIST_NAME>/
#   ├── README.md, SDK_REFERENCE.md       (from bundle/)
#   ├── .env.example                      (template)
#   ├── package.json, package-lock.json, tsconfig.json
#   ├── examples/
#   │   ├── quickstart.ts
#   │   ├── full-trader-example.ts
#   │   └── dotenv.ts                     (shared .env loader + error printer)
#   └── sdk/
#       └── godark-sdk-<version>.tgz      (prebuilt @godark/sdk npm tarball)
#
# Recipients unzip, optionally `cp .env.example .env`, then:
#   npm install         # hydrates devDeps + @godark/sdk from sdk/
#   npm run quickstart  # ./examples/quickstart.ts
#
# Usage:
#   bash scripts/package.sh                              # default: godark-js-sdk-node.zip
#   bash scripts/package.sh my-release-name
#   UPSTREAM_SRC=/path/to/gdx-js-sdk bash scripts/package.sh
set -euo pipefail

UPSTREAM_REPO="gq-godark/gdx-js-sdk"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_NAME="${1:-godark-js-sdk-node}"

cd "$REPO_ROOT"

# ---- pre-flight ----------------------------------------------------------
for required in \
    sdk/UPSTREAM_REF \
    sdk/TARBALL_NAME \
    bundle/package.json \
    bundle/sdk/README.md \
    package-lock.json \
    tsconfig.json \
    bundle/README.md \
    bundle/SDK_REFERENCE.md \
    .env.example \
    examples/quickstart.ts \
    examples/full-trader-example.ts \
    examples/rest-client-example.ts \
    examples/dotenv.ts; do
  if [[ ! -f "${REPO_ROOT}/${required}" ]]; then
    echo "error: required file missing: ${required}" >&2
    exit 1
  fi
done

PINNED_REF="$(tr -d '[:space:]' < "${REPO_ROOT}/sdk/UPSTREAM_REF")"
if [[ -z "$PINNED_REF" ]]; then
  echo "error: sdk/UPSTREAM_REF is empty" >&2
  exit 1
fi

TARBALL_NAME="$(tr -d '[:space:]' < "${REPO_ROOT}/sdk/TARBALL_NAME")"
TARBALL_PATH="${REPO_ROOT}/sdk/${TARBALL_NAME}"
if [[ ! -f "$TARBALL_PATH" ]]; then
  echo "error: vendored tarball missing: sdk/${TARBALL_NAME}" >&2
  exit 1
fi

for cmd in zip unzip npm node python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: '$cmd' not found in PATH" >&2
    exit 1
  fi
done

# ---- resolve upstream source tree ---------------------------------------
CLEANUP_UPSTREAM=false

if [[ -n "${UPSTREAM_SRC:-}" ]]; then
  echo "Using UPSTREAM_SRC=${UPSTREAM_SRC}"
elif [[ -d "${REPO_ROOT}/../gdx-js-sdk/.git" || -e "${REPO_ROOT}/../gdx-js-sdk/.git" ]]; then
  UPSTREAM_SRC="$(cd "${REPO_ROOT}/../gdx-js-sdk" && pwd)"
  echo "Using sibling upstream checkout: $UPSTREAM_SRC"
else
  CLEANUP_UPSTREAM=true
  UPSTREAM_SRC="$(mktemp -d)/gdx-js-sdk"
  echo "Cloning ${UPSTREAM_REPO}@${PINNED_REF} -> $UPSTREAM_SRC ..."
  if command -v gh >/dev/null 2>&1; then
    gh repo clone "${UPSTREAM_REPO}" "$UPSTREAM_SRC" -- --quiet
  else
    git clone --quiet "https://github.com/${UPSTREAM_REPO}.git" "$UPSTREAM_SRC"
  fi
  git -C "$UPSTREAM_SRC" checkout --quiet "$PINNED_REF"
fi

cleanup() {
  if [[ "$CLEANUP_UPSTREAM" == true && -n "${UPSTREAM_SRC:-}" ]]; then
    rm -rf "$(dirname "$UPSTREAM_SRC")"
  fi
}
trap cleanup EXIT

# ---- verify upstream is at the pinned ref -------------------------------
if [[ ! -e "$UPSTREAM_SRC/.git" ]]; then
  echo "error: '$UPSTREAM_SRC' is not a git checkout - cannot verify pin" >&2
  exit 1
fi
upstream_head_sha="$(git -C "$UPSTREAM_SRC" rev-parse HEAD)"
upstream_pin_sha="$(git -C "$UPSTREAM_SRC" rev-parse "$PINNED_REF" 2>/dev/null || true)"
if [[ -z "$upstream_pin_sha" ]]; then
  echo "error: pinned ref '$PINNED_REF' does not resolve in $UPSTREAM_SRC" >&2
  exit 1
fi
if [[ "$upstream_head_sha" != "$upstream_pin_sha" ]]; then
  echo "error: upstream HEAD ($upstream_head_sha) does not match pinned ref" >&2
  echo "       sdk/UPSTREAM_REF=$PINNED_REF -> $upstream_pin_sha" >&2
  exit 1
fi
echo "Upstream verified at pin: $PINNED_REF ($upstream_head_sha)"

# ---- parity check: vendored tarball contents must match a fresh pack ---
# `npm pack` is not byte-deterministic (gzip mtimes vary), so we compare
# the *unpacked tar listings + per-file content hashes* rather than the
# raw tarballs.
PARITY_DIR="$(mktemp -d)"
mkdir -p "$PARITY_DIR/vendored" "$PARITY_DIR/fresh"

echo "Re-packing upstream for parity check ..."
( cd "$UPSTREAM_SRC" && npm ci --no-audit --no-fund --silent && npm run build --silent )
FRESH_TARBALL="$(cd "$PARITY_DIR/fresh" && npm pack "$UPSTREAM_SRC" --silent | tail -n 1)"
FRESH_TARBALL_PATH="$PARITY_DIR/fresh/$FRESH_TARBALL"

tar -xzf "$TARBALL_PATH"        -C "$PARITY_DIR/vendored"
tar -xzf "$FRESH_TARBALL_PATH"  -C "$PARITY_DIR/fresh"

if ! diff -r --brief "$PARITY_DIR/vendored/package" "$PARITY_DIR/fresh/package" >/dev/null; then
  echo
  echo "error: vendored sdk/${TARBALL_NAME} has drifted from upstream ${PINNED_REF}:" >&2
  diff -r --brief "$PARITY_DIR/vendored/package" "$PARITY_DIR/fresh/package" >&2 || true
  echo >&2
  echo "  fix: bash scripts/refresh_sdk.sh ${UPSTREAM_SRC} && git add sdk/ package.json package-lock.json && git commit" >&2
  rm -rf "$PARITY_DIR"
  exit 1
fi
echo "Parity check passed: tarball contents match upstream pack"

SHIP_TARBALL="$PARITY_DIR/fresh/$FRESH_TARBALL"

# ---- stage --------------------------------------------------------------
STAGING_DIR="$(mktemp -d)"
DEST="$STAGING_DIR/$DIST_NAME"
mkdir -p "$DEST/examples" "$DEST/sdk"

echo "Staging distribution at $DEST ..."

# Recipient-facing docs come from bundle/, never the repo root copies.
cp "${REPO_ROOT}/bundle/README.md"         "$DEST/README.md"
cp "${REPO_ROOT}/bundle/SDK_REFERENCE.md"  "$DEST/SDK_REFERENCE.md"
cp "${REPO_ROOT}/.env.example"             "$DEST/.env.example"

# Build manifests + lockfile so `npm install` from inside the bundle is
# fully reproducible. Recipient-facing package.json lives under bundle/.
python3 - "$REPO_ROOT/bundle/package.json" "$TARBALL_NAME" > "$DEST/package.json" <<'PY'
import json, sys
src, tarball = sys.argv[1], sys.argv[2]
pkg = json.load(open(src))
pkg["dependencies"]["@godark/sdk"] = f"file:./sdk/{tarball}"
json.dump(pkg, sys.stdout, indent=2)
sys.stdout.write("\n")
PY
cp "${REPO_ROOT}/package-lock.json"        "$DEST/package-lock.json"
sed -i 's/"gdx-js-sdk-examples"/"godark-examples"/g' "$DEST/package-lock.json"
cp "${REPO_ROOT}/tsconfig.json"            "$DEST/tsconfig.json"

# Examples - the actual demos the recipient is going to run.
cp "${REPO_ROOT}/examples/quickstart.ts"          "$DEST/examples/"
cp "${REPO_ROOT}/examples/full-trader-example.ts" "$DEST/examples/"
cp "${REPO_ROOT}/examples/rest-client-example.ts" "$DEST/examples/"
cp "${REPO_ROOT}/examples/dotenv.ts"              "$DEST/examples/"

# Prebuilt @godark/sdk tarball — repacked from the parity-verified upstream
# pack with a recipient-facing README (internal maintainer docs stripped).
SANITIZE_DIR="$(mktemp -d)"
tar -xzf "$SHIP_TARBALL" -C "$SANITIZE_DIR"
cp "${REPO_ROOT}/bundle/sdk/README.md" "$SANITIZE_DIR/package/README.md"
tar -czf "$DEST/sdk/$TARBALL_NAME" -C "$SANITIZE_DIR" package
rm -rf "$PARITY_DIR" "$SANITIZE_DIR"

# ---- zip ----------------------------------------------------------------
ARCHIVE="$REPO_ROOT/${DIST_NAME}.zip"
rm -f "$ARCHIVE"
( cd "$STAGING_DIR" && zip -qr "$ARCHIVE" "$DIST_NAME" )
rm -rf "$STAGING_DIR"

# ---- post-flight assertions --------------------------------------------
echo
echo "Package created: $ARCHIVE"
LISTING="$(unzip -l "$ARCHIVE")"
echo "$LISTING"

# Recipient contract: no maintainer-only directories must leak.
if echo "$LISTING" | grep -E "${DIST_NAME}/(scripts|bundle|node_modules|\.git)/" >/dev/null; then
  echo "error: bundle contains forbidden internal directory" >&2
  exit 1
fi
# Every required path must be present.
for required in \
  "${DIST_NAME}/README\\.md" \
  "${DIST_NAME}/SDK_REFERENCE\\.md" \
  "${DIST_NAME}/\\.env\\.example" \
  "${DIST_NAME}/package\\.json" \
  "${DIST_NAME}/package-lock\\.json" \
  "${DIST_NAME}/tsconfig\\.json" \
  "${DIST_NAME}/examples/quickstart\\.ts" \
  "${DIST_NAME}/examples/full-trader-example\\.ts" \
  "${DIST_NAME}/examples/dotenv\\.ts" \
  "${DIST_NAME}/sdk/${TARBALL_NAME//./\\.}"; do
  if ! echo "$LISTING" | grep -E "${required}" >/dev/null; then
    echo "error: bundle missing required entry: ${required}" >&2
    exit 1
  fi
done

if echo "$LISTING" | grep -E "${DIST_NAME}/(sdk/UPSTREAM_REF|sdk/TARBALL_NAME|/\\.env$)" >/dev/null; then
  echo "error: bundle contains maintainer-only metadata or .env" >&2
  exit 1
fi

echo
echo "bundle-shape assertion: PASSED"

# Must NOT leak internal repo names or maintainer markers into the archive.
if unzip -p "$ARCHIVE" 2>/dev/null | strings | grep -qiE \
  'gdx-js-sdk|UPSTREAM_REF|TARBALL_NAME|refresh_sdk|package\.sh|\bvendored\b|gdx-proto'; then
  echo "error: bundle contains internal repo references or maintainer markers" >&2
  unzip -p "$ARCHIVE" 2>/dev/null | strings | grep -iE \
    'gdx-js-sdk|UPSTREAM_REF|TARBALL_NAME|refresh_sdk|package\.sh|\bvendored\b|gdx-proto' | head -20 >&2 || true
  exit 1
fi

echo "leak guard: PASSED"
echo "built from upstream:    ${UPSTREAM_REPO}@${PINNED_REF} (${upstream_head_sha})"
