#!/usr/bin/env bash
# tests/test-p0-verification-sweep.sh -- ACCEPTANCE test for the P0
# Verification-Credibility Sweep (docs/P0-SWEEP-PLAN.md).
#
# This is the Slice E acceptance gate. It is written BEFORE the dev slices
# (A/B/C/D) land, so it is EXPECTED TO FAIL TODAY. Every FAIL line below is a
# precise statement of work the integrator still has to merge. Once all slices
# land it MUST go green; a green run is the contract that the sweep is honest.
#
# Convention: mirrors tests/test-evidence-gate.sh -- ok()/bad() counters,
# `set -uo pipefail`, final "Total/Passed/Failed", exit nonzero on any FAIL.
# It is a pure grep/structure acceptance test (no behavioral fixtures here);
# the behavioral mock/mutation/devils-advocate fixtures live in the companion
# SDET suite (tests/test-p0-gate-behavior.sh -- to be authored by the SDET).
#
# CRITICAL grep-scoping rule (do NOT widen):
#   The negative-claim greps (no ">80%", no "Input Guardrails", no "11 gates",
#   etc.) are scoped to an explicit DOC_SET only. They MUST NOT scan:
#     * CHANGELOG.md            -- plan section 1 preserves historical entries
#     * docs/P0-SWEEP-PLAN.md   -- the plan itself names the phantom strings
#     * tests/                  -- THIS file stores the patterns as literals
#   Widening the scope would make the test match its own pattern strings / the
#   plan / the changelog and never go green. A "tolerant" acceptance test is one
#   that can FAIL now and PASS later -- not one that is permanently red.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"
QG_TS="$REPO_ROOT/loki-ts/src/runner/quality_gates.ts"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# DOC_SET: the exact files the docs slice (Slice B) edits, per plan section 1.
# Greps for removed/false claims run ONLY against files that exist in this list.
# CHANGELOG.md and docs/P0-SWEEP-PLAN.md are deliberately excluded (see header).
# ---------------------------------------------------------------------------
DOC_SET=(
    "README.md"
    "SKILL.md"
    "CLAUDE.md"
    "plugins/loki-mode/README.md"
    "wiki/Quality-Gates.md"
    "wiki/Environment-Variables.md"
    "wiki/Home.md"
    "wiki/CLI-Reference.md"
    "docs/cursor-comparison.md"
    "docs/COMPARISON.md"
    "skills/quality-gates.md"
    "skills/00-index.md"
)

# Build the list of doc paths that actually exist (absolute), so a missing file
# is reported as its own diagnostic rather than silently skewing a grep.
doc_paths_existing() {
    local f
    for f in "${DOC_SET[@]}"; do
        [ -f "$REPO_ROOT/$f" ] && printf '%s\n' "$REPO_ROOT/$f"
    done
}

# grep a fixed string across the existing DOC_SET. Returns matching file:line
# rows on stdout (empty if none). Uses -F (literal) + -I (skip binary).
doc_grep_fixed() {
    local needle="$1"
    local -a paths=()
    while IFS= read -r p; do paths+=("$p"); done < <(doc_paths_existing)
    [ "${#paths[@]}" -eq 0 ] && return 0
    grep -RInF -- "$needle" "${paths[@]}" 2>/dev/null || true
}

# grep an extended-regex across the existing DOC_SET.
doc_grep_ere() {
    local re="$1"
    local -a paths=()
    while IFS= read -r p; do paths+=("$p"); done < <(doc_paths_existing)
    [ "${#paths[@]}" -eq 0 ] && return 0
    grep -RInE -- "$re" "${paths[@]}" 2>/dev/null || true
}

# Assert a needle is ABSENT from the doc set. matches -> FAIL (lists offenders).
assert_doc_absent_fixed() {
    local desc="$1" needle="$2"
    local hits
    hits="$(doc_grep_fixed "$needle")"
    if [ -z "$hits" ]; then
        ok "$desc"
    else
        bad "$desc" "still present in doc set:"
        printf '%s\n' "$hits" | sed 's#^'"$REPO_ROOT"'/#       #' | head -20
    fi
}

