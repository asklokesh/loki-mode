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
printf '#!/usr/bin/env bash\na="$*"; a="${a#--no-env-file --config=/dev/null }"; printf "BUN %%s\\n" "$a" >"%s/out"\n' "$T" >"$T/fakebin/bun"
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
expect "start --attempts 2 --no-pr with opencode -> Bun start (engine10 supports opencode)" "BUN $ENTRY start --attempts 2 --no-pr" "$(route_of "$(run_loki "$WITH_BUN" LOKI_PROVIDER=opencode -- start --attempts 2 --no-pr)")"
expect "start --attempts 2 --no-pr with opencode exits 0" "0" "$(cat "$T/rc")"
expect "start --attempts 2 --parallel is refused, no route" "" "$(route_of "$(run_loki "$WITH_BUN" -- start --attempts 2 --no-pr --parallel)")"
expect "start --attempts 2 --parallel exits 2" "2" "$(cat "$T/rc")"
expect "start --attempts 2 bad provider is refused" "" "$(run_loki "$WITH_BUN" LOKI_PROVIDER=gemini -- start --attempts 2 --no-pr)"
expect "start --attempts with missing TS entry is refused, no bash" "" "$(run_loki "$WITH_BUN" LOKI_TS_ENTRY="$T/nope.ts" -- start --attempts 2 --no-pr)"
expect "start 'fix x' --budget 5 stays as typed (11.3.0)" "BUN $ENTRY engine10 fix x --budget 5" "$(run_loki "$WITH_BUN" -- start "fix x" --budget 5)"
expect "start 'fix x' --attempts 1 --budget 5 -> --max-cost" "BUN $ENTRY engine10 fix x --max-cost 5" "$(run_loki "$WITH_BUN" -- start "fix x" --attempts 1 --budget 5)"
expect "plain start with opencode stays bash (11.3.0)" "BASH start prd.md" "$(run_loki "$WITH_BUN" LOKI_PROVIDER=opencode -- start prd.md)"
expect "no bun falls back to legacy, no error" "BASH fix x" "$(run_loki "$NO_BUN" -- "fix x")"
expect "opencode has an engine10 invoker -> engine10" "BUN $ENTRY engine10 fix x" "$(run_loki "$WITH_BUN" LOKI_PROVIDER=opencode -- "fix x")"
expect "provider without an invoker is refused, no route" "" "$(run_loki "$WITH_BUN" LOKI_PROVIDER=gemini -- "fix x")"
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
for w in intent outcomes; do
    expect "legacy $w stays legacy" "BASH $w" "$(run_loki "$WITH_BUN" -- "$w")"
done
# 11.9.0 ESTIMATE-ONE: `loki estimate` runs the Bun estimate, the same one `loki start` shows.
expect "estimate routes to bun" "BUN $ENTRY estimate" "$(run_loki "$WITH_BUN" -- estimate)"
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

# 4b. T5-D2: --attempts never reaches the legacy loop through quick, run, demo, tour, or a direct
#     cmd_start / run.sh entry. Each is refused with exit 2 and no route, no provider call, no .loki.
for cmd in quick run demo; do
    for form in "--attempts 2" "--attempts=2" "--attempts 1"; do
        # shellcheck disable=SC2086
        got="$(route_of "$(run_loki "$WITH_BUN" -- $cmd "fix x" $form)")"
        expect "bin/loki $cmd $form: no route" "" "$got"
        expect "bin/loki $cmd $form: exit 2" "2" "$(cat "$T/rc")"
    done
