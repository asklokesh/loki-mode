#!/usr/bin/env bash
#===============================================================================
# eval/loki10/test-scorecard.sh
#
# S41-02: the D41 scorecard tool against synthetic fixture rows. Task ids are
# real tasks already in eval/loki10/tasks/ (qs-dashboard, qs-blog-platform =
# tier small; pub-werkzeug-3105, pub-attrs-1313, pub-faker-1817 = tier
# medium), so tier lookup needs no fake tasks dir. Never runs a real arm.
#
# Legs:
#   1. tier small: every mark green (completion, cost, p50 all loki >= /<= raw)
#   2. tier medium: every mark red, including a null-cost row on loki's side
#      that must show n/a and red even though its non-null rows alone would
#      average cheaper than raw (null-anywhere kills the average, not just
#      the missing row)
#   3. refusal: unequal task sets -> exit 2, no table printed
#   4. refusal: equal task sets, unequal harness_sha -> exit 2
#   5. empty input: no args, and a label pointing at an empty file
#   6. --append writes the tables to the given path; the real docs/v10/METRICS.md
#      is untouched by this whole test
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

loki_run_tmp_create || { echo "FAIL: cannot create run tmp"; exit 1; }
T="$LOKI_RUN_TMP"
trap 'loki_run_tmp_cleanup || echo "WARN: test tmp cleanup refused: $T"' EXIT

python3 - "$T" <<'PYEOF'
import json, sys
T = sys.argv[1]
MODEL = "claude-sonnet-4-6"

def row(task, arm, harness_sha, completed, t2pr, cost, cost_source="provider", model=MODEL):
    return {"run_id": "%s.%s.%s.fx" % (task, arm, harness_sha), "task": task, "arm": arm,
            "status": "ok", "model": model, "harness_sha": harness_sha,
            "started": "2026-09-27T23:00:00Z", "ended": "2026-09-27T23:00:30Z",
            "completed": completed, "time_to_pr_s": t2pr, "cost_usd": cost,
            "cost_source": cost_source, "pr_opened": True, "hidden_pass": completed, "capped": False}

# ---- tier small: qs-dashboard, qs-blog-platform. loki beats raw on all three
# metrics -> every mark should be green.
small_raw = [
    row("qs-dashboard", "raw-claude", "sha-small", True, 100, 0.20),
    row("qs-blog-platform", "raw-claude", "sha-small", False, 100, 0.20),
]
small_loki = [
    row("qs-dashboard", "v10", "sha-small", True, 50, 0.10),
    row("qs-blog-platform", "v10", "sha-small", True, 50, 0.10),
]

# ---- tier medium: pub-werkzeug-3105, pub-attrs-1313, pub-faker-1817. raw
# beats loki on completion and p50; loki's cost_usd is null on one row, so
# cost must read n/a/red even though its two priced rows (0.05, 0.05) would
# average cheaper than raw's (0.20) if the null row were silently dropped.
medium_raw = [
    row("pub-werkzeug-3105", "raw-claude", "sha-medium", True, 50, 0.20),
    row("pub-attrs-1313", "raw-claude", "sha-medium", True, 50, 0.20),
    row("pub-faker-1817", "raw-claude", "sha-medium", True, 50, 0.20),
]
medium_loki = [
    row("pub-werkzeug-3105", "v10", "sha-medium", True, 100, 0.05),
    row("pub-attrs-1313", "v10", "sha-medium", False, 100, 0.05),
    row("pub-faker-1817", "v10", "sha-medium", True, 100, None),
]

with open(T + "/raw.jsonl", "w") as f:
    f.write("\n".join(json.dumps(r) for r in small_raw + medium_raw) + "\n")
with open(T + "/loki.jsonl", "w") as f:
    f.write("\n".join(json.dumps(r) for r in small_loki + medium_loki) + "\n")

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
# (section 3), cost green only at loki <= 0.5x raw. A non-headline pair
# (raw-opus vs loki-opus) keeps the plain <= rule at the same 0.6x ratio.
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
PYEOF

run() { "$SCRIPT" "$@" >"$T/out.log" 2>"$T/err.log"; }

# ---- 1 & 2: marks
rc=0; run raw="$T/raw.jsonl" loki="$T/loki.jsonl" || rc=$?
[ "$rc" = 0 ] && pass "well-formed raw/loki pair exits 0" || fail "well-formed pair rc=$rc: $(cat "$T/err.log")"

grep -qE '^#### tier small: raw vs loki$' "$T/out.log" && pass "tier small table present" \
    || fail "tier small table missing: $(cat "$T/out.log")"
