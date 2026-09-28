#!/usr/bin/env bash
#===============================================================================
# eval/loki10/test-scorecard.sh
#
# S41-02/S41-17: the D41/D43 scorecard tool against synthetic fixture rows.
# Task ids are real tasks already in eval/loki10/tasks/ (qs-dashboard,
# qs-blog-platform, and 27 more small-tier ids; pub-werkzeug-3105,
# pub-attrs-1313, pub-faker-1817 = tier medium), so tier lookup needs no
# fake tasks dir. Never runs a real arm.
#
# S41-17/D43 marking: every column now gets a seeded 10000-resample
# percentile-bootstrap 95% CI (clustered by task), and is green/red only
# when that CI (the loki-minus-raw difference, or the ratio for the D41
# headline cost pair) lies entirely outside the noise; otherwise
# inconclusive. Row layout is now
#   | Metric | raw | raw CI | loki | loki CI | Diff/Ratio CI | Mark | Reason |
# so row assertions below extract fields by position (col(), 1-indexed on
# "|") instead of anchoring a fixed-width line end.
#
# Legs:
#   1. tier small: every mark green (a small, low-n fixture -- exercised
#      again, more pointedly, by leg (e) below)
#   2. tier medium: every mark red, including a null-cost row on loki's side
#      that must show n/a and red even though its non-null rows alone would
#      average cheaper than raw (null-anywhere kills the average, not just
#      the missing row)
#   3. refusal: unequal task sets -> exit 2, no table printed
#   4. refusal: equal task sets, unequal harness_sha -> exit 2
#   5. empty input: no args, and a label pointing at an empty file
#   6. --append writes the tables to the given path; the real docs/v10/METRICS.md
#      is untouched by this whole test
#   7-9. D41 headline pair (loki-sonnet vs raw-opus): ratio CI vs 0.5x
#   a. two arms with the same expected rate but a complementary per-task
#      split (noise only) give an inconclusive completion mark and verdict
#   b. a clear gap (loki 20/20, raw 8/20, 3 reps) gives green completion
#   c. determinism: identical input gives byte-identical output across runs
#   d. a null cost row still gives red under the new CI columns
#   e. a single rep (n=1 per task, 2 tasks) still works and shows a wide CI
#===============================================================================
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib-tmp.sh
. "$HERE/lib-tmp.sh"
SCRIPT="$HERE/scorecard"

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

if [ ! -x "$SCRIPT" ]; then
    fail "eval/loki10/scorecard is missing or not executable"
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
fi

sha() { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }
REAL_METRICS="$REPO/docs/v10/METRICS.md"
real_metrics_before="$(sha "$REAL_METRICS" 2>/dev/null || echo none)"

# row_of FILE METRIC_PREFIX_REGEX: the one table row for that metric.
row_of() { grep -E "^\| $2" "$1"; }
# col LINE INDEX: 1-indexed field of a "| a | b | c |" row, split on "|"
# (index 1 is the empty text before the first pipe, 2 is Metric, ...).
col() { awk -F'|' -v i="$2" '{v=$i; gsub(/^[ \t]+|[ \t]+$/, "", v); print v}' <<<"$1"; }

loki_run_tmp_create || { echo "FAIL: cannot create run tmp"; exit 1; }
T="$LOKI_RUN_TMP"
trap 'loki_run_tmp_cleanup || echo "WARN: test tmp cleanup refused: $T"' EXIT

python3 - "$T" <<'PYEOF'
import json, sys
T = sys.argv[1]
MODEL = "claude-sonnet-4-6"

def row(task, arm, harness_sha, completed, t2pr, cost, rep=1, cost_source="provider", model=MODEL):
    return {"run_id": "%s.%s.%s.rep%d" % (task, arm, harness_sha, rep), "task": task, "arm": arm,
            "status": "ok", "model": model, "harness_sha": harness_sha,
            "started": "2026-09-27T23:00:00Z", "ended": "2026-09-27T23:00:30Z",
            "completed": completed, "time_to_pr_s": t2pr, "cost_usd": cost,
            "cost_source": cost_source, "pr_opened": True, "hidden_pass": completed, "capped": False}

