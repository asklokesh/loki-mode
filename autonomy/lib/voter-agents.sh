#!/usr/bin/env bash
# autonomy/lib/voter-agents.sh -- Phase C (v7.5.20) bash side.
#
# Builds the JSON declaration of the council voter agents and orchestrates a
# single `claude --agents <json> --json-schema <path>` dispatch per iteration.
# Replaces the ad-hoc per-voter heuristic loop in council_aggregate_votes when
# the locally installed Claude CLI supports both flags.
#
# Vote enum (per architect, BINDING):
#   APPROVE | REJECT | CANNOT_VALIDATE
#
# Translation to the legacy aggregator shape used by council_evaluate and
# council_write_transcript:
#   APPROVE         -> COMPLETE
#   REJECT          -> CONTINUE
#   CANNOT_VALIDATE -> CONTINUE  (mirrors managed council _vote_to_legacy)
#
# Public API (all functions are pure: read env + filesystem, write stdout).
#   loki_voter_agents_json                 -- emits the 3-voter agents JSON
#   loki_devils_advocate_json <summary>    -- emits a one-key JSON for the DA
#   loki_finding_schema_path               -- echoes absolute path to schema
#   loki_council_dispatch_agents <iter> <prd_path>
#                                          -- runs the single claude call,
#                                             writes verdict files and the
#                                             aggregator round file. Returns 0
#                                             on success, 1 on any fallback
#                                             condition (caller falls through
#                                             to existing heuristic dispatch).

# Guard against double-source.
if [ "${__LOKI_VOTER_AGENTS_SH_LOADED:-0}" = "1" ]; then
    return 0 2>/dev/null || true
fi
__LOKI_VOTER_AGENTS_SH_LOADED=1

# Resolve repo root once. This file lives at autonomy/lib/voter-agents.sh.
__LOKI_VA_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
__LOKI_VA_REPO_ROOT="$(cd "${__LOKI_VA_LIB_DIR}/../.." 2>/dev/null && pwd)"

# ---------- Voter agents JSON ----------
# Emits a top-level JSON object with exactly 3 keys (the 3 base voters).
# Required env:
#   LOKI_ITER       -- iteration number (int-ish)
#   LOKI_PRD_PATH   -- PRD path (may be empty)
# Optional env:
#   LOKI_RARV_TIER  -- planning|development|fast (informational only)
#
# Returns 0 always. Emits `{}` when required env missing.
loki_voter_agents_json() {
    local iter="${LOKI_ITER:-}"
    if [ -z "$iter" ]; then
        printf '%s' '{}'
        return 0
    fi
    local prd="${LOKI_PRD_PATH:-}"
    local tier="${LOKI_RARV_TIER:-development}"

    _VA_ITER="$iter" \
    _VA_PRD="$prd" \
    _VA_TIER="$tier" \
    python3 -c '
import json, os
iter_n = os.environ.get("_VA_ITER", "0")
prd = os.environ.get("_VA_PRD", "")
tier = os.environ.get("_VA_TIER", "development")
prd_clause = (
    f"PRD at {prd}. Read it for ground-truth requirements."
    if prd else
    "No PRD path provided; rely on session context."
)
agents = {
    "requirements-verifier": {
        "description": "Verifies the iteration delivered the PRD-required behavior.",
        "model": "opus",
        "effort": "high",
        "tools": ["Read", "Grep", "Bash"],
        "prompt": (
            f"You are the requirements-verifier for iteration {iter_n}. "
            f"{prd_clause} Compare current code+tests against requirements. "
            "Emit a single finding object with role=requirements-verifier, "
            "vote in {APPROVE,REJECT,CANNOT_VALIDATE}, terse reason, "
            "confidence float in [0,1]."
        ),
    },
    "test-auditor": {
        "description": "Audits test coverage and pass status for the iteration.",
        "model": "sonnet",
        "effort": "high",
        "tools": ["Read", "Grep", "Bash"],
        "prompt": (
            f"You are the test-auditor for iteration {iter_n}. "
            "Inspect test logs, coverage, and pass/fail counts. "
            "Emit a single finding object with role=test-auditor, "
            "vote in {APPROVE,REJECT,CANNOT_VALIDATE}, terse reason, "
            "confidence float in [0,1]."
        ),
    },
    "convergence-voter": {
        "description": "Checks code churn and progress signals to judge convergence.",
        "model": "sonnet",
        "effort": "medium",
        "tools": ["Read", "Grep", "Bash"],
        "prompt": (
            f"You are the convergence-voter for iteration {iter_n} on tier {tier}. "
            "Examine git diff trends, queue depth, and stagnation signals. "
            "Emit a single finding object with role=convergence-voter, "
            "vote in {APPROVE,REJECT,CANNOT_VALIDATE}, terse reason, "
            "confidence float in [0,1]."
        ),
    },
}
print(json.dumps(agents, separators=(",", ":")))
'
    return 0
}