done
# Real autonomy/loki and run.sh, a provider stub that leaves a marker if it is ever invoked.
mkdir -p "$T/stubbin" "$T/real"
printf '#!/usr/bin/env bash\n: >"%s/provider-called"\n' "$T" >"$T/stubbin/claude"
chmod +x "$T/stubbin/claude"
real_run() { # real_run <script> <args...>
    local script="$1"; shift
    rm -f "$T/provider-called"
    (cd "$T/real" && env -i HOME="$T/home" PATH="$T/stubbin:/usr/bin:/bin" LOKI_TELEMETRY_DISABLED=1 \
        LOKI_NO_BROWSER=1 LOKI_NO_SKILL_LINK_HEAL=1 ${TO[@]+"${TO[@]}"} bash "$script" "$@") >"$T/stdout" 2>"$T/stderr"
    echo "$?" >"$T/rc"
}
for cmd in start quick run demo tour; do
    for form in "--attempts 2" "--attempts 1" "--attempts=2"; do
        # shellcheck disable=SC2086
        real_run "$REPO/autonomy/loki" $cmd prd.md $form
        expect "autonomy/loki $cmd $form: exit 2" "2" "$(cat "$T/rc")"
        if grep -q -- "--attempts" "$T/stderr" && grep -q "loki start --attempts" "$T/stderr"; then ok "autonomy/loki $cmd $form: message"; else bad "autonomy/loki $cmd $form: message missing: $(cat "$T/stderr")"; fi
        if [ -e "$T/provider-called" ] || [ -d "$T/real/.loki" ]; then bad "autonomy/loki $cmd $form: legacy loop ran"; else ok "autonomy/loki $cmd $form: legacy loop never ran"; fi
    done
done
# run.sh is the dashboard spawn target (control.py, server.py) and the cmd_start exec target.
for form in "--attempts 2" "--attempts=2" "--attempts 1"; do
    # shellcheck disable=SC2086
    real_run "$REPO/autonomy/run.sh" $form prd.md
    expect "run.sh $form: exit 2" "2" "$(cat "$T/rc")"
    # run.sh creates .loki scaffolding at source time; the loop is proven not run by the provider marker and the state files.
    if [ -e "$T/provider-called" ] || [ -e "$T/real/.loki/loki.pid" ] || [ -e "$T/real/.loki/state/orchestrator.json" ]; then bad "run.sh $form: legacy loop ran"; else ok "run.sh $form: legacy loop never ran"; fi
done
# Plain invocations keep their route.
expect "plain quick 'fix x' unchanged" "BUN $ENTRY engine10 --no-pr fix x" "$(run_loki "$WITH_BUN" -- quick "fix x")"

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
#    the modernize) arm (M-08) and the engine block -- never a
#    stray third exec line anywhere else in the file. Anchored on the arms'
#    own text, not line numbers, so edits elsewhere in the file don't rot it.
BIN="$REPO/bin/loki"
EXEC_PAT='exec "$_lb" "${_LOKI_BUN_SAFE[@]}" "$BUN_CLI" engine10'
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

# Routing contract (LM-003): every supported start/quick invocation form goes
# through `loki route --json` and is asserted against a table. Equivalent forms
# must land on the same engine and adapter, and any compatibility route must
# list capability_differences. The "Routing contract" table in docs/exit-codes.md
# is rendered from the live output; this fails if it drifts.
# Regenerate it with: bash tests/test-engine10-dispatch.sh --update-doc
UPDATE=0
[ "${1:-}" = "--update-doc" ] && UPDATE=1
if command -v python3 >/dev/null 2>&1; then
RC_LOKI="$REPO/bin/loki"
DOC="$REPO/docs/exit-codes.md"
RC_TMP="$T/route"
WORK="$RC_TMP/work"
mkdir -p "$WORK"
printf '# Spec\nBuild a thing.\n' >"$WORK/p.md"
printf '{"title":"x"}\n' >"$WORK/p.json"
printf 'title: x\n' >"$WORK/p.yaml"
head -c 100100 /dev/zero | tr '\0' 'a' >"$WORK/big.md"

