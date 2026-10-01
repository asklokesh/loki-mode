#!/usr/bin/env bash
# E-160 / D55: may a push to main reuse a train/** run's verdict for the SAME sha?
#
#   train-verdict-reuse.sh decide   pure; reads RUNS_JSON (a file holding the
#                                   workflow-runs API response) and, when
#                                   CACHE_KEY_FILES is set, COMPARE_JSON
#   train-verdict-reuse.sh gate     fetches both with gh, then runs decide
#
# Both always exit 0 and print reuse=, reused_run_id=, reused_attempt=,
# reused_branch= (also appended to $GITHUB_OUTPUT when set). Anything doubtful
# is reuse=false: the full suite runs. Kill switch: LOKI_E160_REUSE=0.
# Env: SHA REF EVENT_NAME RUN_ID WF_FILE [BEFORE CACHE_KEY_FILES] [REPO GH_TOKEN]
set -uo pipefail

decide() {
  python3 - <<'PYEOF' 2>/dev/null || printf 'reuse=false\nreused_run_id=\nreused_attempt=\nreused_branch=\n'
import json, os, re

E = os.environ.get
NO = {"reuse": "false", "reused_run_id": "", "reused_attempt": "", "reused_branch": ""}

def emit(d):
    for k in ("reuse", "reused_run_id", "reused_attempt", "reused_branch"):
        print(f"{k}={d[k]}")

def decide():
    if E("LOKI_E160_REUSE") == "0":
        return NO
    if E("EVENT_NAME") != "push" or E("REF") != "refs/heads/main":
        return NO
    sha, wf = E("SHA", ""), E("WF_FILE", "")
    if not sha or not wf:
        return NO
    keys = E("CACHE_KEY_FILES", "").split()
    if keys:
        before = E("BEFORE", "")
        if not before or re.fullmatch(r"0+", before):
            return NO
        cj = E("COMPARE_JSON", "")
        if not cj or not os.path.isfile(cj):
            return NO
        files = json.load(open(cj))["files"]
        if not isinstance(files, list) or len(files) >= 300:
            return NO
        if {f["filename"] for f in files} & set(keys):
            return NO
    d = json.load(open(E("RUNS_JSON", "")))
    runs = d["workflow_runs"]
    if not isinstance(runs, list) or int(d["total_count"]) > 100:
        return NO
    path = ".github/workflows/" + wf
    t = [r for r in runs
         if r.get("head_sha") == sha and r.get("event") == "push"
         and str(r.get("head_branch", "")).startswith("train/")
         and r.get("path") == path and str(r.get("id")) != E("RUN_ID", "")
         and r.get("status") == "completed"]
    bad = [r for r in t if r.get("conclusion") in ("failure", "timed_out", "startup_failure")]
    if bad: return NO  # E160-FAILURE-BLOCK
    good = [r for r in t if r.get("conclusion") == "success"]
    if not good:
        return NO
    g = max(good, key=lambda r: r.get("created_at", ""))
    return {"reuse": "true", "reused_run_id": g["id"],
            "reused_attempt": g.get("run_attempt", 1), "reused_branch": g["head_branch"]}

try:
    emit(decide())
except Exception:
    emit(NO)
PYEOF
}

# Print the decision, mirror it to $GITHUB_OUTPUT, annotate on reuse.
report() {
  local out id att br msg
  out="$(decide)"
  printf '%s\n' "$out"
  [ -z "${GITHUB_OUTPUT:-}" ] || printf '%s\n' "$out" >> "$GITHUB_OUTPUT"
  case "$out" in
    *reuse=true*)
      id="$(printf '%s\n' "$out" | sed -n 's/^reused_run_id=//p')"
      att="$(printf '%s\n' "$out" | sed -n 's/^reused_attempt=//p')"
      br="$(printf '%s\n' "$out" | sed -n 's/^reused_branch=//p')"
      msg="E-160: reusing ${WF_FILE:-workflow} run ${id} (attempt ${att}, branch ${br}) for ${SHA:-?}; heavy jobs skip"
      echo "::notice::${msg}"
      [ -z "${GITHUB_STEP_SUMMARY:-}" ] || printf '%s\n' "$msg" >> "$GITHUB_STEP_SUMMARY"
      ;;
  esac
}

case "${1:-}" in
  decide)
    report
    ;;
  gate)
    W="$(mktemp -d "${TMPDIR:-/tmp}/train-reuse.XXXXXXXX")" || { RUNS_JSON=/nonexistent report; exit 0; }
    trap 'rm -rf -- "$W"' EXIT
    if [ "${EVENT_NAME:-}" = "push" ] && [ "${REF:-}" = "refs/heads/main" ] && [ "${LOKI_E160_REUSE:-}" != "0" ]; then
      gh api "repos/${REPO:-}/actions/workflows/${WF_FILE:-}/runs?head_sha=${SHA:-}&event=push&per_page=100" > "$W/runs.json" 2>/dev/null || : > "$W/runs.json"
      if [ -n "${CACHE_KEY_FILES:-}" ]; then
        if gh api "repos/${REPO:-}/compare/${BEFORE:-}...${SHA:-}" > "$W/compare.json" 2>/dev/null; then
          export COMPARE_JSON="$W/compare.json"
        else
          unset COMPARE_JSON
        fi
      fi
    fi
    RUNS_JSON="$W/runs.json" report
    ;;
  *)
    echo "usage: $0 decide|gate" >&2
    exit 64
    ;;
esac
exit 0
