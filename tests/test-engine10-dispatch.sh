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

# 1. Every entry point routes to engine10 (D57); nothing routes to a previous engine.
expect "'fix x' -> engine10" "BUN $ENTRY engine10 fix x" "$(run_loki "$WITH_BUN" -- "fix x")"
expect "owner/repo#3 -> engine10" "BUN $ENTRY engine10 owner/repo#3" "$(run_loki "$WITH_BUN" -- "owner/repo#3")"
expect "https issue url -> engine10" "BUN $ENTRY engine10 https://github.com/o/r/issues/7" \
    "$(run_loki "$WITH_BUN" -- "https://github.com/o/r/issues/7")"
expect "flag-first --no-pr 'fix x' -> engine10" "BUN $ENTRY engine10 --no-pr fix x" "$(run_loki "$WITH_BUN" -- --no-pr "fix x")"
expect "quick 'fix x' -> engine10 --no-pr" "BUN $ENTRY engine10 --no-pr fix x" "$(run_loki "$WITH_BUN" -- quick "fix x")"
expect "quick --no-pr 'fix x' -> engine10" "BUN $ENTRY engine10 --no-pr --no-pr fix x" "$(run_loki "$WITH_BUN" -- quick --no-pr "fix x")"
expect "quick --help -> engine10 --help" "BUN $ENTRY engine10 --help" "$(run_loki "$WITH_BUN" -- quick --help)"
expect "start 'fix x' -> engine10" "BUN $ENTRY engine10 fix x" "$(run_loki "$WITH_BUN" -- start "fix x")"
expect "start owner/repo#3 -> engine10" "BUN $ENTRY engine10 owner/repo#3" "$(run_loki "$WITH_BUN" -- start "owner/repo#3")"
expect "start owner/repo#1 --no-pr -> engine10 with the flag" "BUN $ENTRY engine10 owner/repo#1 --no-pr" "$(run_loki "$WITH_BUN" -- start "owner/repo#1" --no-pr)"
expect "start --no-pr owner/repo#1 -> engine10 with the flag" "BUN $ENTRY engine10 --no-pr owner/repo#1" "$(run_loki "$WITH_BUN" -- start --no-pr "owner/repo#1")"
expect "owner/repo#1 --no-pr -> engine10 (unchanged)" "BUN $ENTRY engine10 owner/repo#1 --no-pr" "$(run_loki "$WITH_BUN" -- "owner/repo#1" --no-pr)"
expect "run owner/repo#3 -> engine10" "BUN $ENTRY engine10 owner/repo#3" "$(run_loki "$WITH_BUN" -- run "owner/repo#3")"
expect "start --provider=codex 'fix x' -> engine10" "BUN $ENTRY engine10 --provider codex fix x" \
    "$(run_loki "$WITH_BUN" -- start --provider=codex "fix x")"
: >"$T/cwd/prd.md"
expect "start prd.md -> engine10" "BUN $ENTRY engine10 prd.md" "$(run_loki "$WITH_BUN" -- start prd.md)"
mkdir -p "$T/cwd/sub"; : >"$T/cwd/sub/task.yaml"; : >"$T/cwd/task.txt"
expect "loki ./prd.md -> engine10" "BUN $ENTRY engine10 ./prd.md" "$(run_loki "$WITH_BUN" -- ./prd.md)"
expect "start ./prd.md -> engine10" "BUN $ENTRY engine10 ./prd.md" "$(run_loki "$WITH_BUN" -- start ./prd.md)"
expect "loki sub/task.yaml -> engine10" "BUN $ENTRY engine10 sub/task.yaml" "$(run_loki "$WITH_BUN" -- sub/task.yaml)"
expect "loki task.txt -> engine10" "BUN $ENTRY engine10 task.txt" "$(run_loki "$WITH_BUN" -- task.txt)"
expect "loki prd.md -> engine10" "BUN $ENTRY engine10 prd.md" "$(run_loki "$WITH_BUN" -- prd.md)"
expect "a missing prd.md stays a bash command word" "BASH nosuch.md" "$(run_loki "$WITH_BUN" -- nosuch.md)"
expect "status -> bun cli (not engine10)" "BUN $ENTRY status" "$(run_loki "$WITH_BUN" -- status)"
expect "single word stays bash" "BASH refactorize" "$(run_loki "$WITH_BUN" -- refactorize)"
expect "LOKI_ENGINE is ignored" "BUN $ENTRY engine10 fix x" "$(run_loki "$WITH_BUN" LOKI_ENGINE=legacy -- "fix x")"
expect "loki legacy is not a route" "BASH legacy fix x" "$(run_loki "$WITH_BUN" -- legacy "fix x")"
# The hidden engine10 form internal callers use.
expect "engine10 status run-1 keeps args" "BUN $ENTRY engine10 status run-1" "$(run_loki "$WITH_BUN" -- engine10 status run-1)"
expect "engine10 dashboard" "BUN $ENTRY engine10 dashboard" "$(run_loki "$WITH_BUN" -- engine10 dashboard)"