# ---- tier small: qs-dashboard, qs-blog-platform, 3 reps each (one file per
# rep, per section 2's "one row per (arm label, rep file, task)"). Clustering
# is by task, so a wider CI needs a real per-task signal, not just more rep
# files: on EVERY task, raw completes exactly 1 of its 3 reps and loki
# completes all 3. Because every task contributes the same 1-of-3 vs 3-of-3
# ratio, the bootstrap's resampled completion rate is exactly 1/3 (raw) vs
# 1 (loki) for ANY resample -- a tight, strictly-green CI (D43: excludes 0
# on the good side), not a boundary tie. Cost and p50 favor loki on every
# row, so all three marks land strictly green.
#
# ---- tier medium: pub-werkzeug-3105, pub-attrs-1313, pub-faker-1817, 3
# reps each, mirroring tier small in the other direction: raw completes
# every rep, loki completes exactly 1 of 3 (same reasoning -> a tight,
# strictly-red completion and p50 CI). loki's cost_usd is null on exactly
# one row (pub-faker-1817's one completed rep), so cost must read n/a/red
# regardless of what its other priced rows would average to.
for rep in (1, 2, 3):
    raw_rows, loki_rows = [], []
    for task in ("qs-dashboard", "qs-blog-platform"):
        raw_rows.append(row(task, "raw-claude", "sha-small", rep == 1, 100, 0.20, rep=rep))
        loki_rows.append(row(task, "v10", "sha-small", True, 50, 0.10, rep=rep))
    for task in ("pub-werkzeug-3105", "pub-attrs-1313", "pub-faker-1817"):
        raw_rows.append(row(task, "raw-claude", "sha-medium", True, 50, 0.20, rep=rep))
        completed = rep == 1
        cost = None if (task == "pub-faker-1817" and completed) else 0.05
        loki_rows.append(row(task, "v10", "sha-medium", completed, 100, cost, rep=rep))
    with open(T + "/raw-r%d.jsonl" % rep, "w") as f:
        f.write("\n".join(json.dumps(r) for r in raw_rows) + "\n")
    with open(T + "/loki-r%d.jsonl" % rep, "w") as f:
        f.write("\n".join(json.dumps(r) for r in loki_rows) + "\n")

# ---- (e): the ORIGINAL 2-task/1-rep tier-small fixture -- single rep,
# wide CI that straddles 0 (not enough evidence to call it), so it must
# read inconclusive, not green.
onerep_raw = [
    row("qs-dashboard", "raw-claude", "sha-onerep", True, 100, 0.20),
    row("qs-blog-platform", "raw-claude", "sha-onerep", False, 100, 0.20),
]
onerep_loki = [
    row("qs-dashboard", "v10", "sha-onerep", True, 50, 0.10),
    row("qs-blog-platform", "v10", "sha-onerep", True, 50, 0.10),
]
with open(T + "/onerep-raw.jsonl", "w") as f:
    f.write("\n".join(json.dumps(r) for r in onerep_raw) + "\n")
with open(T + "/onerep-loki.jsonl", "w") as f:
    f.write("\n".join(json.dumps(r) for r in onerep_loki) + "\n")

# ---- refusal fixtures
with open(T + "/raw-mismatch-tasks.jsonl", "w") as f:
    f.write(json.dumps(row("qs-dashboard", "raw-claude", "sha-x", True, 10, 0.1)) + "\n")
with open(T + "/loki-mismatch-tasks.jsonl", "w") as f:
    f.write(json.dumps(row("qs-blog-platform", "v10", "sha-x", True, 10, 0.1)) + "\n")

with open(T + "/raw-sha-a.jsonl", "w") as f:
    f.write(json.dumps(row("qs-dashboard", "raw-claude", "sha-a", True, 10, 0.1)) + "\n")
with open(T + "/loki-sha-b.jsonl", "w") as f:
    f.write(json.dumps(row("qs-dashboard", "v10", "sha-b", True, 10, 0.1)) + "\n")

