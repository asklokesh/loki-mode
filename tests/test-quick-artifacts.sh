#!/usr/bin/env bash
# A-132: `loki quick` on an existing repo must not commit HANDOFF.md, USAGE.md or
# a new lockfile for a one-character fix; run artifacts stay under .loki/.
# Stub provider, clean HOME, fixture under the run-owned temp dir (every git call
# on the fixture is `git -C "$FIX"`). Real-path run, about 2 minutes.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"
FIX="$T/repo"
mkdir -p "$T/home" "$T/bin" "$FIX"
PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1${2:+ ($2)}"; }

printf '{"name":"bugrepo","version":"1.0.0","scripts":{"test":"node --test"}}\n' > "$FIX/package.json"
printf 'function sum(arr) {\n  let total = 0;\n  for (let i = 1; i < arr.length; i++) total += arr[i];\n  return total;\n}\nmodule.exports = { sum };\n' > "$FIX/sum.js"
printf "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\ntest('sums', () => { assert.strictEqual(sum([1, 2, 3]), 6); });\n" > "$FIX/sum.test.js"
git -C "$FIX" init -q
git -C "$FIX" config user.email t@example.invalid
git -C "$FIX" config user.name t
git -C "$FIX" add package.json sum.js sum.test.js
git -C "$FIX" commit -q -m init

# Stub claude: fixes sum.js, also writes USAGE.md and a lockfile like a real agent
# would when the prompt demands it, then signals completion.
cat > "$T/bin/claude" <<'STUB'
#!/usr/bin/env bash
case " $* " in *" --help "*|*" --version "*) echo "claude stub 2.1.285 --settings --session-id --resume --model --dangerously-skip-permissions"; exit 0;; esac
[ -f sum.js ] && sed -i.bak 's/i = 1/i = 0/' sum.js && rm -f sum.js.bak
printf '%s\n' "$*" >> "$STUB_PROMPTS"
case "$*" in *USAGE_DOC_REQUIRED*) echo "# Usage" > USAGE.md;; esac
mkdir -p .loki/signals; echo "fixed sum loop" > .loki/signals/COMPLETION_REQUESTED
echo "stub claude done"
STUB
chmod +x "$T/bin/claude"

(
    cd "$FIX" || exit 2
    STUB_PROMPTS="$T/prompts.log" HOME="$T/home" PATH="$T/bin:$PATH" LOKI_NO_BROWSER=1 LOKI_SKIP_AUTH_PREFLIGHT=1 \
        "$REPO_ROOT/autonomy/loki" quick "fix the bug that makes the failing test in sum.test.js fail" < /dev/null > "$T/out.log" 2>&1
)
echo "loki quick rc=$?"

FILES="$(git -C "$FIX" ls-files)"
COMMITTED="$(git -C "$FIX" show --name-only --format= HEAD)"
echo "HEAD files: $(echo "$COMMITTED" | tr '\n' ' ')"
echo "$FILES" | grep -qx 'sum.js' && [ "$(git -C "$FIX" rev-list --count HEAD)" -ge 2 ] \
    && ok "the fix is committed" || bad "the fix is not committed"
for f in HANDOFF.md USAGE.md package-lock.json; do
    if echo "$FILES" | grep -qx "$f"; then bad "$f is tracked after quick"; else ok "$f not committed"; fi
done
if grep -q USAGE_DOC_REQUIRED "$T/prompts.log" 2>/dev/null; then bad "prompt still requests USAGE.md" "real quick path"; else ok "prompt does not request USAGE.md"; fi
STRAY="$(git -C "$FIX" ls-files -o | grep -v '^\.loki/' || true)"
[ -z "$STRAY" ] && ok "no untracked files outside .loki/" || bad "untracked files outside .loki/" "$(echo "$STRAY" | tr '\n' ' ')"
[ -f "$FIX/HANDOFF.md" ] && bad "HANDOFF.md written at the repo root" || ok "no HANDOFF.md at the repo root"
[ -f "$FIX/.loki/HANDOFF.md" ] && ok ".loki/HANDOFF.md exists" || bad ".loki/HANDOFF.md missing"

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
