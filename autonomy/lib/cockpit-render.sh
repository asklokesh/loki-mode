#!/usr/bin/env bash
# autonomy/lib/cockpit-render.sh -- state gathering + render dispatch for
# `loki cockpit`. Thin wrapper: it builds a CockpitState JSON from the machine
# registry + each project's .loki state, then pipes it to the pure Bun render
# pipeline (loki-ts/src/cockpit/cli.ts). All the SVG/PNG/terminal-encode logic
# lives there so it stays bun-testable; this file only does I/O and fallback.
#
# Contract with the TS entry:
#   stdin  : CockpitState JSON
#   stdout : raw terminal image escape (image path), empty on fallback
#   exit 0 : image emitted ; exit 3 : fallback (reason on stderr as FALLBACK\t..)
#   other  : hard error (bun missing etc.) -> caller falls back too
#
# Nothing here changes cmd_watch or any existing command.

# cockpit_gather_state <skill_dir> <focus_repo_or_empty>
# Emits a CockpitState JSON on stdout. Never fails hard: missing files degrade
# to empty/default fields so the render always has something to show.
cockpit_gather_state() {
    local skill_dir="$1"
    local focus_repo="${2:-}"

    if ! command -v python3 >/dev/null 2>&1; then
        # No python: emit a minimal single-repo state from the cwd only.
        printf '{"run":"%s","iteration":0,"phase":"unknown","tier":"","provider":"","verdict":"unknown","budgetUsd":0,"gates":[],"council":[],"fleet":[]}\n' \
            "$(basename "$(pwd)")"
        return 0
    fi

    LOKI_CK_SKILL="$skill_dir" LOKI_CK_FOCUS="$focus_repo" LOKI_CK_CWD="$(pwd)" \
    python3 - <<'PYCOCKPIT' 2>/dev/null || printf '{"run":"cockpit","iteration":0,"phase":"unknown","tier":"","provider":"","verdict":"unknown","budgetUsd":0,"gates":[],"council":[],"fleet":[]}\n'
import json, os, sys

skill = os.environ.get("LOKI_CK_SKILL", ".")
focus = (os.environ.get("LOKI_CK_FOCUS") or "").strip()
cwd = os.environ.get("LOKI_CK_CWD") or os.getcwd()
sys.path.insert(0, skill)


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}


def project_state(path):
    """Best-effort per-project state from its .loki/ files."""
    loki = os.path.join(path, ".loki")
    st = read_json(os.path.join(loki, "autonomy-state.json"))
    ev = read_json(os.path.join(loki, "verify", "evidence.json"))

    iteration = st.get("iterationCount", st.get("iteration", 0)) or 0
    phase = st.get("phase") or st.get("status") or ""

    verdict = "unknown"
    v = str(ev.get("verdict", "")).upper()
    if v in ("PASS", "VERIFIED"):
        verdict = "verified"
    elif v in ("BLOCKED", "FAIL", "FAILED"):
        verdict = "failed"
    elif v in ("WORKING", "PARTIAL", "INCONCLUSIVE"):
        verdict = "working"
    elif v:
        verdict = "pending"

    gates = []
    for g in ev.get("deterministic_gates", []) or []:
        gs = str(g.get("status", "")).lower()
        status = {"pass": "pass", "fail": "fail", "failed": "fail",
                  "skipped": "skip", "skip": "skip"}.get(gs, "pending")
        # runner/scanner names the tool; summary is the one-line evidence.
        runner = g.get("runner") or g.get("scanner") or ""
        gates.append({
            "name": g.get("gate", "gate"),
            "status": status,
            "runner": str(runner)[:24],
            "evidence": str(g.get("summary", ""))[:80],
        })

    # Default model tier per reviewer (matches the standing council roster).
    REVIEWER_TIER = {
        "architecture-strategist": "opus",
        "maintainer-mergeability": "opus",
        "security-sentinel": "opus",
        "test-coverage-auditor": "sonnet",
        "performance-oracle": "opus",
        "dependency-analyst": "sonnet",
    }

    # Council votes: .loki/council/*.json, each with a vote-ish field. Skips the
    # aggregate state.json (no per-reviewer vote) so only real reviewer entries
    # populate the strip.
    council = []
    cdir = os.path.join(loki, "council")
    try:
        for fn in sorted(os.listdir(cdir)):
            if not fn.endswith(".json") or fn == "state.json":
                continue
            cj = read_json(os.path.join(cdir, fn))
            raw = str(cj.get("vote") or cj.get("verdict") or "").lower()
            vote = "pending"
            if "approve" in raw:
                vote = "approve"
            elif "reject" in raw:
                vote = "reject"
            elif "concern" in raw:
                vote = "concern"
            reviewer = cj.get("reviewer") or cj.get("name") or os.path.splitext(fn)[0]
            reviewer = str(reviewer)
            tier = cj.get("tier") or cj.get("model_tier") or REVIEWER_TIER.get(reviewer, "")
            council.append({"reviewer": reviewer[:24], "vote": vote, "tier": str(tier)[:8]})
    except Exception:
        pass

    return {
        "iteration": int(iteration) if isinstance(iteration, (int, float)) else 0,
        "phase": phase or "idle",
        "verdict": verdict,
        "gates": gates,
        "council": council,
        "budgetUsd": float(st.get("cost_usd", 0.0) or 0.0),
        "tier": st.get("tier", "") or "",
        "provider": st.get("provider", "") or "",
    }