# Table: id|group|env assignments (space separated, may be empty)|args
# Fields are split on '|'. Args are split on spaces; "_" inside an arg is a space.
TABLE='
prd-md|prd-claude||start p.md
prd-md-flag-last|prd-claude||start p.md --provider claude
prd-md-flag-first|prd-claude||start --provider claude p.md
prd-md-prd-flag|prd-claude||start --prd p.md
prd-json|prd-json||start p.json
prd-yaml|prd-yaml||start p.yaml
task-rc_words|task-claude||start fix_the_bug
task-multi-arg|task-claude||start fix the bug
task-bare-flag-first|task-claude||--explain-route --json fix_the_bug
quick-task|quick-claude||quick fix_the_bug
quick-task-multi-arg|quick-claude||quick fix the bug
issue-ref|issue-claude||start owner/repo#5
issue-ref-flag-last|issue-claude||start owner/repo#5 --provider claude
issue-url|issue-claude||start https://github.com/owner/repo/issues/5
brief-one-word|brief-claude||start hello
provider-codex|codex||start p.md --provider codex
provider-codex-first|codex||start --provider codex p.md
provider-codex-env|codex|LOKI_PROVIDER=codex|start p.md
provider-cline|cline||start p.md --provider cline
provider-aider|aider||start p.md --provider aider
provider-opencode|opencode||start p.md --provider opencode
engine-legacy-flag|legacy-explicit||start p.md --engine legacy
engine-legacy-flag-first|legacy-explicit||start --engine legacy p.md
engine-legacy-env|legacy-explicit|LOKI_ENGINE=legacy|start p.md
engine-engine10-flag|engine10-explicit||start p.md --engine engine10
engine-engine10-env|engine10-explicit|LOKI_ENGINE=engine10|start p.md
prd-too-large|legacy-size||start big.md
'

# Expected per group: engine|adapter|compat (1 = capability_differences must be non-empty)
expect_for() {
    case "$1" in
        prd-claude|prd-json|prd-yaml|task-claude|quick-claude|issue-claude|brief-claude|engine10-explicit)
            echo "engine10|engine10:claude|0" ;;
        codex|cline|aider|opencode) echo "engine10|engine10:$1|1" ;;
        gemini) echo "legacy|legacy-bash:gemini|1" ;;
        legacy-explicit|legacy-flag|legacy-size) echo "legacy|legacy-bash:claude|1" ;;
        *) echo "?|?|?" ;;
    esac
}

route_json() {
    local rc_env="$1"; shift
    local -a args=()
    local a
    for a in "$@"; do args+=("${a//_/ }"); done
    # Explicit scoped env: no inherited provider or engine selection.
    ( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE -u LOKI_MODEL_ROUTE -u LOKI_SESSION_MODEL \
        -u LOKI_MODEL_OVERRIDE -u LOKI_LEGACY_BASH LOKI_NO_BROWSER=1 HOME="$RC_TMP" \
        ${rc_env:+$rc_env} "$RC_LOKI" route "${args[@]}" --json 2>/dev/null )
}

# Bare flag-first rows use --explain-route (route verb would swallow them).
route_row() {
    local rc_env="$1" argstr="$2"
    local -a rc_words
    read -r -a rc_words <<<"$argstr"
    if [ "${rc_words[0]}" = "--explain-route" ]; then
        local -a args=()
        local a
        for a in "${rc_words[@]}"; do args+=("${a//_/ }"); done
        ( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE -u LOKI_MODEL_ROUTE -u LOKI_SESSION_MODEL \
            -u LOKI_MODEL_OVERRIDE -u LOKI_LEGACY_BASH LOKI_NO_BROWSER=1 HOME="$RC_TMP" \
            ${rc_env:+$rc_env} "$RC_LOKI" "${args[@]}" 2>/dev/null )
    else
        route_json "$rc_env" "${rc_words[@]}"
    fi
}

field() { python3 -I -c 'import json,sys; d=json.loads(sys.stdin.read()); v=d[sys.argv[1]]; print(len(v) if isinstance(v,list) else v)' "$1"; }