open(T + "/empty.jsonl", "w").close()

# ---- D41 headline pair: loki-sonnet vs raw-opus, matched by arm+model
# (section 3). Cost mark now comes from the ratio CI against 0.5 (E-122).
# A single-task fixture makes the bootstrap degenerate (every resample
# draws the same one task), so the ratio CI collapses to a point at the
# true ratio -- an exact boundary test.
headline_raw = [row("qs-dashboard", "raw-claude", "sha-headline", True, 100, 1.00, model="claude-opus-5-5")]
with open(T + "/headline-raw.jsonl", "w") as f:
    f.write("\n".join(json.dumps(r) for r in headline_raw) + "\n")
with open(T + "/headline-loki-0.6x.jsonl", "w") as f:
    f.write(json.dumps(row("qs-dashboard", "v10", "sha-headline", True, 100, 0.60,
                            model="claude-sonnet-5")) + "\n")
with open(T + "/headline-loki-0.5x.jsonl", "w") as f:
    f.write(json.dumps(row("qs-dashboard", "v10", "sha-headline", True, 100, 0.50,
                            model="claude-sonnet-5")) + "\n")

with open(T + "/nonheadline-raw.jsonl", "w") as f:
    f.write(json.dumps(row("qs-blog-platform", "raw-claude", "sha-nonheadline", True, 100, 1.00,
                            model="claude-opus-5-5")) + "\n")
with open(T + "/nonheadline-loki-0.6x.jsonl", "w") as f:
    f.write(json.dumps(row("qs-blog-platform", "v10", "sha-nonheadline", True, 100, 0.60,
                            model="claude-opus-5-5")) + "\n")

# ---- (a) same per-task outcomes: loki has the EXACT SAME completion, time
# and cost as raw on every one of 10 tasks (5 completed, 5 not, so there is
# real inter-task variance to resample -- but no arm-vs-arm signal at all).
# Every bootstrap replicate's difference is therefore exactly 0 (both arms
# draw identical rows for identical resampled tasks), which does not
# EXCLUDE 0 -> inconclusive, never green.
small29 = [
    "aiq-52-searchbar", "pub-click-2877", "pub-click-3059", "pub-click-3487", "pub-click-3572",
    "pub-humanize-152", "pub-humanize-174", "pub-humanize-333", "pub-jsonschema-1389", "pub-markupsafe-417",
    "pub-more-itertools-1192", "pub-more-itertools-1250", "pub-more-itertools-1252", "pub-more-itertools-1277",
    "pub-packaging-1315", "qs-api-only", "qs-blog-platform", "qs-cli-tool", "qs-dashboard",
    "qs-data-pipeline", "qs-e-commerce", "qs-game", "qs-microservice", "qs-npm-library", "qs-rest-api",
    "qs-rest-api-auth", "qs-simple-todo-app", "qs-static-landing-page", "qs-web-scraper",
]
noise_tasks = small29[:10]
noise_raw = [row(t, "raw-claude", "sha-noise", i < 5, 60, 0.10) for i, t in enumerate(noise_tasks)]
noise_loki = [row(t, "v10", "sha-noise", i < 5, 60, 0.10) for i, t in enumerate(noise_tasks)]
with open(T + "/noise-raw.jsonl", "w") as f:
    f.write("\n".join(json.dumps(r) for r in noise_raw) + "\n")
with open(T + "/noise-loki.jsonl", "w") as f:
    f.write("\n".join(json.dumps(r) for r in noise_loki) + "\n")

# ---- (b) clear gap: 20 tasks, 3 reps (one rep file per rep, per section
# 2's "one row per (arm label, rep file, task)"). loki completes 20/20 on
# every rep; raw completes a fixed 8/20 on every rep.
gap_tasks = small29[:20]
for rep in (1, 2, 3):
    gap_raw = [row(t, "raw-claude", "sha-gap", i < 8, 200, 0.20) for i, t in enumerate(gap_tasks)]
    gap_loki = [row(t, "v10", "sha-gap", True, 100, 0.05) for t in gap_tasks]
    with open(T + "/gap-raw-r%d.jsonl" % rep, "w") as f:
        f.write("\n".join(json.dumps(r) for r in gap_raw) + "\n")
    with open(T + "/gap-loki-r%d.jsonl" % rep, "w") as f:
        f.write("\n".join(json.dumps(r) for r in gap_loki) + "\n")

