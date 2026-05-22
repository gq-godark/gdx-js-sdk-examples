#!/usr/bin/env bash
# Refresh the vendored SDK tarball under `sdk/` from a sibling
# `gdx-js-sdk` checkout AND record the upstream commit in
# `sdk/UPSTREAM_REF`. The release pipeline (scripts/package.sh +
# .github/workflows/release.yml) verifies the vendored tarball was
# produced from exactly that commit before publishing the examples zip.
#
# The SDK is distributed as a single npm tarball produced by
# `npm pack` (npm's canonical packaging primitive). Recipients install
# it via `npm install ./sdk/godark-sdk-<version>.tgz`, which avoids any
# private npm registry dependency.
#
# Usage:
#   ./scripts/refresh_sdk.sh /path/to/gdx-js-sdk
#
# The source checkout MUST:
#   1. be a git checkout (`.git/` present) so the pin can be recorded
#   2. have a clean worktree (no uncommitted changes); otherwise the
#      recorded SHA wouldn't faithfully describe what was vendored
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 /path/to/gdx-js-sdk" >&2
  exit 1
fi

SRC="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST="$REPO_ROOT/sdk"

if [[ ! -d "$SRC" ]]; then
  echo "error: source directory '$SRC' does not exist" >&2
  exit 1
fi

if [[ ! -e "$SRC/.git" ]]; then
  echo "error: '$SRC' is not a git checkout - pin cannot be recorded" >&2
  exit 1
fi

if [[ ! -f "$SRC/package.json" ]]; then
  echo "error: '$SRC/package.json' missing - is this the gdx-js-sdk repo?" >&2
  exit 1
fi

# Refuse to refresh from a dirty upstream worktree. The pin would not be
# reproducible and the CI parity check would fail in confusing ways.
if ! git -C "$SRC" diff --quiet || ! git -C "$SRC" diff --cached --quiet; then
  echo "error: upstream '$SRC' has uncommitted changes; commit or stash first" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "error: 'npm' not found in PATH" >&2
  exit 1
fi

UPSTREAM_SHA="$(git -C "$SRC" rev-parse HEAD)"
UPSTREAM_TAG="$(git -C "$SRC" describe --tags --exact-match HEAD 2>/dev/null || true)"

echo "Refreshing $DEST from $SRC ..."
echo "  upstream HEAD: $UPSTREAM_SHA${UPSTREAM_TAG:+ (tag $UPSTREAM_TAG)}"

# Build the SDK fresh so the packed tarball reflects the source we're
# pinning to. `npm pack` does not run a build by default - the prepack
# lifecycle script (if any) handles that. We make it explicit so this
# script is hermetic.
echo "  npm ci + build in upstream ..."
( cd "$SRC" && npm ci --no-audit --no-fund --silent && npm run build --silent )

# Produce the tarball. `npm pack --json` writes to ./<name>-<version>.tgz
# in the current directory; we run it inside a temp dir so the upstream
# worktree stays clean.
STAGE_DIR="$(mktemp -d)"
( cd "$STAGE_DIR" && npm pack "$SRC" --silent >/dev/null )

TARBALL="$(ls "$STAGE_DIR"/*.tgz | head -n 1)"
if [[ -z "$TARBALL" || ! -f "$TARBALL" ]]; then
  echo "error: npm pack produced no tarball in $STAGE_DIR" >&2
  rm -rf "$STAGE_DIR"
  exit 1
fi
TARBALL_NAME="$(basename "$TARBALL")"

# Wipe + repopulate the vendored sdk/ atomically.
rm -rf "$DEST"
mkdir -p "$DEST"
mv "$TARBALL" "$DEST/$TARBALL_NAME"
rm -rf "$STAGE_DIR"

# Pin the commit (prefer tag for human readability if HEAD is on one).
if [[ -n "$UPSTREAM_TAG" ]]; then
  printf '%s\n' "$UPSTREAM_TAG" > "$DEST/UPSTREAM_REF"
else
  printf '%s\n' "$UPSTREAM_SHA" > "$DEST/UPSTREAM_REF"
fi

# Record the tarball filename so package.sh / package.json updates can
# look it up deterministically without globbing.
printf '%s\n' "$TARBALL_NAME" > "$DEST/TARBALL_NAME"

echo "  vendored: $TARBALL_NAME ($(du -h "$DEST/$TARBALL_NAME" | cut -f1))"
echo "  wrote pin: $(cat "$DEST/UPSTREAM_REF")  -> sdk/UPSTREAM_REF"

# Auto-rewrite package.json to depend on the vendored tarball via the
# `file:` protocol. This keeps `npm install` reproducible: the lockfile
# resolves @godark/sdk to a content hash of the tgz, not to whatever the
# registry happens to serve. (Recipient-friendly: no private registry.)
PKG_JSON="$REPO_ROOT/package.json"
python3 - "$PKG_JSON" "$TARBALL_NAME" <<'PY'
import json, sys, pathlib
p = pathlib.Path(sys.argv[1])
name = sys.argv[2]
data = json.loads(p.read_text())
deps = data.setdefault("dependencies", {})
deps["@godark/sdk"] = f"file:./sdk/{name}"
p.write_text(json.dumps(data, indent=2) + "\n")
PY
echo "  updated package.json: @godark/sdk -> file:./sdk/$TARBALL_NAME"

echo "Done. Review with: cd '$REPO_ROOT' && git status sdk/ package.json"
echo "Next: run 'npm install' to refresh package-lock.json against the new tarball."