ROWS_TSV="$RC_TMP/rows.tsv"
: >"$ROWS_TSV"
while IFS='|' read -r id group rc_env argstr; do
    [ -n "$id" ] || continue
    out="$(route_row "$rc_env" "$argstr")"
    if [ -z "$out" ]; then bad "$id: no route output"; continue; fi
    eng="$(printf '%s' "$out" | field engine 2>/dev/null)"
    adp="$(printf '%s' "$out" | field adapter 2>/dev/null)"
    ncd="$(printf '%s' "$out" | field capability_differences 2>/dev/null)"
    rsn="$(printf '%s' "$out" | field reason 2>/dev/null)"
    IFS='|' read -r want_eng want_adp compat <<<"$(expect_for "$group")"
    if [ "$eng" = "$want_eng" ] && [ "$adp" = "$want_adp" ]; then
        ok "$id: $eng / $adp"
    else
        bad "$id: got $eng / $adp, want $want_eng / $want_adp"
    fi
    if [ "$compat" = "1" ]; then
        if [ "${ncd:-0}" -gt 0 ]; then ok "$id: compatibility route lists capability differences"
        else bad "$id: compatibility route has empty capability_differences"; fi
    else
        if [ "${ncd:-1}" = "0" ]; then ok "$id: full Claude path has no capability differences"
        else bad "$id: full path lists capability differences ($ncd)"; fi
    fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$rc_env" "$argstr" "$eng" "$adp" "$ncd" "$rsn" >>"$ROWS_TSV"
done <<<"$TABLE"

# A --provider the engine has no invoker for is refused, not routed to legacy (LOKI_PROVIDER=gemini in env stays a notice).
( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE LOKI_NO_BROWSER=1 HOME="$RC_TMP" "$RC_LOKI" route start p.md --provider gemini --json >/dev/null 2>&1 )
rc=$?
if [ "$rc" = "2" ]; then ok "--provider gemini: refused (exit 2)"; else bad "--provider gemini: exit $rc, want 2"; fi
# Error forms: missing PRD file is a usage error (exit 2), never a silent route.
( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE LOKI_NO_BROWSER=1 HOME="$RC_TMP" "$RC_LOKI" route start nope.md --json >/dev/null 2>&1 )
rc=$?
if [ "$rc" = "2" ]; then ok "missing PRD file: exit 2"; else bad "missing PRD file: exit $rc, want 2"; fi
( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE LOKI_NO_BROWSER=1 HOME="$RC_TMP" "$RC_LOKI" route start p.md --engine engine10 --parallel --json >/dev/null 2>&1 )
rc=$?
if [ "$rc" = "2" ]; then ok "--engine engine10 with an unsupported flag: exit 2"; else bad "--engine engine10 + --parallel: exit $rc, want 2"; fi

# FC-START-FLAG-ENGINE (#236): no flag changes the engine and no flag value reaches the task
# text. The flag list is read from `loki start --help` now, never hardcoded: every flag must
# keep an issue ref on engine10 (mapped) or be refused with exit 2 (never a silent legacy route).
ISSUE_REF="owner/repo#5"
START_HELP="$( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE LOKI_NO_BROWSER=1 HOME="$RC_TMP" "$RC_LOKI" start --help 2>&1 )"
FLAG_TSV="$RC_TMP/flags.tsv"
python3 -I - "$START_HELP" >"$FLAG_TSV" <<'PY'
import re, sys
seen = {}
for line in sys.argv[1].split("Environment Variables:")[0].splitlines():
    for m in re.finditer(r"""(?:^|[\s,(])(--[a-z][a-z0-9-]+|-[a-z])(?:=\S+)?(?= |,|$|\))(?: +(\[?[A-Z][A-Z_|]*\]?|"[A-Z]+")(?=\s|$)(?! mode))?""", line):
        f, v = m.group(1), m.group(2)
        if f in ("--help", "-h"):
            continue
        seen[f] = seen.get(f, False) or bool(v)
for f, v in sorted(seen.items()):
    print(f + "\t" + ("1" if v else "0"))
