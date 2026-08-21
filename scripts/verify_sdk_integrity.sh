#!/usr/bin/env bash
# Fail if package-lock.json's integrity for the vendored @godark/sdk
# tarball does not match the sha512 of the file on disk.
#
# Catches merge commits that keep a new sdk/*.tgz but an old lockfile
# hash (EINTEGRITY on npm install / npm ci).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

TARBALL_NAME="$(tr -d '[:space:]' < sdk/TARBALL_NAME)"
TARBALL="sdk/${TARBALL_NAME}"

if [ ! -f "$TARBALL" ]; then
  echo "::error::Vendored tarball missing: ${TARBALL}" >&2
  exit 1
fi

python3 - "$TARBALL" <<'PY'
import base64, hashlib, json, sys

tarball = sys.argv[1]
digest = hashlib.sha512(open(tarball, "rb").read()).digest()
computed = "sha512-" + base64.b64encode(digest).decode()

lock = json.load(open("package-lock.json"))
entry = lock.get("packages", {}).get("node_modules/@godark/sdk")
if not entry:
    sys.stderr.write("::error::package-lock.json has no packages['node_modules/@godark/sdk']\n")
    sys.exit(1)

recorded = entry.get("integrity", "")
resolved = entry.get("resolved", "")
expected_resolved = f"file:{tarball}"
# npm may record file:sdk/... or file:./sdk/...
ok_resolved = resolved in (expected_resolved, f"file:./{tarball}")

print(f"tarball:   {tarball}")
print(f"resolved:  {resolved}")
print(f"lockfile:  {recorded}")
print(f"computed:  {computed}")

failed = False
if not ok_resolved:
    sys.stderr.write(
        f"::error::lockfile resolved={resolved!r} does not point at {tarball}\n"
    )
    failed = True
if recorded != computed:
    sys.stderr.write(
        "::error::package-lock.json integrity for @godark/sdk does not match "
        f"{tarball}. Refresh with: npm install --package-lock-only\n"
    )
    failed = True
if failed:
    sys.exit(1)
print("ok: vendored SDK tarball matches package-lock.json integrity")
PY
