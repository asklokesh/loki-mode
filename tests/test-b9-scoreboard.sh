#!/usr/bin/env bash
# tests/test-b9-scoreboard.sh -- R1-17: scripts/b9-scoreboard.sh dry-run rows and
# --emit-shape-defaults. A fake `loki` (B9_LOKI) and the script's own stub `claude`; no provider, no network.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
B9="$SCRIPT_DIR/../scripts/b9-scoreboard.sh"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
export LOKI_NO_BROWSER=1
FAILS=0
check() { # check name rc detail
    if [ "$2" -eq 0 ]; then echo "PASS $1"; else echo "FAIL $1: $3"; FAILS=$((FAILS + 1)); fi
}

# Fake loki: fixes the bug (unless FAKE_LOSE_ROUTER=1 and this is the router arm), writes a
# receipt carrying route.shape_key, prints a cost line.
cat > "$T/fake-loki" <<'FAKE'
#!/usr/bin/env bash
[ -z "${B9_ENVLOG:-}" ] || echo "ROUTER=${LOKI_ROUTER-unset} ADVISOR=${LOKI_ROUTER_ADVISOR-unset} HOME=$HOME" >> "$B9_ENVLOG"
[ -z "${FAKE_SLEEP:-}" ] || sleep "$FAKE_SLEEP"
[ -z "${FAKE_LOKI_FAIL:-}" ] || { echo "loki: internal error"; exit 1; }
if ! { [ "${FAKE_LOSE_ROUTER:-}" = 1 ] && [ "${LOKI_ROUTER:-}" = 1 ] && [ -z "${LOKI_ROUTER_ADVISOR:-}" ]; }; then
    sed -i.bak 's/i = 1/i = 0/' sum.js && rm -f sum.js.bak
fi
mkdir -p .loki/runs/r1
printf '{"route":{"shape_key":"single-root:javascript"}}\n' > .loki/runs/r1/receipt.json
echo "Cost: \$0.0456"
FAKE
chmod +x "$T/fake-loki"

# 1. dry-run: one row per arm with solve, wall, usd, shape_key
env -u LOKI_RUN_TMP B9_ENVLOG="$T/envlog.txt" LOKI_ROUTER_ADVISOR=on B9_LOKI="$T/fake-loki" bash "$B9" --dry-run --results-out "$T/results.tsv" > "$T/rows.txt" 2> "$T/err.txt"
RC=$?
check dry-run-rc "$RC" "rc=$RC: $(cat "$T/err.txt")"
ROWS=$(grep -c 'b9-scoreboard arm ' "$T/rows.txt")
check one-row-per-arm "$(( ROWS == 4 ? 0 : 1 ))" "rows=$ROWS"
for a in "1 raw" "2 router" "3 no-router" "4 no-advisor"; do
    grep -q "b9-scoreboard arm $a | " "$T/rows.txt"; check "row-arm-${a// /-}" $? "missing"
done
SR=$(grep -Ec 'solved=1 wall=[0-9]+s usd=[0-9.]+ shape_key=' "$T/rows.txt")
check rows-have-all-fields "$(( SR == 4 ? 0 : 1 ))" "rows with solved/wall/usd/shape_key: $SR of 4"
grep -q 'arm 1 raw .*usd=0.0123 shape_key=unknown' "$T/rows.txt"; check raw-usd-from-json $? "$(cat "$T/rows.txt")"
grep -q 'arm 2 router .*usd=0.0456 shape_key=single-root:javascript' "$T/rows.txt"; check router-shape-from-receipt $? "$(cat "$T/rows.txt")"
TL=$(wc -l < "$T/results.tsv" | tr -d ' ')
check results-tsv-lines "$(( TL == 4 ? 0 : 1 ))" "lines=$TL"

# 1b. exact env per arm (arms 2-4 call loki in order); an inherited ADVISOR=on must not leak into arms 2 and 3
EXPECT=$(printf 'ROUTER=1 ADVISOR=unset\nROUTER=0 ADVISOR=unset\nROUTER=1 ADVISOR=off\n')
GOT=$(sed 's/ HOME=.*//' "$T/envlog.txt")
check exact-env-per-arm "$(if [ "$GOT" = "$EXPECT" ]; then echo 0; else echo 1; fi)" "got: $GOT"
grep -q "HOME=$HOME\$" "$T/envlog.txt"; check dry-run-overrides-home "$(( $? == 0 ? 1 : 0 ))" "dry-run HOME should be a throwaway dir"

