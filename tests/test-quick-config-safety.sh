#!/usr/bin/env bash
# P0-t15 guards for `loki quick`: (1) a run started from $HOME must never move the
# user's real ~/.loki/config settings FILE (telemetry opt-out); (2) a python3 that
# exists but is broken must not stop the quiet re-exec. Stub provider, clean HOME,
# fixtures under the run-owned temp dir.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
mkdir -p "$T/bin"
PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1${2:+ ($2)}"; }

cat > "$T/bin/claude" <<'STUB'
#!/usr/bin/env bash
case " $* " in *" --help "*|*" --version "*) echo "claude stub 2.1.285 --settings --session-id --resume --model --dangerously-skip-permissions"; exit 0;; esac
[ -f sum.js ] && sed -i.bak 's/i = 1/i = 0/' sum.js && rm -f sum.js.bak
mkdir -p .loki/signals; echo "fixed sum loop" > .loki/signals/COMPLETION_REQUESTED
echo "stub claude done"
STUB
chmod +x "$T/bin/claude"

mk_fix() { # mk_fix <dir>
    local d="$1"
    mkdir -p "$d"
    printf '{"name":"bugrepo","version":"1.0.0","scripts":{"test":"node --test"}}\n' > "$d/package.json"
    printf 'function sum(arr) {\n  let total = 0;\n  for (let i = 1; i < arr.length; i++) total += arr[i];\n  return total;\n}\nmodule.exports = { sum };\n' > "$d/sum.js"
    printf "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\ntest('sums', () => { assert.strictEqual(sum([1, 2, 3]), 6); });\n" > "$d/sum.test.js"
    git -C "$d" init -q
    git -C "$d" config user.email t@example.invalid
    git -C "$d" config user.name t
    git -C "$d" add package.json sum.js sum.test.js
    git -C "$d" commit -q -m init
}
run_quick() { # run_quick <dir> <home> <pathprefix> <out>
    ( cd "$1" || exit 2
      env HOME="$2" PATH="$3:$T/bin:$PATH" LOKI_NO_BROWSER=1 LOKI_SKIP_AUTH_PREFLIGHT=1 \
          "$REPO_ROOT/autonomy/loki" quick "fix the bug that makes the failing test in sum.test.js fail" \
          < /dev/null > "$4" 2> "$4.err" )
}

# The real preflight block from init_loki_dir, extracted verbatim (a full run with cwd=$HOME
# never finishes quickly, and the block runs first thing in init_loki_dir).
BLOCK="$T/preflight.sh"
awk '/crash.sh.s disclosure sentinel can have left/{f=1} f{print} f&&/^    fi$/{exit}' "$REPO_ROOT/autonomy/run.sh" > "$BLOCK"
[ "$(wc -l < "$BLOCK")" -gt 3 ] || { bad "could not extract the preflight block"; exit 1; }
preflight() { # preflight <cwd> <home>
    ( cd "$1" && HOME="$2" bash -c "$(cat "$BLOCK"); mkdir -p .loki/config 2>/dev/null; true" ) >/dev/null 2>&1
}

# (1) cwd == $HOME with a real settings file at ~/.loki/config: must survive unchanged
mkdir -p "$T/home/.loki"
printf 'TELEMETRY_DISABLED=true\nOTHER=1\n' > "$T/home/.loki/config"
cp "$T/home/.loki/config" "$T/config.before"
preflight "$T/home" "$T/home"
if [ -f "$T/home/.loki/config" ] && cmp -s "$T/config.before" "$T/home/.loki/config"; then
    ok "run from HOME leaves ~/.loki/config untouched"
else
    bad "run from HOME clobbered ~/.loki/config"
fi

# (1b) even a sentinel-only file is never folded when .loki is ~/.loki
mkdir -p "$T/home1b/.loki"
printf 'DISCLOSURE_SHOWN=true\n' > "$T/home1b/.loki/config"
preflight "$T/home1b" "$T/home1b"
[ -f "$T/home1b/.loki/config" ] && ok "sentinel-only ~/.loki/config is left alone too" || bad "HOME .loki/config folded"

# (1c) a project config file with a real setting is not folded away
mkdir -p "$T/proj/.loki" "$T/home2"
printf 'TELEMETRY_DISABLED=true\n' > "$T/proj/.loki/config"
preflight "$T/proj" "$T/home2"
if [ -f "$T/proj/.loki/config" ] && grep -q '^TELEMETRY_DISABLED=true$' "$T/proj/.loki/config"; then
    ok "a non-sentinel project .loki/config file is not discarded"
else
    bad "a non-sentinel project .loki/config file was moved"
fi

# (1d) a sentinel-only project file IS folded so the config directory can be created
mkdir -p "$T/proj2/.loki" "$T/home2"
printf 'DISCLOSURE_SHOWN=true\n' > "$T/proj2/.loki/config"
preflight "$T/proj2" "$T/home2"
[ -d "$T/proj2/.loki/config" ] && ok "sentinel-only project file folds into the config directory" || bad "sentinel-only project file blocked the config directory"

# (2) python3 exists but is broken (CLT stub / pyenv shim): quick must still run
mkdir -p "$T/badpy" "$T/home3"
REAL_PY="$(command -v python3)"
# Fails only the re-exec import probe; everything else delegates so the rest of loki works.
printf '#!/bin/sh\n[ "$*" = "-c import os,signal" ] && exit 1\nexec "%s" "$@"\n' "$REAL_PY" > "$T/badpy/python3"
chmod +x "$T/badpy/python3"
mk_fix "$T/fix3"
run_quick "$T/fix3" "$T/home3" "$T/badpy" "$T/bad-out.log"
if grep -q 'Evidence Receipt' "$T/bad-out.log" 2>/dev/null; then
    ok "quick still completes with a broken python3 on PATH"
else
    bad "quick failed with a broken python3 on PATH" "$(tail -c 300 "$T/bad-out.log.err" | tr '\n' ' ')"
fi

printf 'passed=%d failed=%d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
