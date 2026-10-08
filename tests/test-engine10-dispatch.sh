#!/usr/bin/env bash
# E-12 (ENGINE.md section 11): bin/loki dispatch hook for the Loki 10 engine.
# Runs bin/loki inside a throwaway repo root whose autonomy/loki and `bun` are
# stubs that record argv, so every route is observed without running either CLI.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

T="$(mktemp -d "${TMPDIR:-/tmp}/e10-dispatch.XXXXXX")"
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
    (cd "$T/cwd" && env -i HOME="$T/home" PATH="$path" LOKI_TELEMETRY_DISABLED=1 \
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

# 1. LOKI_ENGINE is gone: the default routes the three entry points to engine10 and everything else as before.
expect "'fix x' -> engine10" "BUN $ENTRY engine10 fix x" "$(run_loki "$WITH_BUN" -- "fix x")"
expect "owner/repo#3 -> engine10" "BUN $ENTRY engine10 owner/repo#3" "$(run_loki "$WITH_BUN" -- "owner/repo#3")"
expect "https issue url -> engine10" "BUN $ENTRY engine10 https://github.com/o/r/issues/7" \
    "$(run_loki "$WITH_BUN" -- "https://github.com/o/r/issues/7")"
expect "quick 'fix x' -> engine10 --no-pr" "BUN $ENTRY engine10 --no-pr fix x" "$(run_loki "$WITH_BUN" -- quick "fix x")"
expect "quick --help stays legacy" "BASH quick --help" "$(run_loki "$WITH_BUN" -- quick --help)"
expect "bare quick stays legacy" "BASH quick" "$(run_loki "$WITH_BUN" -- quick)"
expect "status -> bun cli (not engine10)" "BUN $ENTRY status" "$(run_loki "$WITH_BUN" -- status)"
expect "start -> bash" "BASH start" "$(run_loki "$WITH_BUN" -- start)"
expect "start owner/repo#1 --no-pr -> engine10" "BUN $ENTRY engine10 owner/repo#1 --no-pr" "$(run_loki "$WITH_BUN" -- start owner/repo#1 --no-pr)"
expect "start issue URL -> engine10" "BUN $ENTRY engine10 https://github.com/o/r/issues/2" "$(run_loki "$WITH_BUN" -- start https://github.com/o/r/issues/2)"
expect "start 'fix x' -> engine10" "BUN $ENTRY engine10 fix x" "$(run_loki "$WITH_BUN" -- start "fix x")"
expect "start prd.md stays legacy" "BASH start prd.md" "$(run_loki "$WITH_BUN" -- start prd.md)"
expect "start --help stays legacy" "BASH start --help" "$(run_loki "$WITH_BUN" -- start --help)"
# FC-38 (scoped): plain start stays on bash as in 11.3.0; only --attempts is pinned to the engine10 path.
expect "start --attempts 2 --no-pr -> Bun start, never bash" "BUN $ENTRY start --attempts 2 --no-pr" "$(run_loki "$WITH_BUN" -- start --attempts 2 --no-pr)"
expect "start --attempts=3 -> Bun start" "BUN $ENTRY start --attempts=3" "$(run_loki "$WITH_BUN" -- start --attempts=3)"
expect "start --attempts 2 without bun is refused, no bash" "" "$(run_loki "$NO_BUN" -- start --attempts 2 --no-pr)"
expect "start --attempts 2 without bun exits 1" "1" "$(cat "$T/rc")"
# The bun resolver probes `bun --version`; only a start/autonomy route counts as reaching a loop.
route_of() { printf '%s' "$1" | grep -v -e '^BUN --version$' || true; }
expect "start --attempts 2 --no-pr with opencode is refused, no route" "" "$(route_of "$(run_loki "$WITH_BUN" LOKI_PROVIDER=opencode -- start --attempts 2 --no-pr)")"
expect "start --attempts 2 --no-pr with opencode exits 2" "2" "$(cat "$T/rc")"
expect "start --attempts 2 --parallel is refused, no route" "" "$(route_of "$(run_loki "$WITH_BUN" -- start --attempts 2 --no-pr --parallel)")"
expect "start --attempts 2 --parallel exits 2" "2" "$(cat "$T/rc")"
expect "start --attempts 2 bad provider is refused" "" "$(run_loki "$WITH_BUN" LOKI_PROVIDER=gemini -- start --attempts 2 --no-pr)"
expect "start --attempts with missing TS entry is refused, no bash" "" "$(run_loki "$WITH_BUN" LOKI_TS_ENTRY="$T/nope.ts" -- start --attempts 2 --no-pr)"
expect "plain start with opencode stays bash (11.3.0)" "BASH start prd.md" "$(run_loki "$WITH_BUN" LOKI_PROVIDER=opencode -- start prd.md)"
expect "no bun falls back to legacy, no error" "BASH fix x" "$(run_loki "$NO_BUN" -- "fix x")"
expect "provider without an invoker -> legacy" "BASH fix x" "$(run_loki "$WITH_BUN" LOKI_PROVIDER=opencode -- "fix x")"
expect "LOKI_LEGACY_BASH=1 -> bash" "BASH quick fix x" "$(run_loki "$WITH_BUN" LOKI_LEGACY_BASH=1 -- quick "fix x")"

# 1b. `loki legacy` is removed (11.0.0): a removal message, exit 2, nothing ran. LOKI_ENGINE is no longer read, whatever its value.
got="$(run_loki "$WITH_BUN" -- legacy "fix x")"
expect "[legacy removed] nothing ran" "" "$got"
expect "[legacy removed] exit 2" "2" "$(cat "$T/rc")"
if grep -q "was removed in Loki Mode 11.0.0" "$T/stderr"; then ok "[legacy removed] message"; else bad "[legacy removed] message missing: $(cat "$T/stderr")"; fi
for eng in "LOKI_ENGINE=legacy" "LOKI_ENGINE=v9" "LOKI_ENGINE=v10"; do
    expect "[$eng ignored] 'fix x' -> engine10" "BUN $ENTRY engine10 fix x" "$(run_loki "$WITH_BUN" "$eng" -- "fix x")"
    expect "[$eng ignored] quick 'fix x' -> engine10" "BUN $ENTRY engine10 --no-pr fix x" "$(run_loki "$WITH_BUN" "$eng" -- quick "fix x")"
    expect "[$eng ignored] status -> bun cli" "BUN $ENTRY status" "$(run_loki "$WITH_BUN" "$eng" -- status)"
done

# 2. Issue refs and keys reach engine10; verify --pubkey (any position) reaches engine10.
for a in "owner/repo#12" "https://github.com/o/r/issues/7" \
    "https://gitlab.com/g/p/-/issues/4" "https://x.atlassian.net/browse/AB-1"; do
    expect "'$a' -> engine10" "BUN $ENTRY engine10 $a" "$(run_loki "$WITH_BUN" -- "$a")"
done
expect "keys -> engine10" "BUN $ENTRY engine10 keys export" "$(run_loki "$WITH_BUN" -- keys export)"
expect "verify --pubkey -> engine10" "BUN $ENTRY engine10 verify r.json --pubkey k.pem" "$(run_loki "$WITH_BUN" -- verify r.json --pubkey k.pem)"
expect "verify --pubkey=K first -> engine10" "BUN $ENTRY engine10 verify --pubkey=k.pem r.json" "$(run_loki "$WITH_BUN" -- verify --pubkey=k.pem r.json)"
expect "single word stays legacy" "BASH refactorize" "$(run_loki "$WITH_BUN" -- refactorize)"

# 2b. Default engine: bare verify follows a v10 run only when it has no args or an e10-* id; flags stay legacy.
mkdir -p "$T/cwd/.loki/runs/e10-20260101T000000Z-aa"
expect "[unset+run] bare verify -> engine10" "BUN $ENTRY engine10 verify" "$(run_loki "$WITH_BUN" -- verify)"
expect "[unset+run] verify e10-id -> engine10" "BUN $ENTRY engine10 verify e10-20260101T000000Z-aa" "$(run_loki "$WITH_BUN" -- verify e10-20260101T000000Z-aa)"
for a in "--fast ." "--pr" "--json" "--no-such-flag"; do
    # shellcheck disable=SC2086
    expect "[unset+run] verify $a -> legacy" "BASH verify $a" "$(run_loki "$WITH_BUN" -- verify $a)"
done
rm -rf "$T/cwd/.loki"

# Legacy commands and existing paths fall through unchanged.
for w in estimate intent outcomes; do
    expect "legacy $w stays legacy" "BASH $w" "$(run_loki "$WITH_BUN" -- "$w")"
done
expect "--help -> bash" "BASH --help" "$(run_loki "$WITH_BUN" -- --help)"
: >"$T/cwd/prd.md"
expect "existing file prd.md -> bash" "BASH prd.md" "$(run_loki "$WITH_BUN" -- prd.md)"

# 3. LOKI_LEGACY_BASH=1 still wins.
expect "[LEGACY_BASH] status -> bash" "BASH status" "$(run_loki "$WITH_BUN" LOKI_LEGACY_BASH=1 -- status)"
expect "[LEGACY_BASH] 'fix x' -> bash" "BASH fix x" "$(run_loki "$WITH_BUN" LOKI_LEGACY_BASH=1 -- "fix x")"

# 4. No bun: keys (a hard route) exits 1 with the message and nothing ran.
if PATH="$NO_BUN" command -v bun >/dev/null 2>&1; then
    bad "no-bun case needs a PATH without bun ($NO_BUN has one)"
else
    got="$(run_loki "$NO_BUN" -- keys export)"
    expect "[keys no bun] exit 1" "1" "$(cat "$T/rc")"
    expect "[keys no bun] nothing ran" "" "$got"
    if grep -q 'the Loki 10 engine needs bun' "$T/stderr"; then ok "[keys no bun] message"; else bad "[keys no bun] message missing: $(cat "$T/stderr")"; fi
    # A task without bun keeps today's silent bash fallback.
    expect "[no bun] 'fix x' -> bash" "BASH fix x" "$(run_loki "$NO_BUN" -- "fix x")"
fi

# 5. engine10 appears only in the one cli.ts arm (and the one bin/loki block):
#    the case line plus its two lazy imports (cli.ts, and E-32's registry.ts).
cli="$REPO/loki-ts/src/cli.ts"
#    The HELP row documenting the command (PO4-CLI-TS-HELP) is text, not routing.
help_re='^[[:space:]]*engine10 <subcmd>[[:space:]]'
help_n="$(grep -cE "$help_re" "$cli")"
hits="$(grep -n 'engine10' "$cli" | grep -vE "^[0-9]+:${help_re#^}" | cut -d: -f1 | tr '\n' ' ')"
arm="$(grep -n 'case "engine10": {' "$cli" | cut -d: -f1)"
expect "cli.ts: exactly one engine10 HELP row" "1" "$help_n"
if [ -n "$arm" ] && [ "$hits" = "$arm $((arm + 1)) $((arm + 2)) " ]; then
    ok "cli.ts: engine10 only in its arm (lines $hits)"
else
    bad "cli.ts: engine10 outside the arm (lines '$hits', arm '$arm')"
fi
if grep -q 'const { runEngine10 } = await import("./engine10/cli.ts");' "$cli"; then
    ok "cli.ts arm imports lazily"
else
    bad "cli.ts arm lazy import missing"
fi
# 6. bin/loki: engine10 is reached only through its two known exec arms --
#    the modernize) arm (M-08) and the engine block (D29) -- never a
#    stray third exec line anywhere else in the file. Anchored on the arms'
#    own text, not line numbers, so edits elsewhere in the file don't rot it.
BIN="$REPO/bin/loki"
EXEC_PAT='exec "$_lb" "$BUN_CLI" engine10'
# find_fi <start-line>: the depth-aware matching "fi" for the "if" at start-line.
find_fi() {
    awk -v s="$1" '
        NR < s { next }
        {
            if ($0 ~ /^[[:space:]]*if[[:space:]]/) depth++
            if ($0 ~ /^[[:space:]]*fi([[:space:]]|$)/) {
                depth--
                if (depth == 0) { print NR; exit }
            }
        }' "$BIN"
}
mod_start="$(grep -nF 'if [ "${1:-}" = "modernize" ]; then' "$BIN" | head -1 | cut -d: -f1)"
v10_start="$(grep -nF '# Loki 10 engine (D29, the only engine' "$BIN" | head -1 | cut -d: -f1)" # D48: the block is a case now; bounded by its trailing unset line
if [ -n "$mod_start" ] && [ -n "$v10_start" ]; then
    mod_end="$(find_fi "$mod_start")"
    v10_end="$(grep -nF 'unset _e10 _e10_args' "$BIN" | head -1 | cut -d: -f1)"
    total="$(grep -cF "$EXEC_PAT" "$BIN")"
    mod_hits="$(sed -n "${mod_start},${mod_end}p" "$BIN" | grep -cF "$EXEC_PAT")"
    v10_hits="$(sed -n "${v10_start},${v10_end}p" "$BIN" | grep -cF "$EXEC_PAT")"
    expect "bin/loki: exactly 2 engine10 exec lines total" "2" "$total"
    expect "bin/loki: modernize) arm has its own engine10 exec" "1" "$mod_hits"
    expect "bin/loki: engine block has its own engine10 exec" "1" "$v10_hits"
else
    bad "bin/loki: could not locate the modernize) arm or the engine block"
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