# 1c. real mode leaves HOME alone, and a stuck run is cut by --timeout
mkdir -p "$T/realsrc" "$T/bin"
printf 'function sum(arr) {\n  let total = 0;\n  for (let i = 1; i < arr.length; i++) total += arr[i];\n  return total;\n}\nmodule.exports = { sum };\n' > "$T/realsrc/sum.js"
printf "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\ntest('sums', () => { assert.strictEqual(sum([1, 2, 3]), 6); });\n" > "$T/realsrc/sum.test.js"
( cd "$T/realsrc" && git init -q && git config user.email t@example.invalid && git config user.name t \
    && git add sum.js sum.test.js && git commit -q -m init )
RBASE=$(git -C "$T/realsrc" rev-parse HEAD)
cat > "$T/bin/claude" <<'FC'
#!/usr/bin/env bash
echo "HOME=$HOME" >> "$B9_ENVLOG"
case " $* " in *"single word OK"*) PF=1 ;; *) PF=0 ;; esac
case "${FAKE_CLAUDE_MODE:-}" in
    auth) echo "Not logged in. Please run /login"; exit 1 ;;
    workerr) [ "$PF" = 1 ] || { echo "API Error: boom"; exit 1; } ;;
esac
[ -f sum.js ] && sed -i.bak 's/i = 1/i = 0/' sum.js && rm -f sum.js.bak
echo '{"total_cost_usd": 0.01}'
FC
chmod +x "$T/bin/claude"
: > "$T/real-envlog.txt"
PATH="$T/bin:$PATH" env -u LOKI_RUN_TMP B9_ENVLOG="$T/real-envlog.txt" B9_LOKI="$T/fake-loki" \
    bash "$B9" --repo "$T/realsrc" --base "$RBASE" --test-cmd "node --test" --n 1 > "$T/real.txt" 2>&1
check real-mode-rc $? "$(cat "$T/real.txt")"
BADHOME=$(grep -vc "HOME=$HOME\$" "$T/real-envlog.txt")
check real-mode-keeps-home "$(( BADHOME == 0 && $(wc -l < "$T/real-envlog.txt") == 8 ? 0 : 1 ))" "$(cat "$T/real-envlog.txt")"
grep -c 'solved=1' "$T/real.txt" | grep -qx 4; check real-mode-solves-all-arms $? "$(cat "$T/real.txt")"
PATH="$T/bin:$PATH" env -u LOKI_RUN_TMP FAKE_SLEEP=5 B9_ENVLOG="$T/real-envlog.txt" B9_LOKI="$T/fake-loki" \
    bash "$B9" --repo "$T/realsrc" --base "$RBASE" --test-cmd "node --test" --n 1 --timeout 1 > "$T/timeout.txt" 2>&1
grep -q 'arm 2 router .*solved=0' "$T/timeout.txt" && grep -q 'arm 1 raw .*solved=1' "$T/timeout.txt"
check real-run-timeout-cuts-stuck-arm $? "$(cat "$T/timeout.txt")"

