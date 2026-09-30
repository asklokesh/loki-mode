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
#   D43 item 2 floor: a tier under 20 tasks or 3 reps per task reads
#   inconclusive on every mark (legs e-i); a red null-cost mark outranks
#   inconclusive in the verdict (leg 2b). All fixtures run AT the floor
#   (20 tasks x 3 reps) unless a leg is testing below it.
#   1. tier small at the floor: clear gap, every mark green
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
#   a. 20 tasks x 3 reps, arms share true rates but independent draws:
#      every mark and the verdict read inconclusive
#   b. a clear gap (loki 20/20, raw 8/20, 3 reps) gives green completion
#   c. determinism: identical input gives byte-identical output across runs
#   d. a null cost row still gives red under the new CI columns
#   e. a single rep (n=1 per task, 2 tasks) works, shows a wide CI, and is
#      inconclusive with the floor reason
#   f-i. 1 task x 3 reps (the audit repro), 19 tasks, 2 reps, overrides
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

TASKS = [
    "aiq-52-searchbar", "pub-click-2877", "pub-click-3059", "pub-click-3487", "pub-click-3572",
    "pub-humanize-152", "pub-humanize-174", "pub-humanize-333", "pub-jsonschema-1389", "pub-markupsafe-417",
    "pub-more-itertools-1192", "pub-more-itertools-1250", "pub-more-itertools-1252", "pub-more-itertools-1277",
    "pub-packaging-1315", "qs-api-only", "qs-blog-platform", "qs-cli-tool", "qs-dashboard",
    "qs-data-pipeline", "qs-e-commerce", "qs-game", "qs-microservice", "qs-npm-library", "qs-rest-api",
    "qs-rest-api-auth", "qs-simple-todo-app", "qs-static-landing-page", "qs-web-scraper",
]
FLOOR_TASKS = TASKS[:20]   # exactly the D43 floor: 20 tasks
TASKS = FLOOR_TASKS

# ---- tier medium: pub-werkzeug-3105, pub-attrs-1313, pub-faker-1817, 3
# reps each (one file per rep, per section 2): raw completes every rep, loki
# completes exactly 1 of 3 (a tight, strictly-red completion and p50 CI).
# loki's cost_usd is null on exactly one row (pub-faker-1817's one completed
# rep), so cost must read n/a/red regardless of what its other priced rows
# would average to. Only 3 medium tasks exist, so this fixture is run with
# --min-tasks 3 (the test-only override) and again without it.
for rep in (1, 2, 3):
    raw_rows, loki_rows = [], []
    for task in ("pub-werkzeug-3105", "pub-attrs-1313", "pub-faker-1817"):
        raw_rows.append(row(task, "raw-claude", "sha-medium", True, 50, 0.20, rep=rep))
        completed = rep == 1
        cost = None if (task == "pub-faker-1817" and completed) else 0.05
        loki_rows.append(row(task, "v10", "sha-medium", completed, 100, cost, rep=rep))
    with open(T + "/raw-r%d.jsonl" % rep, "w") as f:
        f.write("\n".join(json.dumps(r) for r in raw_rows) + "\n")
    with open(T + "/loki-r%d.jsonl" % rep, "w") as f:
        f.write("\n".join(json.dumps(r) for r in loki_rows) + "\n")

def write_reps(prefix, reps, mk_raw, mk_loki):
    """One rep file per rep per arm: prefix-raw-rN.jsonl / prefix-loki-rN.jsonl."""
    for rep in range(1, reps + 1):
        for arm, mk in (("raw", mk_raw), ("loki", mk_loki)):
            with open(T + "/%s-%s-r%d.jsonl" % (prefix, arm, rep), "w") as f:
                f.write("\n".join(json.dumps(mk(i, t, rep)) for i, t in enumerate(TASKS)) + "\n")

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
# (section 3), at the D43 floor (20 tasks x 3 reps). Every task has the same
# cost ratio, so the ratio CI collapses to a point at the true ratio: an
# exact boundary test (0.6 is red, 0.5 is green).
OPUS, SONNET = "claude-opus-5-5", "claude-sonnet-5"
write_reps("h6", 3, lambda i, t, r: row(t, "raw-claude", "sha-h", True, 100, 1.00, rep=r, model=OPUS),
           lambda i, t, r: row(t, "v10", "sha-h", True, 100, 0.60, rep=r, model=SONNET))
