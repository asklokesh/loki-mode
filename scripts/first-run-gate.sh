#!/usr/bin/env bash
# scripts/first-run-gate.sh -- A-02 first-run gate. Runs the README's default entry point
# for a new user (`loki quick "<task>"`) on a throwaway bugrepo with a throwaway HOME and
# asserts the run is honest. One PASS/FAIL line per assertion; exit 1 if any FAIL.
#
#   --stub              CI, no keys: a stub `claude` writes the one-character fix (default)
#   --real              real provider (needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN,
#                       the throwaway HOME has no login); also times raw `claude -p` and
#                       appends both to docs/v10/METRICS.md
#   --engine legacy     the no-bun machine (plain `npm i -g` user): legacy verify, 15-line budget, no v10-only
#                       checks, and the legacy fallback line must be printed naming bun. Run it with bun off PATH.
#   --installed <spec>  npm-install that exact package into a temp prefix and run IT
#
# Test hooks: FRG_LOKI overrides the loki binary; FRG_REPORT the report path.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TASK="fix the bug that makes the failing test in sum.test.js fail"
MODE=stub SPEC="" ENGINE=v10
while [ $# -gt 0 ]; do
    case "$1" in
        --stub) MODE=stub ;;
        --real) MODE=real ;;
        --engine) ENGINE="${2:-}"; case "$ENGINE" in v10|legacy) ;; *) echo "--engine needs v10 or legacy" >&2; exit 2 ;; esac; shift ;;
        --installed) SPEC="${2:-}"; [ -n "$SPEC" ] || { echo "--installed needs a spec" >&2; exit 2; }; shift ;;
        *) echo "usage: $0 [--stub|--real] [--engine v10|legacy] [--installed <npm spec>]" >&2; exit 2 ;;
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
    # The legacy leg is a user with no bun at all: omit optional deps so loki-mode's optional bun is not installed beside it.
    OMIT=""; [ "$ENGINE" = legacy ] && OMIT="--omit=optional"
    # shellcheck disable=SC2086
    npm install --silent --no-audit --no-fund $OMIT --prefix "$T/prefix" "$SPEC" >"$T/install.log" 2>&1 \
        || { echo "FAIL install: npm install $SPEC failed (see $T/install.log)"; exit 1; }
    if [ "$ENGINE" = legacy ]; then
        for d in "$T/prefix/node_modules" "$T/prefix/node_modules/loki-mode/node_modules" "$T/prefix/lib/node_modules/loki-mode/node_modules"; do
            for b in "$d/bun" "$d"/@oven/bun-*; do
                [ -e "$b" ] && { echo "FAIL legacy-no-bun: bun is installed at $b; the legacy leg must represent a user with no bun (install with --omit=optional)"; exit 1; }
            done
        done
    fi
    LOKI="$T/prefix/node_modules/.bin/loki"
fi

# --- provider -----------------------------------------------------------------
unset LOKI_PROVIDER LOKI_ENGINE
if [ "$MODE" = stub ]; then
    cat > "$T/bin/claude" <<'STUB'
#!/usr/bin/env bash
case " $* " in *" --help "*|*" --version "*) echo "claude stub 2.1.285 --settings --session-id --resume --model --dangerously-skip-permissions"; exit 0;; esac
if [ -n "${FRG_SKIP:-}" ]; then # G8: skip the target test instead of fixing it (the node equivalent of a conftest skip; this repo has no pytest)
    sed -i.bak "s/'sums all numbers', /'sums all numbers', { skip: true }, /" sum.test.js && rm -f sum.test.js.bak
else
    [ -f sum.js ] && sed -i.bak 's/i = 1/i = 0/' sum.js && rm -f sum.js.bak
fi
mkdir -p .loki/signals; echo "fixed sum loop" > .loki/signals/COMPLETION_REQUESTED
echo "stub claude done"
STUB
    chmod +x "$T/bin/claude"
    export PATH="$T/bin:$PATH" LOKI_SKIP_AUTH_PREFLIGHT=1
    # D48: `loki quick` is the Loki 10 engine now; the stub is a CLI, so select the CLI invoker (no SDK, no keys).
    export LOKI_E10_INVOKER=cli
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
NP=$(sed -n 's/^# pass \([0-9]*\)$/\1/p' "$T/node-test.log" | tail -1)
# D47: green is pass 2 and fail 0, so a skipped test (pass 1, skipped 1) is not green.
GREEN=0; [ "${NT:-x}" = 2 ] && [ "${NP:-x}" = 2 ] && [ "${NF:-x}" = 0 ] && [ "$NPM_RC" -eq 0 ] && GREEN=1

