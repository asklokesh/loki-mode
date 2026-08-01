#!/usr/bin/env bash
# tests/test-installed-agent-reviewer.sh -- R10 extension seam, bash route.
#
# An agent a user installs via `loki agent install` lands in
# .loki/agents/installed.json. Before this seam was wired, the code-review
# specialist selector (SPECIALIST_SELECT in autonomy/run.sh) gated every
# non-hardcoded agent on a FOCUS_KEYWORDS allowlist of 10 built-in type names,
# which no user-chosen type can ever match -- so an installed agent was silently
# dropped and its perspective never reviewed anything.
#
# This runs the REAL selector block (extracted, not re-derived) against a real
# manifest installed through the real agents/hub_install.py, and asserts:
#   1. the installed agent is dispatched as a reviewer on a matching diff
#   2. its reviewer spec is built from ITS OWN manifest text
#   3. it is STRICTLY ADDITIVE -- never displaces a built-in reviewer
#      (the load-bearing property: installing an agent must not weaken review)
#   4. it stays silent on a diff its keywords do not match
#   5. a corrupt installed.json leaves the normal battery intact
#
# Security model note: hub_install.py never EXECUTES anything from a manifest
# (postinstall/scripts/exec are recorded and ignored). "The extension runs"
# means its persona/focus text reaches a reviewer, which is what is asserted.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }

if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not installed. (Not a fail.)"; exit 0
fi
if [ ! -f "$RUN_SH" ] || [ ! -f "$REPO_ROOT/agents/hub_install.py" ]; then
    echo "SKIP: run.sh or agents/hub_install.py not found. (Not a fail.)"; exit 0
fi

WORK="$(mktemp -d -t loki-ext.XXXXXX)"
SEL_PY="$WORK/selector.py"
trap 'rm -rf "$WORK"' EXIT

# Extract the real SPECIALIST_SELECT python heredoc body.
awk '/selected_specialists=\$\(python3 << .SPECIALIST_SELECT./{f=1;next} f&&/^SPECIALIST_SELECT$/{exit} f{print}' "$RUN_SH" > "$SEL_PY"
if [ ! -s "$SEL_PY" ]; then
    echo "SKIP: could not extract SPECIALIST_SELECT block from run.sh. (Not a fail.)"; exit 0
fi

TYPES="$REPO_ROOT/agents/types.json"

# An a11y diff whose tokens match the manifest's focus keywords, and a
# backend-only diff where none of them appear.
printf 'diff --git a/x.html b/x.html\n+<div aria-label="x">contrast wcag screenreader aria</div>\n' > "$WORK/a11y.diff"
printf 'x.html\n' > "$WORK/a11y.files"
printf 'diff --git a/db.py b/db.py\n+def q(): return sql_query("SELECT 1")\n' > "$WORK/backend.diff"
printf 'db.py\n' > "$WORK/backend.files"

cat > "$WORK/manifest.json" <<'JSON'
{
  "schema_version": 1,
  "kind": "agent",
  "type": "my-a11y-auditor",
  "name": "Accessibility Auditor",
  "swarm": "community",
  "persona": "You are PROBE_PERSONA_MARKER, a WCAG accessibility auditor.",
  "focus": ["wcag", "aria", "contrast", "screenreader"],
  "capabilities": "WCAG 2.2 AA, ARIA roles, color contrast, keyboard nav",
  "postinstall": "echo THIS_MUST_NEVER_RUN"
}
JSON

# Install through the REAL shipped seam, not by hand-writing installed.json.
mkdir -p "$WORK/proj" "$WORK/baseline"
INSTALL_OUT="$(cd "$REPO_ROOT" && LOKI_TARGET_DIR="$WORK/proj" python3 -c "
import sys; sys.path.insert(0, '.')
from agents import hub_install
e = hub_install.install_agent('$WORK/manifest.json')
print(e['type'])
" 2>&1)"
if [ "$INSTALL_OUT" = "my-a11y-auditor" ]; then
    ok "loki agent install seam writes .loki/agents/installed.json"
else
    bad "install via hub_install.py" "$INSTALL_OUT"
    echo "=== results: $PASS passed, $((FAIL+1)) failed ==="; exit 1
fi

# names_for <project-dir> <tier> <diff-file> <files-file> -> comma-joined reviewer names
names_for() {
    LOKI_TARGET_DIR="$1" \
    LOKI_AGENTS_TYPES_FILE="$TYPES" \
    LOKI_REVIEW_DIFF_FILE="$3" \
    LOKI_REVIEW_FILES_FILE="$4" \
    LOKI_REVIEW_HEALING_ACTIVE="false" \
    LOKI_REVIEW_COMPLEXITY="$2" \
    python3 "$SEL_PY" 2>/dev/null | python3 -c "
import sys, json
print(','.join(r['name'] for r in json.load(sys.stdin)['reviewers']))
"
}