write_reps("h5", 3, lambda i, t, r: row(t, "raw-claude", "sha-h", True, 100, 1.00, rep=r, model=OPUS),
           lambda i, t, r: row(t, "v10", "sha-h", True, 100, 0.50, rep=r, model=SONNET))
write_reps("nh", 3, lambda i, t, r: row(t, "raw-claude", "sha-nh", True, 100, 1.00, rep=r, model=OPUS),
           lambda i, t, r: row(t, "v10", "sha-nh", True, 100, 0.60, rep=r, model=OPUS))

# ---- (a) noise at the floor: 20 tasks x 3 reps where both arms share the
# same true rates (completion 0.5, time ~60s, cost ~$0.10) but every draw is
# independent, so the arms differ row by row. No arm-vs-arm signal, so no
# mark may go green or red.
import random
def noisy(rng, arm, sha):
    def mk(i, t, r):
        return row(t, arm, sha, rng.random() < 0.5, 50 + rng.randint(0, 20), round(0.05 + rng.random() * 0.10, 4), rep=r)
    return mk
for seed in range(20):
    rng = random.Random(seed)
    write_reps("noise%d" % seed, 3, noisy(rng, "raw-claude", "sha-noise"), noisy(rng, "v10", "sha-noise"))

# ---- D43 floor counts EVALUATED reps (harness.is_evaluated), not rows.
# Base pattern is the clear gap; `bad` turns a row into a non-evaluated one.
def bad(r, status):
    return dict(r, status=status, completed=False, time_to_pr_s=None, cost_usd=None, pr_opened=False, hidden_pass=False)
def gap_raw(i, t, r): return row(t, "raw-claude", "sha-ev", i < 8, 200, 0.20, rep=r)
def gap_loki(i, t, r): return row(t, "v10", "sha-ev", True, 100, 0.05, rep=r)
write_reps("evl", 3, gap_raw, lambda i, t, r: gap_loki(i, t, r) if r == 1 else bad(gap_loki(i, t, r), "auth_unavailable"))
write_reps("evr", 3, lambda i, t, r: gap_raw(i, t, r) if r == 1 else bad(gap_raw(i, t, r), "auth_unavailable"), gap_loki)
write_reps("evi", 3, gap_raw, lambda i, t, r: gap_loki(i, t, r) if r == 1 else bad(gap_loki(i, t, r), "interrupted" if r == 2 else "arm_unavailable"))
write_reps("evz", 3, lambda i, t, r: gap_raw(i, t, r) if i >= 5 else bad(gap_raw(i, t, r), "auth_unavailable"),
           lambda i, t, r: gap_loki(i, t, r) if i >= 5 else bad(gap_loki(i, t, r), "auth_unavailable"))
# F2: loki completes nothing (cost captured on every evaluated row): zero
# completions, not a missing cost capture.
write_reps("zc", 3, gap_raw, lambda i, t, r: row(t, "v10", "sha-ev", False, None, 0.05, rep=r))

# ---- (b) clear gap at the floor: 20 tasks x 3 reps. loki completes 20/20 on
# every rep; raw completes a fixed 8/20 on every rep. Cost and time favor loki.
write_reps("gap", 3, lambda i, t, r: row(t, "raw-claude", "sha-gap", i < 8, 200, 0.20, rep=r),
           lambda i, t, r: row(t, "v10", "sha-gap", True, 100, 0.05, rep=r))

# ---- (d) null cost at the floor: the gap pattern, with one of loki's cost
# rows nulled, so the verdict's only red comes from that null cost.
write_reps("nullcost", 3, lambda i, t, r: row(t, "raw-claude", "sha-nc", i < 8, 200, 0.20, rep=r),
           lambda i, t, r: row(t, "v10", "sha-nc", True, 100, None if (i == 0 and r == 1) else 0.05, rep=r))