# Fleet from the registry; graceful empty on any failure.
fleet = []
runs = []
try:
    from dashboard import registry
    # Self-heal: mark dead-pid "running" zombies as stopped before reading the
    # fleet, so the cockpit does not show 100+ frozen "BUILDING" entries from
    # reaped/crashed sessions. Best-effort; a failure here never blocks the render.
    try:
        registry.reconcile_stale_runs()
    except Exception:
        pass
    runs = registry.get_fleet_runs(include_inactive=True)
except Exception:
    runs = []

for r in runs:
    _running = bool(r.get("running"))
    _status = (r.get("status") or "").lower()
    # A not-running entry must not display an in-flight phase (BUILDING/etc): the
    # reconciled registry status is authoritative for dead runs, so a stopped or
    # stale run shows its status, not a frozen phase left in a stale state file.
    if _running:
        _phase = r.get("phase", "") or ""
    elif _status in ("stale", "stopped", "completed", "failed"):
        _phase = _status
    else:
        _phase = r.get("phase", "") or _status
    fleet.append({
        "name": r.get("name") or os.path.basename(r.get("path", "") or "project"),
        "path": r.get("path", "") or "",
        "phase": _phase,
        "iteration": r.get("iteration", 0) or 0,
        "status": r.get("status", "") or "",
        "running": _running,
    })

# Live-first ordering: running builds, then everything else by most-recent.
# Keeps the useful runs at the top when the fleet has many stopped/stale entries.
def _fleet_sort_key(e):
    st = (e.get("status") or "").lower()
    rank = 0 if e.get("running") else (1 if st not in ("stale", "stopped") else 2)
    return (rank, -(e.get("iteration") or 0))
fleet.sort(key=_fleet_sort_key)

# Focused run: --repo wins; else first running fleet run; else cwd.
focus_path = focus or cwd
focus_entry = None
for r in runs:
    rp = os.path.abspath(r.get("path", "") or "")
    if rp and rp == os.path.abspath(focus_path):
        focus_entry = r
        break
if focus_entry is None and not focus:
    for r in runs:
        if r.get("running"):
            focus_entry = r
            focus_path = r.get("path", "") or cwd
            break

ps = project_state(focus_path)
run_name = (focus_entry or {}).get("name") if focus_entry else os.path.basename(os.path.abspath(focus_path))

# Registry values override file reads where present (registry is fresher).
if focus_entry:
    if focus_entry.get("iteration"):
        ps["iteration"] = focus_entry["iteration"]
    if focus_entry.get("phase"):
        ps["phase"] = focus_entry["phase"]
    if focus_entry.get("cost_usd"):
        ps["budgetUsd"] = float(focus_entry["cost_usd"])

