#!/usr/bin/env bash
# tests/test-b9-scoreboard.sh -- R1-17: scripts/b9-scoreboard.sh dry-run rows and
# --emit-shape-defaults. A fake `loki` (B9_LOKI) and the script's own stub `claude`; no provider, no network.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
B9="$SCRIPT_DIR/../scripts/b9-scoreboard.sh"
# shellcheck source=../eval/loki10/lib-tmp.sh
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
if ! { [ "${FAKE_LOSE_ROUTER:-}" = 1 ] && [ "${LOKI_ROUTER:-}" = 1 ] && [ -z "${LOKI_ROUTER_ADVISOR:-}" ]; }; then
    sed -i.bak 's/i = 1/i = 0/' sum.js && rm -f sum.js.bak
fi
mkdir -p .loki/runs/r1
printf '{"route":{"shape_key":"single-root:javascript"}}\n' > .loki/runs/r1/receipt.json
echo "Cost: \$0.0456"
FAKE
chmod +x "$T/fake-loki"

# 1. dry-run: one row per arm with solve, wall, usd, shape_key
env -u LOKI_RUN_TMP B9_LOKI="$T/fake-loki" bash "$B9" --dry-run --results-out "$T/results.tsv" > "$T/rows.txt" 2> "$T/err.txt"
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
bash "$B9" --emit-shape-defaults "$T/defaults.json" --results "$T/fixture.tsv"
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

# 4. no loss: empty map
grep -v 'repoB' "$T/fixture.tsv" > "$T/noloss.tsv"
bash "$B9" --emit-shape-defaults "$T/empty.json" --results "$T/noloss.tsv"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["shapes"]=={} else 1)' "$T/empty.json"
check emit-empty-when-no-loss $? "$(cat "$T/empty.json")"

# 5. usage errors
bash "$B9" --emit-shape-defaults "$T/x.json" > /dev/null 2>&1; [ $? -eq 2 ]; check emit-needs-results $? "expected rc 2"
bash "$B9" --bogus > /dev/null 2>&1; [ $? -eq 2 ]; check bad-flag-rc2 $? "expected rc 2"

echo "b9-scoreboard tests: $FAILS failure(s)"
[ "$FAILS" -eq 0 ]