# 1d. BLOCKED, never solved=0: failed auth preflight, and an error before any work
real_run() { # real_run outfile [extra env assignments...]
    local out="$1"; shift
    PATH="$T/bin:$PATH" env -u LOKI_RUN_TMP B9_ENVLOG="$T/real-envlog.txt" B9_LOKI="$T/fake-loki" "$@" \
        bash "$B9" --repo "$T/realsrc" --base "$RBASE" --test-cmd "node --test" --n 1 --results-out "$out.tsv" > "$out" 2>&1
}
real_run "$T/auth.txt" FAKE_CLAUDE_MODE=auth
AR=$?
check auth-fail-exit-3 "$(( AR == 3 ? 0 : 1 ))" "rc=$AR"
BL=$(grep -c 'BLOCKED reason=.*Not logged in' "$T/auth.txt")
check auth-fail-all-arms-blocked "$(( BL == 4 ? 0 : 1 ))" "$(cat "$T/auth.txt")"
grep -q 'solved=' "$T/auth.txt"; check auth-fail-no-solved-field "$(( $? == 0 ? 1 : 0 ))" "$(cat "$T/auth.txt")"
real_run "$T/werr.txt" FAKE_CLAUDE_MODE=workerr
grep -q 'arm 1 raw .*BLOCKED reason=.*boom' "$T/werr.txt" && grep -q 'arm 2 router .*solved=1' "$T/werr.txt"
check error-before-work-blocked "$?" "$(cat "$T/werr.txt")"
grep -q '^1	.*	BLOCKED	' "$T/werr.txt.tsv"; check blocked-recorded-in-results-tsv $? "$(cat "$T/werr.txt.tsv")"
real_run "$T/lokierr.txt" FAKE_LOKI_FAIL=1
grep -q 'arm 3 no-router .*BLOCKED' "$T/lokierr.txt"; check loki-error-before-work-blocked $? "$(cat "$T/lokierr.txt")"
real_run "$T/ok.txt"
NB=$(grep -c BLOCKED "$T/ok.txt"); check preflight-success-gives-normal-rows "$(( NB == 0 ? 0 : 1 ))" "$(cat "$T/ok.txt")"

# 2. router loses: its row says solved=0, the control still solves
env -u LOKI_RUN_TMP FAKE_LOSE_ROUTER=1 B9_LOKI="$T/fake-loki" bash "$B9" --dry-run > "$T/lose.txt" 2>&1
grep -q 'arm 2 router .*solved=0' "$T/lose.txt" && grep -q 'arm 3 no-router .*solved=1' "$T/lose.txt"
check losing-router-solved-0 $? "$(cat "$T/lose.txt")"

# 3. --emit-shape-defaults lists exactly the shape where the router solved fewer than raw
{
    for r in 1 2 3; do
        printf '1\trepoA\t%s\t1\t10\t0.10\tunknown\n' "$r"
        printf '2\trepoA\t%s\t1\t10\t0.05\tsingle:node\n' "$r"
        printf '1\trepoB\t%s\t1\t10\t0.10\tunknown\n' "$r"
    done
    printf '2\trepoB\t1\t1\t10\t0.05\tmulti-root:python+typescript\n'
    printf '2\trepoB\t2\t0\t10\t0.05\tmulti-root:python+typescript\n'
    printf '2\trepoB\t3\t0\t10\t0.05\tmulti-root:python+typescript\n'
    printf '3\trepoB\t1\t0\t10\t0.05\tmulti-root:python+typescript\n'
} > "$T/fixture.tsv"
printf '2\trepoB\t1\t1\t10\t0.08\tmulti-root:python+typescript\n2\trepoB\t2\t1\t10\t0.08\tmulti-root:python+typescript\n2\trepoB\t3\t1\t10\t0.08\tmulti-root:python+typescript\n' > "$T/confirm-win.tsv"
printf '2\trepoB\t1\t0\t10\t0.08\tmulti-root:python+typescript\n2\trepoB\t2\t1\t10\t0.08\tmulti-root:python+typescript\n2\trepoB\t3\t0\t10\t0.08\tmulti-root:python+typescript\n' > "$T/confirm-lose.tsv"
bash "$B9" --emit-shape-defaults "$T/defaults.json" --results "$T/fixture.tsv" --confirm-results "$T/confirm-win.tsv"
check emit-rc $? "nonzero rc"
python3 - "$T/defaults.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["$schema_version"] == 1, d
assert list(d["shapes"]) == ["multi-root:python+typescript"], d
e = d["shapes"]["multi-root:python+typescript"]
assert e["executor"] == "sonnet" and "1/3" in e["evidence"] and "3/3" in e["evidence"], e
PY
check emit-lists-exactly-the-losing-shape $? "$(cat "$T/defaults.json")"

# 3b. confirming rerun (seeded file present): Sonnet wins -> sonnet; Sonnet also loses -> prior-default
bash "$B9" --emit-shape-defaults "$T/win.json" --results "$T/fixture.tsv" --confirm-results "$T/confirm-win.tsv"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if {k:v["executor"] for k,v in d["shapes"].items()}=={"multi-root:python+typescript":"sonnet"} else 1)' "$T/win.json"
check emit-sonnet-when-rerun-wins $? "$(cat "$T/win.json")"
bash "$B9" --emit-shape-defaults "$T/lose.json" --results "$T/fixture.tsv" --confirm-results "$T/confirm-lose.tsv"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if {k:v["executor"] for k,v in d["shapes"].items()}=={"multi-root:python+typescript":"prior-default"} else 1)' "$T/lose.json"
check emit-prior-default-when-rerun-loses $? "$(cat "$T/lose.json")"

