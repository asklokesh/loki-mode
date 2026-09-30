#!/usr/bin/env bash
# scripts/first-run-gate.sh -- A-02 first-run gate. Runs the README's default entry point
# for a new user (`loki quick "<task>"`) on a throwaway bugrepo with a throwaway HOME and
# asserts the run is honest. One PASS/FAIL line per assertion; exit 1 if any FAIL.
#
#   --stub              CI, no keys: a stub `claude` writes the one-character fix (default)
#   --real              real provider (needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN,
#                       the throwaway HOME has no login); also times raw `claude -p` and
#                       appends both to docs/v10/METRICS.md
#   --installed <spec>  npm-install that exact package into a temp prefix and run IT
#
# Test hooks: FRG_LOKI overrides the loki binary; FRG_REPORT the report path.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TASK="fix the bug that makes the failing test in sum.test.js fail"
MODE=stub SPEC=""
while [ $# -gt 0 ]; do
    case "$1" in
        --stub) MODE=stub ;;
        --real) MODE=real ;;
        --installed) SPEC="${2:-}"; [ -n "$SPEC" ] || { echo "--installed needs a spec" >&2; exit 2; }; shift ;;
        *) echo "usage: $0 [--stub|--real] [--installed <npm spec>]" >&2; exit 2 ;;
    esac
    shift
done

# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
REPORT="${FRG_REPORT:-$T/first-run-gate-report.txt}"
mkdir -p "$T/home" "$T/bin" "$T/repo" "$T/raw"

# --- bugrepo: the exact fixture from the adoption repro ----------------------
mk_bugrepo() {
    local d="$1"
    printf '{"name":"bugrepo","version":"1.0.0","scripts":{"test":"node --test"}}\n' > "$d/package.json"
    printf '// Sum an array of numbers\nfunction sum(arr) {\n  let total = 0;\n  for (let i = 1; i < arr.length; i++) total += arr[i];\n  return total;\n}\nmodule.exports = { sum };\n' > "$d/sum.js"
    printf "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\ntest('sums all numbers', () => { assert.strictEqual(sum([1, 2, 3]), 6); });\ntest('empty array is 0', () => { assert.strictEqual(sum([]), 0); });\n" > "$d/sum.test.js"
    ( cd "$d" && git init -q && git config user.email gate@example.invalid && git config user.name gate \
        && git add package.json sum.js sum.test.js && git commit -q -m init )
}
mk_bugrepo "$T/repo"
BASE=$(git -C "$T/repo" rev-parse HEAD)

# Throwaway HOME first: npm must not read ~/.npmrc or ~/.npm.
export HOME="$T/home" LOKI_NO_BROWSER=1 npm_config_cache="$T/npm-cache" npm_config_userconfig="$T/home/.npmrc"

# --- which loki ---------------------------------------------------------------
LOKI="${FRG_LOKI:-$REPO_ROOT/bin/loki}"
if [ -n "$SPEC" ]; then
    npm install --silent --no-audit --no-fund --prefix "$T/prefix" "$SPEC" >"$T/install.log" 2>&1 \
        || { echo "FAIL install: npm install $SPEC failed (see $T/install.log)"; exit 1; }
    LOKI="$T/prefix/node_modules/.bin/loki"
fi

# --- provider -----------------------------------------------------------------
unset LOKI_PROVIDER LOKI_ENGINE
if [ "$MODE" = stub ]; then
    cat > "$T/bin/claude" <<'STUB'
#!/usr/bin/env bash
case " $* " in *" --help "*|*" --version "*) echo "claude stub 2.1.285 --settings --session-id --resume --model --dangerously-skip-permissions"; exit 0;; esac
[ -f sum.js ] && sed -i.bak 's/i = 1/i = 0/' sum.js && rm -f sum.js.bak
mkdir -p .loki/signals; echo "fixed sum loop" > .loki/signals/COMPLETION_REQUESTED
echo "stub claude done"
STUB
    chmod +x "$T/bin/claude"
    export PATH="$T/bin:$PATH" LOKI_SKIP_AUTH_PREFLIGHT=1
fi

# --- run the default entry point ---------------------------------------------
echo "ENTRY: loki quick \"$TASK\"  (mode=$MODE${SPEC:+, installed=$SPEC})"
S=$(date +%s)
( cd "$T/repo" && "$LOKI" quick "$TASK" ) < /dev/null > "$T/out.log" 2>&1
RC=$?
WALL=$(( $(date +%s) - S ))

# --- assertions ---------------------------------------------------------------
FAILS=0
: > "$REPORT"
res() { # res PASS|FAIL name detail
    printf '%s %s: %s\n' "$1" "$2" "$3" | tee -a "$REPORT"
    [ "$1" = PASS ] || FAILS=$((FAILS + 1))
}
cd "$T/repo" || exit 2

npm test --silent >"$T/npm-test.log" 2>&1; NPM_RC=$?
# Run the fixture's tests ourselves: expect exactly 2 tests and 0 failures.
node --test --test-reporter=tap >"$T/node-test.log" 2>&1
NT=$(sed -n 's/^# tests \([0-9]*\)$/\1/p' "$T/node-test.log" | tail -1)
NF=$(sed -n 's/^# fail \([0-9]*\)$/\1/p' "$T/node-test.log" | tail -1)
GREEN=0; [ "${NT:-x}" = 2 ] && [ "${NF:-x}" = 0 ] && [ "$NPM_RC" -eq 0 ] && GREEN=1