assert_doc_absent_ere() {
    local desc="$1" re="$2"
    local hits
    hits="$(doc_grep_ere "$re")"
    if [ -z "$hits" ]; then
        ok "$desc"
    else
        bad "$desc" "still present in doc set:"
        printf '%s\n' "$hits" | sed 's#^'"$REPO_ROOT"'/#       #' | head -20
    fi
}

# Assert a needle is PRESENT somewhere in the doc set.
assert_doc_present_fixed() {
    local desc="$1" needle="$2"
    if [ -n "$(doc_grep_fixed "$needle")" ]; then
        ok "$desc"
    else
        bad "$desc" "expected string not found in doc set"
    fi
}

echo "=========================================="
echo "P0 Verification-Credibility Sweep -- ACCEPTANCE"
echo "(FAILs now are expected; they are the work list.)"
echo "=========================================="
echo

# ===========================================================================
# P0-1 + P0-5: coverage honesty in docs (plan sections 2, 6, 9).
# After Slice B: no ">80%" / "coverage.json" / "min_coverage: 80% # Never drop"
# survive in the doc set. min_coverage as a JSON FIELD is kept in run.sh + tests
# (NOT in the doc set) -- which is why those are not part of this grep.
# ===========================================================================
echo "--- P0-1/P0-5: coverage honesty (docs) ---"
assert_doc_absent_fixed "no '>80%' coverage claim in doc set"                ">80%"
assert_doc_absent_fixed "no 'coverage.json' artifact claim in doc set"        "coverage.json"
assert_doc_absent_fixed "no 'min_coverage: 80% # Never drop' line in doc set" "min_coverage: 80% # Never drop"

# ===========================================================================
# P0-2: phantom guardrails removed + honest gate count (plan sections 3, 9).
# After Slice B: zero live "Input Guardrails" / "Output Guardrails" / "11 gates"
# in the doc set; "8 gates" present in quality-gates.md + wiki/Quality-Gates.md.
# ===========================================================================
echo "--- P0-2: phantom guardrails removed + 8-gate count ---"
assert_doc_absent_fixed "no live 'Input Guardrails' in doc set"  "Input Guardrails"
assert_doc_absent_fixed "no live 'Output Guardrails' in doc set" "Output Guardrails"
# "11 gates" / "11-gate": match either phrasing without catching "8 gates".
assert_doc_absent_ere   "no live '11 gates'/'11-gate' claim in doc set" "11[ -]gate"
assert_doc_present_fixed "'8 gates' present in doc set (honest count)" "8 gates"

# ===========================================================================
# P0-3: detectors wired into run.sh (plan sections 4, 9).
# Structure assertions, NOT line numbers (Slice A's insert shifts every line):
#   * enforce_mock_integrity defined AND referenced (>=2 occurrences)
#   * enforce_mutation_integrity defined AND referenced (>=2 occurrences)
#   * each detector script path invoked from run.sh
# ===========================================================================
echo "--- P0-3: mock + mutation gates wired into run.sh ---"
if [ -f "$RUN_SH" ]; then
    # Count occurrences: a wired gate appears at least twice (def + orchestration
    # call). A single occurrence (def only, never called) is still a FAIL.
    mock_def="$(grep -cE '^[[:space:]]*enforce_mock_integrity[[:space:]]*\(\)' "$RUN_SH" 2>/dev/null || echo 0)"
    mock_refs="$(grep -cE 'enforce_mock_integrity' "$RUN_SH" 2>/dev/null || echo 0)"
    mut_def="$(grep -cE '^[[:space:]]*enforce_mutation_integrity[[:space:]]*\(\)' "$RUN_SH" 2>/dev/null || echo 0)"
    mut_refs="$(grep -cE 'enforce_mutation_integrity' "$RUN_SH" 2>/dev/null || echo 0)"

    [ "$mock_def" -ge 1 ] && ok "enforce_mock_integrity defined in run.sh" \
        || bad "enforce_mock_integrity defined in run.sh" "no function definition found"
    [ "$mock_refs" -ge 2 ] && ok "enforce_mock_integrity referenced in orchestration (refs=$mock_refs)" \
        || bad "enforce_mock_integrity referenced in orchestration" "refs=$mock_refs (need def + call >=2)"
    [ "$mut_def" -ge 1 ] && ok "enforce_mutation_integrity defined in run.sh" \
        || bad "enforce_mutation_integrity defined in run.sh" "no function definition found"
    [ "$mut_refs" -ge 2 ] && ok "enforce_mutation_integrity referenced in orchestration (refs=$mut_refs)" \
        || bad "enforce_mutation_integrity referenced in orchestration" "refs=$mut_refs (need def + call >=2)"

    grep -qF 'detect-mock-problems.sh' "$RUN_SH" \
        && ok "run.sh invokes tests/detect-mock-problems.sh" \
        || bad "run.sh invokes detect-mock-problems.sh" "detector path not referenced in run.sh"
    grep -qF 'detect-test-mutations.sh' "$RUN_SH" \
        && ok "run.sh invokes tests/detect-test-mutations.sh" \
        || bad "run.sh invokes detect-test-mutations.sh" "detector path not referenced in run.sh"