# 3c. an unconfirmed single loss never seeds a default: --confirm-results is required
bash "$B9" --emit-shape-defaults "$T/unconf.json" --results "$T/fixture.tsv" > /dev/null 2> "$T/unconf.err"
RCU=$?
check emit-requires-confirm-results "$(( RCU == 2 ? 0 : 1 ))" "rc=$RCU"
grep -q 'confirm-results' "$T/unconf.err"; check emit-confirm-message $? "$(cat "$T/unconf.err")"
check emit-confirm-writes-nothing "$(if [ -e "$T/unconf.json" ]; then echo 1; else echo 0; fi)" "file written"

# 3d. BLOCKED rows never feed a default: a BLOCKED Haiku arm (arm 2) must not seed sonnet,
# and a BLOCKED confirming rerun leaves the shape unconfirmed (not emitted)
{
    for r in 1 2 3; do
        printf '1\trepoC\t%s\t1\t10\t0.10\tunknown\n' "$r"
        printf '2\trepoC\t%s\tBLOCKED\t0\tunknown\tblocked-shape\tnot logged in\n' "$r"
    done
} > "$T/blocked.tsv"
{ cat "$T/confirm-win.tsv"; printf "2\trepoC\t1\t1\t10\t0.08\tblocked-shape\n2\trepoC\t2\t1\t10\t0.08\tblocked-shape\n2\trepoC\t3\t1\t10\t0.08\tblocked-shape\n"; } > "$T/confirm-c.tsv"
bash "$B9" --emit-shape-defaults "$T/b1.json" --results "$T/blocked.tsv" --confirm-results "$T/confirm-c.tsv" 2>/dev/null
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["shapes"]=={} else 1)' "$T/b1.json"
check blocked-arm-emits-no-default $? "$(cat "$T/b1.json")"
printf '2\trepoB\t1\tBLOCKED\t0\tunknown\tunknown\tauth\n2\trepoB\t2\tBLOCKED\t0\tunknown\tunknown\tauth\n2\trepoB\t3\tBLOCKED\t0\tunknown\tunknown\tauth\n' > "$T/confirm-blocked.tsv"
bash "$B9" --emit-shape-defaults "$T/b2.json" --results "$T/fixture.tsv" --confirm-results "$T/confirm-blocked.tsv" 2>/dev/null
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["shapes"]=={} else 1)' "$T/b2.json"
check blocked-confirm-leaves-shape-unemitted $? "$(cat "$T/b2.json")"

# 3e. --emit-seed: unconfirmed loss shapes, provisional, never BLOCKED, never the shipped path
bash "$B9" --emit-seed "$T/seed.json" --results "$T/fixture.tsv"
check emit-seed-rc $? "nonzero rc"
python3 - "$T/seed.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d["_provisional"] is True, d
assert "emit-seed" in d["_source"] and "fixture.tsv" in d["_source"], d
assert list(d["shapes"]) == ["multi-root:python+typescript"], d
assert d["shapes"]["multi-root:python+typescript"]["executor"] == "sonnet", d
PY
check emit-seed-only-loss-shapes-provisional $? "$(cat "$T/seed.json")"
bash "$B9" --emit-seed "$T/seed-b.json" --results "$T/blocked.tsv" 2>/dev/null
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["shapes"]=={} and d["_provisional"] is True else 1)' "$T/seed-b.json"
check emit-seed-never-seeds-blocked $? "$(cat "$T/seed-b.json")"
SHIPPED="$SCRIPT_DIR/../loki-ts/data/router-shape-defaults.json"
BEFORE=$(if [ -e "$SHIPPED" ]; then cksum < "$SHIPPED"; else echo absent; fi)
bash "$B9" --emit-seed "$SHIPPED" --results "$T/fixture.tsv" > /dev/null 2>&1
RCS=$?
AFTER=$(if [ -e "$SHIPPED" ]; then cksum < "$SHIPPED"; else echo absent; fi)
check emit-seed-refuses-shipped-path "$(( RCS == 2 ? 0 : 1 ))" "rc=$RCS"
check emit-seed-shipped-file-unchanged "$(if [ "$BEFORE" = "$AFTER" ]; then echo 0; else echo 1; fi)" "$BEFORE vs $AFTER"
bash "$B9" --emit-seed "$SCRIPT_DIR/../loki-ts/data/b9-seed-probe.json" --results "$T/fixture.tsv" > /dev/null 2>&1
RCD=$?
check emit-seed-refuses-data-dir "$(( RCD == 2 ? 0 : 1 ))" "rc=$RCD"
check emit-seed-data-dir-nothing-written "$(if [ -e "$SCRIPT_DIR/../loki-ts/data/b9-seed-probe.json" ]; then echo 1; else echo 0; fi)" "probe file exists"
ln -s "$SHIPPED" "$T/link-seed.json"
bash "$B9" --emit-seed "$T/link-seed.json" --results "$T/fixture.tsv" > /dev/null 2>&1
check emit-seed-refuses-symlink-to-shipped "$(( $? == 2 ? 0 : 1 ))" "symlink not refused"

