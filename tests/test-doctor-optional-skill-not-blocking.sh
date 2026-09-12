#!/usr/bin/env bash
#===============================================================================
# A stale skill symlink for an OPTIONAL, NOT-INSTALLED provider must not block.
#
# THE BUG, from a real transcript on a healthy machine:
#
#     Skills:
#       PASS  Claude Code  ~/.claude/skills/loki-mode
#       WARN  Codex CLI  (not found - run 'loki setup-skill')
#       FAIL  Cline CLI  (broken symlink -> /Users/lokesh/git/loki-mode)
#       FAIL  Aider CLI  (broken symlink -> /Users/lokesh/git/loki-mode)
#     Summary: 20 passed, 2 failed, 8 warnings
#     Blocking (2).
#
# Claude was installed, logged in, and auto-selected. The dangling target was an
# old checkout path that no longer exists. Cline and Aider are OPTIONAL, and the
# Provider Availability section on the SAME SCREEN said "not installed" for both
# -- yet their stale links exited 1. Doctor contradicted itself and told the user
# to repair a tool they do not have.
#
# SEVERITY DEPENDS ON WHOSE SKILL IT IS. A dangling link for the provider a build
# would actually launch is a real blocker. The same link for a provider the user
# does not use is inert state: reported, never fatal.
#
# WHY THE ASSERTIONS ARE SHAPED THE WAY THEY ARE -- each one is a trap this repo
# has already paid for:
#
#   1. VACUITY. During development doctor was observed aborting mid-run at the
#      "API Keys:" header, emitting 979 bytes and NO Skills section at all. Every
#      "no blocker present" assertion passes perfectly against output that died
#      early. So each capture is first asserted non-empty AND asserted to contain
#      the literal "Skills:" header, before any negative assertion runs.
#
#   2. NOT THE TEXT EXIT CODE. Doctor aggregates blockers from many checks, and a
#      developer machine legitimately carries unrelated ones ("Multiple loki
#      installs on PATH"). Asserting exit 0 on the text route would make this
#      suite red on a working fix. The text route is therefore asserted on the
#      BLOCKING LIST CONTENTS -- no "is a broken symlink" entry -- which is the
#      actual claim. The literal "does not exit 1" requirement is asserted on the
#      --json route, which is hermetic and returns a clean summary.ok.
#
#   3. POSITIVE CONTROL. A fix that simply stopped doctor from ever blocking
#      would satisfy every negative assertion here. LOKI_PROVIDER=cline makes the
#      SAME dangling link belong to the selected provider, and it must block
#      again. Without this the suite could pass on a gutted check.
#
#   4. STILL REPORTED. The stale link must not be silently swallowed: the
#      dangling target and the fix command must both still be printed.
#
# ANTHROPIC_API_KEY is set to an inert non-credential on purpose. With a
# synthetic HOME the "API Keys:" section shells out to `claude auth status`,
# whose pipeline exits non-zero and aborts doctor before Skills renders. Setting
# the key short-circuits that branch and is what makes this suite hermetic.
#
# LOKI_BIN is an override so the mutation direction can be verified without
# editing a tracked file: point it at an extraction of `git show HEAD:autonomy/
# loki` (the pre-fix code) and the blocking assertions must go RED.
#===============================================================================

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI_BIN="${LOKI_BIN:-$REPO_ROOT/autonomy/loki}"

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1"; }

TMPROOT=""
cleanup() {
    # Guarded rather than a bare `trap rm EXIT`: that fires in subshells too,
    # and an empty TMPROOT would expand into something dangerous.
    if [ -n "$TMPROOT" ] && [ -d "$TMPROOT" ]; then
        rm -rf "$TMPROOT"
    fi
}
trap cleanup EXIT

# pwd -P: on macOS $TMPDIR resolves under /private/var, and realpath-style
# guards in this repo have refused unresolved fixture paths before.
TMPROOT="$(cd "$(mktemp -d -t loki-doctor-optskill.XXXXXX)" && pwd -P)"

echo "test-doctor-optional-skill-not-blocking"

# Build the transcript's machine: Claude healthy and selected, Cline and Aider
# carrying stale links to a checkout path that does not exist.
HOME_DIR="$TMPROOT/home"
DANGLING_TARGET="$TMPROOT/no-such-old-checkout"
mkdir -p "$HOME_DIR/.claude/skills/loki-mode" \
         "$HOME_DIR/.cline/skills" \
         "$HOME_DIR/.aider/skills"
printf '# SKILL\n' > "$HOME_DIR/.claude/skills/loki-mode/SKILL.md"
ln -s "$DANGLING_TARGET" "$HOME_DIR/.cline/skills/loki-mode"
ln -s "$DANGLING_TARGET" "$HOME_DIR/.aider/skills/loki-mode"