else
    bad "run.sh present" "autonomy/run.sh not found at $RUN_SH"
fi

# ===========================================================================
# P0-3 + P0-4: opt-out toggles exist (plan sections 4, 5, 1 table).
# Convention matches LOKI_GATE_DOC_COVERAGE / LOKI_GATE_MAGIC_DEBATE. The
# toggles must be readable somewhere in run.sh.
# ===========================================================================
echo "--- P0-3/P0-4: gate opt-out toggles present ---"
if [ -f "$RUN_SH" ]; then
    grep -qF 'LOKI_GATE_MOCK' "$RUN_SH" \
        && ok "LOKI_GATE_MOCK toggle present in run.sh" \
        || bad "LOKI_GATE_MOCK toggle" "not referenced in run.sh"
    grep -qF 'LOKI_GATE_MUTATION' "$RUN_SH" \
        && ok "LOKI_GATE_MUTATION toggle present in run.sh" \
        || bad "LOKI_GATE_MUTATION toggle" "not referenced in run.sh"
    grep -qF 'LOKI_GATE_DEVILS_ADVOCATE' "$RUN_SH" \
        && ok "LOKI_GATE_DEVILS_ADVOCATE toggle present in run.sh" \
        || bad "LOKI_GATE_DEVILS_ADVOCATE toggle" "not referenced in run.sh"
fi

# ===========================================================================
# P0-4: anti-sycophancy actually dispatches a Devil's Advocate (plan section 5).
# The inert block only logs + writes anti-sycophancy.txt. After Slice A there
# must be a real DA dispatch path. Heuristic structural check: run.sh references
# a devil's-advocate dispatch token near the anti-sycophancy region. This is a
# weak proxy; the authoritative behavioral proof is in the SDET behavior suite
# (unanimous-PASS + DA-High -> run_code_review returns 1).
# ===========================================================================
echo "--- P0-4: anti-sycophancy dispatches Devil's Advocate (structural proxy) ---"
if [ -f "$RUN_SH" ]; then
    # A genuine dispatch reuses the reviewer invocation with a DA role. Accept
    # either an explicit devil's-advocate reviewer role token or a DA verdict
    # parse near the anti-sycophancy block. Pattern is intentionally broad; the
    # SDET behavior suite is the real gate.
    if grep -qiE "devil.?s.?advocate.*(review|dispatch|reviewer|verdict)|dispatch.*devil" "$RUN_SH"; then
        ok "run.sh has a Devil's-Advocate dispatch reference (structural proxy)"
    else
        bad "Devil's-Advocate dispatch in run.sh" \
            "no DA dispatch token found; anti-sycophancy block may still be inert (see SDET behavior suite for the authoritative check)"
    fi