# ---- below the floor (D43 item 2). The audit repro: ONE task, 3 reps.
# raw completes 2 of 3 at 100s/$1.00, loki 3 of 3 at 90s/$0.90; Fisher
# exact p = 1.0, so nothing may mark green.
TASKS = ["qs-dashboard"]
write_reps("one", 3, lambda i, t, r: row(t, "raw-claude", "sha-one", r != 3, 100, 1.00, rep=r),
           lambda i, t, r: row(t, "v10", "sha-one", True, 90, 0.90, rep=r))
# 19 tasks x 3 reps: one task short of the floor, with a clear gap.
TASKS = FLOOR_TASKS[:19]
write_reps("t19", 3, lambda i, t, r: row(t, "raw-claude", "sha-t19", i < 8, 200, 0.20, rep=r),
           lambda i, t, r: row(t, "v10", "sha-t19", True, 100, 0.05, rep=r))
# 20 tasks x 2 reps: one rep short of the floor, with a clear gap.
TASKS = FLOOR_TASKS
write_reps("r2", 2, lambda i, t, r: row(t, "raw-claude", "sha-r2", i < 8, 200, 0.20, rep=r),
           lambda i, t, r: row(t, "v10", "sha-r2", True, 100, 0.05, rep=r))
PYEOF

# reps PREFIX N: the raw=/loki= argument list for N rep files.
reps() { local n; for n in $(seq 1 "$2"); do printf 'raw=%s/%s-raw-r%s.jsonl loki=%s/%s-loki-r%s.jsonl ' "$T" "$1" "$n" "$T" "$1" "$n"; done; }
# only_mark LOG: the three mark columns joined, e.g. "inconclusive inconclusive inconclusive".
marks() { local c; for c in 'Completion' 'Cost per completed' 'p50 time to PR'; do col "$(row_of "$1" "$c")" 8; done | paste -sd' ' -; }

run() { "$SCRIPT" "$@" >"$T/out.log" 2>"$T/err.log"; }

# ---- 1: a clear gap at the floor (20 tasks x 3 reps): every mark green.
# Fisher p on the completion counts (24/60 vs 60/60) is far below 0.05, so
# green is earned, not noise.
rc=0
run $(reps gap 3) || rc=$?
[ "$rc" = 0 ] && pass "well-formed raw/loki pair exits 0" || fail "well-formed pair rc=$rc: $(cat "$T/err.log")"
grep -qE '^#### tier small: raw vs loki$' "$T/out.log" && pass "tier small table present" \
    || fail "tier small table missing: $(cat "$T/out.log")"
[ "$(marks "$T/out.log")" = "green green green" ] && pass "small: all three marks green at the floor" \
    || fail "small: marks not all green: $(marks "$T/out.log")"
grep -qE '^Verdict: green\.' "$T/out.log" && pass "small: verdict green" || fail "small: verdict not green"

# ---- 2: tier medium (3 tasks, run with the test-only --min-tasks 3): every
# mark red, including a null-cost row on loki's side that must show n/a and
# red even though its non-null rows alone would average cheaper than raw
# (null-anywhere kills the average, not just the missing row)
rc=0
run raw="$T/raw-r1.jsonl" raw="$T/raw-r2.jsonl" raw="$T/raw-r3.jsonl" \
    loki="$T/loki-r1.jsonl" loki="$T/loki-r2.jsonl" loki="$T/loki-r3.jsonl" --min-tasks 3 || rc=$?
[ "$rc" = 0 ] && pass "medium pair (--min-tasks 3) exits 0" || fail "medium pair rc=$rc: $(cat "$T/err.log")"
cp "$T/out.log" "$T/medium.log"
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

# ---- 2b: the same medium fixture WITHOUT the override is below the floor
# (3 tasks, need 20): completion and p50 read inconclusive with the reason,
# the null cost stays red (D43 item 1), and red outranks inconclusive in the
# verdict.
rc=0
run raw="$T/raw-r1.jsonl" raw="$T/raw-r2.jsonl" raw="$T/raw-r3.jsonl" \
    loki="$T/loki-r1.jsonl" loki="$T/loki-r2.jsonl" loki="$T/loki-r3.jsonl" || rc=$?