# Run doctor with a synthetic HOME. $1 = output file, remaining args = extra env
# assignments. Prints the exit code. stderr is dropped the way the other doctor
# suites drop it (provider install hints go there by design).
run_doctor() {
    local out="$1"; shift
    local rc=0
    env HOME="$HOME_DIR" \
        ANTHROPIC_API_KEY=doctor-fixture-not-a-key \
        LOKI_LEGACY_BASH=1 \
        "$@" \
        bash "$LOKI_BIN" doctor > "$out" 2>/dev/null || rc=$?
    printf '%s' "$rc"
}

# Every capture must be proven real before it is asserted against. An empty file
# or a run that died before the Skills section satisfies every negative check.
assert_renderable() {
    local out="$1" label="$2"
    if [ ! -s "$out" ]; then
        fail "$label: doctor produced NO output (nothing was measured)"
        return 1
    fi
    if ! grep -q 'Skills:' "$out"; then
        fail "$label: output has no Skills: section (doctor died before it)"
        return 1
    fi
    pass "$label: doctor rendered a Skills section (capture is real)"
    return 0
}

# The blocking list is the authority, not the exit code. Blocker lines are
# rendered as "  - <text>" under the "Blocking (N)" header.
blocker_lines() {
    grep -E '^[[:space:]]+- ' "$1" 2>/dev/null
}

#------------------------------------------------------------------------------
# Case 1: the transcript. A dangling link for a NOT-INSTALLED optional provider
# must not appear in the blocking list.
#------------------------------------------------------------------------------
OUT_DEFAULT="$TMPROOT/default.txt"
run_doctor "$OUT_DEFAULT" >/dev/null

if assert_renderable "$OUT_DEFAULT" "default"; then
    blockers="$(blocker_lines "$OUT_DEFAULT")"

    if printf '%s' "$blockers" | grep -q 'is a broken symlink'; then
        fail "stale optional-provider skill link still blocks (found in Blocking list)"
    else
        pass "stale optional-provider skill link is not a blocker"
    fi

    # Named individually, never as a count: a threshold cannot say WHICH
    # provider regressed.
    for prov in "Cline CLI" "Aider CLI"; do
        if printf '%s' "$blockers" | grep -q "$prov is a broken symlink"; then
            fail "$prov stale link is listed as blocking"
        else
            pass "$prov stale link is not listed as blocking"
        fi
    done

    # STILL REPORTED. The point is severity, not silence.
    if grep -q "broken symlink -> $DANGLING_TARGET" "$OUT_DEFAULT"; then
        pass "the dangling target is still printed (not silently swallowed)"
    else
        fail "the dangling target is NOT printed -- the stale link was hidden"
    fi
    if grep -q 'Fix: loki setup-skill' "$OUT_DEFAULT"; then
        pass "the fix command is still printed"
    else
        fail "the fix command is not printed"
    fi

    # Healthy provider must stay healthy: a fix that downgraded everything
    # would also downgrade this.
    # Matched with a wildcard between badge and name, never `PASS[[:space:]]+`:
    # the badge carries an ANSI reset, so the raw bytes are
    # "<esc>[0;32mPASS<esc>[0m  Claude Code" and an adjacency regex cannot match.
    if grep -q 'PASS.*Claude Code' "$OUT_DEFAULT"; then
        pass "the installed provider's healthy skill still reports PASS"
    else
        fail "the installed provider's healthy skill no longer reports PASS"
    fi
fi

#------------------------------------------------------------------------------
# Case 2: POSITIVE CONTROL. The same dangling link, for the SELECTED provider,
# must still block. Without this the suite would pass against a doctor that had
# simply stopped blocking on anything.
#------------------------------------------------------------------------------
OUT_SELECTED="$TMPROOT/selected.txt"
run_doctor "$OUT_SELECTED" LOKI_PROVIDER=cline >/dev/null

if assert_renderable "$OUT_SELECTED" "selected-provider"; then
    if blocker_lines "$OUT_SELECTED" | grep -q 'Cline CLI is a broken symlink'; then
        pass "a broken link for the SELECTED provider still blocks"
    else
        fail "a broken link for the selected provider no longer blocks (check is gutted)"
    fi
fi

#------------------------------------------------------------------------------
# Case 3: --json must stay valid JSON and must not report failure. This is where
# the literal "does not exit 1" requirement is asserted: the JSON route carries
# no ambient developer-machine blockers.
#------------------------------------------------------------------------------
# True when doctor --json failed ONLY because no AI provider CLI exists, which
# is the normal state of a CI runner. Any other failing check returns false, so
# this can never launder a real regression into a pass.
_dj_only_provider_missing() {
    python3 - "$1" <<'PYHELP'
import json, sys
try:
    raw = open(sys.argv[1]).read()
    d = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
except Exception:
    sys.exit(1)
def fails(node, path=""):
    out = []
    if isinstance(node, dict):
        if node.get("status") == "fail":
            out.append(str(node.get("name") or path.lstrip(".")))
        for k, v in node.items():
            out += fails(v, path + "." + k)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            out += fails(v, path + "[" + str(i) + "]")
    return out
bad = set(fails(d)) - {"ai_provider"}
sys.exit(1 if bad else 0)
PYHELP
}

