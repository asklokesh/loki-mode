#!/usr/bin/env bash
# STALE-ZERO SZ-03: docs must not carry stale facts.
#   (a) a `loki <cmd>` in README/SKILL/docs/wiki naming a top-level command absent
#       from the registry (loki-ts/src/cli/registry.ts, visible or hidden)
#   (b) dead env vars LOKI_ENGINE, LOKI_LEGACY_BASH, LOKI_SDK_LOOP
#   (c) a version string of an older major (v9.x and below)
# Exclusions: CHANGELOG.md, docs/history/, docs/v10/ planning records.
# ADVISORY while the legacy removal is in flight: prints findings and exits 0
# unless LOKI_STALE_ZERO_STRICT=1. The positive controls always run and are
# always fatal (a scanner that cannot see a planted violation is broken).
# Scanner: tests/lib/scan-stale-facts.py.
# shellcheck disable=SC2016  # fixture text deliberately contains literal backticks
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAN="$SCRIPT_DIR/lib/scan-stale-facts.py"

PASS=0
FAIL=0
pass() { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

echo "test-no-stale-facts"

if ! command -v python3 >/dev/null 2>&1 || ! command -v bun >/dev/null 2>&1; then
    echo "  [SKIP] python3 and bun are required"
    exit 0
fi

TMP_ROOT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
WORK="$(mktemp -d "${TMP_ROOT}/loki-run.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$WORK"' EXIT

CMDS="$WORK/commands.txt"
if ! (cd "$REPO_ROOT" && bun -e '
import { REGISTRY, allNames } from "./loki-ts/src/cli/registry.ts";
for (const c of REGISTRY) for (const n of allNames(c)) if (!n.startsWith("-")) console.log(n);
') >"$CMDS" 2>"$WORK/bun.err" || [ ! -s "$CMDS" ]; then
    fail "could not read the command registry: $(head -1 "$WORK/bun.err")"
    echo "  Passed: $PASS  Failed: $FAIL"
    exit 1
fi
pass "registry lists $(wc -l <"$CMDS" | tr -d ' ') names"

# --- Positive controls: planted violations in a temp tree ---------------------
BAD="$WORK/bad"
mkdir -p "$BAD/docs/history" "$BAD/docs/v10" "$BAD/wiki"
{
    echo '# Bad'
    echo 'Run `loki frobnicate-everything` now.'
    echo 'Set LOKI_ENGINE=legacy for the old path.'
    echo 'Introduced in v9.4.2.'
    echo '```bash'
    echo 'loki zzz-not-a-command --flag'
    echo '```'
} >"$BAD/README.md"
cp "$BAD/README.md" "$BAD/docs/history/old.md"
cp "$BAD/README.md" "$BAD/docs/v10/PLAN.md"
echo 'The LOKI_LEGACY_BASH switch and LOKI_SDK_LOOP.' >"$BAD/wiki/Page.md"

python3 "$SCAN" "$BAD" "$CMDS" >"$WORK/bad.out"
for kind in command envvar version; do
    if grep -q "^${kind}	" "$WORK/bad.out"; then pass "control: planted $kind violation caught"; else fail "control: planted $kind violation NOT caught"; fi
done
if grep -q "^command	README.md:6" "$WORK/bad.out"; then pass "control: fenced-block command caught"; else fail "control: fenced-block command NOT caught"; fi
if grep -q "wiki/Page.md:1	LOKI_LEGACY_BASH" "$WORK/bad.out" && grep -q "wiki/Page.md:1	LOKI_SDK_LOOP" "$WORK/bad.out"; then pass "control: wiki dead env vars caught"; else fail "control: wiki dead env vars NOT caught"; fi
if grep -qE "docs/(history|v10)/" "$WORK/bad.out"; then fail "control: excluded paths were scanned"; else pass "control: docs/history and docs/v10 excluded"; fi

GOOD="$WORK/good"
mkdir -p "$GOOD"
{
    echo '# Good'
    echo 'Run `loki doctor` and `loki "fix the bug"` or `loki owner/repo#1`.'
    echo 'Released as v10.2.0.'
    echo '```bash'
    echo 'loki status'
    echo '```'
} >"$GOOD/README.md"
python3 "$SCAN" "$GOOD" "$CMDS" >"$WORK/good.out"
if [ ! -s "$WORK/good.out" ]; then pass "control: clean tree has no findings"; else fail "control: clean tree flagged: $(head -1 "$WORK/good.out")"; fi

# --- Real scan ------------------------------------------------------------------
python3 "$SCAN" "$REPO_ROOT" "$CMDS" >"$WORK/real.out"
total="$(wc -l <"$WORK/real.out" | tr -d ' ')"
for kind in command envvar version; do
    n="$(grep -c "^${kind}	" "$WORK/real.out" || true)"
    echo "  findings ${kind}: ${n}"
done
echo "  findings total: ${total}"

if [ "$total" -gt 0 ]; then
    head -40 "$WORK/real.out" | sed 's/^/    /'
    [ "$total" -gt 40 ] && echo "    ... ($((total - 40)) more)"
    if [ "${LOKI_STALE_ZERO_STRICT:-0}" = "1" ]; then
        fail "stale facts found in docs (strict mode)"
    else
        echo "  [ADVISORY] stale facts present; set LOKI_STALE_ZERO_STRICT=1 to enforce"
    fi
else
    pass "no stale facts in docs"
fi

echo "  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
