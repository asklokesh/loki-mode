#!/usr/bin/env bash
#===============================================================================
# `loki doctor --json` must report skill-link integrity truthfully and fail
# closed on a broken required link, matching the text mode it has always had.
#
# WHY THIS TEST EXISTS. The text path has failed closed on a dangling skill
# symlink since the Skills section was added: it prints FAIL, records a
# blocker, and exits 1. But --json omitted skills ENTIRELY, so on the same
# host the two outputs gave OPPOSITE verdicts:
#
#     text: exit 1
#     json: {"summary": {"failed": 0, "ok": true}}   <-- fake green
#
# An operator gating a pipeline on the JSON (the documented enterprise use --
# see tests/test-doctor-ci-gateable.sh) got a pass on a host where the skill
# cannot load. Both routes had the defect, so it was invisible to bun-parity.
#
# ALL THREE STATES ARE ASSERTED, not just the broken one. A check that only
# ever fails is as useless as one that only ever passes: an ABSENT skill is a
# warn (the user simply has not run setup-skill for that provider) and must
# NOT block, while a HEALTHY link must not be reported as a problem.
#
# HOME is redirected per case, which is what makes this hermetic: the skill
# entries are all resolved under $HOME on both routes.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0
FAIL=0
TMPROOT=""

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

cleanup() {
    # Guarded by the -n test rather than a bare rm: a bare `trap rm EXIT`
    # fires in subshells too, and an empty TMPROOT would expand dangerously.
    if [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ]; then
        rm -rf "$TMPROOT"
    fi
}
trap cleanup EXIT

TMPROOT=$(mktemp -d -t loki-doctor-skills.XXXXXX)

# Extract one field of the Claude Code skill entry (index 0) plus the summary.
# Reads the JSON from stdin. Tolerates leading/trailing noise the way the
# other doctor tests do, by slicing between the outermost braces.
read_field() {
    python3 -c '
import json, sys
field = sys.argv[1]
raw = sys.stdin.read()
try:
    d = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
except Exception:
    print("UNPARSEABLE"); raise SystemExit
skills = d.get("skills")
if skills is None:
    print("MISSING_SKILLS_KEY"); raise SystemExit
entry = next((s for s in skills if s.get("name") == "Claude Code"), None)
if entry is None:
    print("MISSING_CLAUDE_ENTRY"); raise SystemExit
if field == "status":
    print(entry.get("status"))
elif field == "detail":
    print(entry.get("detail"))
elif field == "required":
    print(entry.get("required"))
elif field == "failed":
    print(d.get("summary", {}).get("failed"))
elif field == "ok":
    print(str(d.get("summary", {}).get("ok")).lower())
elif field == "count":
    print(len(skills))
' "$1"
}

# Run doctor --json on one route with a synthetic HOME and read one field.
# $1 = route (bash|bun), $2 = HOME, $3 = field
probe() {
    local route="$1" home="$2" field="$3"
    if [ "$route" = "bash" ]; then
        LOKI_LEGACY_BASH=1 HOME="$home" "$LOKI" doctor --json 2>/dev/null | read_field "$field"
    else
        HOME="$home" "$LOKI" doctor --json 2>/dev/null | read_field "$field"
    fi
}

expect() { # $1=route $2=home $3=field $4=want $5=label
    local got
    got="$(probe "$1" "$2" "$3")"
    if [ "$got" = "$4" ]; then
        ok "$1: $5"
    else
        bad "$1: $5 (want '$4', got '$got')"
    fi
}

#------------------------------------------------------------------------------
# Case 1: BROKEN required link -> fail, and it must reach summary.failed/ok.
# This is the regression the whole test exists for.
#------------------------------------------------------------------------------
BROKEN="$TMPROOT/broken"
mkdir -p "$BROKEN/.claude/skills"
ln -s "$BROKEN/no-such-target" "$BROKEN/.claude/skills/loki-mode"