# 1. exit 0 if and only if the repo ends fully green
if { [ "$RC" -eq 0 ] && [ "$GREEN" -eq 1 ]; } || { [ "$RC" -ne 0 ] && [ "$GREEN" -eq 0 ]; }; then
    res PASS exit-honest "run rc=$RC, green=$GREEN"
else
    res FAIL exit-honest "run rc=$RC but green=$GREEN (tests=${NT:-none} pass=${NP:-none} fail=${NF:-none} npm rc=$NPM_RC)"
fi
# 2. the fix actually lands: 2 tests, 0 failures
[ "$GREEN" -eq 1 ] && res PASS tests-green "node --test: 2 tests, 2 pass, 0 failures; npm test rc=0" \
    || res FAIL tests-green "node --test tests=${NT:-none} pass=${NP:-none} fail=${NF:-none}; npm test rc=$NPM_RC"

# 3. diff against the base commit: only sum.js may change; nothing new outside .loki/
BAD=$( { git diff --name-status "$BASE" -- . ':!.loki' | grep -v -E '^M[[:space:]]+sum\.js$'
         git ls-files -o | grep -v '^\.loki/' | sed 's/^/?\t/'; } || true)
if [ -z "$BAD" ]; then res PASS no-stray-files "only sum.js modified vs base; nothing new outside .loki/"
else res FAIL no-stray-files "unexpected changes: $(echo "$BAD" | tr '\t\n' '  ')"; fi

# 4. printed receipt digest: FULL 64-hex, equal to the receipt_sha256 loki verify reports
VOUT="$T/verify.log"
# D48: bare `loki verify` stays the legacy deterministic verify; the receipt a v10 run seals is checked by the v10 verify.
if [ "$ENGINE" = legacy ]; then "$LOKI" verify < /dev/null > "$VOUT" 2>&1; VRC=$?
else LOKI_ENGINE=v10 "$LOKI" verify < /dev/null > "$VOUT" 2>&1; VRC=$?; fi
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

# 7. terminal output 8 lines or fewer without --verbose (D48: the v10 quiet budget; was 15 on the legacy engine)
LINES=$(wc -l < "$T/out.log" | tr -d ' ')
MAXL=8; [ "$ENGINE" = legacy ] && MAXL=15 # legacy quiet budget
[ "$LINES" -le "$MAXL" ] && res PASS output-lines "$LINES lines (max $MAXL)" || res FAIL output-lines "$LINES lines (max $MAXL)"

# 8. wall time recorded
echo "$WALL" | grep -Eq '^[0-9]+$' && res PASS wall-time "recorded ${WALL}s" || res FAIL wall-time "not recorded"

OUTC=$(sed 's/\x1b\[[0-9;]*m//g' "$T/out.log")
if [ "$ENGINE" = legacy ]; then
    # no-bun leg: the fallback must be announced and name the reason, never silent
    if grep -q 'loki: the Loki 10 engine cannot run on this machine: no working bun' <<<"$OUTC"; then
        res PASS legacy-fallback-line "fallback line printed and names bun"
    else res FAIL legacy-fallback-line "no legacy-engine fallback line naming bun (is bun still on PATH?)"; fi
else
# 7b. D48: the default entry is the Loki 10 engine: one start line naming it, then Outcome, PR, Receipt, NOT PROVEN, Cost, Time
MISSL=""; for l in Outcome PR Receipt 'NOT PROVEN' Cost Time; do grep -q "^$l:" <<<"$OUTC" || MISSL="$MISSL $l"; done
if head -1 <<<"$OUTC" | grep -q '^Loki 10 engine (set LOKI_ENGINE=legacy' && [ -z "$MISSL" ]; then
    res PASS engine-start-line "start line names Loki 10; Outcome/PR/Receipt/NOT PROVEN/Cost/Time present"
else res FAIL engine-start-line "missing start line or summary label(s):${MISSL:- none}: $(head -2 <<<"$OUTC" | tr '\n' '|')"; fi

# 7a. fail closed on engine fallback: a runner without bun silently runs the legacy engine, which fails 7 checks for one cause
FB=$(sed 's/\x1b\[[0-9;]*m//g' "$T/out.log" | grep -m1 -E 'using the legacy engine|Running the legacy engine instead' || true)
if [ -n "$FB" ]; then res FAIL engine-fallback "engine fell back to legacy: $FB"
else res PASS engine-fallback "no legacy-engine fallback"; fi

