#!/usr/bin/env bash
# Guard: the run-owned temp cleanup helper must work when sourced under zsh.
# In zsh `path` is tied to $PATH, so a `local path=...` inside the stat helper
# emptied PATH, stat vanished, and cleanup refused (rc 64) and leaked the dir.
set -u
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="${LOKI_TMP_LIB:-$REPO_ROOT/eval/loki10/lib-tmp.sh}"
pass=0; fail=0
ok() { pass=$((pass + 1)); echo "  [PASS] $1"; }
bad() { fail=$((fail + 1)); echo "  [FAIL] $1"; }

if ! command -v zsh >/dev/null 2>&1; then
    echo "SKIP: zsh not installed"; echo "Results: 0 passed, 0 failed (skipped)"; exit 0
fi

out="$(zsh -f -c '
    unset LOKI_RUN_TMP
    source "$1" || exit 3
    loki_run_tmp_create || exit 4
    d="$LOKI_RUN_TMP"
    loki_run_tmp_cleanup; rc=$?
    if [ -e "$d" ]; then echo "LEAK rc=$rc $d"; rm -rf -- "$d"; else echo "GONE rc=$rc"; fi
' zsh "$LIB" 2>&1)"
case "$out" in
    "GONE rc=0") ok "cleanup sourced under zsh removes the run-owned dir (rc 0)" ;;
    *) bad "cleanup under zsh: $out" ;;
esac

for f in "$REPO_ROOT/CLAUDE.md" "$REPO_ROOT/docs/dev/tmp-cleanup.md" "$LIB"; do
    if grep -q 'bsd_fmt="\$2" path="\$3"' "$f"; then bad "$f still declares a local named path"; else ok "$(basename "$f") uses no local named path"; fi
done

echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