[ "$rc" = 0 ] && pass "medium pair below the floor exits 0" || fail "medium below floor rc=$rc"
[ "$(marks "$T/out.log")" = "inconclusive red inconclusive" ] \
    && pass "below floor: null cost stays red, other marks inconclusive" \
    || fail "below floor: marks wrong: $(marks "$T/out.log")"
grep -qF 'below D43 floor: 3 tasks, need 20' "$T/out.log" \
    && pass "below floor: reason names the task count and the floor" || fail "below floor: reason missing"
grep -qE '^Verdict: red\.' "$T/out.log" && pass "red (null cost) outranks inconclusive in the verdict" \
    || fail "verdict: red did not outrank inconclusive: $(grep '^Verdict:' "$T/out.log")"

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
run $(reps gap 3) --append "$T/METRICS.md" || rc=$?
[ "$rc" = 0 ] && [ -f "$T/METRICS.md" ] && grep -qE '^#### tier small: raw vs loki$' "$T/METRICS.md" \
    && pass "--append writes the tables to the given path" \
    || fail "--append did not write the expected tables (rc=$rc)"

real_metrics_after="$(sha "$REAL_METRICS" 2>/dev/null || echo none)"
[ "$real_metrics_before" = "$real_metrics_after" ] && pass "real docs/v10/METRICS.md untouched" \
    || fail "real docs/v10/METRICS.md CHANGED during this test"

# ---- 7: D41 headline pair (loki-sonnet vs raw-opus), 0.6x raw cost is red
rc=0; run $(reps h6 3) || rc=$?
[ "$rc" = 0 ] && pass "headline pair at 0.6x exits 0" || fail "headline pair at 0.6x rc=$rc: $(cat "$T/err.log")"
h6_cost="$(row_of "$T/out.log" 'Cost per completed \(headline')"
[ -n "$h6_cost" ] && pass "headline pair: row is labeled headline" || fail "headline pair: row not labeled headline: $(cat "$T/out.log")"
[ "$(col "$h6_cost" 8)" = "red" ] && pass "headline pair: 0.6x raw cost is red" \
    || fail "headline pair: 0.6x raw cost mark wrong: $h6_cost"

# ---- 8: D41 headline pair, exactly 0.5x raw cost is green (ratio CI
# boundary: hi<=0.5 is inclusive, matching D41's original <=)
rc=0; run $(reps h5 3) || rc=$?
[ "$rc" = 0 ] && pass "headline pair at 0.5x exits 0" || fail "headline pair at 0.5x rc=$rc: $(cat "$T/err.log")"
h5_cost="$(row_of "$T/out.log" 'Cost per completed \(headline')"
[ -n "$h5_cost" ] && pass "0.5x pair: row is labeled headline" || fail "0.5x pair: row not labeled headline: $(cat "$T/out.log")"
[ "$(col "$h5_cost" 8)" = "green" ] && pass "headline pair: 0.5x raw cost is green" \
    || fail "headline pair: 0.5x raw cost mark wrong: $h5_cost"

# ---- 9: non-headline pair (raw-opus vs loki-opus) at 0.6x raw cost stays
# green under the plain diff-CI-vs-0 rule (no 0.5x ratio bar).
rc=0; run $(reps nh 3) || rc=$?
[ "$rc" = 0 ] && pass "non-headline pair at 0.6x exits 0" || fail "non-headline pair at 0.6x rc=$rc: $(cat "$T/err.log")"
nh_cost="$(row_of "$T/out.log" 'Cost per completed \|')"
[ -n "$nh_cost" ] && pass "non-headline pair: row is the plain (non-headline) label" \
    || fail "non-headline pair: row wrongly labeled headline: $(cat "$T/out.log")"
[ "$(col "$nh_cost" 8)" = "green" ] && pass "non-headline pair: 0.6x raw cost stays green" \
    || fail "non-headline pair: 0.6x raw cost mark wrong: $nh_cost"

