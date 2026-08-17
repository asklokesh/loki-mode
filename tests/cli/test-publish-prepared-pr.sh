#!/usr/bin/env bash
# Deterministic acceptance for the explicit prepared-PR publication seam.
# Real git repositories + local bare remotes are used; GitHub is a fake `gh`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOKI="$ROOT/autonomy/loki"
TMP="$(mktemp -d -t loki-publish-pr-XXXX)"
trap 'rm -rf "$TMP"' EXIT
PASS=0 FAIL=0
ok() { echo "PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL: $1" >&2; FAIL=$((FAIL + 1)); }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${GH_LOG:?}"
case "$1 $2" in
  "pr list") printf '%s' "${GH_EXISTING_URL:-}"; exit 0 ;;
  "pr create")
    [ "${GH_CREATE_FAIL:-0}" = 1 ] && exit 1
    # Prove --body-file carries the exact prepared bytes, never a re-render.
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --body-file ]; then shift; sha256sum "$1" | awk '{print $1}' > "${GH_BODY_SHA:?}"; fi
      shift
    done
    printf '%s\n' 'https://github.com/acme/widget/pull/7'; exit 0 ;;
esac
exit 1
GH
chmod +x "$TMP/bin/gh"
export PATH="$TMP/bin:$PATH" GH_LOG="$TMP/gh.log" GH_BODY_SHA="$TMP/body.sha"

git init -q --bare "$TMP/remote.git"
git init -q "$TMP/repo"
git -C "$TMP/repo" config user.email test@example.com
git -C "$TMP/repo" config user.name Test
git -C "$TMP/repo" remote add origin "$TMP/remote.git"
printf 'base\n' > "$TMP/repo/app.txt"
git -C "$TMP/repo" add app.txt
git -C "$TMP/repo" commit -qm base
git -C "$TMP/repo" branch -M main
git -C "$TMP/repo" push -q -u origin main
git -C "$TMP/repo" checkout -qb issue/github-42
printf 'fixed\n' >> "$TMP/repo/app.txt"
git -C "$TMP/repo" commit -qam fix
mkdir -p "$TMP/repo/.loki/state"
printf 'Fix missing profile\n' > "$TMP/repo/.loki/state/pr-title.txt"
cat > "$TMP/repo/.loki/state/pr-body.md" <<'BODY'
Fixes #42

## Acceptance criteria
- Returns 404 for a missing user
- Adds a regression test

## Evidence Receipt
Tests: passed (npm test)
Build: passed (npm run build)
Rollback: git revert HEAD
BODY
expected_sha="$(sha256sum "$TMP/repo/.loki/state/pr-body.md" | awk '{print $1}')"

# Default remains non-mutating even when prepared artifacts exist.
: > "$GH_LOG"
(cd "$TMP/repo" && "$LOKI" ship --help >/dev/null)
if [ ! -s "$GH_LOG" ] && ! git -C "$TMP/remote.git" show-ref --verify --quiet refs/heads/issue/github-42; then
  ok "default/help path performs no GitHub or push mutation"
else bad "default/help path mutated"; fi

# Explicit success pushes once, publishes exact bytes, and records the URL.
: > "$GH_LOG"
out="$(cd "$TMP/repo" && "$LOKI" ship --publish 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] \
  && grep -q '^pr create ' "$GH_LOG" \
  && [ "$(cat "$GH_BODY_SHA")" = "$expected_sha" ] \
  && python3 - "$TMP/repo/.loki/state/pr.json" <<'PY'
import json, sys
p=json.load(open(sys.argv[1]))
assert p == {"state":"created","url":"https://github.com/acme/widget/pull/7",
             "branch":"issue/github-42","title":"Fix missing profile",
             "body_path":".loki/state/pr-body.md"}, p
PY
then ok "--publish creates a review-ready PR with exact prepared body"
else bad "explicit publish failed: rc=$rc out=$out"; fi

# Retry is idempotent: reuse an open URL and never call create.
: > "$GH_LOG"
export GH_EXISTING_URL='https://github.com/acme/widget/pull/7'
out="$(cd "$TMP/repo" && "$LOKI" ship --publish 2>&1)"; rc=$?
unset GH_EXISTING_URL
if [ "$rc" -eq 0 ] && ! grep -q '^pr create ' "$GH_LOG"; then
  ok "retry reuses the open PR without duplicate creation"
else bad "retry was not idempotent: $out"; fi

# Create failure is honest and reversible: artifacts remain byte-identical and
# no created state replaces the prepared record.
rm -f "$TMP/repo/.loki/state/pr.json" "$GH_BODY_SHA"
: > "$GH_LOG"
export GH_CREATE_FAIL=1
out="$(cd "$TMP/repo" && "$LOKI" ship --publish 2>&1)"; rc=$?
unset GH_CREATE_FAIL
after_sha="$(sha256sum "$TMP/repo/.loki/state/pr-body.md" | awk '{print $1}')"
if [ "$rc" -eq 1 ] && [ "$after_sha" = "$expected_sha" ] \
  && [ ! -e "$TMP/repo/.loki/state/pr.json" ] \
  && printf '%s' "$out" | grep -q 'Rollback remote branch:'; then
  ok "create failure preserves proof body and prints exact rollback"
else bad "failure path overstated or altered prepared evidence: rc=$rc out=$out"; fi

# Combining mutation with review/preview flags fails closed before gh.
: > "$GH_LOG"
(cd "$TMP/repo" && "$LOKI" ship --publish --preview >/dev/null 2>&1); rc=$?
if [ "$rc" -eq 2 ] && [ ! -s "$GH_LOG" ]; then
  ok "ambiguous publish combinations fail closed before GitHub"
else bad "ambiguous flags reached GitHub or returned $rc"; fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
