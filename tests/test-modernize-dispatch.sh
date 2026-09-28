#!/usr/bin/env bash
# M-08 (docs/v10/MODERNIZE.md section 2): `loki modernize` must always reach
# the engine10 modernize CLI, whatever LOKI_ENGINE is set to (or unset). Runs
# bin/loki inside a throwaway repo root whose autonomy/loki and `bun` are
# stubs that record argv, so routing is observed without running either CLI.
# Headless: LOKI_NO_BROWSER=1, no network, no real bun/bash invocation.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

T="$(mktemp -d "${TMPDIR:-/tmp}/modernize-dispatch.XXXXXX")"
trap 'rm -rf -- "$T"' EXIT

mkdir -p "$T/root/bin" "$T/root/autonomy" "$T/fakebin" "$T/home" "$T/cwd"
cp "$REPO/bin/loki" "$T/root/bin/loki"
cp "$REPO/autonomy/telemetry.sh" "$T/root/autonomy/telemetry.sh"
printf '#!/usr/bin/env bash\nprintf "BASH %%s\\n" "$*" >"%s/out"\n' "$T" >"$T/root/autonomy/loki"
printf '#!/usr/bin/env bash\nprintf "BUN %%s\\n" "$*" >"%s/out"\n' "$T" >"$T/fakebin/bun"
chmod +x "$T/root/autonomy/loki" "$T/fakebin/bun" "$T/root/bin/loki"
ENTRY="$T/entry.ts"
: >"$ENTRY"

# run_loki <path-prefix> <env...> -- <args...>; prints the recorded route.
run_loki() {
    local path="$1"; shift
    local envs=()
    while [ "$1" != "--" ]; do envs+=("$1"); shift; done
    shift
    rm -f "$T/out"
    (cd "$T/cwd" && env -i HOME="$T/home" PATH="$path" LOKI_TELEMETRY_DISABLED=1 LOKI_NO_BROWSER=1 \
        LOKI_TS_ENTRY="$ENTRY" ${envs[@]+"${envs[@]}"} \
        ${TO[@]+"${TO[@]}"} bash "$T/root/bin/loki" "$@") >"$T/stdout" 2>"$T/stderr"
    echo "$?" >"$T/rc"
    cat "$T/out" 2>/dev/null || true
}

# Resolve timeout before env -i strips PATH (macOS keeps it under Homebrew).
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
TO=()
[ -n "$TIMEOUT_BIN" ] && TO=("$TIMEOUT_BIN" -k 5 20)

WITH_BUN="$T/fakebin:/usr/bin:/bin"
NO_BUN="/usr/bin:/bin"

expect() { # expect <label> <want> <got>
    if [ "$3" = "$2" ]; then ok "$1"; else bad "$1 (want '$2', got '$3')"; fi
}

# 1. Default engine (LOKI_ENGINE unset): modernize still reaches engine10.
expect "[default] modernize repo --to python3 -> engine10" "BUN $ENTRY engine10 modernize repo --to python3" \
    "$(run_loki "$WITH_BUN" -- modernize repo --to python3)"

# 2. LOKI_ENGINE=legacy and LOKI_ENGINE=v9: modernize still reaches engine10
#    even though those values keep every other command on the legacy CLI.
for eng in legacy v9; do
    expect "[LOKI_ENGINE=$eng] other command stays legacy" "BASH fix x" \
        "$(run_loki "$WITH_BUN" "LOKI_ENGINE=$eng" -- "fix x")"
    expect "[LOKI_ENGINE=$eng] modernize -> engine10" "BUN $ENTRY engine10 modernize repo --to python3" \
        "$(run_loki "$WITH_BUN" "LOKI_ENGINE=$eng" -- modernize repo --to python3)"
done

# 3. `loki modernize --help` reaches engine10 and the shim itself exits 0
#    (the modernize CLI's own --help handling returns 0; see modernize/cli.ts).
run_loki "$WITH_BUN" -- modernize --help >/dev/null
expect "[--help] routes to engine10" "BUN $ENTRY engine10 modernize --help" "$(run_loki "$WITH_BUN" -- modernize --help)"
expect "[--help] shim exit 0" "0" "$(cat "$T/rc")"

# 4. An unknown flag still reaches engine10 (the modernize CLI itself rejects
#    it and exits non-zero; the shim's job is only to route, not validate).
#    Simulate the CLI's own rejection by having the bun stub exit 2.
printf '#!/usr/bin/env bash\nprintf "BUN %%s\\n" "$*" >"%s/out"\nexit 2\n' "$T" >"$T/fakebin/bun"
chmod +x "$T/fakebin/bun"
run_loki "$WITH_BUN" -- modernize repo --to python3 --bogus-flag >/dev/null
expect "[unknown flag] routes to engine10" "BUN $ENTRY engine10 modernize repo --to python3 --bogus-flag" \
    "$(run_loki "$WITH_BUN" -- modernize repo --to python3 --bogus-flag)"
expect "[unknown flag] non-zero exit" "2" "$(cat "$T/rc")"

# 5. No bun on PATH: exits 1 with a message, never silently falls back to bash.
if PATH="$NO_BUN" command -v bun >/dev/null 2>&1; then
    bad "no-bun case needs a PATH without bun ($NO_BUN has one)"
else
    got="$(run_loki "$NO_BUN" -- modernize repo --to python3)"
    expect "[no bun] exit 1" "1" "$(cat "$T/rc")"
    expect "[no bun] nothing ran" "" "$got"
    if grep -q 'needs bun' "$T/stderr"; then ok "[no bun] message"; else bad "[no bun] message missing: $(cat "$T/stderr")"; fi
fi

# 6. modernize appears in bin/loki only in its own dispatch arm.
n="$(grep -c 'modernize' "$REPO/bin/loki")"
if [ "$n" -ge 1 ]; then ok "bin/loki: modernize arm present ($n mention(s))"; else bad "bin/loki: no modernize arm found"; fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
