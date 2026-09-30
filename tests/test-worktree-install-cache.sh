#!/usr/bin/env bash
# E-130: create_worktree must cache the npm install keyed on the lockfile hash
# under <project>/.loki/cache/install. Drives _loki_npm_install_cached from
# run.sh with a fake npm that counts invocations.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SCRIPT="${RUN_SCRIPT:-$REPO_ROOT/autonomy/run.sh}"
PASS=0
FAIL=0
ok()  { echo "ok: $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

# shellcheck disable=SC1091
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
unset LOKI_RUN_TMP
loki_run_tmp_create || exit 1
T="$LOKI_RUN_TMP"
trap 'loki_run_tmp_cleanup' EXIT

FN_SRC="$(awk '/^_loki_npm_install_cached\(\) \{/{f=1} f{print} f && /^\}/{exit}' "$RUN_SCRIPT")"
if [ -z "$FN_SRC" ]; then
  echo "FAIL: _loki_npm_install_cached not found in $RUN_SCRIPT"
  exit 1
fi
eval "$FN_SRC"

# Fake npm: appends to a counter file, creates node_modules
mkdir -p "$T/bin"
cat >"$T/bin/npm" <<'EOF'
#!/bin/sh
echo x >>"$FAKE_NPM_COUNT"
mkdir -p node_modules/pkg && echo "$$" >node_modules/pkg/index.js
EOF
chmod +x "$T/bin/npm"
export PATH="$T/bin:$PATH"
export FAKE_NPM_COUNT="$T/npm-count"
CACHE="$T/proj/.loki/cache/install"

installs() { if [ -f "$FAKE_NPM_COUNT" ]; then wc -l <"$FAKE_NPM_COUNT" | tr -d ' '; else echo 0; fi; }
mkwt() { # name, lock content
  mkdir -p "$T/$1"
  echo '{"name":"a"}' >"$T/$1/package.json"
  echo "$2" >"$T/$1/package-lock.json"
}

# 1. miss installs and stores; hit reuses without npm
mkwt w1 lockA
_loki_npm_install_cached "$CACHE" "$T/w1"
[ "$(installs)" = "1" ] && [ -f "$T/w1/node_modules/pkg/index.js" ] && ok "cold miss runs npm once" || bad "cold miss runs npm once (installs=$(installs))"
mkwt w2 lockA
_loki_npm_install_cached "$CACHE" "$T/w2"
if [ "$(installs)" = "1" ] && [ -f "$T/w2/node_modules/pkg/index.js" ]; then ok "hit reuses cache, no npm run"; else bad "hit reuses cache, no npm run (installs=$(installs))"; fi

# 2. changed lockfile misses
mkwt w3 lockB
_loki_npm_install_cached "$CACHE" "$T/w3"
[ "$(installs)" = "2" ] && ok "changed lockfile misses" || bad "changed lockfile misses (installs=$(installs))"

# 3. corrupt entries fall back to a fresh install
for e in "$CACHE"/*/; do rm -f "${e}.complete"; done
mkwt w4 lockA
_loki_npm_install_cached "$CACHE" "$T/w4"
[ "$(installs)" = "3" ] && [ -f "$T/w4/node_modules/pkg/index.js" ] && ok "entry without .complete marker falls back to install" || bad "entry without marker falls back (installs=$(installs))"
for e in "$CACHE"/*/; do rm -rf "${e}node_modules"; done
mkwt w5 lockA
_loki_npm_install_cached "$CACHE" "$T/w5"
[ "$(installs)" = "4" ] && [ -f "$T/w5/node_modules/pkg/index.js" ] && ok "entry without node_modules falls back to install" || bad "entry without node_modules falls back (installs=$(installs))"
mkwt w6 lockA
_loki_npm_install_cached "$CACHE" "$T/w6"
[ "$(installs)" = "4" ] && ok "corrupt entry was repaired (next call hits)" || bad "corrupt entry repaired (installs=$(installs))"

# 4. concurrent creation is safe
rm -rf "$CACHE"
: >"$FAKE_NPM_COUNT"
pids=()
for i in 1 2 3 4 5 6; do
  mkwt "c$i" lockC
  _loki_npm_install_cached "$CACHE" "$T/c$i" &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done
good=0
for i in 1 2 3 4 5 6; do [ -f "$T/c$i/node_modules/pkg/index.js" ] && good=$((good + 1)); done
leftover="$(find "$CACHE" -maxdepth 1 -name '.tmp.*' 2>/dev/null | wc -l | tr -d ' ')"
entries="$(find "$CACHE" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
if [ "$good" = "6" ] && [ "$leftover" = "0" ] && [ "$entries" = "1" ] && [ -f "$(find "$CACHE" -mindepth 2 -maxdepth 2 -name .complete | head -1)" ]; then
  ok "concurrent creation: 6 worktrees ok, one complete entry, no temp leftovers"
else
  bad "concurrent creation (good=$good leftover=$leftover entries=$entries)"
fi

# 5. wiring: create_worktree uses the helper and strips the cache from the .loki copy
cw="$(awk '/^create_worktree\(\) \{/{f=1} f{print} f && /^\}/{exit}' "$RUN_SCRIPT")"
case "$cw" in *_loki_npm_install_cached*) ok "create_worktree calls the cached installer" ;; *) bad "create_worktree calls the cached installer" ;; esac
case "$cw" in *'.loki/cache/install'*) ok "create_worktree keeps the cache out of the worktree" ;; *) bad "create_worktree keeps the cache out of the worktree" ;; esac

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
