#!/usr/bin/env bash
# Will this run succeed, and what will it likely cost? Answered BEFORE the run.
#
# WHY THIS EXISTS. The signals that predict a doomed or expensive build already
# exist, but a user has to know four commands to collect them, and three of the
# four are easy to reach for in a form that MUTATES. This is one read-only
# command that composes them into a single verdict.
#
# COMPOSE, NEVER REIMPLEMENT. Every number and every fix string below comes out
# of the surface that owns it. This repo has already paid for the alternative:
# four separate provider lists drifted apart, and "unmeasured" was rendered as
# "$0.00" on four surfaces before the estimator centralised the predicate. So:
#
#   provider selection  providers/loader.sh auto_detect_provider (the ONE list)
#   blockers + fixes    loki doctor --json  (its detail strings, verbatim)
#   resumable run       loki next --dry-run (read-only; loki resume DELETES the
#                       PAUSE file, so it can never be the seam a preflight uses)
#   projected cost      tools/estimate-run.py --json (its notes, verbatim)
#
# When a signal is absent this prints UNKNOWN and says why. It never prints 0
# for something it did not measure, and it never invents the iteration horizon:
# --iterations is the estimator's REQUIRED input precisely so a guess cannot be
# laundered through a real per-iteration cost, and passing a default here would
# reintroduce that on this surface.
#
# Read-only: starts nothing, spends nothing, contacts no provider.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ponytail: overridable so the "missing helper degrades to unavailable" path is
# testable without moving repo files out from under a live install.
LOKI_PREFLIGHT_DOCTOR="${LOKI_PREFLIGHT_DOCTOR:-$REPO_ROOT/autonomy/loki}"
LOKI_PREFLIGHT_ESTIMATOR="${LOKI_PREFLIGHT_ESTIMATOR:-$REPO_ROOT/tools/estimate-run.py}"
LOKI_PREFLIGHT_LOADER="${LOKI_PREFLIGHT_LOADER:-$REPO_ROOT/providers/loader.sh}"

BOLD='\033[1m'; RED='\033[0;31m'; GREEN='\033[0;32m'
YELLOW='\033[1;33m'; DIM='\033[2m'; NC='\033[0m'

# timeout(1) is coreutils; on macOS it exists only via homebrew. Hard-coding it
# made this script exit 127 on a stock mac -- and made the scrubbed-PATH test
# impossible to run at all. Degrade to running the helper uncapped rather than
# failing the whole preflight over a missing convenience.
_run_capped() {
    local secs="$1"; shift
    if command -v timeout >/dev/null 2>&1; then
        timeout "$secs" "$@"
    elif command -v gtimeout >/dev/null 2>&1; then
        gtimeout "$secs" "$@"
    else
        "$@"
    fi
}

ITERATIONS=""
WORKSPACE="."

while [ "$#" -gt 0 ]; do
    case "$1" in
        --iterations)
            # An empty value must ERROR, not silently read as "flag absent" --
            # that would quietly downgrade a requested projection to UNKNOWN and
            # look like missing history rather than a typo.
            if [ -z "${2:-}" ]; then
                echo "preflight: --iterations requires a value" >&2; exit 64
            fi
            ITERATIONS="$2"; shift 2 ;;
        --iterations=*)
            ITERATIONS="${1#*=}"
            if [ -z "$ITERATIONS" ]; then
                echo "preflight: --iterations requires a value" >&2; exit 64
            fi
            shift ;;
        --help|-h)
            echo "loki preflight -- will this run succeed, and what will it cost?"
            echo ""
            echo "Usage: tools/preflight.sh [WORKSPACE] [--iterations N]"
            echo ""
            echo "Read-only. Starts nothing, spends nothing, contacts no provider."
            echo ""
            echo "  --iterations N   Project cost over N iterations. Without it the"
            echo "                   measured per-iteration cost is still shown; the"
            echo "                   total reads UNKNOWN rather than being guessed."
            exit 0 ;;
        -*)
            echo "preflight: unknown option: $1" >&2; exit 64 ;;
        *)
            WORKSPACE="$1"; shift ;;
    esac
done

if [ -n "$ITERATIONS" ] && ! [[ "$ITERATIONS" =~ ^[1-9][0-9]*$ ]]; then
    echo "preflight: --iterations must be a positive integer, got: $ITERATIONS" >&2
    exit 64
