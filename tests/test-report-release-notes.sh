#!/usr/bin/env bash
# #391: `loki report release-notes <from>..<to> [--format json]` lists each commit under
# "changes" when its Loki-Run trailer names a run with a receipt.json, else under
# "not sealed". No existing test covers this user-facing command (tests/test-release-notes.sh
# covers scripts/release-notes.sh). Fixture repo and .loki live under the run-owned temp dir.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
LOKI="$REPO_ROOT/autonomy/loki"
PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1${2:+ ($2)}"; }

FIX="$T/fix"; mkdir -p "$FIX/.loki/runs"
G() { git -C "$FIX" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false "$@"; }
G init -q -b main
echo base > "$FIX/f"; G add f; G commit -q -m "base"
for i in 1 2 3 4 5; do
    echo "s$i" >> "$FIX/f"; G add f
    G commit -q -m "feat sealed $i" -m "Loki-Run: run-$i"
    mkdir -p "$FIX/.loki/runs/run-$i"
    printf '{"schema":"loki.v10.receipt/1","verdict":"VERIFIED"}\n' > "$FIX/.loki/runs/run-$i/receipt.json"
done
for i in 1 2; do
    echo "u$i" >> "$FIX/f"; G add f; G commit -q -m "plain change $i"
done
RUN() { (cd "$FIX" && LOKI_DIR="$FIX/.loki" LOKI_LEGACY_BASH=1 bash "$LOKI" report release-notes "$@"); }

TXT="$(RUN main~7..main 2>&1)"; rc=$?
[ "$rc" -eq 0 ] || bad "text range exits 0" "rc=$rc"
printf '%s\n' "$TXT" | grep -q '^changes (5)$' && ok "text: 5 changes" || bad "text: 5 changes" "$TXT"
printf '%s\n' "$TXT" | grep -q '^not sealed (2)$' && ok "text: 2 not sealed" || bad "text: 2 not sealed" "$TXT"
for i in 1 2 3 4 5; do
    printf '%s\n' "$TXT" | grep -q "feat sealed $i .*\[receipt run-$i\]" || bad "text: sealed $i names its receipt"
done
ok "text: every sealed row checked for its receipt id"

JSON="$(RUN main~7..main --format json 2>&1)"
n_c="$(printf '%s' "$JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["changes"]))' 2>/dev/null)"
n_u="$(printf '%s' "$JSON" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["not_sealed"]))' 2>/dev/null)"
[ "$n_c" = 5 ] && [ "$n_u" = 2 ] && ok "json: same 5 + 2 rows" || bad "json: same 5 + 2 rows" "changes=$n_c not_sealed=$n_u"
ids="$(printf '%s' "$JSON" | python3 -c 'import json,sys; print(",".join(sorted(r["receipt"] for r in json.load(sys.stdin)["changes"])))' 2>/dev/null)"
[ "$ids" = "run-1,run-2,run-3,run-4,run-5" ] && ok "json: receipt ids equal the text ids" || bad "json: receipt ids" "$ids"

# A trailer naming a run with no receipt is not sealed.
G commit -q --allow-empty -m "ghost" -m "Loki-Run: run-missing"
RUN main~1..main 2>&1 | grep -q '^not sealed (1)$' && ok "trailer without a receipt is not sealed" || bad "trailer without a receipt is not sealed"

RUN notarange >/dev/null 2>&1; [ $? -eq 2 ] && ok "malformed range exits 2" || bad "malformed range exits 2"
RUN nope..main >/dev/null 2>"$T/err"; rc=$?
[ "$rc" -eq 2 ] && grep -q 'Usage:' "$T/err" && ok "unresolvable range exits 2 with a usage line" || bad "unresolvable range exits 2 with usage" "rc=$rc"
E="$(RUN main..main 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && printf '%s\n' "$E" | grep -q '^changes (0)$' && printf '%s\n' "$E" | grep -q '^not sealed (0)$' && ok "empty range prints 0 rows and exits 0" || bad "empty range" "rc=$rc $E"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
