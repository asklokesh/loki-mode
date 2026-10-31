#!/usr/bin/env bash
# Guard: the run-owned temp cleanup helper must work when sourced under zsh,
# and its guarded reaper (loki_run_tmp_reap) must only remove aged, marked, idle dirs.
# In zsh `path` is tied to $PATH, so a `local path=...` inside the stat helper
# emptied PATH, stat vanished, and cleanup refused (rc 64) and leaked the dir.
set -u
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="${LOKI_TMP_LIB:-$REPO_ROOT/eval/loki10/lib-tmp.sh}"
pass=0; fail=0
ok() { pass=$((pass + 1)); echo "  [PASS] $1"; }
bad() { fail=$((fail + 1)); echo "  [FAIL] $1"; }

# --- guarded reaper (loki_run_tmp_reap): fixtures live only in a run-owned dir ---
reap_tests() {
    local R root held_pids="" out p
    # shellcheck disable=SC1090
    . "$LIB" || { bad "reaper: cannot source $LIB"; return; }
    if ! command -v lsof >/dev/null 2>&1; then echo "SKIP: reaper tests need lsof"; return; fi
    unset LOKI_RUN_TMP
    loki_run_tmp_create || { bad "reaper: cannot create fixture dir"; return; }
    R="$LOKI_RUN_TMP"
    root="$R/root"; mkdir "$root"; root="$(cd "$root" && pwd -P)"

    mk_run() { # name
        local d="$root/$1"; mkdir "$d"; chmod 700 "$d"
        printf '%s\n' "$d" >"$d/.loki-run-owned"; chmod 600 "$d/.loki-run-owned"
    }
    mk_home() { # name
        local d="$root/$1"; mkdir "$d"; chmod 700 "$d"
        printf '[user]\n\tname = loki-test\n\temail = loki-test@example.invalid\n' >"$d/.gitconfig"
    }
    age() { touch -t 200001010000 "$1"; }
    reap() { ( unset LOKI_RUN_TMP; TMPDIR="$root" loki_run_tmp_reap "$@" 2>&1 ); }

    mk_run loki-run.aged; age "$root/loki-run.aged"
    mk_home loki-test-home-aged; age "$root/loki-test-home-aged"

    out="$(reap dry)"
    if [ -d "$root/loki-run.aged" ] && [ -d "$root/loki-test-home-aged" ] \
        && printf '%s\n' "$out" | grep -q "WOULD-REAP $root/loki-run.aged" \
        && printf '%s\n' "$out" | grep -q "WOULD-REAP $root/loki-test-home-aged"; then
        ok "reaper dry-run lists aged marked dirs and deletes nothing"
    else bad "reaper dry-run: $out"; fi

    out="$(reap apply)"
    if [ ! -e "$root/loki-run.aged" ] && [ ! -e "$root/loki-test-home-aged" ] \
        && printf '%s\n' "$out" | grep -q 'df_avail_kb before=[0-9]* after=[0-9]* delta='; then
        ok "reaper real run removes aged marked dirs and reports the df delta"
    else bad "reaper apply: $out"; fi

    mk_run loki-run.open; echo x >"$root/loki-run.open/f"; age "$root/loki-run.open"
    sleep 60 3<"$root/loki-run.open/f" & p=$!; held_pids="$held_pids $p"
    mk_run loki-run.cwd; age "$root/loki-run.cwd"
    ( cd "$root/loki-run.cwd" && exec sleep 60 ) & p=$!; held_pids="$held_pids $p"
    sleep 1
    out="$(reap apply)"
    if [ -d "$root/loki-run.open" ] && printf '%s\n' "$out" | grep -q "SKIP in-use $root/loki-run.open"; then
        ok "reaper skips a dir with an open file"
    else bad "reaper open-file: $out"; fi
    if [ -d "$root/loki-run.cwd" ] && printf '%s\n' "$out" | grep -q "SKIP in-use $root/loki-run.cwd"; then
        ok "reaper skips a dir with a process cwd inside"
    else bad "reaper cwd: $out"; fi
    for p in $held_pids; do kill "$p" 2>/dev/null; wait "$p" 2>/dev/null; done

    mkdir "$root/loki-run.nomarker"; chmod 700 "$root/loki-run.nomarker"; age "$root/loki-run.nomarker"
    mkdir "$root/loki-test-home-nomarker"; chmod 700 "$root/loki-test-home-nomarker"; age "$root/loki-test-home-nomarker"
    out="$(reap apply)"
    if [ -d "$root/loki-run.nomarker" ] && [ -d "$root/loki-test-home-nomarker" ] \
        && printf '%s\n' "$out" | grep -q "REFUSE no-valid-marker $root/loki-run.nomarker"; then
        ok "reaper refuses a dir without its marker"
    else bad "reaper no-marker: $out"; fi

    mk_run loki-run.young
    out="$(reap apply)"
    if [ -d "$root/loki-run.young" ] && printf '%s\n' "$out" | grep -q "SKIP young $root/loki-run.young"; then
        ok "reaper skips a dir younger than 6h"
    else bad "reaper young: $out"; fi

    mkdir "$R/target"; ln -s "$R/target" "$root/loki-run.link"
    out="$(reap apply)"
    if [ -d "$R/target" ] && [ -L "$root/loki-run.link" ] && printf '%s\n' "$out" | grep -q "REFUSE symlink $root/loki-run.link"; then
        ok "reaper refuses a symlinked candidate"
    else bad "reaper symlink: $out"; fi

    mk_run loki-run.badmarker; printf '%s\n' "$root/other" >"$root/loki-run.badmarker/.loki-run-owned"; age "$root/loki-run.badmarker"
    out="$(reap apply)"
    if [ -d "$root/loki-run.badmarker" ] && printf '%s\n' "$out" | grep -q "REFUSE no-valid-marker $root/loki-run.badmarker"; then
        ok "reaper refuses a marker whose content differs"
    else bad "reaper bad-marker: $out"; fi

    loki_run_tmp_cleanup || bad "reaper: fixture cleanup refused"
}
reap_tests

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
