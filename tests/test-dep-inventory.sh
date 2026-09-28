#!/usr/bin/env bash
# D35 DEP-01: guards scripts/dep-inventory.py's Latest/Bump self-consistency
# (Tech Lead reject on 2cceecd2, item 1). The heavy lifting is the script's
# own --self-test (fixed fixtures, no network); this wrapper runs it and adds
# a couple of static checks on the current docs/v10/DEPS.md so a stale report
# doesn't silently drift from the generator.
set -u
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/dep-inventory.py"
DEPS="$REPO_ROOT/docs/v10/DEPS.md"

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "  [PASS] $1"; }
bad() { fail=$((fail + 1)); echo "  [FAIL] $1"; }

echo "T1 -- script's own offline self-test (Latest/Bump agreement fixtures)"
if python3 "$SCRIPT" --self-test; then
    ok "dep-inventory.py --self-test passed"
else
    bad "dep-inventory.py --self-test failed"
fi

echo
echo "T2 -- DEPS.md exists and is non-empty"
if [ -s "$DEPS" ]; then
    ok "$DEPS exists and is non-empty"
else
    bad "$DEPS is missing or empty"
fi

echo
echo "T3 -- DEPS.md carries no bare 'MAJOR' next-line claim for a 0.x package"
# A row whose Current starts with a 0.x version must never be labeled plain
# "minor"/"patch" in the Bump column -- it must say "0.x breaking".
if grep -qE '\| (fastapi|httpx|uvicorn|aiosqlite|esbuild|python-multipart) \| .0\.[0-9][^|]*\| [^|]*\| (patch|minor) \|' "$DEPS"; then
    bad "a 0.x package is still classified patch/minor instead of 0.x breaking"
else
    ok "no 0.x package left classified plain patch/minor"
fi

echo
echo "T4 -- DEPS.md summary table has a dedicated '0.x breaking' column"
if grep -q '0.x breaking' "$DEPS"; then
    ok "summary/table carries the 0.x breaking column"
else
    bad "0.x breaking column missing from DEPS.md"
fi

echo
echo "T5 -- every manifest git ls-files finds (by pattern) appears in DEPS.md"
# Tech Lead reject B1 on 9a438bdf: a hardcoded deploy/helm/ prefix silently
# skipped helm/loki-mode/. This checks every manifest CLASS against the
# generated report -- not just Chart.yaml, and not the generator's own
# self-test -- with patterns written independently of dep-inventory.py's own
# discovery regexes, so a future hardcoded-directory regression anywhere is
# caught here too. ".github/workflows/" is the one directory kept literal on
# purpose: GitHub Actions requires workflow files to live there.
t5_total=0
t5_missing=""
t5_check() {
    label="$1"; pattern="$2"
    count=0
    while IFS= read -r manifest; do
        [ -n "$manifest" ] || continue
        count=$((count + 1))
        t5_total=$((t5_total + 1))
        grep -qF "\`$manifest\`" "$DEPS" || t5_missing="$t5_missing [$label]$manifest"
    done < <(cd "$REPO_ROOT" && git ls-files | grep -E "$pattern")
    [ "$count" -gt 0 ] || t5_missing="$t5_missing [$label]NO-FILES-MATCHED-$pattern"
}
t5_check "package.json"     '(^|/)package\.json$'
t5_check "requirements.txt" 'requirements[^/]*\.txt$'
t5_check "pyproject.toml"   '(^|/)pyproject\.toml$'
t5_check "workflow"         '^\.github/workflows/[^/]+\.ya?ml$'
t5_check "action.yml"       '(^|/)action\.ya?ml$'
t5_check "Dockerfile"       '(^|/)Dockerfile[^/]*$'
t5_check "compose"          '(^|/)(docker-compose[^/]*\.ya?ml|compose\.ya?ml)$'
t5_check "Chart.yaml"       '(^|/)Chart\.yaml$'
t5_check "*.tf"             '\.tf$'
if [ -z "$t5_missing" ]; then
    ok "all $t5_total manifest file(s) across 9 classes appear in DEPS.md"
else
    bad "manifest file(s) missing from DEPS.md or a class had zero matches:$t5_missing"
fi

echo
echo "T6 -- self-test survives an unauthenticated, gh-less environment (E-92 guard 17)"
# E-92: main went red because --self-test made a real `gh api` call in CI
# that passed locally only because a working, authenticated `gh` happened
# to be on PATH there. Re-run under a stripped env (empty HOME so gh's own
# ~/.config/gh auth store is gone, no GH_TOKEN/GITHUB_TOKEN, and gh itself
# excluded from PATH wherever it lives outside /usr/bin:/bin) so a future
# unstubbed floating_tag/gh_release cache bucket fails here, unauthenticated,
# instead of on main. This does not block network access (npm/pypi/endoflife
# fetchers still reach it); it only removes gh's ability to authenticate.
t6_home="$(mktemp -d)"
t6_out="$(mktemp)"
if env -i HOME="$t6_home" PATH=/usr/bin:/bin python3 "$SCRIPT" --self-test >"$t6_out" 2>&1; then
    ok "self-test passes with HOME=empty dir, PATH=/usr/bin:/bin, no GH_TOKEN/GITHUB_TOKEN, gh absent from PATH"
else
    bad "self-test failed unauthenticated/gh-less (see $t6_out)"
    sed 's/^/    /' "$t6_out"
fi
rm -rf "$t6_home"
rm -f "$t6_out"

echo
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