# Tiers print sorted by name ("medium" < "small"), so the small block runs
# from its heading to end of file.
awk '/^#### tier small/,0' "$T/out.log" > "$T/small.log"
grep -qE '^\| Completion \| .* \| green \|$' "$T/small.log" && pass "small: completion mark green" \
    || fail "small: completion mark not green: $(cat "$T/small.log")"
grep -qE '^\| Cost per completed \| .* \| green \|$' "$T/small.log" && pass "small: cost mark green" \
    || fail "small: cost mark not green"
grep -qE '^\| p50 time to PR \| .* \| green \|$' "$T/small.log" && pass "small: p50 mark green" \
    || fail "small: p50 mark not green"
grep -qE '^Verdict: green\.' "$T/small.log" && pass "small: verdict green" || fail "small: verdict not green"

awk '/^#### tier medium/,/^#### tier small/' "$T/out.log" > "$T/medium.log"
grep -qE '^\| Completion \| .* \| red \|$' "$T/medium.log" && pass "medium: completion mark red" \
    || fail "medium: completion mark not red: $(cat "$T/medium.log")"
grep -qE '^\| Cost per completed \| \$0\.2000 \| n/a \| red \|$' "$T/medium.log" \
    && pass "medium: null-cost row shows n/a and red (not the cheaper 2-row average)" \
    || fail "medium: cost row wrong: $(grep 'Cost per completed' "$T/medium.log")"
grep -qE '^\| p50 time to PR \| .* \| red \|$' "$T/medium.log" && pass "medium: p50 mark red" \
    || fail "medium: p50 mark not red"
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

rc=0; run raw="$T/empty.jsonl" loki="$T/loki.jsonl" || rc=$?
[ "$rc" = 2 ] && pass "empty result file refused (rc=2)" || fail "empty result file rc=$rc (want 2)"
grep -qi "no result rows" "$T/err.log" && pass "empty result file: clear stderr message" \
    || fail "empty result file: stderr unclear: $(cat "$T/err.log")"

# ---- 6: --append
rc=0; run raw="$T/raw.jsonl" loki="$T/loki.jsonl" --append "$T/METRICS.md" || rc=$?
[ "$rc" = 0 ] && [ -f "$T/METRICS.md" ] && grep -qE '^#### tier small: raw vs loki$' "$T/METRICS.md" \
    && pass "--append writes the tables to the given path" \
    || fail "--append did not write the expected tables (rc=$rc)"

real_metrics_after="$(sha "$REAL_METRICS" 2>/dev/null || echo none)"
[ "$real_metrics_before" = "$real_metrics_after" ] && pass "real docs/v10/METRICS.md untouched" \
    || fail "real docs/v10/METRICS.md CHANGED during this test"

# ---- 7: D41 headline pair (loki-sonnet vs raw-opus), 0.6x raw cost is red
rc=0; run raw="$T/headline-raw.jsonl" loki="$T/headline-loki-0.6x.jsonl" || rc=$?
[ "$rc" = 0 ] && pass "headline pair at 0.6x exits 0" || fail "headline pair at 0.6x rc=$rc: $(cat "$T/err.log")"
grep -qE '^\| Cost per completed \(headline: <=0\.5x raw\) \| .* \| red \|$' "$T/out.log" \
    && pass "headline pair: 0.6x raw cost is red" \
    || fail "headline pair: 0.6x raw cost mark wrong: $(cat "$T/out.log")"

# ---- 8: D41 headline pair, exactly 0.5x raw cost is green
rc=0; run raw="$T/headline-raw.jsonl" loki="$T/headline-loki-0.5x.jsonl" || rc=$?
[ "$rc" = 0 ] && pass "headline pair at 0.5x exits 0" || fail "headline pair at 0.5x rc=$rc: $(cat "$T/err.log")"
grep -qE '^\| Cost per completed \(headline: <=0\.5x raw\) \| .* \| green \|$' "$T/out.log" \
    && pass "headline pair: 0.5x raw cost is green" \
    || fail "headline pair: 0.5x raw cost mark wrong: $(cat "$T/out.log")"

# ---- 9: non-headline pair (raw-opus vs loki-opus) at 0.6x raw cost stays
# green under the plain <= rule.
rc=0; run raw="$T/nonheadline-raw.jsonl" loki="$T/nonheadline-loki-0.6x.jsonl" || rc=$?
[ "$rc" = 0 ] && pass "non-headline pair at 0.6x exits 0" || fail "non-headline pair at 0.6x rc=$rc: $(cat "$T/err.log")"
grep -qE '^\| Cost per completed \| .* \| green \|$' "$T/out.log" \
    && pass "non-headline pair: 0.6x raw cost stays green" \
    || fail "non-headline pair: 0.6x raw cost mark wrong: $(cat "$T/out.log")"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
