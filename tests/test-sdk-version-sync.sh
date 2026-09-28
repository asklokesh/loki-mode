#!/usr/bin/env bash
#
# test-sdk-version-sync.sh
#
# Regression test for the Agent SDK version drift caught in incident 9db2a4ed:
# loki-ts/package.json was bumped to @anthropic-ai/claude-agent-sdk 0.3.283
# but root package.json, root package-lock.json and the Dockerfile pin were
# left at older versions. The published npm package resolves the OLD SDK
# while the source that runs on claude-opus-5-5 expects the new one. The only
# existing check ("Agent SDK is a resolvable root dependency" in
# scripts/local-ci.sh) is not wired into CI, so the drift shipped for a full
# day of releases.
#
# This test asserts the claude-agent-sdk version is IDENTICAL in all 4 places:
#   1. loki-ts/package.json           (source of truth: what the code imports)
#   2. root package.json              (dependencies or optionalDependencies)
#   3. root package-lock.json
#   4. every Dockerfile* install line that pins the package
#
# Deterministic and offline: reads only files already in the repo.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PKG="@anthropic-ai/claude-agent-sdk"
FAILS=0

echo "== SDK version sync (loki-ts / root package.json / lockfile / Dockerfile*) =="

# --- 1. Source of truth: loki-ts/package.json -----------------------------
SRC_VER="$(node -e '
  const d = require("./loki-ts/package.json");
  const v = (d.dependencies || {})["'"$PKG"'"];
  if (!v) process.exit(1);
  process.stdout.write(v);
')" || { echo "FAIL: loki-ts/package.json has no dependency on $PKG"; exit 1; }
echo "  loki-ts/package.json:       $SRC_VER"

# --- 2. root package.json (dependencies OR optionalDependencies) ----------
ROOT_VER="$(node -e '
  const d = require("./package.json");
  const v = (d.dependencies && d.dependencies["'"$PKG"'"]) ||
            (d.optionalDependencies && d.optionalDependencies["'"$PKG"'"]) || "";
  process.stdout.write(v);
')"
echo "  root package.json:          ${ROOT_VER:-<missing>}"
if [[ "$ROOT_VER" != "$SRC_VER" ]]; then
  echo "  FAIL: root package.json pins $ROOT_VER, loki-ts expects $SRC_VER"
  FAILS=$((FAILS + 1))
fi

# --- 3. root package-lock.json ---------------------------------------------
LOCK_VER="$(node -e '
  const d = require("./package-lock.json");
  const root = d.packages && d.packages[""];
  const v = (root && root.dependencies && root.dependencies["'"$PKG"'"]) ||
            (root && root.optionalDependencies && root.optionalDependencies["'"$PKG"'"]) || "";
  process.stdout.write(v);
')"
echo "  package-lock.json (root):   ${LOCK_VER:-<missing>}"
if [[ "$LOCK_VER" != "$SRC_VER" ]]; then
  echo "  FAIL: package-lock.json (root manifest entry) pins $LOCK_VER, loki-ts expects $SRC_VER"
  FAILS=$((FAILS + 1))
fi

# Also check the lockfile's resolved package entry, if npm generated one, so
# a hand-edited manifest line with a stale resolved/version does not slip by.
RESOLVED_VER="$(node -e '
  const d = require("./package-lock.json");
  const key = "node_modules/'"$PKG"'";
  const v = d.packages && d.packages[key] && d.packages[key].version;
  process.stdout.write(v || "");
')"
if [[ -n "$RESOLVED_VER" && "$RESOLVED_VER" != "$SRC_VER" ]]; then
  echo "  FAIL: package-lock.json resolved node_modules entry is $RESOLVED_VER, loki-ts expects $SRC_VER"
  FAILS=$((FAILS + 1))
fi

# --- 4. every Dockerfile* install line that pins the package ---------------
DOCKER_MISMATCH=0
while IFS=: read -r file line; do
  [[ -z "$file" ]] && continue
  ver="$(sed -n "${line}p" "$file" | grep -oE "${PKG}@[0-9][0-9A-Za-z.\\-]*" | head -1 | sed "s|^${PKG}@||")"
  [[ -z "$ver" ]] && continue
  echo "  ${file}:${line}:        $ver"
  if [[ "$ver" != "$SRC_VER" ]]; then
    echo "  FAIL: ${file}:${line} pins $ver, loki-ts expects $SRC_VER"
    FAILS=$((FAILS + 1))
    DOCKER_MISMATCH=1
  fi
done < <(grep -rnE "${PKG}@[0-9]" --include="Dockerfile*" . 2>/dev/null | cut -d: -f1,2)

if [[ "$DOCKER_MISMATCH" -eq 0 ]] && ! grep -rqE "${PKG}@[0-9]" --include="Dockerfile*" . 2>/dev/null; then
  echo "  FAIL: no Dockerfile* pins a version for $PKG (expected at least one)"
  FAILS=$((FAILS + 1))
fi

echo ""
if [[ "$FAILS" -eq 0 ]]; then
  echo "SDK-VERSION-SYNC-TEST: PASS (all 4 locations pin $SRC_VER)"
  exit 0
fi
echo "SDK-VERSION-SYNC-TEST: FAIL (${FAILS} mismatch(es))"
exit 1
