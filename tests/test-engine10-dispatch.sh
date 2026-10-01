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

# 1. D48 flip: LOKI_ENGINE unset routes the three entry points to engine10 and everything else as before.
expect "[unset] 'fix x' -> engine10" "BUN $ENTRY engine10 fix x" "$(run_loki "$WITH_BUN" -- "fix x")"
expect "[unset] owner/repo#3 -> engine10" "BUN $ENTRY engine10 owner/repo#3" "$(run_loki "$WITH_BUN" -- "owner/repo#3")"
expect "[unset] https issue url -> engine10" "BUN $ENTRY engine10 https://github.com/o/r/issues/7" \
    "$(run_loki "$WITH_BUN" -- "https://github.com/o/r/issues/7")"
expect "[unset] quick 'fix x' -> engine10 --no-pr" "BUN $ENTRY engine10 --no-pr fix x" "$(run_loki "$WITH_BUN" -- quick "fix x")"
expect "[unset] quick --help stays legacy" "BASH quick --help" "$(run_loki "$WITH_BUN" -- quick --help)"
expect "[unset] bare quick stays legacy" "BASH quick" "$(run_loki "$WITH_BUN" -- quick)"
expect "[unset] status -> bun cli (not engine10)" "BUN $ENTRY status" "$(run_loki "$WITH_BUN" -- status)"
expect "[unset] start -> bash" "BASH start" "$(run_loki "$WITH_BUN" -- start)"
expect "[unset] no bun falls back to legacy, no error" "BASH fix x" "$(run_loki "$NO_BUN" -- "fix x")"
expect "[unset] provider without an invoker -> legacy" "BASH fix x" "$(run_loki "$WITH_BUN" LOKI_PROVIDER=opencode -- "fix x")"
expect "[unset] LOKI_LEGACY_BASH=1 -> bash" "BASH quick fix x" "$(run_loki "$WITH_BUN" LOKI_LEGACY_BASH=1 -- quick "fix x")"

# 1b. Escape hatches: LOKI_ENGINE=legacy (and any non-v10 value) and `loki legacy` run the previous engine.
for eng in "LOKI_ENGINE=legacy" "LOKI_ENGINE=v9"; do
    expect "[$eng] 'fix x' -> bash" "BASH fix x" "$(run_loki "$WITH_BUN" "$eng" -- "fix x")"
    expect "[$eng] owner/repo#3 -> bash" "BASH owner/repo#3" "$(run_loki "$WITH_BUN" "$eng" -- "owner/repo#3")"
    expect "[$eng] quick 'fix x' -> bash" "BASH quick fix x" "$(run_loki "$WITH_BUN" "$eng" -- quick "fix x")"
    expect "[$eng] status -> bun cli" "BUN $ENTRY status" "$(run_loki "$WITH_BUN" "$eng" -- status)"
done
expect "[legacy alias] 'fix x' -> bash" "BASH fix x" "$(run_loki "$WITH_BUN" -- legacy "fix x")"
expect "[legacy alias] owner/repo#3 -> bash" "BASH owner/repo#3" "$(run_loki "$WITH_BUN" -- legacy "owner/repo#3")"
expect "[legacy alias] quick 'fix x' -> bash" "BASH quick fix x" "$(run_loki "$WITH_BUN" -- legacy quick "fix x")"
expect "[legacy alias] with LOKI_ENGINE=v10 set still -> bash" "BASH fix x" "$(run_loki "$WITH_BUN" LOKI_ENGINE=v10 -- legacy "fix x")"

# 2. LOKI_ENGINE=v10: tasks, issue refs, status, verify, dashboard reach engine10.
for a in "fix x" "owner/repo#12" "https://github.com/o/r/issues/7" \
    "https://gitlab.com/g/p/-/issues/4" "https://x.atlassian.net/browse/AB-1" status verify dashboard; do
    expect "[v10] '$a' -> engine10" "BUN $ENTRY engine10 $a" "$(run_loki "$WITH_BUN" LOKI_ENGINE=v10 -- "$a")"
done
expect "[v10] status run-1 keeps args" "BUN $ENTRY engine10 status run-1" \
    "$(run_loki "$WITH_BUN" LOKI_ENGINE=v10 -- status run-1)"