state = {
    "run": run_name or "cockpit",
    "iteration": ps["iteration"],
    "phase": ps["phase"],
    "tier": ps["tier"] or (os.environ.get("LOKI_SESSION_MODEL", "")),
    "provider": ps["provider"] or (os.environ.get("LOKI_PROVIDER", "claude")),
    "verdict": ps["verdict"],
    "budgetUsd": ps["budgetUsd"],
    "budgetLimitUsd": float(os.environ.get("LOKI_MAX_BUDGET_USD", "0") or 0) or None,
    "freshness": "now",
    "gates": ps["gates"],
    "council": ps["council"],
    "fleet": fleet,
}
print(json.dumps(state))
PYCOCKPIT
}

# cockpit_render <skill_dir> <ts_dir> <protocol> <no_image> <focus_repo>
# Returns: 0 (image emitted to stdout), 3 (fallback), or 2 (bun unavailable).
# On fallback / bun-missing the caller is responsible for the text summary.
cockpit_render() {
    local skill_dir="$1" ts_dir="$2" protocol="${3:-auto}" no_image="${4:-0}" focus_repo="${5:-}"

    # Prefer the shipped bundle (dist/cockpit.js -- present in npm/Docker/brew
    # installs, which ship loki-ts/dist/ but not src/); fall back to the source
    # entry for in-repo development.
    local entry="$ts_dir/dist/cockpit.js"
    [ -f "$entry" ] || entry="$ts_dir/src/cockpit/cli.ts"
    if ! command -v bun >/dev/null 2>&1 || [ ! -f "$entry" ]; then
        return 2
    fi

    local args=(--protocol "$protocol")
    [ "$no_image" = "1" ] && args+=(--no-image)

    # Gather -> render. Preserve the TS exit code (0 image / 3 fallback).
    cockpit_gather_state "$skill_dir" "$focus_repo" | bun "$entry" "${args[@]}"
}

#===============================================================================
# E3: keyboard interactivity for `loki cockpit --follow`.
# These live here (sourced by cmd_cockpit) so they can be extracted + unit
# tested without pulling in the whole autonomy/loki CLI.
#===============================================================================

# Pure key -> action mapping. Takes a normalized key token, echoes one action
# word. Side-effect-free so it is trivially unit-testable.
#   TAB / RIGHT / DOWN -> next    (cycle focus forward across the fleet)
#   LEFT / UP          -> prev    (cycle focus backward)
#   e                  -> explain (print verify evidence for the focused run)
#   s                  -> steer   (print how to steer the focused run)
#   q / ESC / Ctrl-C   -> quit
#   anything else      -> noop
cockpit_handle_key() {
    case "$1" in
        TAB|RIGHT|DOWN)  echo "next" ;;
        LEFT|UP)         echo "prev" ;;
        e|E)             echo "explain" ;;
        s|S)             echo "steer" ;;
        q|Q|ESC|$'\x03') echo "quit" ;;
        *)               echo "noop" ;;
    esac
}

# Read one keypress (non-blocking, no redraw stall) and normalize it to a token
# cockpit_handle_key understands. Echoes the token, or nothing if no key was
# pressed within the timeout. Arrow keys arrive as ESC [ A/B/C/D; a lone ESC (no
# following bytes) normalizes to ESC (quit). Only usable on a TTY.
#   $1 = timeout seconds (fractional ok; feeds `read -t`)
cockpit_read_key() {
    local timeout="${1:-2}"
    local k rest
    IFS= read -rsn1 -t "$timeout" k 2>/dev/null || return 1
    case "$k" in
        $'\t') echo "TAB"; return 0 ;;
        $'\x03') echo "ESC"; return 0 ;;  # Ctrl-C byte if trapped as data
        $'\x1b')
            # Possible escape sequence: grab up to 2 more bytes without blocking.
            IFS= read -rsn2 -t 0.01 rest 2>/dev/null || rest=""
            case "$rest" in
                '[A') echo "UP" ;;
                '[B') echo "DOWN" ;;
                '[C') echo "RIGHT" ;;
                '[D') echo "LEFT" ;;
                *)    echo "ESC" ;;
            esac
            return 0 ;;
        '') return 1 ;;   # timed out, no key
        *) echo "$k"; return 0 ;;
    esac
}