# ---- (d) a dedicated null-cost fixture (leg 2 above also covers this at
# tier medium): reuse leg 1's strictly-green 1-of-3-vs-3-of-3 pattern (one
# file per rep, so dedupe never collapses reps into one row) and null
# exactly one of loki's cost rows, so the verdict's only red comes from
# that null cost.
for rep in (1, 2, 3):
    nc_raw_rows, nc_loki_rows = [], []
    for task in ("qs-dashboard", "qs-blog-platform"):
        nc_raw_rows.append(row(task, "raw-claude", "sha-nc", rep == 1, 100, 0.20, rep=rep))
        cost = None if (task == "qs-dashboard" and rep == 1) else 0.05
        nc_loki_rows.append(row(task, "v10", "sha-nc", True, 50, cost, rep=rep))
    with open(T + "/nullcost-raw-r%d.jsonl" % rep, "w") as f:
        f.write("\n".join(json.dumps(r) for r in nc_raw_rows) + "\n")
    with open(T + "/nullcost-loki-r%d.jsonl" % rep, "w") as f:
        f.write("\n".join(json.dumps(r) for r in nc_loki_rows) + "\n")
PYEOF

run() { "$SCRIPT" "$@" >"$T/out.log" 2>"$T/err.log"; }

# ---- 1 & 2: marks
rc=0
run raw="$T/raw-r1.jsonl" raw="$T/raw-r2.jsonl" raw="$T/raw-r3.jsonl" \
    loki="$T/loki-r1.jsonl" loki="$T/loki-r2.jsonl" loki="$T/loki-r3.jsonl" || rc=$?
[ "$rc" = 0 ] && pass "well-formed raw/loki pair exits 0" || fail "well-formed pair rc=$rc: $(cat "$T/err.log")"

grep -qE '^#### tier small: raw vs loki$' "$T/out.log" && pass "tier small table present" \
    || fail "tier small table missing: $(cat "$T/out.log")"
# Tiers print sorted by name ("medium" < "small"), so the small block runs
# from its heading to end of file.
awk '/^#### tier small/,0' "$T/out.log" > "$T/small.log"

small_completion="$(row_of "$T/small.log" 'Completion')"
[ "$(col "$small_completion" 8)" = "green" ] && pass "small: completion mark green" \
    || fail "small: completion mark not green: $small_completion"
small_cost="$(row_of "$T/small.log" 'Cost per completed')"
[ "$(col "$small_cost" 8)" = "green" ] && pass "small: cost mark green" \
    || fail "small: cost mark not green: $small_cost"
small_p50="$(row_of "$T/small.log" 'p50 time to PR')"
[ "$(col "$small_p50" 8)" = "green" ] && pass "small: p50 mark green" \
    || fail "small: p50 mark not green: $small_p50"
grep -qE '^Verdict: green\.' "$T/small.log" && pass "small: verdict green" || fail "small: verdict not green"

awk '/^#### tier medium/,/^#### tier small/' "$T/out.log" > "$T/medium.log"
medium_completion="$(row_of "$T/medium.log" 'Completion')"
[ "$(col "$medium_completion" 8)" = "red" ] && pass "medium: completion mark red" \
    || fail "medium: completion mark not red: $medium_completion"
medium_cost="$(row_of "$T/medium.log" 'Cost per completed')"
[ "$(col "$medium_cost" 3)" = '$0.2000' ] && [ "$(col "$medium_cost" 5)" = "n/a" ] \
    && [ "$(col "$medium_cost" 8)" = "red" ] \
    && pass "medium: null-cost row shows n/a and red (not the cheaper 2-row average)" \
    || fail "medium: cost row wrong: $medium_cost"
