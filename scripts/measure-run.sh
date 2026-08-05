#!/usr/bin/env bash
# Report where a run's wall clock actually went.
#
# WHY. The speed knobs shipped in v8.33.0-v8.36.0 are verified to BIND, but the
# end-to-end win is unproven -- proving it needs a real build, and until now
# reading the result meant hand-parsing .loki/events.jsonl. That is how the
# original measurement got made, and it is not a thing to re-derive under time
# pressure with a paid build already spent.
#
# This reads ONLY what a run already wrote. It starts nothing, costs nothing,
# and never contacts a provider.
#
# Usage:
#   scripts/measure-run.sh [workspace]      # default: .
#   scripts/measure-run.sh --json [ws]      # machine-readable
#
# The comparison it exists to make:
#
#   baseline   LOKI_REVIEW_MAX_REVIEWERS unset, LOKI_REVIEW_SKIP_ON_GATE_FAIL unset
#   capped     LOKI_REVIEW_MAX_REVIEWERS=3 LOKI_REVIEW_SKIP_ON_GATE_FAIL=true
#
# Run the same issue twice, diff the code_review row and the total.

set -uo pipefail

JSON=false
if [ "${1:-}" = "--json" ]; then JSON=true; shift; fi
WS="${1:-.}"
EVENTS="$WS/.loki/events.jsonl"

if [ ! -f "$EVENTS" ]; then
    echo "no events at $EVENTS -- pass the workspace directory of a completed run" >&2
    exit 66
fi

LOKI_MEASURE_EVENTS="$EVENTS" LOKI_MEASURE_JSON="$JSON" python3 <<'PY'
import json, os, datetime as dt
from collections import defaultdict

path = os.environ["LOKI_MEASURE_EVENTS"]
as_json = os.environ["LOKI_MEASURE_JSON"] == "true"

stages = defaultdict(list)
prompt_bytes = []
reviews = []          # (seconds, reviewer_count, pass, fail)
starts = {}
first_artifact = first_preview = None
iterations = 0

def when(e):
    ts = e.get("timestamp")
    if not ts:
        return None
    try:
        return dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None

with open(path, errors="replace") as fh:
    for line in fh:
        try:
            e = json.loads(line)
        except Exception:
            continue                      # a truncated tail must not abort the report
        t = e.get("type") or e.get("event")
        d = e.get("data", {}) if isinstance(e.get("data"), dict) else {}

        if t == "stage_complete":
            s, secs = d.get("stage"), d.get("duration_s")
            if s is not None and isinstance(secs, (int, float)):
                stages[s].append(float(secs))
        elif t == "iteration_complete":
            iterations += 1
        elif t == "agent_prompt":
            b = d.get("bytes")
            if isinstance(b, (int, float)) and b > 0:
                prompt_bytes.append(int(b))
        elif t == "code_review_start":
            T = when(e)
            rid = d.get("review_id")
            if T and rid:
                names = [n for n in str(d.get("reviewers", "")).split(",") if n.strip()]
                starts[rid] = (T, len(names))
        elif t == "code_review_complete":
            T = when(e)
            rid = d.get("review_id")
            if T and rid in starts:
                T0, n = starts.pop(rid)
                reviews.append((int((T - T0).total_seconds()), n,
                                d.get("pass_count"), d.get("fail_count")))

# Signals written outside events.jsonl.
ws = os.path.dirname(os.path.dirname(path))
for rel, key, var in (
    (".loki/app-runner/first-preview.json", "seconds_to_first_preview", "preview"),
    (".loki/state/first-artifact.json", "seconds_to_first_artifact", "artifact"),
):
    try:
        with open(os.path.join(ws, rel)) as fh:
            v = json.load(fh).get(key)
        if isinstance(v, (int, float)) and v >= 0:
            if var == "preview": first_preview = int(v)
            else: first_artifact = int(v)
    except Exception:
        pass

total = sum(sum(v) for v in stages.values())

if as_json:
    print(json.dumps({
        "iterations": iterations,
        "total_stage_seconds": round(total, 1),
        "stages": {k: {"n": len(v), "total_s": round(sum(v), 1),
                       "median_s": round(sorted(v)[len(v)//2], 1)}
                   for k, v in stages.items()},
        "reviews": [{"seconds": s, "reviewers": n, "pass": p, "fail": f}
                    for s, n, p, f in reviews],
        "seconds_to_first_artifact": first_artifact,
        "agent_prompt_bytes": prompt_bytes or None,
        "seconds_to_first_preview": first_preview,
    }, indent=2))
    raise SystemExit

if not stages and not reviews:
    print("No stage or review events recorded. Either the run predates the")
    print("stage instrumentation, or it never reached a gate.")
    raise SystemExit

print("WHERE THE TIME WENT")
print("=" * 58)
print(f"{'stage':22}{'n':>4}{'median':>9}{'total':>9}{'share':>8}")
for k, v in sorted(stages.items(), key=lambda x: -sum(x[1])):
    v = sorted(v)
    tot = sum(v)
    share = (tot / total * 100) if total else 0
    print(f"{k:22}{len(v):>4}{v[len(v)//2]:>8.0f}s{tot:>8.0f}s{share:>7.0f}%")
print("-" * 58)
print(f"{'TOTAL':22}{'':>4}{'':>9}{total:>8.0f}s")

if reviews:
    print()
    print("CODE REVIEW, per council")
    print(f"{'seconds':>9}{'reviewers':>11}{'pass':>6}{'fail':>6}")
    for s, n, p, f in sorted(reviews, reverse=True):
        print(f"{s:>9}{n:>11}{str(p):>6}{str(f):>6}")
    # The relationship the cap targets. Stated only when the data shows both
    # ends; a single sample cannot support a claim about scaling.
    sizes = {n for _, n, _, _ in reviews}
    if len(sizes) > 1:
        small = min(reviews, key=lambda r: r[1])
        large = max(reviews, key=lambda r: r[1])
        if small[0] > 0:
            print(f"\n  {large[1]} reviewers took {large[0] // max(small[0],1)}x "
                  f"the {small[1]}-reviewer council ({large[0]}s vs {small[0]}s)")

print()
print("TIME TO FIRST SIGNAL")
print(f"  first code change : {str(first_artifact) + 's' if first_artifact is not None else 'not recorded'}")
print(f"  first preview     : {str(first_preview) + 's' if first_preview is not None else 'not recorded (no previewable app)'}")
print(f"  iterations        : {iterations}")
if prompt_bytes:
    _med = sorted(prompt_bytes)[len(prompt_bytes) // 2]
    print(f"  agent prompt      : {_med / 1024:.0f} KB median "
          f"({min(prompt_bytes) / 1024:.0f}-{max(prompt_bytes) / 1024:.0f} KB over "
          f"{len(prompt_bytes)} call(s))")
else:
    print("  agent prompt      : not recorded")

print()
print("TO COMPARE: run the same issue twice and diff the code_review row.")
print("  baseline:  (knobs unset)")
print("  capped:    LOKI_REVIEW_MAX_REVIEWERS=3 LOKI_REVIEW_SKIP_ON_GATE_FAIL=true")
PY