expect "[v10] single word stays legacy" "BASH refactorize" \
    "$(run_loki "$WITH_BUN" LOKI_ENGINE=v10 -- refactorize)"

# Legacy commands and existing paths fall through unchanged under v10.
for w in estimate intent outcomes; do
    expect "[v10] legacy $w stays legacy" "BASH $w" "$(run_loki "$WITH_BUN" LOKI_ENGINE=v10 -- "$w")"
done
expect "[v10] start -> bash" "BASH start" "$(run_loki "$WITH_BUN" LOKI_ENGINE=v10 -- start)"
expect "[v10] --help -> bash" "BASH --help" "$(run_loki "$WITH_BUN" LOKI_ENGINE=v10 -- --help)"
: >"$T/cwd/prd.md"
expect "[v10] existing file prd.md -> bash" "BASH prd.md" "$(run_loki "$WITH_BUN" LOKI_ENGINE=v10 -- prd.md)"

# 3. LOKI_LEGACY_BASH=1 still wins.
expect "[v10+legacy] status -> bash" "BASH status" \
    "$(run_loki "$WITH_BUN" LOKI_ENGINE=v10 LOKI_LEGACY_BASH=1 -- status)"
expect "[v10+legacy] 'fix x' -> bash" "BASH fix x" \
    "$(run_loki "$WITH_BUN" LOKI_ENGINE=v10 LOKI_LEGACY_BASH=1 -- "fix x")"

# 4. No bun plus v10: exit 1 with the message; nothing ran.
if PATH="$NO_BUN" command -v bun >/dev/null 2>&1; then
    bad "no-bun case needs a PATH without bun ($NO_BUN has one)"
else
    got="$(run_loki "$NO_BUN" LOKI_ENGINE=v10 -- "fix x")"
    expect "[v10 no bun] exit 1" "1" "$(cat "$T/rc")"
    expect "[v10 no bun] nothing ran" "" "$got"
    if grep -q 'LOKI_ENGINE=v10 needs bun' "$T/stderr"; then ok "[v10 no bun] message"; else bad "[v10 no bun] message missing: $(cat "$T/stderr")"; fi
    # Unset engine without bun keeps today's silent bash fallback.
    expect "[unset no bun] 'fix x' -> bash" "BASH fix x" "$(run_loki "$NO_BUN" -- "fix x")"
fi

# 5. engine10 appears only in the one cli.ts arm (and the one bin/loki block):
#    the case line plus its two lazy imports (cli.ts, and E-32's registry.ts).
cli="$REPO/loki-ts/src/cli.ts"
hits="$(grep -n 'engine10' "$cli" | cut -d: -f1 | tr '\n' ' ')"
arm="$(grep -n 'case "engine10": {' "$cli" | cut -d: -f1)"
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
#    the modernize) arm (M-08) and the LOKI_ENGINE=v10 block (D29) -- never a
#    stray third exec line anywhere else in the file. Anchored on the arms'
#    own text, not line numbers, so edits elsewhere in the file don't rot it.
BIN="$REPO/bin/loki"
EXEC_PAT='exec bun "$BUN_CLI" engine10'
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
v10_start="$(grep -nF '# Loki 10 engine (D29, flipped' "$BIN" | head -1 | cut -d: -f1)" # D48: the block is a case now; bounded by its trailing unset line
if [ -n "$mod_start" ] && [ -n "$v10_start" ]; then
    mod_end="$(find_fi "$mod_start")"
    v10_end="$(grep -nF 'unset _e10 _e10_args' "$BIN" | head -1 | cut -d: -f1)"
    total="$(grep -cF "$EXEC_PAT" "$BIN")"
    mod_hits="$(sed -n "${mod_start},${mod_end}p" "$BIN" | grep -cF "$EXEC_PAT")"
    v10_hits="$(sed -n "${v10_start},${v10_end}p" "$BIN" | grep -cF "$EXEC_PAT")"
    expect "bin/loki: exactly 2 engine10 exec lines total" "2" "$total"
    expect "bin/loki: modernize) arm has its own engine10 exec" "1" "$mod_hits"
    expect "bin/loki: LOKI_ENGINE=v10 block has its own engine10 exec" "1" "$v10_hits"
else
    bad "bin/loki: could not locate the modernize) arm or the LOKI_ENGINE=v10 block"
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
