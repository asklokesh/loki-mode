#!/usr/bin/env bash
# Test: `loki status` prints the newest sealed receipt's verdict (133-F4), read from
# the receipt field only, identically on the bash and Bun routes.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"
STATUS_TS="$REPO_ROOT/loki-ts/src/commands/status.ts"
export LOKI_NO_BROWSER=1

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

command -v bun >/dev/null 2>&1 || { echo "bun not installed: the suite did not run (unmeasured, not clean)"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq not installed: the suite did not run (unmeasured, not clean)"; exit 1; }

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")" || exit 1
cleanup() { rm -rf -- "$TMP_ROOT"; }
trap cleanup EXIT

strip_ansi() { sed $'s/\x1b\\[[0-9;]*m//g'; }

# Each case gets its own project dir holding .loki/runs.
new_proj() {
    local d="$TMP_ROOT/$1"
    mkdir -p "$d/.loki/runs"
    printf '%s' "$d"
}

status_bash() { (cd "$1" && LOKI_DIR="$1/.loki" timeout -k 5 60 bash "$LOKI" status 2>&1 | strip_ansi); }
# The Bun text path is commands/status.ts runStatus; `bun cli.ts status` is the separate
# Loki 10 run_status.ts surface, so this test imports the ported command directly.
status_bun() { (cd "$1" && LOKI_DIR="$1/.loki" timeout -k 5 60 bun -e "const m = await import('$STATUS_TS'); process.exit(await m.runStatus([]));" 2>&1 | strip_ansi); }

last_line() { printf '%s\n' "$1" | grep '^Last run:' || true; }

# check <name> <proj> <expected line>
check() {
    local name="$1" proj="$2" want="$3" b t
    b="$(last_line "$(status_bash "$proj")")"
    t="$(last_line "$(status_bun "$proj")")"
    if [ "$b" = "$want" ]; then ok "$name (bash)"; else bad "$name (bash): got '$b' want '$want'"; fi
    if [ "$t" = "$want" ]; then ok "$name (bun)"; else bad "$name (bun): got '$t' want '$want'"; fi
    if [ "$b" = "$t" ]; then ok "$name (routes agree)"; else bad "$name: routes differ"; fi
}

HASH="abc123def456789000aa"

p="$(new_proj verified)"
mkdir -p "$p/.loki/runs/e10-20260101-a"
printf '{"verdict":"VERIFIED","receipt_sha256":"%s"}' "$HASH" >"$p/.loki/runs/e10-20260101-a/receipt.json"
check "VERIFIED prints the 12 char hash" "$p" "Last run: VERIFIED (receipt sha256:abc123def456)"

p="$(new_proj none)"
check "no receipt" "$p" "Last run: no receipt (verdict NOT AVAILABLE)"

p="$(new_proj corrupt)"
mkdir -p "$p/.loki/runs/e10-20260101-a"
printf '{not json' >"$p/.loki/runs/e10-20260101-a/receipt.json"
check "corrupt receipt" "$p" "Last run: receipt unreadable"

p="$(new_proj missing-file)"
mkdir -p "$p/.loki/runs/e10-20260101-a"
check "run dir without receipt.json" "$p" "Last run: receipt unreadable"

p="$(new_proj nofield)"
mkdir -p "$p/.loki/runs/e10-20260101-a"
printf '{"receipt_sha256":"%s"}' "$HASH" >"$p/.loki/runs/e10-20260101-a/receipt.json"
check "receipt without a verdict field never reads VERIFIED" "$p" "Last run: receipt unreadable"

for v in PARTIAL FAILED; do
    p="$(new_proj "stored-$v")"
    mkdir -p "$p/.loki/runs/e10-20260101-a"
    printf '{"verdict":"%s","receipt_sha256":"sha256:%s"}' "$v" "$HASH" >"$p/.loki/runs/e10-20260101-a/receipt.json"
    check "$v prints as stored" "$p" "Last run: $v (receipt sha256:abc123def456)"
done

# Newest run wins: an older VERIFIED receipt must not mask a newer FAILED one.
p="$(new_proj newest)"
mkdir -p "$p/.loki/runs/e10-20260101-a" "$p/.loki/runs/e10-20260102-b"
printf '{"verdict":"VERIFIED","receipt_sha256":"%s"}' "$HASH" >"$p/.loki/runs/e10-20260101-a/receipt.json"
printf '{"verdict":"FAILED","receipt_sha256":"%s"}' "$HASH" >"$p/.loki/runs/e10-20260102-b/receipt.json"
check "newest receipt wins over an older VERIFIED" "$p" "Last run: FAILED (receipt sha256:abc123def456)"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