for route in bash bun; do
    expect "$route" "$BROKEN" status "fail"  "broken link reports status fail"
    expect "$route" "$BROKEN" failed "1"     "broken link is counted in summary.failed"
    expect "$route" "$BROKEN" ok     "false" "broken link flips summary.ok to false"

    # The detail must name the fix, the same remedy the text path prints.
    detail="$(probe "$route" "$BROKEN" detail)"
    case "$detail" in
        *"broken symlink"*"loki setup-skill"*)
            ok "$route: broken link detail names the symlink and the fix" ;;
        *)
            bad "$route: broken link detail missing symlink/fix text (got '$detail')" ;;
    esac
done

#------------------------------------------------------------------------------
# Case 2: ABSENT link -> warn, and it must NOT block. A user who has not run
# setup-skill for Cline is not a broken host, and escalating this to a failure
# would make doctor unusable as a gate on an ordinary machine.
#------------------------------------------------------------------------------
ABSENT="$TMPROOT/absent"
mkdir -p "$ABSENT"

for route in bash bun; do
    expect "$route" "$ABSENT" status "warn"  "absent link reports status warn"
    expect "$route" "$ABSENT" failed "0"     "absent link does NOT count as a failure"
    expect "$route" "$ABSENT" ok     "true"  "absent link leaves summary.ok true"
done

#------------------------------------------------------------------------------
# Case 3: HEALTHY link -> pass, no detail. Guards the other direction: a check
# that reports a problem on a correct host is a false alarm.
#------------------------------------------------------------------------------
HEALTHY="$TMPROOT/healthy"
mkdir -p "$HEALTHY/.claude/skills/loki-mode"
printf '# SKILL\n' > "$HEALTHY/.claude/skills/loki-mode/SKILL.md"

for route in bash bun; do
    expect "$route" "$HEALTHY" status "pass"  "healthy link reports status pass"
    expect "$route" "$HEALTHY" failed "0"     "healthy link is not a failure"
    expect "$route" "$HEALTHY" ok     "true"  "healthy link leaves summary.ok true"
    expect "$route" "$HEALTHY" detail "None"  "healthy link carries no detail"
done

#------------------------------------------------------------------------------
# Case 4: schema shape. All four provider entries are always present (the text
# path lists all four regardless of state), and `required` is populated so a
# consumer can tell a blocking entry from an advisory one.
#------------------------------------------------------------------------------
for route in bash bun; do
    expect "$route" "$HEALTHY" count    "4"        "all four skill entries present"
    expect "$route" "$HEALTHY" required "required" "skill entry carries required field"
done

#------------------------------------------------------------------------------
# Case 5: ROUTE PARITY. The bash and Bun JSON must be byte-identical for the
# skills block and the summary, in every state. This is the assertion that
# stops one route from being fixed while the other drifts.
#------------------------------------------------------------------------------
for state in "$BROKEN" "$ABSENT" "$HEALTHY"; do
    label="$(basename "$state")"
    a="$TMPROOT/${label}.bash.json"
    b="$TMPROOT/${label}.bun.json"
    slice='
import json, sys
raw = sys.stdin.read()
d = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
print(json.dumps({"skills": d.get("skills"), "summary": d.get("summary")},
                 indent=2, sort_keys=True))
'
    LOKI_LEGACY_BASH=1 HOME="$state" "$LOKI" doctor --json 2>/dev/null \
        | python3 -c "$slice" > "$a" 2>/dev/null
    HOME="$state" "$LOKI" doctor --json 2>/dev/null \
        | python3 -c "$slice" > "$b" 2>/dev/null

    # An empty capture is an ABSENT measurement, not a passing one -- diffing
    # two empty files would report success and prove nothing.
    if [ ! -s "$a" ] || [ ! -s "$b" ]; then
        bad "parity ($label): one or both routes produced no parseable JSON"
    elif diff -q "$a" "$b" >/dev/null 2>&1; then
        ok "parity ($label): bash and Bun skills+summary are identical"
    else
        bad "parity ($label): bash and Bun disagree"
        diff "$a" "$b" | head -20
    fi
done

printf '\n%s\n' "-----------------------------------------------"
printf 'Passed: %d  Failed: %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
