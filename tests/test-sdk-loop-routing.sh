#!/usr/bin/env bash
# v8 Phase 4 Story 6: bin/loki routes `start` to the Bun RARV loop ONLY when
# LOKI_SDK_LOOP is truthy. Default-off keeps `loki start` on the bash cmd_start.
# We stub `bun` and the bash CLI so nothing actually runs; we only assert WHICH
# route bin/loki chose, by intercepting the exec via a fake bun on PATH and a
# marker printed by a stubbed bash CLI.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Fake bun on PATH: prints a BUN marker + its args, exits 0 (so exec bun ... is
# observable without running the real Bun CLI).
mkdir -p "$WORK/bin"
cat > "$WORK/bin/bun" <<'STUB'
#!/usr/bin/env bash
echo "ROUTE=BUN args=$*"
exit 0
STUB
chmod +x "$WORK/bin/bun"

# Run bin/loki with a controlled PATH (our fake bun first) + a stubbed BASH_CLI.
# bin/loki execs "$BASH_CLI" for the bash route; we point that at a marker script
# by overriding via a copy of bin/loki is overkill -- instead we detect the bash
# route by the ABSENCE of the BUN marker (bin/loki would exec the real
# autonomy/loki which we do NOT want to run). So we short-circuit: set
# LOKI_LEGACY_BASH is NOT what we test; we assert the BUN marker appears only
# when LOKI_SDK_LOOP=1, and that with it unset bin/loki does NOT exec our bun.
# To avoid running the real bash CLI, we stub autonomy/loki via a temp REPO copy.
run_start() {
    # $1 = value for LOKI_SDK_LOOP (empty string = unset)
    local sdk="$1"
    # Build a throwaway repo shim: copy bin/loki, stub BASH_CLI + BUN_CLI targets.
    local root="$WORK/repo"
    rm -rf "$root"; mkdir -p "$root/bin" "$root/autonomy" "$root/loki-ts/dist"
    cp "$REPO_ROOT/bin/loki" "$root/bin/loki"
    # stub bash CLI (autonomy/loki) -> prints BASH marker
    printf '#!/usr/bin/env bash\necho "ROUTE=BASH args=$*"\nexit 0\n' > "$root/autonomy/loki"
    chmod +x "$root/autonomy/loki"
    # stub the Bun dist entry (only reached if bin/loki execs `bun $BUN_CLI`)
    printf '// stub\n' > "$root/loki-ts/dist/loki.js"
    # run with our fake bun first on PATH
    if [ -z "$sdk" ]; then
        PATH="$WORK/bin:$PATH" bash "$root/bin/loki" start ./prd.md 2>/dev/null
    else
        PATH="$WORK/bin:$PATH" LOKI_SDK_LOOP="$sdk" bash "$root/bin/loki" start ./prd.md 2>/dev/null
    fi
}

# 1. default-off (unset) -> BASH route
out="$(run_start "")"
case "$out" in
    *ROUTE=BASH*) ok "default-off: start routes to bash (byte-identical cmd_start)" ;;
    *ROUTE=BUN*)  bad "default-off WRONGLY routed to Bun: $out" ;;
    *) bad "default-off produced no route marker: $out" ;;
esac

# 2. LOKI_SDK_LOOP=1 -> BUN route
out="$(run_start "1")"
case "$out" in
    *ROUTE=BUN*args=*start*) ok "LOKI_SDK_LOOP=1: start routes to Bun ($out)" ;;
    *) bad "LOKI_SDK_LOOP=1 did not route to Bun: $out" ;;
esac

# 3. LOKI_SDK_LOOP=true -> BUN route
out="$(run_start "true")"
case "$out" in
    *ROUTE=BUN*) ok "LOKI_SDK_LOOP=true: start routes to Bun" ;;
    *) bad "LOKI_SDK_LOOP=true did not route to Bun: $out" ;;
esac

# 4. LOKI_SDK_LOOP=1 but LOKI_LEGACY_BASH=1 -> bash wins (legacy override precedes)
out="$(PATH="$WORK/bin:$PATH" LOKI_LEGACY_BASH=1 LOKI_SDK_LOOP=1 bash "$WORK/repo/bin/loki" start ./prd.md 2>/dev/null)"
case "$out" in
    *ROUTE=BASH*) ok "LOKI_LEGACY_BASH=1 wins over LOKI_SDK_LOOP=1 (rollback precedence)" ;;
    *) bad "legacy override did not win: $out" ;;
esac

# 5. a non-start command with LOKI_SDK_LOOP=1 is unaffected (still bash here)
out="$(PATH="$WORK/bin:$PATH" LOKI_SDK_LOOP=1 bash "$WORK/repo/bin/loki" heal ./x 2>/dev/null)"
case "$out" in
    *ROUTE=BASH*) ok "LOKI_SDK_LOOP=1 does not hijack non-start commands" ;;
    *ROUTE=BUN*)  bad "LOKI_SDK_LOOP=1 wrongly routed a non-start command to Bun: $out" ;;
    *) ok "non-start command produced no start-route marker (fell through, acceptable)" ;;
esac

echo ""
echo "Total: $((PASS+FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