# 1. exit 0 if and only if the repo ends fully green
if { [ "$RC" -eq 0 ] && [ "$GREEN" -eq 1 ]; } || { [ "$RC" -ne 0 ] && [ "$GREEN" -eq 0 ]; }; then
    res PASS exit-honest "run rc=$RC, green=$GREEN"
else
    res FAIL exit-honest "run rc=$RC but green=$GREEN (tests=${NT:-none} fail=${NF:-none} npm rc=$NPM_RC)"
fi
# 2. the fix actually lands: 2 tests, 0 failures
[ "$GREEN" -eq 1 ] && res PASS tests-green "node --test: 2 tests, 0 failures; npm test rc=0" \
    || res FAIL tests-green "node --test tests=${NT:-none} fail=${NF:-none}; npm test rc=$NPM_RC"

# 3. diff against the base commit: only sum.js may change; nothing new outside .loki/
BAD=$( { git diff --name-status "$BASE" -- . ':!.loki' | grep -v -E '^M[[:space:]]+sum\.js$'
         git ls-files -o | grep -v '^\.loki/' | sed 's/^/?\t/'; } || true)
if [ -z "$BAD" ]; then res PASS no-stray-files "only sum.js modified vs base; nothing new outside .loki/"
else res FAIL no-stray-files "unexpected changes: $(echo "$BAD" | tr '\t\n' '  ')"; fi

# 4. printed receipt digest: FULL 64-hex, equal to the receipt_sha256 loki verify reports
VOUT="$T/verify.log"
"$LOKI" verify < /dev/null > "$VOUT" 2>&1; VRC=$?
PRINTED=$(sed 's/\x1b\[[0-9;]*m//g' "$T/out.log" | grep -Eio '(receipt_sha256|sha256|receipt)[^0-9a-f]*[0-9a-f]{64}' \
    | head -1 | grep -Eo '[0-9a-f]{64}$')
VERIFIED_D=$(sed -n 's/^.*receipt_sha256[^0-9a-f]*\([0-9a-f]\{64\}\).*$/\1/p' "$VOUT" | head -1)
if [ -z "$PRINTED" ]; then res FAIL digest-matches "no full 64-hex receipt digest printed"
elif [ -z "$VERIFIED_D" ]; then res FAIL digest-matches "loki verify reports no receipt_sha256"
elif [ "$PRINTED" = "$VERIFIED_D" ]; then res PASS digest-matches "printed digest equals verify's receipt_sha256 (${PRINTED:0:12}...)"
else res FAIL digest-matches "printed ${PRINTED:0:12}... but verify reports ${VERIFIED_D:0:12}..."; fi

# 5. loki verify OK, exit 0
if [ "$VRC" -eq 0 ] && grep -Eqi 'verdict: *verified' "$VOUT"; then res PASS verify-ok "loki verify VERIFIED rc=0"
else res FAIL verify-ok "loki verify rc=$VRC: $(grep -Ei 'verdict' "$VOUT" | head -1)"; fi

# 6. receipt signed: loki verify itself must report a valid signature
if grep -Eqi '^attestation: *verified' "$VOUT"; then res PASS receipt-signed "loki verify reports a valid signature"
else res FAIL receipt-signed "loki verify reports no valid signature: $(grep -Ei 'attestation|signature' "$VOUT" | head -1)"; fi

# 7. terminal output 15 lines or fewer without --verbose
LINES=$(wc -l < "$T/out.log" | tr -d ' ')
[ "$LINES" -le 15 ] && res PASS output-lines "$LINES lines (max 15)" || res FAIL output-lines "$LINES lines (max 15)"

# 8. wall time recorded
echo "$WALL" | grep -Eq '^[0-9]+$' && res PASS wall-time "recorded ${WALL}s" || res FAIL wall-time "not recorded"

# --- real mode: raw claude -p comparison, appended to METRICS.md --------------
if [ "$MODE" = real ]; then
    mk_bugrepo "$T/raw"
    RS=$(date +%s)
    ( cd "$T/raw" && claude -p "$TASK" --dangerously-skip-permissions --output-format json ) < /dev/null > "$T/raw.json" 2>&1
    RAW_WALL=$(( $(date +%s) - RS ))
    RAW_COST=$(grep -Eo '"total_cost_usd": *[0-9.]+' "$T/raw.json" | head -1 | grep -Eo '[0-9.]+$')
    LOKI_COST=$(sed 's/\x1b\[[0-9;]*m//g' "$T/out.log" | grep -Eo 'Cost[: |]*\$[0-9.]+' | head -1 | grep -Eo '[0-9.]+$')
    printf '| %s | first-run-gate --real | loki quick %ss $%s | raw claude -p %ss $%s |\n' \
        "$(date -u +%Y-%m-%dT%H:%MZ)" "$WALL" "${LOKI_COST:-unknown}" "$RAW_WALL" "${RAW_COST:-unknown}" \
        >> "$REPO_ROOT/docs/v10/METRICS.md"
    echo "METRICS: loki ${WALL}s \$${LOKI_COST:-unknown}; raw ${RAW_WALL}s \$${RAW_COST:-unknown}"
fi

echo "GATE: $FAILS assertion(s) failed, wall ${WALL}s"
[ "$FAILS" -eq 0 ]
