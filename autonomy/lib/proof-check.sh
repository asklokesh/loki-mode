#!/usr/bin/env bash
# proof-check.sh -- best-effort, advisory GitHub check-run for a Loki run.
#
# Posts an ADVISORY check-run named "loki: verified-completion" to a PR's head
# commit, mapping the deterministic honesty headline from the redacted proof.json
# 1:1 to a check-run conclusion. This surface is purely advisory.
#
# HONEST FRAMING (load-bearing invariant): Loki CANNOT block a merge. This posts
# an advisory check-run only. It NEVER sets any merge gate, NEVER marks the check
# as required, NEVER calls any merge-gate API. Requiring this check is the repo
# owner's setting (add "loki: verified-completion" as a required status check in
# repository settings). We do not overclaim.
#
# HONESTY (single source of truth): the ONLY input that can produce a green
# (success) conclusion is honesty.headline == "VERIFIED" read from the redacted
# proof.json. We never recompute a verdict, never read raw .loki state, never
# infer a conclusion from anything but the headline. A missing/unknown headline
# posts NOTHING (no fabricated green or red).
#
# set -e SAFE: this lib may be sourced under `set -uo pipefail` or
# `set -euo pipefail`. Every fallible command ends with `|| true` or sits in a
# guarded `if`; every optional tool is `command -v`-guarded; every var is
# defaulted with `${VAR:-}`; all paths `return 0` so a sourced call cannot abort
# the caller. This is pure best-effort: it NEVER fails the caller and NEVER
# blocks PR creation.
#
# This function is only ever called when the operator opted in (the call site
# guards on LOKI_PROVEN_PR_CHECK=1). It is also safe if called directly.

# Double-source guard.
[ -n "${_PROOF_CHECK_SH:-}" ] && return 0
_PROOF_CHECK_SH=1

# _proof_check_net <cmd...>
# Best-effort timeout wrapper so a hung network call cannot stall the caller.
# Mirrors the run.sh _loki_net idiom. Never fatal.
_proof_check_net() {
    if command -v timeout >/dev/null 2>&1; then
        timeout 30 "$@"
    else
        "$@"
    fi
}

# _proof_check_headline <proof_json_path>
# Echoes the exact honesty.headline string from the redacted proof.json, or an
# empty string if the file is missing/unreadable/not-a-dict or the headline is
# absent. Reads ONLY the passed proof.json, NEVER raw .loki state. Best-effort.
_proof_check_headline() {
    local proof_path="${1:-}"
    [ -n "$proof_path" ] || { printf '%s' ""; return 0; }
    [ -f "$proof_path" ] || { printf '%s' ""; return 0; }
    command -v python3 >/dev/null 2>&1 || { printf '%s' ""; return 0; }

    local headline=""
    headline="$(python3 - "$proof_path" <<'PY' 2>/dev/null || true
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        sys.exit(0)
    honesty = data.get("honesty")
    if not isinstance(honesty, dict):
        sys.exit(0)
    h = honesty.get("headline")
    if isinstance(h, str):
        sys.stdout.write(h)
except Exception:
    sys.exit(0)
PY
)"
    printf '%s' "${headline:-}"
    return 0
}

# _proof_check_proof_head_sha <proof_json_path>
# Echoes facts.git.head_sha from the redacted proof.json (the fallback head sha),
# or empty string. Reads ONLY the passed proof.json. Best-effort.
_proof_check_proof_head_sha() {
    local proof_path="${1:-}"
    [ -n "$proof_path" ] || { printf '%s' ""; return 0; }
    [ -f "$proof_path" ] || { printf '%s' ""; return 0; }
    command -v python3 >/dev/null 2>&1 || { printf '%s' ""; return 0; }

    local sha=""
    sha="$(python3 - "$proof_path" <<'PY' 2>/dev/null || true
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        sys.exit(0)
    facts = data.get("facts")
    if not isinstance(facts, dict):
        sys.exit(0)
    git = facts.get("git")
    if not isinstance(git, dict):
        sys.exit(0)
    s = git.get("head_sha")
    if isinstance(s, str):
        sys.stdout.write(s.strip())
except Exception:
    sys.exit(0)
PY
)"
    printf '%s' "${sha:-}"
    return 0
}