medium_p50="$(row_of "$T/medium.log" 'p50 time to PR')"
[ "$(col "$medium_p50" 8)" = "red" ] && pass "medium: p50 mark red" || fail "medium: p50 mark not red: $medium_p50"
grep -qE '^Verdict: red\.' "$T/medium.log" && pass "medium: verdict red" || fail "medium: verdict not red"

# ---- 3: refusal, mismatched task sets
rc=0; run raw="$T/raw-mismatch-tasks.jsonl" loki="$T/loki-mismatch-tasks.jsonl" || rc=$?
[ "$rc" = 2 ] && pass "mismatched task sets refused (rc=2)" || fail "mismatched task sets rc=$rc (want 2)"
[ -s "$T/out.log" ] && fail "mismatched task sets printed a table anyway" || pass "mismatched task sets: no table printed"
grep -qi "not comparable" "$T/err.log" && pass "mismatched task sets: clear stderr message" \
    || fail "mismatched task sets: stderr unclear: $(cat "$T/err.log")"

# ---- 4: refusal, mismatched harness_sha
rc=0; run raw="$T/raw-sha-a.jsonl" loki="$T/loki-sha-b.jsonl" || rc=$?
[ "$rc" = 2 ] && pass "mismatched harness_sha refused (rc=2)" || fail "mismatched harness_sha rc=$rc (want 2)"
grep -qi "harness_sha" "$T/err.log" && pass "mismatched harness_sha: clear stderr message" \
    || fail "mismatched harness_sha: stderr unclear: $(cat "$T/err.log")"

# ---- 5: empty input
rc=0; run || rc=$?
[ "$rc" = 2 ] && pass "no arguments refused (rc=2)" || fail "no arguments rc=$rc (want 2)"
[ -s "$T/err.log" ] && pass "no arguments: stderr not empty" || fail "no arguments: stderr empty"

rc=0; run raw="$T/empty.jsonl" loki="$T/loki-r1.jsonl" || rc=$?
[ "$rc" = 2 ] && pass "empty result file refused (rc=2)" || fail "empty result file rc=$rc (want 2)"
grep -qi "no result rows" "$T/err.log" && pass "empty result file: clear stderr message" \
    || fail "empty result file: stderr unclear: $(cat "$T/err.log")"

# ---- 6: --append
rc=0
run raw="$T/raw-r1.jsonl" raw="$T/raw-r2.jsonl" raw="$T/raw-r3.jsonl" \
    loki="$T/loki-r1.jsonl" loki="$T/loki-r2.jsonl" loki="$T/loki-r3.jsonl" \
    --append "$T/METRICS.md" || rc=$?
[ "$rc" = 0 ] && [ -f "$T/METRICS.md" ] && grep -qE '^#### tier small: raw vs loki$' "$T/METRICS.md" \
    && pass "--append writes the tables to the given path" \
    || fail "--append did not write the expected tables (rc=$rc)"

real_metrics_after="$(sha "$REAL_METRICS" 2>/dev/null || echo none)"
[ "$real_metrics_before" = "$real_metrics_after" ] && pass "real docs/v10/METRICS.md untouched" \
    || fail "real docs/v10/METRICS.md CHANGED during this test"

# ---- 7: D41 headline pair (loki-sonnet vs raw-opus), 0.6x raw cost is red
rc=0; run raw="$T/headline-raw.jsonl" loki="$T/headline-loki-0.6x.jsonl" || rc=$?
[ "$rc" = 0 ] && pass "headline pair at 0.6x exits 0" || fail "headline pair at 0.6x rc=$rc: $(cat "$T/err.log")"
h6_cost="$(row_of "$T/out.log" 'Cost per completed \(headline')"
[ -n "$h6_cost" ] && pass "headline pair: row is labeled headline" || fail "headline pair: row not labeled headline: $(cat "$T/out.log")"
[ "$(col "$h6_cost" 8)" = "red" ] && pass "headline pair: 0.6x raw cost is red" \
    || fail "headline pair: 0.6x raw cost mark wrong: $h6_cost"

