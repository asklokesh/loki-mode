#!/usr/bin/env bash
# E-129: WhatsNew.tsx CURRENT_VERSION must equal VERSION (release.sh stamps it).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
want="$(tr -d '[:space:]' < "$ROOT/VERSION")"
got="$(sed -n "s/^const CURRENT_VERSION = '\([0-9.]*\)';\$/\1/p" "$ROOT/web-app/src/components/WhatsNew.tsx")"
if [ "$got" = "$want" ]; then
    echo "PASS: WhatsNew CURRENT_VERSION $got == VERSION"
else
    echo "FAIL: WhatsNew CURRENT_VERSION '$got' != VERSION '$want'"
    exit 1
fi