PY
nflags="$(wc -l <"$FLAG_TSV" | tr -d ' ')"
if [ "$nflags" -ge 30 ]; then ok "read $nflags flags from loki start --help"; else bad "only $nflags flags read from loki start --help"; fi
while IFS=$'\t' read -r flag takes; do
    [ -n "$flag" ] || continue
    fargs=("$flag"); if [ "$takes" = "1" ] && [ "$flag" != "--resume" ]; then fargs+=(3); fi
    out="$( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE -u LOKI_MODEL_ROUTE -u LOKI_SESSION_MODEL -u LOKI_MODEL_OVERRIDE \
        LOKI_NO_BROWSER=1 HOME="$RC_TMP" "$RC_LOKI" route start "$ISSUE_REF" "${fargs[@]}" --json 2>"$RC_TMP/flag.err" )"
    rc=$?
    if [ "$rc" = "2" ] && [ -s "$RC_TMP/flag.err" ] && grep -q -- "$flag" "$RC_TMP/flag.err"; then
        ok "flag $flag: refused, error names the flag"
    elif [ "$rc" = "0" ] && [ "$(printf '%s' "$out" | field engine 2>/dev/null)" = "engine10" ] && [ "$(printf '%s' "$out" | field input 2>/dev/null)" = "$ISSUE_REF" ]; then
        ok "flag $flag: stays on engine10, task text is the issue ref only"
    else
        bad "flag $flag: rc=$rc engine=$(printf '%s' "$out" | field engine 2>/dev/null) input=$(printf '%s' "$out" | field input 2>/dev/null) err=$(head -c 200 "$RC_TMP/flag.err")"
    fi
done <"$FLAG_TSV"
# --max-duration maps to the engine10 run cap (LOKI_E10_CAP_S semantics: seconds), bounded by the 3600s ceiling.
for row in "50m|3000" "2h|3600" "90|90" "5h|3600"; do
    dur="${row%%|*}"; want="${row##*|}"
    out="$( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE LOKI_NO_BROWSER=1 HOME="$RC_TMP" "$RC_LOKI" route start "$ISSUE_REF" --max-duration "$dur" --json 2>/dev/null )"
    got="$(printf '%s' "$out" | field run_cap_s 2>/dev/null)"
    if [ "$got" = "$want" ] && [ "$(printf '%s' "$out" | field engine 2>/dev/null)" = "engine10" ]; then ok "--max-duration $dur: engine10, run cap ${got}s"; else bad "--max-duration $dur: run_cap_s=$got engine=$(printf '%s' "$out" | field engine 2>/dev/null), want ${want}s on engine10"; fi
done
( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE LOKI_NO_BROWSER=1 HOME="$RC_TMP" "$RC_LOKI" route start "$ISSUE_REF" --max-duration soon --json >/dev/null 2>&1 )
rc=$?
if [ "$rc" = "2" ]; then ok "--max-duration soon: refused (exit 2)"; else bad "--max-duration soon: exit $rc, want 2"; fi
# An unknown flag on a non-issue input is refused too, and --engine legacy still honors any flag.
# Each flag with no engine10 equivalent is refused (exit 2) and the message names its replacement.
for row in "--parallel|queue run --parallel" "--ship|loki merge-queue" "--worktree|isolated worktree" "-w|isolated worktree" "--detach|nohup loki start" "-d|nohup loki start"; do
    rf="${row%%|*}"; hint="${row##*|}"
    ( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE LOKI_NO_BROWSER=1 HOME="$RC_TMP" "$RC_LOKI" route start p.md "$rf" --json >/dev/null 2>"$RC_TMP/ref.err" )
    rc=$?
    if [ "$rc" = "2" ] && grep -q -- "$hint" "$RC_TMP/ref.err" && grep -q -- "--engine legacy" "$RC_TMP/ref.err"; then ok "flag $rf: refused (exit 2), names '$hint' and --engine legacy"; else bad "flag $rf: exit $rc, err=$(head -c 200 "$RC_TMP/ref.err")"; fi
