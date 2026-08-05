#!/usr/bin/env bash
# test-spec-contradiction-classify.sh -- the classifier must NOT mislabel pure
# AMBIGUITY as a CONTRADICTION just because the grill filed it under a
# contradiction-ish section heading. Observed live: a valid SaaS-dashboard spec
# was terminal-failed (inconclusive_spec_contradiction, exit 20) on a finding
# whose text was "Ambiguities and missing acceptance criteria" -- ambiguity is
# assumable-away, a contradiction ("X and not-X") is not. A section heading alone
# is too weak to trigger the no-retry terminal.
#
# No emojis. No em dashes.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPEC="$SCRIPT_DIR/../autonomy/spec-interrogation.sh"
PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
ok() { PASS=$((PASS + 1)); }
[ -f "$SPEC" ] || { echo "FATAL: spec-interrogation.sh not found"; exit 2; }

FN="$(awk '/^spec_interrogation_class_for\(\) \{/{f=1} f{print} f&&/^}/{exit}' "$SPEC")"
[ -n "$FN" ] || { echo "FATAL: could not extract spec_interrogation_class_for"; exit 2; }

# classify <section> <line> [env-assignment]
# The optional 3rd arg is a single VAR=value assignment prepended to the command
# (empty by default). Never run a bare `export` (that dumps the whole environment).
classify() {
    local section="$1" line="$2" env="${3:-}"
    local pre=""
    [ -n "$env" ] && pre="export $env; "
    bash -c "set -u; ${pre}$FN"$'\n'"spec_interrogation_class_for \"\$1\" \"\$2\"" _ "$section" "$line"
}

# 1. THE BUG: an ambiguity finding under a contradiction-ish section is NOT contradictory
r="$(classify "Contradictions and ambiguities" "Ambiguities and missing acceptance criteria")"
[ "$r" != "contradictory" ] && ok || fail "ambiguity under contra-section must NOT be contradictory (got $r)"

# 2. a genuinely-worded conflict line IS contradictory regardless of section
r="$(classify "Findings" "requirement A conflicts with requirement B")"
[ "$r" = "contradictory" ] && ok || fail "real conflict line must be contradictory (got $r)"

# 3. contra-section WITH conflict language in the line -> contradictory
r="$(classify "Contradictions" "these two requirements are mutually exclusive")"
[ "$r" = "contradictory" ] && ok || fail "contra-section + conflict line -> contradictory (got $r)"

# 4. "inconsistent" in the line -> contradictory (existing line-level behavior intact)
r="$(classify "Anything" "the two sections are inconsistent with each other")"
[ "$r" = "contradictory" ] && ok || fail "inconsistent line must be contradictory (got $r)"

# 5. an ambiguity finding NOT under a contra-section classifies as its real type
r="$(classify "Ambiguities" "acceptance criteria are unclear")"
[ "$r" != "contradictory" ] && ok || fail "plain ambiguity must never be contradictory (got $r)"

# 6. opt back in: LOKI_SPEC_SECTION_CONTRADICTION_FORCE=1 restores the old broad force
r="$(classify "Contradictions" "these are mutually exclusive but also required" "LOKI_SPEC_SECTION_CONTRADICTION_FORCE=1")"
[ "$r" = "contradictory" ] && ok || fail "opt-in force must restore old section-force (got $r)"

# --- interrogative/hypothetical keyword guard (the real showcase bug) ---
# A finding that merely QUESTIONS a possible contradiction is an ambiguity, not
# an asserted "X and not-X". Naive substring matching on "contradict"/"conflict"
# force-tagged such questions and killed valid specs.

# 7. THE REAL BUG: a question using the word "contradicting" -> NOT contradictory
r="$(classify "Ambiguities and missing acceptance criteria" "what stops them from contradicting the line chart, e.g. KPI says up 12% while chart shows a decline")"
[ "$r" != "contradictory" ] && ok || fail "interrogative 'contradicting' must not be a contradiction (got $r)"

# 8. hypothetical "could conflict" -> NOT contradictory
r="$(classify "Findings" "these two settings could conflict at runtime")"
[ "$r" != "contradictory" ] && ok || fail "hypothetical 'could conflict' must not be a contradiction (got $r)"

# 9. an ASSERTED contradiction is STILL detected (guard did not over-demote)
r="$(classify "Findings" "section 2 mandates immutable records but section 5 says records are editable, which is inconsistent")"
[ "$r" = "contradictory" ] && ok || fail "an asserted contradiction must still classify contradictory (got $r)"

# 10. a plain asserted "directly contradicts" -> contradictory
r="$(classify "Findings" "requirement A directly contradicts requirement B")"
[ "$r" = "contradictory" ] && ok || fail "asserted 'directly contradicts' must be contradictory (got $r)"

# 11. keyword-strict opt-out restores the old broad substring match
r="$(classify "Findings" "what stops them from contradicting the chart" "LOKI_SPEC_CONTRADICTION_KEYWORD_STRICT=0")"
[ "$r" = "contradictory" ] && ok || fail "keyword-strict=0 must restore old broad match (got $r)"

# --- authoritative section-kind guard (the escaping showcase phrasings) ---
# The grill's own section categorization wins: a finding it filed under an
# ambiguity/assumption section is that kind, even if its prose says "contradict".

# 12. "could show contradictory trends" under an Ambiguities section -> ambiguous
r="$(classify "Ambiguities and missing acceptance criteria" "two implementations could show contradictory trends for the same data")"
[ "$r" != "contradictory" ] && ok || fail "contradictory prose under Ambiguities must not be a contradiction (got $r)"

# 13. "contradicts opening index.html" under Unstated assumptions -> not contradictory
r="$(classify "Unstated assumptions" "a dev-server-only build contradicts opening index.html as a standalone acceptance")"
[ "$r" != "contradictory" ] && ok || fail "contradictory prose under Unstated assumptions must not be a contradiction (got $r)"

# 14. an asserted contradiction in a real Contradictions section IS contradictory
r="$(classify "Internal contradictions" "requirement A contradicts requirement B")"
[ "$r" = "contradictory" ] && ok || fail "asserted contradiction in a Contradictions section must be contradictory (got $r)"

# 15. section-kind guard opt-out restores keyword-first behavior
r="$(classify "Ambiguities" "requirement A directly contradicts requirement B" "LOKI_SPEC_SECTION_KIND_GUARD=0")"
[ "$r" = "contradictory" ] && ok || fail "guard opt-out must let an asserted keyword classify contradictory (got $r)"

echo ""
echo "test-spec-contradiction-classify: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