# _proof_check_run_id <proof_json_path>
# Echoes run_id from the redacted proof.json (for the verify-yourself hint in the
# advisory summary), or empty string. Best-effort.
_proof_check_run_id() {
    local proof_path="${1:-}"
    [ -n "$proof_path" ] || { printf '%s' ""; return 0; }
    [ -f "$proof_path" ] || { printf '%s' ""; return 0; }
    command -v python3 >/dev/null 2>&1 || { printf '%s' ""; return 0; }

    local rid=""
    rid="$(python3 - "$proof_path" <<'PY' 2>/dev/null || true
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        sys.exit(0)
    r = data.get("run_id")
    if isinstance(r, str):
        sys.stdout.write(r)
except Exception:
    sys.exit(0)
PY
)"
    printf '%s' "${rid:-}"
    return 0
}

# post_verified_completion_check <proof_json_path> <pr_url_or_empty>
#
# Best-effort: post an advisory GitHub check-run "loki: verified-completion" to
# the PR's head commit. Maps honesty.headline 1:1 to the check-run conclusion:
#     VERIFIED            -> success
#     VERIFIED WITH GAPS  -> neutral
#     NOT VERIFIED        -> failure
# A missing/unknown headline posts NOTHING. ALWAYS returns 0; NEVER fails the
# caller; NEVER blocks PR creation. This is advisory only: it NEVER makes the
# check required and NEVER calls any merge-gate API. Requiring the check is the
# repo owner's setting.
post_verified_completion_check() {
    local proof_path="${1:-}"
    local pr_url="${2:-}"

    # --- Honesty gate FIRST: read + map the headline before touching gh. -------
    # A missing/unknown headline must produce NO gh call at all (no fabricated
    # green or red).
    local headline=""
    headline="$(_proof_check_headline "$proof_path")"

    local conclusion=""
    case "$headline" in
        "VERIFIED")            conclusion="success" ;;
        "VERIFIED WITH GAPS")  conclusion="neutral" ;;
        "NOT VERIFIED")        conclusion="failure" ;;
        *)
            # Missing or unknown headline -> do not post anything.
            return 0
            ;;
    esac

    # --- gh availability + auth (best-effort, never fatal). --------------------
    if ! command -v gh >/dev/null 2>&1; then
        printf '%s\n' "loki: advisory check-run not posted (gh CLI not found)." || true
        return 0
    fi
    if ! _proof_check_net gh auth status >/dev/null 2>&1; then
        printf '%s\n' "loki: advisory check-run not posted (gh not authenticated)." || true
        return 0
    fi

    # --- Resolve owner/repo (nameWithOwner). ----------------------------------
    # Prefer the current repo context (Loki's model is same-repo branch PRs).
    local repo=""
    repo="$(_proof_check_net gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"

    # --- Resolve head sha: PR head if a pr_url is given, else proof fallback. --
    local head_sha=""
    if [ -n "$pr_url" ]; then
        head_sha="$(_proof_check_net gh pr view "$pr_url" --json headRefOid -q .headRefOid 2>/dev/null || true)"
    fi
    if [ -z "$head_sha" ]; then
        head_sha="$(_proof_check_proof_head_sha "$proof_path")"
    fi

    # If we cannot identify both the repo and the head commit, do not guess.
    if [ -z "$repo" ] || [ -z "$head_sha" ]; then
        printf '%s\n' "loki: advisory check-run not posted (could not resolve repo or head commit)." || true
        return 0
    fi

    # --- Build the advisory summary text. -------------------------------------
    # Plainly states this is advisory and how the OWNER can make it blocking.
    local run_id=""
    run_id="$(_proof_check_run_id "$proof_path")"

    local verify_line="Verify it yourself: loki proof verify"
    if [ -n "$run_id" ]; then
        verify_line="Verify it yourself: loki proof verify ${run_id}"
    fi

    local summary=""
    summary="This is an advisory check posted by Loki. It reports the deterministic verified-completion headline (${headline}) for this run. Loki does not enforce a merge gate and does not make this check required. To make this gate blocking, the repository owner must add \"loki: verified-completion\" as a required status check in repository settings. ${verify_line}"

    # --- Post the advisory check-run (best-effort). ---------------------------
    # gh api supports nested fields via key[subkey]=value, so conclusion appears
    # as a direct flat parameter. We POST to the check-runs endpoint only; we
    # NEVER touch any merge-gate / required-status endpoint.
    if _proof_check_net gh api \
        -X POST \
        "repos/${repo}/check-runs" \
        -f "name=loki: verified-completion" \
        -f "head_sha=${head_sha}" \
        -f "status=completed" \
        -f "conclusion=${conclusion}" \
        -f "output[title]=loki: verified-completion" \
        -f "output[summary]=${summary}" \
        >/dev/null 2>&1; then
        printf '%s\n' "loki: posted advisory check-run \"loki: verified-completion\" (${conclusion})." || true
    else
        printf '%s\n' "loki: advisory check-run not posted (gh API error or insufficient check permission)." || true
    fi

    return 0
}