done
# --pr is an accepted no-op on engine10; --quiet and --resume pass through to the supervisor.
out="$( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE LOKI_NO_BROWSER=1 HOME="$RC_TMP" "$RC_LOKI" route start "$ISSUE_REF" --pr --quiet --json 2>/dev/null )"
if [ "$(printf '%s' "$out" | field engine 2>/dev/null)" = "engine10" ]; then ok "--pr --quiet: stay on engine10"; else bad "--pr --quiet: $out"; fi
# --dry-run prints provider, model, max-cost and run cap, starts nothing, exits 0.
dry="$( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE LOKI_NO_BROWSER=1 HOME="$RC_TMP" "$RC_LOKI" start "$ISSUE_REF" --dry-run --max-cost 5 --max-duration 90 2>&1 )"
rc=$?
if [ "$rc" = "0" ] && printf '%s' "$dry" | grep -q "^provider:" && printf '%s' "$dry" | grep -q "^model:" && printf '%s' "$dry" | grep -q "^max-cost: 5$" && printf '%s' "$dry" | grep -q "^run-cap: 90s$" && printf '%s' "$dry" | grep -q "nothing was started"; then ok "--dry-run on an issue ref: prints provider, model, max-cost, run cap; exit 0"; else bad "--dry-run: rc=$rc out=$dry"; fi
out="$( cd "$WORK" && env -u LOKI_PROVIDER -u LOKI_ENGINE LOKI_NO_BROWSER=1 HOME="$RC_TMP" "$RC_LOKI" route start "$ISSUE_REF" --ship --engine legacy --json 2>/dev/null )"
if [ "$(printf '%s' "$out" | field engine 2>/dev/null)" = "legacy" ]; then ok "--engine legacy still honors --ship"; else bad "--engine legacy --ship: $out"; fi

# Render the contract table from the live results.
RENDER="$RC_TMP/render.md"
python3 -I - "$ROWS_TSV" >"$RENDER" <<'PY'
import sys
print("| Invocation (after `loki route`, unless it starts with `loki` or an env var) | Engine | Adapter | Capability differences | Reason |")
print("|---|---|---|---|---|")
for line in open(sys.argv[1]):
    id_, rc_env, args, eng, adp, ncd, rsn = line.rstrip("\n").split("\t")
    args = " ".join('"%s"' % w.replace("_", " ") if "_" in w else w for w in args.split(" "))
    inv = "`" + (rc_env + " " if rc_env else "") + ("loki " if args.startswith("--explain-route") else "") + args + "`"
    cd = "none" if ncd == "0" else "%s listed" % ncd
    print("| %s | %s | %s | %s | %s |" % (inv, eng, adp, cd, rsn.replace("|", "/")))
PY

BEGIN='<!-- route-table:begin (generated by tests/test-engine10-dispatch.sh --update-doc) -->'
END='<!-- route-table:end -->'
if [ "$UPDATE" = "1" ]; then
    python3 -I - "$DOC" "$RENDER" "$BEGIN" "$END" <<'PY'
import sys
doc, render, begin, end = sys.argv[1:5]
s = open(doc).read()
a = s.index(begin) + len(begin)
b = s.index(end)
s = s[:a] + "\n" + open(render).read() + s[b:]
open(doc, "w").write(s)
PY
    echo "updated $DOC"
fi
current="$(python3 -I - "$DOC" "$BEGIN" "$END" <<'PY'
import sys
doc, begin, end = sys.argv[1:4]
s = open(doc).read()
a = s.index(begin) + len(begin)
b = s.index(end)
sys.stdout.write(s[a:b].strip("\n") + "\n")
PY
)"
if [ "$current" = "$(cat "$RENDER")" ]; then
    ok "docs/exit-codes.md table matches live route output"
else
    bad "docs/exit-codes.md table drifted; run: bash tests/test-engine10-dispatch.sh --update-doc"
fi
else
    echo "SKIP: route contract needs python3"
fi