# 4. no loss: empty map
grep -v 'repoB' "$T/fixture.tsv" > "$T/noloss.tsv"
bash "$B9" --emit-shape-defaults "$T/empty.json" --results "$T/noloss.tsv" --confirm-results "$T/confirm-win.tsv"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["shapes"]=={} else 1)' "$T/empty.json"
check emit-empty-when-no-loss $? "$(cat "$T/empty.json")"

# 6b. a recorded usd of 0 is NOT RECORDED, never a free router
for r in 1 2 3; do printf '2\tx\t%s\t1\t10\t0\ts\t1\t1\t1\t1\t0\n3\tx\t%s\t1\t10\t1\ts\t1\t1\t1\t1\t0\n' "$r" "$r"; done > "$T/zero.tsv"
bash "$B9" --summarize "$T/zero.tsv" > "$T/zero.txt"
grep -q '^gate_1_05=FAIL$' "$T/zero.txt" && ! grep -q '^gate_1_05=PASS$' "$T/zero.txt"; check arm2-zero-usd-fails-gate $? "$(cat "$T/zero.txt")"
grep -q 'summary arm 2 router usd: NOT RECORDED (0 of 3 runs)' "$T/zero.txt" && grep -q '^router_cost_ratio=NOT RECORDED$' "$T/zero.txt"; check zero-usd-is-not-recorded-not-numeric-zero $? "$(cat "$T/zero.txt")"

# 5. usage errors
bash "$B9" --emit-shape-defaults "$T/x.json" > /dev/null 2>&1; RCU=$?; check emit-needs-results "$(( RCU == 2 ? 0 : 1 ))" "expected rc 2"
bash "$B9" --bogus > /dev/null 2>&1; RCU=$?; check bad-flag-rc2 "$(( RCU == 2 ? 0 : 1 ))" "expected rc 2"

# 6. R1-19 measurement: usage fields, --repeat, NOT RECORDED, router_cost_ratio and gate_1_05
cat > "$T/fake-loki-usage" <<'FAKE'
#!/usr/bin/env bash
sed -i.bak 's/i = 1/i = 0/' sum.js && rm -f sum.js.bak
mkdir -p .loki/metrics
if [ "${LOKI_ROUTER:-}" = 1 ] && [ -z "${LOKI_ROUTER_ADVISOR:-}" ]; then
    printf '{"total_cost_usd":%s,"input_tokens":100,"output_tokens":50,"cache_read_tokens":1000,"cache_creation_tokens":200,"advisor_calls":0}\n' "${FAKE_ROUTER_USD:-0.06}" > .loki/metrics/result-cost-1.json
elif [ "${LOKI_ROUTER:-}" = 0 ]; then
    printf '{"total_cost_usd":0.05,"input_tokens":90,"output_tokens":40}\n' > .loki/metrics/result-cost-1.json
else
    printf '{"total_cost_usd":0.05,"input_tokens":90,"output_tokens":40,"cache_read_tokens":900,"cache_creation_tokens":0}\n' > .loki/metrics/result-cost-1.json