fi

if [ ! -d "$WORKSPACE" ]; then
    echo "preflight: no such workspace: $WORKSPACE" >&2
    exit 66
fi

BLOCKERS=()   # each entry: "what blocks|the command that fixes it"
WARNINGS=()

echo -e "${BOLD}Loki preflight${NC} -- $(cd "$WORKSPACE" && pwd)"
echo -e "${DIM}Read-only: starts nothing, spends nothing, contacts no provider.${NC}"
echo ""

# ---- Provider ---------------------------------------------------------------
# auto_detect_provider is THE priority list. Restating the order here is how the
# four-lists-disagree bug happened, so this sources it and asks.
echo -e "${BOLD}Provider${NC}"
PROVIDER=""
if [ -r "$LOKI_PREFLIGHT_LOADER" ]; then
    # shellcheck disable=SC1090
    if source "$LOKI_PREFLIGHT_LOADER" >/dev/null 2>&1 \
       && declare -f auto_detect_provider >/dev/null 2>&1; then
        PROVIDER="$(auto_detect_provider 2>/dev/null || true)"
        if [ -n "$PROVIDER" ]; then
            echo -e "  ${GREEN}OK${NC}    auto-detection would select: ${BOLD}${PROVIDER}${NC}"
        else
            echo -e "  ${RED}FAIL${NC}  no provider CLI installed"
        fi
    else
        echo -e "  ${YELLOW}UNKNOWN${NC}  provider loader unreadable -- selection not determined"
        WARNINGS+=("provider selection unavailable: could not load $LOKI_PREFLIGHT_LOADER")
    fi
else
    echo -e "  ${YELLOW}UNKNOWN${NC}  provider loader missing -- selection not determined"
    WARNINGS+=("provider selection unavailable: $LOKI_PREFLIGHT_LOADER not found")
fi
echo ""

# ---- Doctor blockers --------------------------------------------------------
# --json only. The TEXT path backgrounds a first-run-blocked telemetry emit on
# failure, which a read-only preflight must not trigger.
echo -e "${BOLD}Environment${NC}"
DOCTOR_JSON=""
if [ -x "$LOKI_PREFLIGHT_DOCTOR" ] || [ -r "$LOKI_PREFLIGHT_DOCTOR" ]; then
    DOCTOR_JSON="$(cd "$WORKSPACE" && _run_capped 120 bash "$LOKI_PREFLIGHT_DOCTOR" doctor --json 2>/dev/null || true)"
fi
if [ -z "$DOCTOR_JSON" ]; then
    echo -e "  ${YELLOW}UNKNOWN${NC}  doctor unavailable -- environment blockers not checked"
    WARNINGS+=("environment check unavailable: could not run '$LOKI_PREFLIGHT_DOCTOR doctor --json'")
else
    # Surface doctor's OWN blocker text. Re-authoring the fix line is how the
    # advice drifts from the thing that actually installs the dependency.
    DOCTOR_REPORT="$(printf '%s' "$DOCTOR_JSON" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(3)
lines = []
for c in d.get("checks") or []:
    if c.get("status") == "fail":
        name = c.get("name") or c.get("command") or "check"
        cmd = c.get("command") or ""
        lines.append("BLOCK\t%s is missing or too old\tInstall %s, then re-run: loki doctor" % (name, cmd or name))
ai = d.get("ai_provider") or {}
if ai.get("status") == "fail":
    detail = ai.get("detail") or "No AI provider CLI."
    what, _, fix = detail.partition("Fix:")
    lines.append("BLOCK\t%s\t%s" % (what.strip().rstrip(".") or "No AI provider CLI",
                                    fix.strip() or "install a provider CLI"))
disk = d.get("disk") or {}
if disk.get("status") == "fail":
    lines.append("BLOCK\tLow disk space (%s GB available)\tFree up disk, then re-run: loki doctor"
                 % disk.get("available_gb"))