fi

# ===========================================================================
# Parity (P0-3/P0-4): Bun mirror in quality_gates.ts (plan section 7).
# After Slice C: mock_integrity + mutation_integrity appear in the GateName
# union/sequence, and the DA dispatch exists in runCodeReview.
# ===========================================================================
echo "--- Parity: Bun quality_gates.ts mirrors new gates ---"
if [ -f "$QG_TS" ]; then
    grep -qF 'mock_integrity' "$QG_TS" \
        && ok "quality_gates.ts references mock_integrity gate" \
        || bad "quality_gates.ts mock_integrity" "not present in Bun mirror"
    grep -qF 'mutation_integrity' "$QG_TS" \
        && ok "quality_gates.ts references mutation_integrity gate" \
        || bad "quality_gates.ts mutation_integrity" "not present in Bun mirror"
else
    bad "quality_gates.ts present" "loki-ts/src/runner/quality_gates.ts not found"
fi

# ---------------------------------------------------------------------------
# ===========================================================================
# REPO-WIDE regression guards (added after council rounds kept finding the
# same two claim-classes leaking into non-DOC_SET files). These scan the whole
# tracked tree, excluding only: CHANGELOG.md (historical), docs/P0-SWEEP-PLAN.md
# (names the phantom strings), tests/ (stores patterns as literals), node_modules,
# .git. A hit = a stale honesty claim slipped in somewhere new.
# ===========================================================================
echo "--- Repo-wide regression guards (no stale claim may reappear anywhere) ---"
_repo_grep() {
    grep -rinE "$1" \
        --include="*.md" --include="*.json" --include="*.html" \
        --include="*.py" --include="*.sh" --include="*.ts" "$REPO_ROOT" 2>/dev/null \
        | grep -viE "P0-SWEEP|CHANGELOG|node_modules|/\.git/|/tests/|/internal/"
}

# Guard 1: no claim that the code-review gate blocks on Medium severity.
# Broadened to catch .py/.sh/.ts variants ("Critical/High/Medium = BLOCK",
# "Critical, High, and Medium ... BLOCK", "Medium blocks by default",
# "Medium issues BLOCK"). Excludes:
#   * the legitimate healing-mode gate where specific Medium findings DO block
#     (Gate 10 / business rule / baseline mismatch / Missing API docs / npm/pip)
#   * the actual code-logic lines in run.sh:8395 and verify.sh (severity ladder)
#   * legitimate human-guidance prose and severity-label taxonomies
_med_hits="$(_repo_grep 'Critical/High/Medium = BLOCK|Critical, High, (and|or) Medium [^.]*BLOCK|Medium blocks by default|Medium issues BLOCK|Medium \| BLOCK|Medium\*? \| BLOCK - Fix' \
    | grep -viE 'healing|Gate 10|business rule|baseline mismatch|Missing API docs|npm/pip' \
    | grep -viE 'autonomy/run\.sh:8395|autonomy/verify\.sh' \
    | grep -viE 'NEVER proceed|ALWAYS fix|Mark each|For each .*finding|Findings by severity')"
if [ -z "$_med_hits" ]; then
    ok "repo-wide: no false 'Medium blocks' code-review-gate claim"
else
    bad "repo-wide Medium-blocks claim" "$(printf '%s' "$_med_hits" | head -3)"
fi

# Guard 2: no quality-gate-count claim other than 8 (SDLC phase counts excluded).
# Catches prose ("N-gate quality system", "N quality gates") AND the served
# JSON field ("quality_gates": N).
_cnt_hits="$(_repo_grep '\b(6|7|9|10|11|12|14)[ -](explicit )?(quality )?gate|(6|7|9|10|11|12|14)-gate (quality|review|status|pipeline|system)|(6|7) quality gates|"quality_gates": ?(6|7|9|10|11|12|14)' \
    | grep -viE 'gateway|SDLC|phase')"
if [ -z "$_cnt_hits" ]; then
    ok "repo-wide: no quality-gate-count claim other than 8"
