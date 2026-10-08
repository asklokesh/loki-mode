#!/usr/bin/env bash
# tests/test-sigpipe-guard.sh - FC-63 (NR-PIPE): `echo "$big" | grep -q` under
# pipefail fails with "echo: write error: Broken pipe" once the captured output
# outgrows the pipe buffer, because grep -q exits at the first match.
# Section 1 proves the mechanism deterministically; section 2 enforces the
# here-string form in the onboard family; section 3 ratchets the repo-wide count.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TESTS_DIR="${SIGPIPE_GUARD_TESTS_DIR:-$SCRIPT_DIR}"
# Repo-wide ceiling of the legacy pipe form in suites that set pipefail.
# Lower it when you convert a suite; never raise it.
CEILING="${SIGPIPE_GUARD_CEILING:-1789}"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

# The legacy form: echo/printf of a variable piped into grep -q.
PATTERN='(echo|printf)[^|]*\$[{A-Za-z_][^|]*\| *grep +-[A-Za-z]*q'

echo "=== sigpipe guard (FC-63) ==="

# 1. Mechanism: a ~400KB captured value, legacy pipe form vs here-string form.
big="$(yes 'npm line of onboard output' | head -n 15000)"
(
    set -o pipefail
    echo "$big" | grep -q "npm" 2>/dev/null
)
legacy_rc=$?
(
    set -o pipefail
    grep -q "npm" <<<"$big"
)
herestr_rc=$?
if [ "$legacy_rc" -ne 0 ]; then ok "legacy pipe form fails on a large value (rc=$legacy_rc)"; else bad "legacy pipe form unexpectedly passed; mechanism not reproduced"; fi
if [ "$herestr_rc" -eq 0 ]; then ok "here-string form passes on the same value"; else bad "here-string form failed (rc=$herestr_rc)"; fi

# 2. The onboard family (large-output command) must not use the legacy form.
onboard_hits=0
for f in "$TESTS_DIR"/test-onboard-*.sh; do
    [ -f "$f" ] || continue
    n=$(grep -cE "$PATTERN" "$f" || true)
    if [ "${n:-0}" -gt 0 ]; then
        onboard_hits=$((onboard_hits + n))
        bad "$(basename "$f"): $n legacy pipe-to-grep-q line(s); use grep -q ... <<<\"\$var\""
    fi
done
[ "$onboard_hits" -eq 0 ] && ok "onboard family uses here-strings only"

# 3. Repo-wide ratchet over suites that set pipefail.
total=0
for f in "$TESTS_DIR"/*.sh; do
    [ "$(basename "$f")" = "test-sigpipe-guard.sh" ] && continue
    grep -q "pipefail" "$f" || continue
    n=$(grep -cE "$PATTERN" "$f" || true)
    total=$((total + ${n:-0}))
done
if [ "$total" -le "$CEILING" ]; then ok "legacy form count $total <= ceiling $CEILING"; else bad "legacy form count $total exceeds ceiling $CEILING; use here-strings in new tests"; fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
