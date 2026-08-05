#!/usr/bin/env bash
# Client fix: the code_review gate must not choke on a directory that is
# git-TRACKED but listed in .gitignore (committed before the ignore rule). Such a
# dir bloats the review diff -> reviewer prompt overflow -> every reviewer
# NO_OUTPUT -> opaque block. This test EXTRACTS the REAL gitignore-filter block
# from autonomy/run.sh (not a hand-copy) and runs it against fixture repos, so a
# regression in the actual filter logic breaks this test.
#
# Asserts:
#   Fix 1: the tracked-but-gitignored dir is EXCLUDED at its EXACT depth, and a
#          REAL non-ignored sibling under the SAME top-level dir SURVIVES (the
#          council-caught over-exclusion / fail-closed hole).
#   Fix 2: an oversized context rejects explicitly before reviewer dispatch.
#   Fix 3: per-reviewer prompt sizes are logged + recorded.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0; FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

# ---- Extract the REAL filter block from run.sh by INDENTATION boundary: the
# guard is a 4-space-indented `if ...; then`, and its close is the first
# 4-space-indented bare `fi`. Robust to the nested if/case/while inside (which
# are all MORE indented), unlike keyword counting.
FILTER_BLOCK="$(awk '
  /^    if \[ "\$\{LOKI_REVIEW_GITIGNORE_FILTER:-1\}" != "0" \]; then/ { grab=1 }
  grab { print }
  grab && /^    fi$/ { exit }
' "$RUN_SH")"
if [ -z "$FILTER_BLOCK" ] || ! printf '%s' "$FILTER_BLOCK" | grep -q 'check-ignore'; then
    bad "could not extract the real filter block from run.sh (test harness broken)"
    echo "Total: $((PASS+FAIL))  Passed: $PASS  Failed: $FAIL"; exit 1
fi

# run_real_filter <fixture_dir> <base>: build _review_pathspec with base excludes,
# run the EXTRACTED real filter, then compute the review diff exactly as run.sh
# does (throwaway index add -A + diff --cached). Prints the diff.
run_real_filter() {
    local dir="$1" base="$2"
    (
        set +u
        cd "$dir" || exit 1
        log_warn() { :; }; log_info() { :; }
        TARGET_DIR="$dir"
        _review_pathspec=(-- . ':(exclude).loki/' ':(exclude).git/')
        # shellcheck disable=SC1090
        eval "$FILTER_BLOCK"
        local idx; idx="$(mktemp -u)"
        GIT_INDEX_FILE="$idx" git add -A 2>/dev/null
        GIT_INDEX_FILE="$idx" git diff --cached "$base" "${_review_pathspec[@]}" 2>/dev/null
        rm -f "$idx"
    )
}

# ---- Fixture A: whole-subdir ignored + a REAL non-ignored SIBLING under the
# SAME top-level dir (the exact over-exclusion the council caught). ----
FA="$(mktemp -d)"; trap 'rm -rf "$FA"' EXIT
(
  cd "$FA" || exit 1; git init -q; git config user.email t@t.com; git config user.name t
  mkdir -p .agents/skills
  for i in $(seq 1 20); do { printf 's %s\n' "$i"; head -c 300 /dev/zero | tr '\0' 'x'; printf '\n'; } > ".agents/skills/s-$i.md"; done
  echo "real config" > .agents/config.yaml
  echo "def f(): return 1" > app.py
  git add -A && git commit -qm base
  printf '.agents/skills/\n' > .gitignore && git add .gitignore && git commit -qm ignore
  echo "config CHANGED" > .agents/config.yaml
  echo "def f(): return 2" > app.py
  git add -A && git commit -qm "real changes"
) >/dev/null 2>&1
BASE_A="$(cd "$FA" && git rev-parse HEAD~1)"
DIFF_A="$(run_real_filter "$FA" "$BASE_A")"
[ "$(printf '%s' "$DIFF_A" | grep -c 'agents/skills')" -eq 0 ] \
    && ok "Fix 1 (real block): tracked-but-ignored .agents/skills EXCLUDED" \
    || bad "Fix 1: .agents/skills still in diff"
[ "$(printf '%s' "$DIFF_A" | grep -c 'agents/config.yaml')" -gt 0 ] \
    && ok "Fix 1 NO OVER-EXCLUSION: real sibling .agents/config.yaml SURVIVES (fail-closed hole closed)" \
    || bad "Fix 1 OVER-EXCLUSION REGRESSION: real .agents/config.yaml wrongly dropped"
[ "$(printf '%s' "$DIFF_A" | grep -c 'app.py')" -gt 0 ] \
    && ok "Fix 1: top-level real change app.py survives" \
    || bad "Fix 1: app.py wrongly dropped"

# ---- Fixture B: nested ignore (pkg/generated/ ignored, real pkg/keep.ts). ----
FB="$(mktemp -d)"; trap 'rm -rf "$FA" "$FB"' EXIT
(
  cd "$FB" || exit 1; git init -q; git config user.email t@t.com; git config user.name t
  mkdir -p pkg/generated
  for i in $(seq 1 10); do echo "gen $i" > "pkg/generated/g-$i.js"; done
  echo "keep real" > pkg/keep.ts
  git add -A && git commit -qm base
  printf 'pkg/generated/\n' > .gitignore && git add .gitignore && git commit -qm ignore
  echo "keep CHANGED" > pkg/keep.ts
  git add -A && git commit -qm "real change under partially-ignored dir"
) >/dev/null 2>&1
BASE_B="$(cd "$FB" && git rev-parse HEAD~1)"
DIFF_B="$(run_real_filter "$FB" "$BASE_B")"
[ "$(printf '%s' "$DIFF_B" | grep -c 'pkg/generated')" -eq 0 ] \
    && ok "Fix 1 (nested): pkg/generated excluded at exact depth" \
    || bad "Fix 1 (nested): pkg/generated still in diff"