# ---- 8: D41 headline pair, exactly 0.5x raw cost is green (ratio CI
# boundary: hi<=0.5 is inclusive, matching D41's original <=)
rc=0; run raw="$T/headline-raw.jsonl" loki="$T/headline-loki-0.5x.jsonl" || rc=$?
[ "$rc" = 0 ] && pass "headline pair at 0.5x exits 0" || fail "headline pair at 0.5x rc=$rc: $(cat "$T/err.log")"
h5_cost="$(row_of "$T/out.log" 'Cost per completed \(headline')"
[ -n "$h5_cost" ] && pass "0.5x pair: row is labeled headline" || fail "0.5x pair: row not labeled headline: $(cat "$T/out.log")"
[ "$(col "$h5_cost" 8)" = "green" ] && pass "headline pair: 0.5x raw cost is green" \
    || fail "headline pair: 0.5x raw cost mark wrong: $h5_cost"

# ---- 9: non-headline pair (raw-opus vs loki-opus) at 0.6x raw cost stays
# green under the plain diff-CI-vs-0 rule (no 0.5x ratio bar).
rc=0; run raw="$T/nonheadline-raw.jsonl" loki="$T/nonheadline-loki-0.6x.jsonl" || rc=$?
[ "$rc" = 0 ] && pass "non-headline pair at 0.6x exits 0" || fail "non-headline pair at 0.6x rc=$rc: $(cat "$T/err.log")"
nh_cost="$(row_of "$T/out.log" 'Cost per completed \|')"
[ -n "$nh_cost" ] && pass "non-headline pair: row is the plain (non-headline) label" \
    || fail "non-headline pair: row wrongly labeled headline: $(cat "$T/out.log")"
[ "$(col "$nh_cost" 8)" = "green" ] && pass "non-headline pair: 0.6x raw cost stays green" \
    || fail "non-headline pair: 0.6x raw cost mark wrong: $nh_cost"

# ---- a: noise only (same 50% rate, complementary per-task split) ->
# inconclusive completion mark, and an inconclusive verdict (never flips a
# default to green or red on ambiguous evidence)
rc=0; run raw="$T/noise-raw.jsonl" loki="$T/noise-loki.jsonl" || rc=$?
[ "$rc" = 0 ] && pass "noise fixture exits 0" || fail "noise fixture rc=$rc: $(cat "$T/err.log")"
noise_completion="$(row_of "$T/out.log" 'Completion')"
[ "$(col "$noise_completion" 8)" = "inconclusive" ] && pass "noise: completion mark inconclusive" \
    || fail "noise: completion mark not inconclusive: $noise_completion"
grep -qE '^Verdict: inconclusive\.' "$T/out.log" && pass "noise: verdict inconclusive" \
    || fail "noise: verdict not inconclusive: $(grep '^Verdict:' "$T/out.log")"

# ---- b: clear gap (loki 20/20, raw 8/20, 3 reps) -> green completion
rc=0
run raw="$T/gap-raw-r1.jsonl" raw="$T/gap-raw-r2.jsonl" raw="$T/gap-raw-r3.jsonl" \
    loki="$T/gap-loki-r1.jsonl" loki="$T/gap-loki-r2.jsonl" loki="$T/gap-loki-r3.jsonl" || rc=$?
[ "$rc" = 0 ] && pass "gap fixture exits 0" || fail "gap fixture rc=$rc: $(cat "$T/err.log")"
gap_completion="$(row_of "$T/out.log" 'Completion')"
[ "$(col "$gap_completion" 3)" = "24/60 (40.0%)" ] && [ "$(col "$gap_completion" 5)" = "60/60 (100.0%)" ] \
    && [ "$(col "$gap_completion" 8)" = "green" ] \
    && pass "gap: clear 20/20 vs 8/20 gives green completion" \
    || fail "gap: completion row wrong: $gap_completion"