# ---------- Devil's advocate agent JSON ----------
# Emits a single-key JSON object describing the conditional 4th voter.
# Arg $1: terse base findings summary used to brief the DA prompt.
loki_devils_advocate_json() {
    local summary="${1:-}"
    _VA_SUMMARY="$summary" python3 -c '
import json, os
summary = os.environ.get("_VA_SUMMARY", "")[:1000]
agents = {
    "devils-advocate": {
        "description": "Skeptical re-review when the first three voters unanimously approve.",
        "model": "opus",
        "effort": "xhigh",
        "tools": ["Read", "Grep", "Bash"],
        "prompt": (
            "You are the devils-advocate. The first three voters unanimously "
            "voted APPROVE. Find the strongest reason this is wrong. "
            "Base voter summary:\n"
            f"{summary}\n"
            "Emit one finding with role=devils-advocate, "
            "vote in {APPROVE,REJECT,CANNOT_VALIDATE}, terse reason, "
            "confidence float in [0,1]."
        ),
    },
}
print(json.dumps(agents, separators=(",", ":")))
'
    return 0
}

# ---------- Finding schema path ----------
# Echo the absolute path to the schema file Dev-A maintains.
# Returns 1 if the file is missing; the path string is still printed so callers
# and tests can assert on the resolved location.
loki_finding_schema_path() {
    local schema="${__LOKI_VA_REPO_ROOT}/loki-ts/data/finding-schema.json"
    printf '%s' "$schema"
    if [ -f "$schema" ]; then
        return 0
    fi
    return 1
}