[ "$(printf '%s' "$DIFF_B" | grep -c 'pkg/keep.ts')" -gt 0 ] \
    && ok "Fix 1 (nested) NO OVER-EXCLUSION: pkg/keep.ts survives (not collapsed to pkg/)" \
    || bad "Fix 1 (nested) OVER-EXCLUSION: pkg/keep.ts wrongly dropped (top-level collapse regression)"

# ---- Fixture C: nothing tracked-but-ignored -> byte-identical no-op. ----
FC="$(mktemp -d)"; trap 'rm -rf "$FA" "$FB" "$FC"' EXIT
(
  cd "$FC" || exit 1; git init -q; git config user.email t@t.com; git config user.name t
  echo "x" > a.py; git add -A && git commit -qm base
  echo "y" > a.py; git add -A && git commit -qm change
) >/dev/null 2>&1
BASE_C="$(cd "$FC" && git rev-parse HEAD~1)"
DF="$(run_real_filter "$FC" "$BASE_C" | wc -c | tr -d ' ')"
NF="$( (set +u; cd "$FC" || exit 1; log_warn(){ :;}; log_info(){ :;}; LOKI_REVIEW_GITIGNORE_FILTER=0; TARGET_DIR="$FC"; _review_pathspec=(-- . ':(exclude).loki/' ':(exclude).git/'); eval "$FILTER_BLOCK"; idx=$(mktemp -u); GIT_INDEX_FILE="$idx" git add -A 2>/dev/null; GIT_INDEX_FILE="$idx" git diff --cached "$BASE_C" "${_review_pathspec[@]}" 2>/dev/null; rm -f "$idx") | wc -c | tr -d ' ' )"
[ "$DF" = "$NF" ] && ok "no-op parity: identical diff when nothing is tracked-but-ignored" \
    || bad "filter changed the diff with nothing to exclude ($DF vs $NF)"

# ---- Fixture D: a ROOT-LEVEL ignored FILE (dirname ".") must be excluded by
# its exact path, and a real root sibling must survive. ----
FD="$(mktemp -d)"; trap 'rm -rf "$FA" "$FB" "$FC" "$FD"' EXIT
(
  cd "$FD" || exit 1; git init -q; git config user.email t@t.com; git config user.name t
  echo "log line" > debug.log
  echo "real src" > main.py
  git add -A && git commit -qm base
  printf 'debug.log\n' > .gitignore && git add .gitignore && git commit -qm ignore
  echo "log CHANGED" > debug.log
  echo "real CHANGED" > main.py
  git add -A && git commit -qm "real changes"
) >/dev/null 2>&1
BASE_D="$(cd "$FD" && git rev-parse HEAD~1)"
DIFF_D="$(run_real_filter "$FD" "$BASE_D")"
[ "$(printf '%s' "$DIFF_D" | grep -c 'debug.log')" -eq 0 ] \
    && ok "Fix 1 (root file): tracked-but-ignored root file debug.log EXCLUDED at exact path" \
    || bad "Fix 1 (root file): debug.log leaked into the diff (root-file exclude bug)"
[ "$(printf '%s' "$DIFF_D" | grep -c 'main.py')" -gt 0 ] \
    && ok "Fix 1 (root file): real root sibling main.py survives" \
    || bad "Fix 1 (root file): main.py wrongly dropped"

# ---- Fix 1/2/3 wiring present in run.sh ----
grep -q 'LOKI_REVIEW_GITIGNORE_FILTER' "$RUN_SH" && grep -q 'check-ignore --no-index --stdin' "$RUN_SH" \
    && ok "Fix 1 wired in run.sh" || bad "Fix 1 not wired in run.sh"
# the filter block must use dirname-depth exclusion, NOT a top-level prefix
# collapse (the council-caught over-exclusion bug). Check the EXTRACTED block.
if printf '%s' "$FILTER_BLOCK" | grep -q 'dirname "\$_f"' \
   && ! printf '%s' "$FILTER_BLOCK" | grep -q "sed 's#/[.][*]##'"; then
    ok "Fix 1 uses exact-depth (dirname) exclusion, not top-level-prefix collapse"
else
    bad "REGRESSION: filter block collapses to top-level prefix (over-exclusion bug)"
fi
grep -q 'LOKI_REVIEW_MAX_DIFF_BYTES' "$RUN_SH" \
    && grep -q 'code_review_diff_oversized' "$RUN_SH" \
    && grep -q 'refusing to truncate or dispatch a partial review' "$RUN_SH" \
    && ok "Fix 2 wired: oversized context rejects explicitly" || bad "Fix 2 not wired"
grep -q 'Reviewer .*: prompt .* bytes' "$RUN_SH" && grep -q 'sizes.tsv' "$RUN_SH" \
    && ok "Fix 3 wired: per-reviewer prompt-size logging" || bad "Fix 3 not wired"
grep -q 'LOKI_REVIEW_MAX_PROMPT_BYTES' "$RUN_SH" \
    && grep -q 'code_review_prompt_oversized' "$RUN_SH" \
    && ok "Fix 3 rejects oversized prompts before a partial council" || bad "prompt rejection wiring missing"

# ---- syntax ----
bash -n "$RUN_SH" && ok "run.sh passes bash -n" || bad "run.sh syntax error"

echo ""
echo "Total: $((PASS+FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