# ---- a: noise at the floor, 20 seeds (same true rates, different draws).
# Rate bound, not one lucky seed: at most 15 percent of the 60 marks outside
# inconclusive, and no whole-tier green. --resamples keeps this leg fast.
outside=0; greens=0; bad_rc=0
for seed in $(seq 0 19); do
    rc=0; run $(reps "noise$seed" 3) --resamples 400 || rc=$?
    [ "$rc" = 0 ] || bad_rc=$((bad_rc + 1))
    for m in $(marks "$T/out.log"); do [ "$m" = inconclusive ] || outside=$((outside + 1)); done
    if grep -qE '^Verdict: green\.' "$T/out.log"; then greens=$((greens + 1)); fi
done
[ "$bad_rc" = 0 ] && [ "$outside" -le 9 ] && pass "noise x20 seeds: $outside/60 marks outside inconclusive (<=9)" \
    || fail "noise x20 seeds: outside=$outside bad_rc=$bad_rc (want <=9, 0)"
[ "$greens" = 0 ] && pass "noise x20 seeds: zero green verdicts" || fail "noise x20 seeds: $greens green verdicts"

# ---- j: D43 floor counts evaluated reps, not rows. Every variant must read
# inconclusive on every mark and name the shortfall.
for spec in "evl:loki 1 ok + 2 auth_unavailable" "evr:raw-side mirror" "evi:interrupted/arm_unavailable"; do
    p="${spec%%:*}"; d="${spec#*:}"
    rc=0; run $(reps "$p" 3) || rc=$?
    [ "$rc" = 0 ] && [ "$(marks "$T/out.log")" = "inconclusive inconclusive inconclusive" ] \
        && grep -qE '^Verdict: inconclusive\.' "$T/out.log" \
        && grep -qF 'below D43 floor: 0 tasks with 3 evaluated reps on both arms, need 20' "$T/out.log" \
        && pass "evaluated floor ($d): inconclusive with shortfall reason" \
        || fail "evaluated floor ($d): rc=$rc marks=$(marks "$T/out.log")"
done
rc=0; run $(reps evz 3) || rc=$?
[ "$rc" = 0 ] && [ "$(marks "$T/out.log")" = "inconclusive inconclusive inconclusive" ] \
    && grep -qF 'below D43 floor: 15 tasks with 3 evaluated reps on both arms, need 20' "$T/out.log" \
    && pass "evaluated floor: 5 of 20 tasks with no evaluated rows is inconclusive (15 of 20)" \
    || fail "evaluated floor (5 dead tasks): rc=$rc marks=$(marks "$T/out.log")"

# ---- k: F2 zero completions is not a missing cost capture.
rc=0; run $(reps zc 3) --resamples 400 || rc=$?
zc_cost="$(row_of "$T/out.log" 'Cost per completed')"
[ "$rc" = 0 ] && [ "$(col "$zc_cost" 8)" = "inconclusive" ] && ! grep -qF 'null cost row' <<<"$zc_cost" \
    && pass "zero completions: cost inconclusive, not 'n/a: null cost row'" \
    || fail "zero completions: cost row wrong: $zc_cost"

# ---- l: a non-default floor is printed on the verdict line.
rc=0; run $(reps one 3) --min-tasks 1 --resamples 200 || rc=$?
grep -E '^Verdict:' "$T/out.log" | grep -qF 'Floor: 1 tasks, 3 evaluated reps (non-default)' \
    && pass "non-default floor printed on the verdict line" || fail "non-default floor not on verdict line"
rc=0; run $(reps gap 3) --resamples 200 || rc=$?
if grep -qF 'Floor:' "$T/out.log"; then fail "default floor leaked onto the verdict line"; else pass "default floor not printed"; fi