# 1b. Routes with no v10 equivalent exit 2 with one line and run nothing.
for a in "start" "run" "quick" "quickstart" "start --parallel x" "start --bg x" "run --openspec x" "quick --yolo x" \
    "start 123" "start PROJ-456" "start ./my-project" "run refactorize"; do
    # shellcheck disable=SC2086
    got="$(run_loki "$WITH_BUN" -- $a)"
    expect "[$a] exit 2" "2" "$(cat "$T/rc")"
    expect "[$a] nothing ran" "" "$got"
    expect "[$a] one plain line" "1" "$(wc -l <"$T/stderr" | tr -d ' ')"
    grep -q 'was removed in 10.6.0; use loki "<task>"' "$T/stderr" && ok "[$a] names the v10 alternative" || bad "[$a] message: $(cat "$T/stderr")"
done
got="$(run_loki "$WITH_BUN" -- start ./missing.md)"
expect "[start ./missing.md] exit 2" "2" "$(cat "$T/rc")"
expect "[start ./missing.md] nothing ran" "" "$got"
grep -q 'missing.md not found' "$T/stderr" && ok "[start ./missing.md] says not found" || bad "[start ./missing.md] message: $(cat "$T/stderr")"
expect "quick with a one-word task still routes" "BUN $ENTRY engine10 --no-pr refactorize" "$(run_loki "$WITH_BUN" -- quick refactorize)"
expect "start with two bare words routes as one task" "BUN $ENTRY engine10 fix bug" "$(run_loki "$WITH_BUN" -- start fix bug)"
expect "provider without an invoker -> exit 2" "2" "$(run_loki "$WITH_BUN" LOKI_PROVIDER=opencode -- "fix x" >/dev/null; cat "$T/rc")"
expect "LOKI_LEGACY_BASH=1 -> bash CLI" "BASH status" "$(run_loki "$WITH_BUN" LOKI_LEGACY_BASH=1 -- status)"

# 2. Bare verify follows a v10 run only when it has no args or an e10-* id; flags stay on the bash verify.
mkdir -p "$T/cwd/.loki/runs/e10-20260101T000000Z-aa"
expect "[run] bare verify -> engine10" "BUN $ENTRY engine10 verify" "$(run_loki "$WITH_BUN" -- verify)"
expect "[run] verify e10-id -> engine10" "BUN $ENTRY engine10 verify e10-20260101T000000Z-aa" "$(run_loki "$WITH_BUN" -- verify e10-20260101T000000Z-aa)"
for a in "--fast ." "--pr" "--json" "--no-such-flag"; do
    # shellcheck disable=SC2086
    expect "[run] verify $a -> bash" "BASH verify $a" "$(run_loki "$WITH_BUN" -- verify $a)"
done
rm -rf "$T/cwd/.loki"

# 3. No bun: one plain error line plus the fix, exit 1, nothing ran, never a legacy fallback.
if PATH="$NO_BUN" command -v bun >/dev/null 2>&1; then
    bad "no-bun case needs a PATH without bun ($NO_BUN has one)"
else
    for a in "fix x" "owner/repo#3"; do
        got="$(run_loki "$NO_BUN" -- "$a")"
        expect "[no bun] '$a' exit 1" "1" "$(cat "$T/rc")"
        expect "[no bun] '$a' nothing ran" "" "$got"
        expect "[no bun] '$a' one line" "1" "$(wc -l <"$T/stderr" | tr -d ' ')"
        grep -q '^loki: the Loki 10 engine cannot run on this machine: no working bun (.*)\. To fix: reinstall with npm install -g loki-mode (it includes bun), or install bun from https://bun.sh\.$' "$T/stderr" \
            && ok "[no bun] '$a' message" || bad "[no bun] '$a' message: $(cat "$T/stderr")"
    done
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
#    the modernize) arm (M-08) and the engine block (D57) -- never a
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
v10_start="$(grep -nF '# Loki 10 is the only engine (D57)' "$BIN" | head -1 | cut -d: -f1)"
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