JSON_OUT="$TMPROOT/doctor.json"
json_rc=0
env HOME="$HOME_DIR" \
    ANTHROPIC_API_KEY=doctor-fixture-not-a-key \
    LOKI_LEGACY_BASH=1 \
    bash "$LOKI_BIN" doctor --json > "$JSON_OUT" 2>/dev/null || json_rc=$?

# A provider-less host (every CI runner) makes doctor exit 1 on ai_provider,
# which is the correct verdict there: with no provider CLI a build cannot run.
# Assert on the SKILL severity this suite exists to check, not on an exit code
# that encodes whether the machine happens to have Claude installed.
if [ "$json_rc" -eq 0 ]; then
    pass "doctor --json exits 0 (a provider is installed on this host)"
elif _dj_only_provider_missing "$JSON_OUT"; then
    pass "doctor --json exits $json_rc, and the ONLY failing check is ai_provider (provider-less host)"
else
    fail "doctor --json exits $json_rc with a failure other than ai_provider"
fi

# Validity and severity are read in one place, from the file, so a broken parse
# cannot masquerade as a passing severity check.
json_verdict="$(python3 - "$JSON_OUT" <<'PY'
import json, sys

raw = open(sys.argv[1]).read()
if not raw.strip():
    print("EMPTY"); raise SystemExit
try:
    d = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
except Exception:
    print("UNPARSEABLE"); raise SystemExit

skills = {s.get("name"): s for s in d.get("skills") or []}
if not skills:
    print("NO_SKILLS"); raise SystemExit

problems = []
for name in ("Cline CLI", "Aider CLI"):
    entry = skills.get(name)
    if entry is None:
        problems.append(name + ":missing")
        continue
    if entry.get("status") != "warn":
        problems.append(name + ":status=" + str(entry.get("status")))
    if "broken symlink" not in (entry.get("detail") or ""):
        problems.append(name + ":detail=" + str(entry.get("detail")))

claude = skills.get("Claude Code")
if claude is None or claude.get("status") != "pass":
    problems.append("Claude Code:status=" + str(claude and claude.get("status")))

# summary.ok is false whenever ANY check fails, and on a provider-less runner
# ai_provider legitimately fails. Tolerate exactly that one check and nothing
# else, so a real regression still turns this red.
if (d.get("summary") or {}).get("ok") is not True:
    def _fails(node, path=""):
        out = []
        if isinstance(node, dict):
            if node.get("status") == "fail":
                out.append(str(node.get("name") or path.lstrip(".")))
            for k, v in node.items():
                out += _fails(v, path + "." + k)
        elif isinstance(node, list):
            for i, v in enumerate(node):
                out += _fails(v, path + "[" + str(i) + "]")
        return out
    unexpected = set(_fails(d)) - {"ai_provider"}
    if unexpected:
        problems.append("summary.ok=False with " + ",".join(sorted(unexpected)))

print("OK" if not problems else "BAD " + ",".join(problems))
PY
)"

case "$json_verdict" in
    OK)
        pass "doctor --json is valid and grades stale optional links as warn" ;;
    EMPTY|UNPARSEABLE|NO_SKILLS)
        fail "doctor --json did not yield usable JSON ($json_verdict)" ;;
    *)
        fail "doctor --json severity is wrong ($json_verdict)" ;;
esac

# Positive control for the JSON route too: the selected provider's broken link
# must still be graded fail there.
JSON_SEL="$TMPROOT/doctor-selected.json"
env HOME="$HOME_DIR" \
    ANTHROPIC_API_KEY=doctor-fixture-not-a-key \
    LOKI_PROVIDER=cline \
    LOKI_LEGACY_BASH=1 \
    bash "$LOKI_BIN" doctor --json > "$JSON_SEL" 2>/dev/null || true

sel_verdict="$(python3 - "$JSON_SEL" <<'PY'
import json, sys

raw = open(sys.argv[1]).read()
if not raw.strip():
    print("EMPTY"); raise SystemExit
try:
    d = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
except Exception:
    print("UNPARSEABLE"); raise SystemExit

entry = next((s for s in d.get("skills") or [] if s.get("name") == "Cline CLI"), None)
print("OK" if entry and entry.get("status") == "fail" else "BAD " + str(entry and entry.get("status")))
PY
)"

case "$sel_verdict" in
    OK)  pass "doctor --json still grades the SELECTED provider's broken link as fail" ;;
    *)   fail "doctor --json no longer fails on the selected provider's broken link ($sel_verdict)" ;;
esac

echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