else
    bad "repo-wide gate-count drift" "$(printf '%s' "$_cnt_hits" | head -3)"
fi

# Guard 3: no 'open source' / '(OSS)' license claim for Loki in canonical product
# files. The canonical product files describe ONLY Loki, so any open-source claim
# there is about Loki. COMPARISON.md and server.py are added but scoped: for
# COMPARISON.md we only flag the Loki-column patterns (Free (OSS) / Free (open
# source) as Loki's own pricing/source cell), never OTHER tools' OSS cells.
_os_hits="$(grep -rinE 'open[ -]source|\(OSS\)' \
    "$REPO_ROOT/README.md" "$REPO_ROOT/SKILL.md" "$REPO_ROOT/CLAUDE.md" \
    "$REPO_ROOT/plugins/loki-mode/README.md" "$REPO_ROOT/dashboard/server.py" 2>/dev/null \
    | grep -viE 'source-available|NOT open')"
# COMPARISON.md: scope to the Loki-column open-source/OSS claims only. The Loki
# column is the FIRST data column, so its pricing/source cell leads the row.
_os_comp="$(grep -rinE 'Free \(OSS\)|Free \(open[ -]source\)|\| \*\*(Open Source|Source model)\*\* \| (Yes|Open[ -]source|.*OSS)' \
    "$REPO_ROOT/docs/COMPARISON.md" 2>/dev/null \
    | grep -viE 'source-available|BUSL')"
_os_hits="$(printf '%s\n%s' "$_os_hits" "$_os_comp" | grep -vE '^$')"
if [ -z "$_os_hits" ]; then
    ok "canonical files: no 'open source' license claim (BUSL-1.1 is source-available)"
else
    bad "canonical 'open source' license claim" "$(printf '%s' "$_os_hits" | head -3)"
fi

# Guard 3b: product web surfaces (web-app/src/ + website/) describe ONLY Loki,
# so any 'open source' / '(OSS)' / 'MIT license' string in them is a Loki license
# claim and is false (Loki is BUSL-1.1 source-available). Generated/minified
# trees (dist/, node_modules/) are excluded -- they are rebuilt from src.
#
# ALLOWLIST: if a future hit is a legitimate reference to ANOTHER tool being
# open-source (true statement) or to the open-core *business model* (not a
# literal "Loki is open source" claim), add its 'path:substring' marker to
# _WEB_OS_ALLOW below with a one-line reason. Keep the allowlist minimal; reword
# the source in preference to allowlisting wherever possible.
_WEB_OS_ALLOW=(
    # path-substring markers for legitimate third-party-OSS / open-core refs.
    # (none today: both trees are fully reworded to source-available.)
)
_web_os_raw="$(grep -rinE 'open[ -]source|\(OSS\)|MIT[ -]licen' \
    "$REPO_ROOT/web-app/src" "$REPO_ROOT/website" 2>/dev/null \
    | grep -vE 'node_modules|/dist/')"
# Drop allowlisted lines (each marker is matched as a fixed substring).
if [ -n "$_web_os_raw" ] && [ "${#_WEB_OS_ALLOW[@]}" -gt 0 ]; then
    for _mk in "${_WEB_OS_ALLOW[@]}"; do
        _web_os_raw="$(printf '%s\n' "$_web_os_raw" | grep -vF "$_mk")"
    done
fi
_web_os_hits="$(printf '%s' "$_web_os_raw" | grep -vE '^$')"
if [ -z "$_web_os_hits" ]; then
    ok "web-app/src + website: no Loki 'open source'/'MIT' license claim (BUSL-1.1 is source-available)"
else
    bad "web surface Loki 'open source'/'MIT' license claim" "$(printf '%s' "$_web_os_hits" | head -3)"
fi

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
echo
echo "NOTE: until all P0 slices (A/B/C/D) land, FAIL lines above are the"
echo "      expected acceptance surface, not a regression. A fully green run"
echo "      is the contract that the sweep is honest and complete."
[ "$FAIL" -eq 0 ]