fi
FAKE
chmod +x "$T/fake-loki-usage"
env -u LOKI_RUN_TMP B9_LOKI="$T/fake-loki-usage" bash "$B9" --dry-run --repeat 3 --results-out "$T/u.tsv" > "$T/u.txt" 2> "$T/u.err"
check usage-repeat-rc $? "$(cat "$T/u.err")"
UR=$(grep -c 'b9-scoreboard arm ' "$T/u.txt")
check repeat-3-gives-12-rows "$(( UR == 12 ? 0 : 1 ))" "rows=$UR"
grep -q 'arm 2 router .*usd=0.06 .*cache_read=1000 cache_create=200 fresh_in=100 out=50 advisor_calls=0 |' "$T/u.txt"; check row-has-usage-fields $? "$(grep 'arm 2' "$T/u.txt")"
grep -q 'arm 3 no-router .*cache_read=NOT RECORDED cache_create=NOT RECORDED fresh_in=90 out=40 advisor_calls=NOT RECORDED |' "$T/u.txt"; check missing-fields-not-recorded-row $? "$(grep 'arm 3' "$T/u.txt")"
grep -q 'arm 1 raw .*cache_read=NOT RECORDED' "$T/u.txt"; check raw-stub-without-usage-not-recorded $? "$(grep 'arm 1' "$T/u.txt")"
grep -q 'summary arm 2 router usd: mean=0.0600 min=0.0600 max=0.0600 (n=3 of 3 runs)' "$T/u.txt"; check summary-mean-min-max $? "$(grep summary "$T/u.txt")"
grep -q 'summary arm 3 no-router cache_read: NOT RECORDED (0 of 3 runs)' "$T/u.txt"; check summary-not-recorded-never-zero $? "$(grep 'summary arm 3' "$T/u.txt")"
grep -q '^router_cost_ratio=1.2000$' "$T/u.txt" && grep -q '^gate_1_05=FAIL$' "$T/u.txt"; check ratio-1.2-fails-gate $? "$(grep -E 'ratio|gate' "$T/u.txt")"
env -u LOKI_RUN_TMP FAKE_ROUTER_USD=0.0525 B9_LOKI="$T/fake-loki-usage" bash "$B9" --dry-run --repeat 3 > "$T/u2.txt" 2>&1
grep -q '^router_cost_ratio=1.0500$' "$T/u2.txt" && grep -q '^gate_1_05=PASS$' "$T/u2.txt"; check ratio-1.05-passes-gate $? "$(grep -E 'ratio|gate' "$T/u2.txt")"
bash "$B9" --summarize "$T/u.tsv" > "$T/u3.txt"
check summarize-only-rc $? "rc"
grep -q '^gate_1_05=FAIL$' "$T/u3.txt"; check summarize-only-gate $? "$(cat "$T/u3.txt")"
# n=1 per arm and unrecorded dollars are FAIL with NOT RECORDED, never a false green
printf '2\tx\t1\t1\t10\t0.01\ts\t1\t1\t1\t1\t0\n3\tx\t1\t1\t10\t0.05\ts\t1\t1\t1\t1\t0\n' > "$T/n1.tsv"
bash "$B9" --summarize "$T/n1.tsv" > "$T/n1.txt"
grep -q '^router_cost_ratio=NOT RECORDED$' "$T/n1.txt" && grep -q '^gate_1_05=FAIL$' "$T/n1.txt"; check n1-is-not-a-pass $? "$(cat "$T/n1.txt")"
for r in 1 2 3; do printf '2\tx\t%s\t1\t10\tunknown\ts\n3\tx\t%s\t1\t10\t0.05\ts\n' "$r" "$r"; done > "$T/unk.tsv"
bash "$B9" --summarize "$T/unk.tsv" > "$T/unk.txt"
grep -q 'summary arm 2 router usd: NOT RECORDED' "$T/unk.txt" && grep -q '^gate_1_05=FAIL$' "$T/unk.txt"; check unknown-usd-not-zero-not-green $? "$(cat "$T/unk.txt")"

echo "b9-scoreboard tests: $FAILS failure(s)"
[ "$FAILS" -eq 0 ]