s = d.get("summary") or {}
lines.append("SUMMARY\t%s\t%s" % (s.get("passed"), s.get("warnings")))
print("\n".join(lines))
' 2>/dev/null || true)"

    if [ -z "$DOCTOR_REPORT" ]; then
        echo -e "  ${YELLOW}UNKNOWN${NC}  doctor output unparseable -- environment blockers not checked"
        WARNINGS+=("environment check unavailable: doctor --json produced no readable result")
    else
        _env_blocks=0
        while IFS=$'\t' read -r kind a b; do
            case "$kind" in
                BLOCK)
                    # THE TWO LISTS DISAGREE, and preflight is the first surface
                    # that shows both at once. auto_detect_provider iterates
                    # claude cline codex aider opencode; doctor's ai_provider
                    # checks only the first four. On an opencode-only machine
                    # this printed "would select: opencode" directly above
                    # "No AI provider CLI" -- a self-contradicting report.
                    # Neither producer is editable from here, so the
                    # disagreement is NAMED rather than silently resolved:
                    # asserting either side is right would be a fifth opinion
                    # about which providers count, which is how the four lists
                    # drifted apart in the first place.
                    if [ "$a" = "No AI provider CLI" ] && [ -n "$PROVIDER" ]; then
                        echo -e "  ${YELLOW}WARN${NC}  doctor reports no provider, but auto-detection selected '${PROVIDER}'"
                        echo -e "  ${DIM}      doctor does not recognise '${PROVIDER}'. Unresolved here: these two${NC}"
                        echo -e "  ${DIM}      checks disagree, so provider readiness is UNCERTAIN, not confirmed.${NC}"
                        WARNINGS+=("provider readiness uncertain: auto-detection selected '$PROVIDER' but doctor does not count it as a provider")
                    else
                        echo -e "  ${RED}FAIL${NC}  $a"
                        BLOCKERS+=("$a|$b")
                        _env_blocks=$((_env_blocks + 1))
                    fi ;;
                SUMMARY)
                    if [ "$_env_blocks" -eq 0 ]; then
                        echo -e "  ${GREEN}OK${NC}    doctor: $a checks passed, $b warning(s)"
                    fi ;;
            esac
        done <<< "$DOCTOR_REPORT"
    fi
fi

# A provider is required to run at all. Doctor reports it too, so only add this
# when doctor could not be consulted -- otherwise the same blocker lists twice.
if [ -z "$PROVIDER" ] && [ -r "$LOKI_PREFLIGHT_LOADER" ] && [ -z "$DOCTOR_JSON" ]; then
    BLOCKERS+=("No AI provider CLI|npm install -g @anthropic-ai/claude-code")
fi
echo ""

# ---- Resumable run ----------------------------------------------------------
# loki next --dry-run resolves the saved run status and prints the exact
# continuation command WITHOUT acting. loki resume would rm the PAUSE file.
echo -e "${BOLD}Saved state${NC}"
if [ ! -d "$WORKSPACE/.loki" ]; then
    echo -e "  ${DIM}no .loki/ here -- this would be a fresh run${NC}"
elif [ -z "$DOCTOR_JSON" ] && [ ! -r "$LOKI_PREFLIGHT_DOCTOR" ]; then
    echo -e "  ${YELLOW}UNKNOWN${NC}  cannot resolve saved run state (loki CLI unavailable)"
    WARNINGS+=("saved-state check unavailable: $LOKI_PREFLIGHT_DOCTOR not found")
else
    NEXT_OUT="$(cd "$WORKSPACE" && _run_capped 60 bash "$LOKI_PREFLIGHT_DOCTOR" next --dry-run 2>/dev/null || true)"
    if [ -z "$NEXT_OUT" ]; then
        echo -e "  ${DIM}no resumable run found${NC}"
    else
        _outcome="$(printf '%s' "$NEXT_OUT" | sed -n 's/.*Last outcome *: *//p' | head -1)"
        _will="$(printf '%s' "$NEXT_OUT" | sed -n 's/.*Will run *: *//p' | head -1)"
        if [ -n "$_outcome" ]; then
            echo -e "  ${YELLOW}FOUND${NC} interrupted or paused run present (last outcome: ${BOLD}${_outcome}${NC})"
            [ -n "$_will" ] && echo -e "        continue it with: ${BOLD}${_will}${NC}"
            WARNINGS+=("a resumable run exists here; starting fresh would leave it behind")
        else
            echo -e "  ${DIM}no resumable run found${NC}"
        fi
    fi
fi
echo ""