# 7c. D48: every run records a non-null cost, in the cost events and in the receipt (0 with a source marker when the CLI invoker is unmetered)
CJ=$(python3 - "$T/repo" <<'PY'
import glob, json, sys
g = glob.glob(sys.argv[1] + "/.loki/runs/*/")
if not g:
    print("null no v10 run dir")
    sys.exit(0)
d = g[0]
ev = [json.loads(l) for l in open(d + "events.jsonl") if l.strip()]
cost = [e["data"] for e in ev if e["type"] == "cost"]
rc = json.load(open(d + "receipt.json"))["cost"]["usd"]
ok = bool(cost) and all(isinstance(c.get("usd"), (int, float)) for c in cost) and isinstance(rc, (int, float))
print(("ok" if ok else "null") + " events=" + ",".join(str(c.get("usd")) + ":" + str(c.get("source")) for c in cost) + " receipt=" + str(rc))
PY
)
case "$CJ" in ok*) res PASS cost-non-null "$CJ" ;; *) res FAIL cost-non-null "$CJ" ;; esac

fi

# 9. G8 (stub only): an agent that skips the target test (node { skip: true } on the target) must not end VERIFIED. Runs the v10 engine,
#    whose verify stage judges skips and test configuration (A-115); since D48 this IS the default engine, so no LOKI_ENGINE is set.
if [ "$MODE" = stub ]; then
  if [ "$ENGINE" = v10 ]; then
    mkdir -p "$T/skip" && mk_bugrepo "$T/skip"
    ( cd "$T/skip" && FRG_SKIP=1 "$LOKI" "$TASK" --no-pr ) < /dev/null > "$T/skip.log" 2>&1; SRC=$?
    if [ "$SRC" -ne 0 ] && ! grep -Eqi '^Outcome: *VERIFIED|verdict: *verified' "$T/skip.log"; then
        res PASS skip-not-verified "skipped target: rc=$SRC, $(grep -Ei '^Outcome:' "$T/skip.log" | head -1)"
    else res FAIL skip-not-verified "skipped target sealed: rc=$SRC, $(grep -Ei '^Outcome:' "$T/skip.log" | head -1)"; fi
    # 9a. bare `loki verify` after the skipped default run must follow the v10 run: exit 4 and never VERIFIED (D48 review blocker)
    ( cd "$T/skip" && "$LOKI" verify ) < /dev/null > "$T/skipv.log" 2>&1; VRC=$?
    if [ "$VRC" -eq 4 ] && ! sed 's/\x1b\[[0-9;]*m//g' "$T/skipv.log" | grep -Eqi 'VERDICT:? *VERIFIED|^VERIFIED'; then
        res PASS skip-bare-verify "bare verify after a failed default run: rc=$VRC, $(head -1 "$T/skipv.log")"
    else res FAIL skip-bare-verify "bare verify after a failed default run: rc=$VRC, $(head -1 "$T/skipv.log")"; fi
  fi
    # 9b. the same skip under the escape hatch (LOKI_ENGINE=legacy `loki quick`, D48): the headline must not be a verified verdict. Its rc is reported, not
    #     asserted: legacy prints NOT VERIFIED but can exit 0 (exit-honest policy, G1's domain).
    mkdir -p "$T/skipl" && mk_bugrepo "$T/skipl"
    ( cd "$T/skipl" && FRG_SKIP=1 LOKI_ENGINE=legacy "$LOKI" quick "$TASK" ) < /dev/null > "$T/skipl.log" 2>&1; LRC=$?
    HH=$(sed 's/\x1b\[[0-9;]*m//g' "$T/out.log" | grep -Ei '^Outcome:' | head -1)
    if [ "$ENGINE" = legacy ]; then HH="main run headline not checked in legacy mode; 9b checked only the legacy skipped-target run above"; fi
    LH=$(sed 's/\x1b\[[0-9;]*m//g' "$T/skipl.log" | grep -Ei 'Evidence Receipt' | head -1)
    if [ "$LRC" -eq 3 ] && grep -Eqi 'NOT VERIFIED' <<<"$LH" && ! sed 's/\x1b\[[0-9;]*m//g' "$T/skipl.log" | grep -Eqi 'verdict: *verified|Evidence Receipt:? *VERIFIED'; then
        res PASS skip-not-verified-legacy "legacy skipped target: rc=3, headline: ${LH:-none} (honest run: ${HH:-none})"
    else res FAIL skip-not-verified-legacy "legacy skipped target: rc=$LRC, headline: ${LH:-none}"; fi
fi

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