# ---- b: clear gap (loki 20/20, raw 8/20, 3 reps) -> green completion
rc=0
run $(reps gap 3) || rc=$?
[ "$rc" = 0 ] && pass "gap fixture exits 0" || fail "gap fixture rc=$rc: $(cat "$T/err.log")"
gap_completion="$(row_of "$T/out.log" 'Completion')"
[ "$(col "$gap_completion" 3)" = "24/60 (40.0%)" ] && [ "$(col "$gap_completion" 5)" = "60/60 (100.0%)" ] \
    && [ "$(col "$gap_completion" 8)" = "green" ] \
    && pass "gap: clear 20/20 vs 8/20 gives green completion" \
    || fail "gap: completion row wrong: $gap_completion"

# ---- c: determinism -- identical input, two separate runs, byte-identical
# stdout (fixed bootstrap seed and resample count)
"$SCRIPT" $(reps gap 3) >"$T/det1.log" 2>"$T/det1.err"
"$SCRIPT" $(reps gap 3) >"$T/det2.log" 2>"$T/det2.err"
if diff -q "$T/det1.log" "$T/det2.log" >/dev/null; then
    pass "determinism: two runs on identical input are byte-identical"
else
    fail "determinism: two runs on identical input differ"
fi

# ---- d: a null cost row still gives red under the new CI columns
rc=0
run $(reps nullcost 3) || rc=$?
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
grep -qF 'below D43 floor: 2 tasks, need 20' "$T/out.log" \
    && pass "single rep: reason names the D43 floor" || fail "single rep: floor reason missing"

# ---- f: the audit repro. 1 task, 3 reps; raw 2/3 vs loki 3/3 (Fisher p =
# 1.0). Before the floor this read "Verdict: green" off a single-point CI.
rc=0; run $(reps one 3) || rc=$?
[ "$rc" = 0 ] && pass "1 task x 3 reps exits 0" || fail "1 task x 3 reps rc=$rc: $(cat "$T/err.log")"
[ "$(marks "$T/out.log")" = "inconclusive inconclusive inconclusive" ] \
    && pass "1 task x 3 reps: every mark inconclusive (not green from noise)" \
    || fail "1 task x 3 reps: marks: $(marks "$T/out.log")"
grep -qE '^Verdict: inconclusive\.' "$T/out.log" && pass "1 task x 3 reps: verdict inconclusive" \
    || fail "1 task x 3 reps: verdict: $(grep '^Verdict:' "$T/out.log")"
grep -qF 'below D43 floor: 1 tasks, need 20' "$T/out.log" \
    && pass "1 task x 3 reps: reason says tasks below floor" || fail "1 task x 3 reps: reason missing"

# ---- g: 19 tasks x 3 reps with a clear gap: one task under the floor, so
# inconclusive; the same gap at 20 tasks (leg 1) is green.
rc=0; run $(reps t19 3) || rc=$?
[ "$(marks "$T/out.log")" = "inconclusive inconclusive inconclusive" ] \
    && pass "19 tasks: clear gap still inconclusive below the task floor" || fail "19 tasks: marks: $(marks "$T/out.log")"
grep -qF 'below D43 floor: 19 tasks, need 20' "$T/out.log" && pass "19 tasks: reason" || fail "19 tasks: reason missing"

# ---- h: 20 tasks x 2 reps with a clear gap: under the rep floor.
rc=0; run $(reps r2 2) || rc=$?
[ "$(marks "$T/out.log")" = "inconclusive inconclusive inconclusive" ] \
    && pass "2 reps: clear gap still inconclusive below the rep floor" || fail "2 reps: marks: $(marks "$T/out.log")"
grep -qF 'below D43 floor: 0 tasks with 3 evaluated reps on both arms, need 20' "$T/out.log" && pass "2 reps: reason" || fail "2 reps: reason missing"

# ---- i: the overrides are accepted and validated (tests only).
rc=0; run $(reps one 3) --min-tasks 1 --min-reps 3 || rc=$?
[ "$rc" = 0 ] && ! grep -q 'below D43 floor' "$T/out.log" && pass "--min-tasks/--min-reps lower the floor" \
    || fail "--min-tasks/--min-reps not honored (rc=$rc)"
rc=0; run $(reps one 3) --min-tasks abc || rc=$?
[ "$rc" = 2 ] && pass "--min-tasks rejects a non-integer (rc=2)" || fail "--min-tasks abc rc=$rc (want 2)"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