# ---- Projected cost ---------------------------------------------------------
echo -e "${BOLD}Projected cost${NC}"
if [ ! -r "$LOKI_PREFLIGHT_ESTIMATOR" ]; then
    echo -e "  ${YELLOW}UNKNOWN${NC}  estimator unavailable -- no cost projection"
    WARNINGS+=("cost projection unavailable: $LOKI_PREFLIGHT_ESTIMATOR not found")
else
    # --iterations is REQUIRED by the estimator by design. Passing 1 here just to
    # satisfy it and then scaling would be the guess it refuses to make, so when
    # the user gave none we ask for the per-iteration basis only and report the
    # total as UNKNOWN.
    _est_iters="${ITERATIONS:-1}"
    EST_JSON="$(_run_capped 60 python3 "$LOKI_PREFLIGHT_ESTIMATOR" --iterations "$_est_iters" "$WORKSPACE" --json 2>/dev/null || true)"
    if [ -z "$EST_JSON" ]; then
        echo -e "  ${YELLOW}UNKNOWN${NC}  estimator produced no result -- no cost projection"
        WARNINGS+=("cost projection unavailable: estimator did not return a result")
    else
        # The estimator's own notes carry the "not \$0.00" wording. Printed
        # verbatim so this surface cannot drift from the rule it inherits.
        printf '%s' "$EST_JSON" | LOKI_PF_ITERS="${ITERATIONS:-}" python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("  UNKNOWN  estimator output unreadable -- no cost projection")
    sys.exit(0)
iters = os.environ.get("LOKI_PF_ITERS") or ""
if not d.get("has_basis"):
    print("  UNKNOWN  no measured, priced iteration in this workspace")
    for n in d.get("notes") or []:
        print("           " + n)
else:
    med = d.get("median_cost_per_iteration_usd")
    print("  measured per-iteration cost: $%.4f (median of %d priced iteration(s))"
          % (med, d.get("basis_count") or 0))
    if d.get("single_point_basis"):
        print("           basis is a SINGLE data point -- arithmetically fine,")
        print("           epistemically weak; treat the total as indicative only")
    if iters:
        proj = d.get("projected_cost_usd")
        # Explicit None check. "or 0.0" would render an absent projection as
        # $0.00 -- the exact defect this surface exists to refuse, and it would
        # slip in on the one branch that prints a real dollar figure.
        if proj is None:
            print("  projected total: UNKNOWN -- estimator returned no projection")
        else:
            print("  projected for %s iteration(s): $%.2f  [ESTIMATE, not a guarantee]"
                  % (iters, proj))
    else:
        print("  projected total: UNKNOWN -- pass --iterations N to project a total")
        print("           (the horizon is not guessed: an invented N would launder")
        print("            a guess through a real per-iteration cost)")
'
    fi
fi
echo ""

# ---- Verdict ----------------------------------------------------------------
echo -e "${BOLD}========================================${NC}"
if [ "${#BLOCKERS[@]}" -gt 0 ]; then
    echo -e "${RED}${BOLD}VERDICT: BLOCKED${NC}"
    echo ""
    echo "This run cannot succeed until these are fixed:"
    for b in "${BLOCKERS[@]}"; do
        echo -e "  - ${BOLD}${b%%|*}${NC}"
        echo -e "    fix: ${b#*|}"
    done
    # Warnings are printed under BLOCKED too. Showing them only on the READY
    # paths meant a blocked run silently DROPPED every uncertain signal -- the
    # user fixes the named blocker, re-runs, and only then discovers a second
    # problem that was already known. An unmeasured signal must not become
    # invisible just because something else failed first.
    if [ "${#WARNINGS[@]}" -gt 0 ]; then
        echo ""
        echo "Also uncertain (not blocking):"
        for w in "${WARNINGS[@]}"; do
            echo "  - $w"
        done
    fi
    echo ""
    echo "Then re-run: tools/preflight.sh"
    exit 1
elif [ "${#WARNINGS[@]}" -gt 0 ]; then
    echo -e "${YELLOW}${BOLD}VERDICT: READY WITH WARNINGS${NC}"
    echo ""
    for w in "${WARNINGS[@]}"; do
        echo "  - $w"
    done
    exit 0
else
    echo -e "${GREEN}${BOLD}VERDICT: READY${NC}"
    exit 0
fi
