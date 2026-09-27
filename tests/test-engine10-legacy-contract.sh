#!/usr/bin/env bash
# E-30 (ENGINE.md section 11): legacy alias contract.
#
# Records today's bin/loki routing as golden rows in
# tests/fixtures/engine10-legacy-routes.txt and asserts the current shim still
# routes each argv shape the same way with LOKI_ENGINE unset. When the default
# flips to v10, `loki legacy <args>` must run exactly the golden route for
# <args>; those assertions report SKIP until bin/loki has a `legacy)` arm.
#
# Method: bin/loki is copied into a scratch repo layout whose autonomy/loki is
# a stub printing "bash|<argv>", LOKI_TS_ENTRY points at a stub entry, and a
# stub `bun` on PATH prints "bun|<entry>|<argv>". No real CLI, no network.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SHIM="${LOKI_E30_SHIM:-$REPO_ROOT/bin/loki}"
FIXTURE="${LOKI_E30_FIXTURE:-$SCRIPT_DIR/fixtures/engine10-legacy-routes.txt}"

PASS=0
FAIL=0
SKIP=0
pass() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf 'SKIP: %s\n' "$1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-e30.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$WORK"' EXIT

mkdir -p "$WORK/repo/bin" "$WORK/repo/autonomy" "$WORK/fakebin" "$WORK/home" "$WORK/cwd"
cp "$SHIM" "$WORK/repo/bin/loki"
chmod +x "$WORK/repo/bin/loki"
cat >"$WORK/repo/autonomy/loki" <<'EOF'
#!/usr/bin/env bash
out="bash"
for a in "$@"; do out="$out|$a"; done
printf '%s\n' "$out"
EOF
cat >"$WORK/fakebin/bun" <<'EOF'
#!/usr/bin/env bash
out="bun"
for a in "$@"; do out="$out|$a"; done
printf '%s\n' "$out"
EOF
chmod +x "$WORK/repo/autonomy/loki" "$WORK/fakebin/bun"
ENTRY="$WORK/entry.ts"
: >"$ENTRY"
# The file-path row needs an existing file in the cwd.
: >"$WORK/cwd/prd.md"

# Resolved from the caller's PATH (macOS ships timeout only via Homebrew).
TIMEOUT_CMD=()
if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_CMD=("$(command -v timeout)" -k 5 20)
fi

# Run the copied shim with a clean env: LOKI_ENGINE, LOKI_LEGACY_BASH,
# LOKI_SDK_*, BUN_FROM_SOURCE and LOKI_PROVIDER all unset.
route_of() {
    (cd "$WORK/cwd" && env -i \
        HOME="$WORK/home" PATH="$WORK/fakebin:/usr/bin:/bin" \
        LOKI_TS_ENTRY="$ENTRY" LOKI_TELEMETRY_DISABLED=true DO_NOT_TRACK=1 \
        ${TIMEOUT_CMD[@]+"${TIMEOUT_CMD[@]}"} "$WORK/repo/bin/loki" "$@" </dev/null 2>/dev/null)
}

# Expected output for a golden row: bash keeps argv as is; bun gets the entry.
expected_of() {
    local route="$1"
    shift
    local out="$route"
    [ "$route" = "bun" ] && out="$out|$ENTRY"
    local a
    for a in "$@"; do out="$out|$a"; done
    printf '%s\n' "$out"
}

if [ ! -f "$FIXTURE" ]; then
    fail "golden fixture missing: $FIXTURE"
    printf 'Results: %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
    exit 1
fi

# The alias lands only when the default flips (ENGINE.md section 11).
ALIAS_ACTIVE=0
grep -Eq '^[[:space:]]*legacy\)' "$SHIM" && ALIAS_ACTIVE=1

rows=0
while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    IFS='|' read -r -a fields <<<"$line"
    route="${fields[0]}"
    args=("${fields[@]:1}")
    rows=$((rows + 1))
    label="loki ${args[*]:-<no args>} -> $route"
    case "$route" in
        bash | bun) ;;
        *) fail "$label (bad route in fixture)"; continue ;;
    esac
    want="$(expected_of "$route" ${args[@]+"${args[@]}"})"
    got="$(route_of ${args[@]+"${args[@]}"})"
    rc=$?
    if [ "$got" = "$want" ] && [ "$rc" -eq 0 ]; then
        pass "$label"
    else
        fail "$label (got '$got' rc=$rc, want '$want' rc=0)"
    fi
    if [ "$ALIAS_ACTIVE" = "1" ]; then
        got="$(route_of legacy ${args[@]+"${args[@]}"})"
        rc=$?
        if [ "$got" = "$want" ] && [ "$rc" -eq 0 ]; then
            pass "legacy alias: $label"
        else
            fail "legacy alias: $label (got '$got' rc=$rc, want '$want' rc=0)"
        fi
    else
        skip "legacy alias: $label (until LOKI_ENGINE defaults to v10)"
    fi
done <"$FIXTURE"

if [ "$rows" -eq 20 ]; then
    pass "fixture holds 20 golden rows"
else
    fail "fixture holds $rows golden rows, want 20"
fi

printf 'Results: %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]
