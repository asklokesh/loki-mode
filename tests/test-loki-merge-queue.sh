#!/usr/bin/env bash
# loki merge: serial queue, green-only, rebase-next, --dry-run. Uses a stub gh.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"
PASS=0; FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/repo"
cat > "$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1 $2" in
  "pr checks") [ "$3" = "12" ] && exit 1; exit 0 ;;
esac
exit 0
STUB
chmod +x "$WORK/bin/gh"
export STUB_LOG="$WORK/calls.log"; : > "$STUB_LOG"
export PATH="$WORK/bin:$PATH" LOKI_MERGE_POLL_S=0
cd "$WORK/repo" || exit 1

bash "$LOKI" merge add 11 12 13 >/dev/null
[ "$(wc -l < .loki/merge-queue | tr -d ' ')" = "3" ] && ok "add queues three PRs" || bad "add"

OUT="$(bash "$LOKI" merge run --dry-run)"
echo "$OUT" | grep -q "#12: checks not green, would skip" && ok "dry-run flags red PR" || bad "dry-run red: $OUT"
grep -q "pr merge\|update-branch" "$STUB_LOG" && bad "dry-run mutated" || ok "dry-run makes no merge or rebase call"

OUT="$(bash "$LOKI" merge run)"; RC=$?
grep -q "^pr merge 11 " "$STUB_LOG" && ok "green PR 11 merged" || bad "11 not merged: $OUT"
grep -q "^pr merge 12" "$STUB_LOG" && bad "red PR 12 merged" || ok "red PR 12 never merged"
grep -q "^pr update-branch 12 --rebase" "$STUB_LOG" && ok "next PR rebased after merge" || bad "no rebase"
grep -q "^pr merge 13 " "$STUB_LOG" && ok "PR 13 merged after rebase" || bad "13 not merged"
[ "$RC" -ne 0 ] && [ "$(cat .loki/merge-queue)" = "12" ] && ok "red PR left in queue, nonzero exit" || bad "queue/rc: rc=$RC"

echo "Passed: $PASS Failed: $FAIL"
[ "$FAIL" -eq 0 ]