# GAME10-01a: the installed layout (a root with autonomy/route.sh) is the path users take; the fixture above omits route.sh on purpose.
mkdir -p "$T/root2/bin" "$T/root2/autonomy"
cp "$REPO/bin/loki" "$T/root2/bin/loki"
cp "$REPO/autonomy/telemetry.sh" "$REPO/autonomy/route.sh" "$T/root2/autonomy/"
cp "$T/root/autonomy/loki" "$T/root2/autonomy/loki"
run_loki2() { T_BIN="$T/root2/bin/loki" run_loki_bin "$@"; }
run_loki_bin() {
    local path="$1"; shift
    local envs=()
    while [ "$1" != "--" ]; do envs+=("$1"); shift; done
    shift
    rm -f "$T/out"
    (cd "$T/cwd" && env -i HOME="$T/home" PATH="$path" LOKI_TELEMETRY_DISABLED=1 \
        LOKI_TS_ENTRY="$ENTRY" ${envs[@]+"${envs[@]}"} \
        ${TO[@]+"${TO[@]}"} bash "$T_BIN" "$@") >"$T/stdout" 2>"$T/stderr"
    echo "$?" >"$T/rc"
    cat "$T/out" 2>/dev/null || true
}
# `loki start <github PR URL>` reaches verify-pr through bin/loki, on every spelling and flag order, never engine10/implement.
PRU="https://github.com/o/r/pull/12"
expect "start <PR url> -> verify-pr, not engine10" "BUN $ENTRY verify-pr $PRU" "$(run_loki2 "$WITH_BUN" -- start "$PRU")"
expect "start --no-pr <PR url> (flag first) -> verify-pr" "BUN $ENTRY verify-pr $PRU" "$(run_loki2 "$WITH_BUN" -- start --no-pr "$PRU")"
expect "start <PR url> --json -> verify-pr keeps --json" "BUN $ENTRY verify-pr $PRU --json" "$(run_loki2 "$WITH_BUN" -- start "$PRU" --json)"
expect "start <PR url> --out d -> verify-pr keeps --out d" "BUN $ENTRY verify-pr $PRU --out d" "$(run_loki2 "$WITH_BUN" -- start "$PRU" --out d)"
expect "start <PR url> --out=d -> verify-pr --out d" "BUN $ENTRY verify-pr $PRU --out d" "$(run_loki2 "$WITH_BUN" -- start "$PRU" --out=d)"
expect "start uppercase host PR url -> normalized verify-pr" "BUN $ENTRY verify-pr $PRU" "$(run_loki2 "$WITH_BUN" -- start "HTTPS://GitHub.COM/o/r/pull/12")"
expect "start www.github.com PR url -> normalized verify-pr" "BUN $ENTRY verify-pr $PRU" "$(run_loki2 "$WITH_BUN" -- start "https://www.github.com/o/r/pull/12")"
expect "start http:// PR url -> normalized https verify-pr" "BUN $ENTRY verify-pr $PRU" "$(run_loki2 "$WITH_BUN" -- start "http://github.com/o/r/pull/12")"
expect "start PR url with /files suffix -> verify-pr" "BUN $ENTRY verify-pr $PRU" "$(run_loki2 "$WITH_BUN" -- start "$PRU/files")"
got="$(run_loki2 "$WITH_BUN" -- start "$PRU" --provider codex)"
expect "start <PR url> --provider codex is refused, nothing runs" "" "$got"
expect "start <PR url> --provider codex exits 2" "2" "$(cat "$T/rc")"
if grep -q -- "--provider" "$T/stderr" && grep -q -- "--out" "$T/stderr" && grep -q -- "--json" "$T/stderr" && [ "$(wc -l <"$T/stderr" | tr -d ' ')" = "1" ]; then ok "unsupported flag refusal is one line naming the flag and the supported ones"; else bad "refusal text: $(cat "$T/stderr")"; fi
expect "route start <PR url> prints the pr kind" "1" "$(cd "$T/cwd" && env -i HOME="$T/home" PATH="$WITH_BUN" LOKI_TS_ENTRY="$ENTRY" bash "$T/root2/bin/loki" route start "$PRU" 2>&1 | grep -c '^input:    pr (')"
expect "start issue url still -> engine10" "BUN $ENTRY engine10 https://github.com/o/r/issues/7" "$(run_loki2 "$WITH_BUN" -- start "https://github.com/o/r/issues/7")"
expect "start owner/repo#N still -> engine10 issue" "BUN $ENTRY engine10 o/r#12" "$(run_loki2 "$WITH_BUN" -- start "o/r#12")"
expect "start multi-word brief still -> engine10" "BUN $ENTRY engine10 fix the login bug" "$(run_loki2 "$WITH_BUN" -- start "fix the login bug")"
expect "start one-word brief still -> engine10 brief" "BUN $ENTRY engine10 fixit" "$(run_loki2 "$WITH_BUN" -- start fixit)"
# GAME10-01a-F1: only the github.com host is a PR host. Other hosts run as a brief, never verify-pr.
expect "start GitHub Enterprise host PR-shaped url is not a PR (brief)" "BUN $ENTRY engine10 https://github.example.com/o/r/pull/1" "$(run_loki2 "$WITH_BUN" -- start "https://github.example.com/o/r/pull/1")"
expect "start github.com.evil.com PR-shaped url is not a PR (brief)" "BUN $ENTRY engine10 https://github.com.evil.com/o/r/pull/1" "$(run_loki2 "$WITH_BUN" -- start "https://github.com.evil.com/o/r/pull/1")"
# A PR-shaped url verify-pr would reject (".." in owner/repo) is refused by the route itself: exit 2, one line, nothing runs.
got="$(run_loki2 "$WITH_BUN" -- start "https://github.com/a/b..c/pull/1")"
expect "start PR url with .. in repo is refused, nothing runs" "" "$got"
expect "start PR url with .. in repo exits 2" "2" "$(cat "$T/rc")"
if grep -q -- "b..c" "$T/stderr" && [ "$(wc -l <"$T/stderr" | tr -d ' ')" = "1" ]; then ok "invalid PR url refusal is one line naming the url"; else bad "invalid PR url refusal text: $(cat "$T/stderr")"; fi
# --explain-route prints the verify-pr route and runs nothing (the TS entry does the same).
got="$(run_loki2 "$WITH_BUN" -- start "$PRU" --explain-route)"
expect "start <PR url> --explain-route runs nothing" "" "$got"
expect "start <PR url> --explain-route exits 0" "0" "$(cat "$T/rc")"
if grep -q '^engine:   verify-pr$' "$T/stdout" && grep -q '^input:    pr (' "$T/stdout"; then ok "start <PR url> --explain-route prints the verify-pr route"; else bad "explain-route output: $(cat "$T/stdout")"; fi
# The label says what runs: `loki route quick <PR url>` runs engine10 on the url as a brief.
rq="$(cd "$T/cwd" && env -i HOME="$T/home" PATH="$WITH_BUN" LOKI_TS_ENTRY="$ENTRY" bash "$T/root2/bin/loki" route quick "$PRU" 2>&1)"
if printf '%s\n' "$rq" | grep -q '^input:    brief (' && printf '%s\n' "$rq" | grep -q 'brief input runs on engine10' && ! printf '%s\n' "$rq" | grep -q 'pr input'; then ok "route quick <PR url> is labelled brief, which is what runs"; else bad "route quick label: $rq"; fi
expect "quick <PR url> really runs engine10 with the url as the brief" "BUN $ENTRY engine10 --no-pr $PRU" "$(run_loki2 "$WITH_BUN" -- quick "$PRU")"

# #308: a value flag consumes its value on the route parser, so the value never joins the positional list.
vf_resolve() { bash -c 'source "$1"; shift; loki_route_resolve start "$@"; printf "%s|%s" "$R_INPUT" "$R_INPUT_TYPE"' _ "$REPO/autonomy/route.sh" "$@" 2>/dev/null; }
for vf in "--workspace ws" "--config c.yaml" "--vars v.yaml" "--mirofish http://m" "--max-iterations 7" "--completion-promise done"; do
    got="$(vf_resolve "owner/repo#5" $vf)"
    expect "route: '$vf' consumes its value, input stays owner/repo#5" "owner/repo#5|issue" "$got"
done
# --parallel is a boolean in cmd_start, so its next token stays positional: the route splits it exactly as cmd_start does.
got="$(vf_resolve "owner/repo#5" --parallel 3)"
expect "route: '--parallel 3' leaves 3 positional like cmd_start (two inputs, type unchanged from bare)" "$(vf_resolve "owner/repo#5" 3)" "$got"
got="$(vf_resolve "owner/repo#5" --parallel)"
expect "route: bare --parallel (no value) keeps the single input" "owner/repo#5|issue" "$got"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