# --- 1. the installed agent is dispatched -----------------------------------
GOT="$(names_for "$WORK/proj" standard "$WORK/a11y.diff" "$WORK/a11y.files")"
case ",$GOT," in
    *,my-a11y-auditor,*) ok "installed agent is dispatched as a reviewer ($GOT)" ;;
    *) bad "installed agent dispatched" "not in: $GOT" ;;
esac

# --- 2. built from its own manifest text ------------------------------------
CHECKS="$(LOKI_TARGET_DIR="$WORK/proj" LOKI_AGENTS_TYPES_FILE="$TYPES" \
    LOKI_REVIEW_DIFF_FILE="$WORK/a11y.diff" LOKI_REVIEW_FILES_FILE="$WORK/a11y.files" \
    LOKI_REVIEW_HEALING_ACTIVE="false" LOKI_REVIEW_COMPLEXITY="standard" \
    python3 "$SEL_PY" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
for r in d['reviewers']:
    if r['name'] == 'my-a11y-auditor':
        print(r['focus'] + '||' + r['checks'])
")"
if [ "${CHECKS%%||*}" = "WCAG 2.2 AA, ARIA roles, color contrast, keyboard nav" ] \
   && case "$CHECKS" in *screenreader*) true ;; *) false ;; esac; then
    ok "reviewer spec is built from the user's own manifest text"
else
    bad "manifest text reaches the reviewer" "$CHECKS"
fi

# --- 3. strictly additive: never displaces a built-in ------------------------
# This is the property that keeps the seam from weakening the review gate.
for tier in simple standard complex; do
    BASE="$(names_for "$WORK/baseline" "$tier" "$WORK/a11y.diff" "$WORK/a11y.files")"
    WITH="$(names_for "$WORK/proj" "$tier" "$WORK/a11y.diff" "$WORK/a11y.files")"
    if [ "$WITH" = "$BASE,my-a11y-auditor" ]; then
        ok "tier=$tier: strictly additive (baseline preserved, agent appended)"
    else
        bad "tier=$tier: additive" "baseline='$BASE' with='$WITH'"
    fi
done

# --- 4. silent when its keywords do not match -------------------------------
GOT="$(names_for "$WORK/proj" standard "$WORK/backend.diff" "$WORK/backend.files")"
case ",$GOT," in
    *,my-a11y-auditor,*) bad "silent on non-matching diff" "fired anyway: $GOT" ;;
    *) ok "stays silent on a diff its keywords do not match" ;;
esac

# --- 5. fail-safe on a corrupt installed.json -------------------------------
mkdir -p "$WORK/corrupt/.loki/agents"
printf '{ this is not json' > "$WORK/corrupt/.loki/agents/installed.json"
BASE="$(names_for "$WORK/baseline" standard "$WORK/a11y.diff" "$WORK/a11y.files")"
GOT="$(names_for "$WORK/corrupt" standard "$WORK/a11y.diff" "$WORK/a11y.files")"
if [ -n "$GOT" ] && [ "$GOT" = "$BASE" ]; then
    ok "corrupt installed.json leaves the normal battery intact"
else
    bad "corrupt installed.json fail-safe" "baseline='$BASE' got='$GOT'"
fi

# --- 6. production invocation shape: LOKI_TARGET_DIR is NOT exported ---------
# run.sh does not export LOKI_TARGET_DIR at the selection site, so in production
# hub_install._target_dir() falls back to the heredoc's getcwd(). The cases above
# set the var explicitly; this one proves the real, unset-var path also works --
# otherwise the seam would be green in tests and dead for actual users.
GOT="$(cd "$WORK/proj" && env -u LOKI_TARGET_DIR \
    LOKI_AGENTS_TYPES_FILE="$TYPES" \
    LOKI_REVIEW_DIFF_FILE="$WORK/a11y.diff" \
    LOKI_REVIEW_FILES_FILE="$WORK/a11y.files" \
    LOKI_REVIEW_HEALING_ACTIVE="false" \
    LOKI_REVIEW_COMPLEXITY="standard" \
    python3 "$SEL_PY" 2>/dev/null | python3 -c "
import sys, json
print(','.join(r['name'] for r in json.load(sys.stdin)['reviewers']))
")"
case ",$GOT," in
    *,my-a11y-auditor,*) ok "fires with LOKI_TARGET_DIR unset (real run.sh invocation shape)" ;;
    *) bad "unset LOKI_TARGET_DIR" "agent did not fire: $GOT" ;;
esac

# --- 7. the manifest's executable field was never run ------------------------
if grep -q "THIS_MUST_NEVER_RUN" "$WORK/proj/.loki/agents/installed.json" 2>/dev/null; then
    bad "postinstall not stored" "executable field persisted into installed.json"
else
    ok "manifest postinstall field is not stored and never runs (data-only)"
fi

echo ""
echo "=== results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ]