# ---- c: determinism -- identical input, two separate runs, byte-identical
# stdout (fixed bootstrap seed and resample count)
"$SCRIPT" raw="$T/gap-raw-r1.jsonl" raw="$T/gap-raw-r2.jsonl" raw="$T/gap-raw-r3.jsonl" \
    loki="$T/gap-loki-r1.jsonl" loki="$T/gap-loki-r2.jsonl" loki="$T/gap-loki-r3.jsonl" \
    >"$T/det1.log" 2>"$T/det1.err"
"$SCRIPT" raw="$T/gap-raw-r1.jsonl" raw="$T/gap-raw-r2.jsonl" raw="$T/gap-raw-r3.jsonl" \
    loki="$T/gap-loki-r1.jsonl" loki="$T/gap-loki-r2.jsonl" loki="$T/gap-loki-r3.jsonl" \
    >"$T/det2.log" 2>"$T/det2.err"
if diff -q "$T/det1.log" "$T/det2.log" >/dev/null; then
    pass "determinism: two runs on identical input are byte-identical"
else
    fail "determinism: two runs on identical input differ"
fi

# ---- d: a null cost row still gives red under the new CI columns
rc=0
run raw="$T/nullcost-raw-r1.jsonl" raw="$T/nullcost-raw-r2.jsonl" raw="$T/nullcost-raw-r3.jsonl" \
    loki="$T/nullcost-loki-r1.jsonl" loki="$T/nullcost-loki-r2.jsonl" loki="$T/nullcost-loki-r3.jsonl" || rc=$?
[ "$rc" = 0 ] && pass "nullcost fixture exits 0" || fail "nullcost fixture rc=$rc: $(cat "$T/err.log")"
nullcost_row="$(row_of "$T/out.log" 'Cost per completed')"
[ "$(col "$nullcost_row" 5)" = "n/a" ] && [ "$(col "$nullcost_row" 6)" = "n/a" ] \
    && [ "$(col "$nullcost_row" 7)" = "n/a" ] && [ "$(col "$nullcost_row" 8)" = "red" ] \
    && pass "nullcost: n/a cost row is red across value, CI and diff CI" \
    || fail "nullcost: cost row wrong: $nullcost_row"
nullcost_completion="$(row_of "$T/out.log" 'Completion')"
nullcost_p50="$(row_of "$T/out.log" 'p50 time to PR')"
[ "$(col "$nullcost_completion" 8)" = "green" ] && [ "$(col "$nullcost_p50" 8)" = "green" ] \
    && pass "nullcost: completion and p50 are clearly green (only cost is red)" \
    || fail "nullcost: completion/p50 not both green: $nullcost_completion / $nullcost_p50"
grep -qE '^Verdict: red\.' "$T/out.log" && pass "nullcost: verdict red" \
    || fail "nullcost: verdict not red: $(grep '^Verdict:' "$T/out.log")"

# ---- e: a single rep (n=1 per task, only 2 tasks) still works: it exits 0
# (no crash on thin data), its completion diff CI is wide (spans the whole
# 0-100pp range) rather than silently narrowing, and -- because that CI
# straddles 0 -- the mark is inconclusive, not green.
rc=0; run raw="$T/onerep-raw.jsonl" loki="$T/onerep-loki.jsonl" || rc=$?
[ "$rc" = 0 ] && pass "single rep: exits 0 (works with n=1 rep per task)" \
    || fail "single rep: rc=$rc: $(cat "$T/err.log")"
onerep_completion="$(row_of "$T/out.log" 'Completion')"
onerep_completion_ci="$(col "$onerep_completion" 7)"
[ "$onerep_completion_ci" = "[+0.0pp, +100.0pp]" ] \
    && pass "single rep: completion diff CI is wide ($onerep_completion_ci), not degenerate" \
    || fail "single rep: completion diff CI not wide: $onerep_completion_ci"
[ "$(col "$onerep_completion" 8)" = "inconclusive" ] \
    && pass "single rep: wide CI (straddles 0) marks inconclusive, not green" \
    || fail "single rep: mark should be inconclusive: $onerep_completion"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