# Echo the fleet repo paths (one per line) so the follow loop can cycle focus.
# Empty output = no fleet (cycling is a no-op). Best-effort, never errors.
cockpit_fleet_paths() {
    local skill_dir="$1"
    local state_json
    state_json="$(cockpit_gather_state "$skill_dir" "" 2>/dev/null || true)"
    [ -z "$state_json" ] && return 0
    command -v python3 >/dev/null 2>&1 || return 0
    LOKI_CK_STATE="$state_json" python3 - <<'PYPATHS' 2>/dev/null || true
import json, os
s = json.loads(os.environ.get("LOKI_CK_STATE") or "{}")
for r in s.get("fleet") or []:
    p = r.get("path") or ""
    if p:
        print(p)
PYPATHS
}

# Given the current focus path, a direction (next|prev), and a newline list of
# fleet paths, echo the path to focus after cycling. Wraps around. If focus is
# not in the list, next -> first entry, prev -> last entry. Empty list echoes the
# current focus unchanged. Pure, unit-testable.
#   $1 = current focus path (may be empty)  $2 = next|prev  $3 = newline paths
cockpit_cycle_focus() {
    local cur="$1" dir="$2" paths="$3"
    [ -z "$paths" ] && { echo "$cur"; return 0; }
    local -a arr=()
    local line
    while IFS= read -r line; do
        [ -n "$line" ] && arr+=("$line")
    done <<< "$paths"
    local n="${#arr[@]}"
    [ "$n" -eq 0 ] && { echo "$cur"; return 0; }
    # Find current index.
    local idx=-1 i
    for i in "${!arr[@]}"; do
        if [ "${arr[$i]}" = "$cur" ]; then idx="$i"; break; fi
    done
    local target
    if [ "$idx" -lt 0 ]; then
        # Not in list: next -> first, prev -> last.
        if [ "$dir" = "prev" ]; then target=$((n - 1)); else target=0; fi
    elif [ "$dir" = "prev" ]; then
        target=$(( (idx - 1 + n) % n ))
    else
        target=$(( (idx + 1) % n ))
    fi
    echo "${arr[$target]}"
}

# Print the verify evidence ("explain") for the focused run. Reads the run's
# .loki/verify/evidence.json directly. Never fabricates: says so if absent.
cockpit_explain_focus() {
    local focus_repo="$1"
    local repo="${focus_repo:-$(pwd)}"
    local ev="$repo/.loki/verify/evidence.json"
    printf '\n'
    printf 'verify --explain (%s)\n' "$repo"
    if [ ! -f "$ev" ] || ! command -v python3 >/dev/null 2>&1; then
        echo "  (no evidence.json for this run yet)"
        return 0
    fi
    LOKI_CK_EV="$ev" python3 - <<'PYEV' 2>/dev/null || echo "  (could not read evidence)"
import json, os
try:
    ev = json.load(open(os.environ["LOKI_CK_EV"]))
except Exception:
    print("  (could not read evidence)"); raise SystemExit(0)
print(f"  Verdict   {str(ev.get('verdict','?')).upper()}")
checks = ev.get("deterministic_gates") or ev.get("checks") or ev.get("gates") or []
for c in checks[:12]:
    name = c.get("gate") or c.get("name") or c.get("id") or "?"
    status = c.get("status") or c.get("result") or "?"
    print(f"    {name:<28} {status}")
reason = ev.get("reason") or ev.get("summary")
if reason:
    print(f"  Reason    {reason}")
PYEV
}

# Print a steering hint for the focused run. Steering is opt-in prompt injection;
# this only tells the operator how, it does not inject anything.
# RUN-25 iter 22 (Wave D #3): the hint used to name .loki/steering.md, which
# NOTHING reads -- a control the UI advertised silently no-op'd (a quiet lie to
# the operator). The file the loop actually reads is .loki/HUMAN_INPUT.md, gated
# behind LOKI_PROMPT_INJECTION=1. Name the REAL file + flag (or the `loki steer`
# helper) so the advertised control genuinely steers the run.
cockpit_steer_hint() {
    local focus_repo="$1"
    local repo="${focus_repo:-$(pwd)}"
    printf '\n'
    echo "Steer this run"
    echo "  Drop a note the next iteration will read (needs LOKI_PROMPT_INJECTION=1):"
    echo "    loki steer 'your guidance'            # writes it for you"
    echo "    echo 'your guidance' > $repo/.loki/HUMAN_INPUT.md"
    echo "  Or open the dashboard chat: loki dashboard"
}