# ---------- Council dispatch via --agents + --json-schema ----------
# Orchestrator. Args:
#   $1 -- iteration number (required, int-ish)
#   $2 -- prd path (may be empty)
#
# Behavior:
#   1. Source autonomy/lib/claude-flags.sh; require both --agents and
#      --json-schema in `claude --help`. Either missing -> return 1 (fallback).
#   2. Build the agents JSON via loki_voter_agents_json.
#   3. Invoke `claude --dangerously-skip-permissions -p <prompt>
#                    --agents <json> --json-schema <path>` and capture stdout.
#      Any non-zero exit or empty stdout -> return 1 (fallback).
#   4. Parse the response via python3 (no jq dependency): extract
#      findings[].{role, vote, reason, confidence}. On parse failure -> 1.
#   5. Write per-voter verdicts/<role>-iter-<iter>.json AND the aggregator
#      round file votes/round-<iter>.json in the existing shape consumed by
#      council_evaluate + council_write_transcript.
#   6. Return 0 on success.
loki_council_dispatch_agents() {
    local iteration="${1:-}"
    local prd_path="${2:-}"
    if [ -z "$iteration" ]; then
        return 1
    fi
    if [ -z "${COUNCIL_STATE_DIR:-}" ]; then
        return 1
    fi

    # 1. Flag support gate.
    # shellcheck disable=SC1091
    . "${__LOKI_VA_LIB_DIR}/claude-flags.sh" 2>/dev/null || return 1
    if ! loki_claude_flag_supported "--agents"; then
        return 1
    fi
    if ! loki_claude_flag_supported "--json-schema"; then
        return 1
    fi

    # 2. Build agents JSON. Empty result means we cannot proceed.
    local agents_json
    agents_json=$(LOKI_ITER="$iteration" LOKI_PRD_PATH="$prd_path" \
                  LOKI_RARV_TIER="${LOKI_RARV_TIER:-development}" \
                  loki_voter_agents_json)
    if [ -z "$agents_json" ] || [ "$agents_json" = "{}" ]; then
        return 1
    fi

    local schema_path
    schema_path=$(loki_finding_schema_path) || return 1

    # 3. Invoke claude. Guard against absent binary or non-zero exit.
    command -v claude >/dev/null 2>&1 || return 1

    local prompt
    prompt=$(printf 'Loki council iteration %s. Run each declared agent against the current workspace, return one finding per agent matching the provided JSON Schema. Be terse, be honest.' "$iteration")

    local response
    local rc=0
    response=$(claude --dangerously-skip-permissions \
                      -p "$prompt" \
                      --agents "$agents_json" \
                      --json-schema "$schema_path" 2>/dev/null) || rc=$?
    if [ "$rc" -ne 0 ] || [ -z "$response" ]; then
        return 1
    fi

    # 4 + 5. Parse + materialize state files.
    local verdicts_dir="$COUNCIL_STATE_DIR/verdicts"
    local votes_dir="$COUNCIL_STATE_DIR/votes"
    mkdir -p "$verdicts_dir" "$votes_dir" 2>/dev/null || return 1

    _VA_RESP="$response" \
    _VA_ITER="$iteration" \
    _VA_VDIR="$verdicts_dir" \
    _VA_RFILE="$votes_dir/round-${iteration}.json" \
    python3 -c '
import json, os, sys
from datetime import datetime, timezone

try:
    resp = json.loads(os.environ["_VA_RESP"])
except Exception:
    sys.exit(2)

findings = resp.get("findings") if isinstance(resp, dict) else None
if not isinstance(findings, list) or not findings:
    sys.exit(3)

it = int(os.environ.get("_VA_ITER", "0") or 0)
vdir = os.environ["_VA_VDIR"]
rfile = os.environ["_VA_RFILE"]

def to_legacy(vote: str) -> str:
    v = (vote or "").upper()
    if v == "APPROVE":
        return "COMPLETE"
    return "CONTINUE"

votes = []
complete = 0
total = 0
for idx, f in enumerate(findings, start=1):
    if not isinstance(f, dict):
        continue
    role = str(f.get("role") or f.get("name") or f"voter-{idx}")
    raw_vote = str(f.get("vote") or "CANNOT_VALIDATE").upper()
    if raw_vote not in ("APPROVE", "REJECT", "CANNOT_VALIDATE"):
        raw_vote = "CANNOT_VALIDATE"
    reason = (f.get("reason") or "").strip()
    try:
        confidence = float(f.get("confidence", 0.0))
    except Exception:
        confidence = 0.0
    legacy = to_legacy(raw_vote)
    total += 1
    if legacy == "COMPLETE":
        complete += 1
    # Per-voter file (architect-specified shape).
    per = {
        "role": role,
        "vote": raw_vote,
        "reason": reason,
        "confidence": confidence,
        "iteration": it,
    }
    try:
        with open(os.path.join(vdir, f"{role}-iter-{it}.json"), "w") as fp:
            json.dump(per, fp, indent=2)
    except OSError:
        sys.exit(4)
    votes.append({
        "member": idx,
        "role": role,
        "vote": legacy,
        "reason": reason,
    })

if total == 0:
    sys.exit(5)

threshold = (total * 2 + 2) // 3
verdict = "COMPLETE" if complete >= threshold else "CONTINUE"
round_data = {
    "round": it,
    "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "complete_votes": complete,
    "continue_votes": total - complete,
    "total_members": total,
    "threshold": threshold,
    "verdict": verdict,
    "votes": votes,
    "source": "voter-agents-dispatch",
}
try:
    with open(rfile, "w") as fp:
        json.dump(round_data, fp, indent=2)
except OSError:
    sys.exit(6)
' || return 1

    return 0
}
