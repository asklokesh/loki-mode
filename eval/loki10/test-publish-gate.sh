#!/usr/bin/env bash
#===============================================================================
# eval/loki10/test-publish-gate.sh
#
# EV-6 prep: publish_gate.sh merges three arms' results.jsonl files and hands
# the merge to gate_report.py (E-33). Runs entirely against generated fixture
# rows -- never a real arm, never the real docs/v10/METRICS.md or CHANGELOG.md.
#
# gate_report.py is E-33's file and is not committed by this slice. Until
# E-33 merges, this test finds it via LOKI_GATE_REPORT (a checkout that has
# it); with neither present it FAILs loudly rather than skipping, per this
# repo's no-false-green rule.
#
# Legs:
#   1. three well-formed arms -> met marker in both metrics and changelog
#      targets, and a legacy row in the arm table (proves the third file
#      merged in, not just the two the gate itself scores)
#   2. a missing input file -> nonzero exit, both targets left untouched
#   3. a rerun is byte-identical (idempotent)
#   4. the real repo docs/v10/METRICS.md and CHANGELOG.md are byte-identical
#      before and after this whole test
#===============================================================================
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib-tmp.sh
. "$HERE/lib-tmp.sh"
export LOKI_NO_BROWSER=1
SCRIPT="$HERE/publish_gate.sh"

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

if [ ! -f "$SCRIPT" ]; then
    fail "publish_gate.sh is missing"
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
fi

GEN="${LOKI_GATE_REPORT:-$HERE/gate_report.py}"
if [ ! -f "$GEN" ]; then
    fail "gate_report.py not found (checked \$LOKI_GATE_REPORT and $HERE/gate_report.py); E-33 must merge, or set LOKI_GATE_REPORT, before this test can pass"
    echo "Results: $PASS passed, $FAIL failed"
    exit 1
fi
export LOKI_GATE_REPORT="$GEN"

sha() { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$1"; }

REAL_METRICS="$REPO/docs/v10/METRICS.md"
REAL_CHANGELOG="$REPO/CHANGELOG.md"
real_metrics_before="$(sha "$REAL_METRICS" 2>/dev/null || echo none)"
real_changelog_before="$(sha "$REAL_CHANGELOG" 2>/dev/null || echo none)"

loki_run_tmp_create || { echo "FAIL: cannot create run tmp"; exit 1; }
T="$LOKI_RUN_TMP"
trap 'loki_run_tmp_cleanup || echo "WARN: test tmp cleanup refused: $T"' EXIT

# Build 25 completed rows per scored arm (v10, raw-claude) plus 3 legacy rows,
# all one model, so the gate reads met. raw-claude.jsonl is written WITHOUT a
# trailing newline on purpose: it sits between v10.jsonl and legacy.jsonl on
# the command line, so a plain `cat` (unlike `awk 1`) would fuse its last row
# into legacy.jsonl's first line -- the mutation leg below depends on that.
python3 - "$T" <<'PYEOF'
import json, sys
T = sys.argv[1]
MODEL = "claude-sonnet-4-6"
SHA = "fixture0"

def row(task, arm, t2pr, cost, completed=True):
    return {"run_id": "%s.%s.fx" % (task, arm), "task": task, "arm": arm, "status": "ok",
            "model": MODEL, "harness_sha": SHA, "started": "2026-09-27T23:00:00Z",
            "ended": "2026-09-27T23:00:30Z", "completed": completed,
            "time_to_pr_s": t2pr, "cost_usd": cost, "pr_opened": True,
            "hidden_pass": completed, "capped": False}

v10_rows = [row("gt-%02d" % i, "v10", 200 + i, 0.5) for i in range(1, 26)]
raw_rows = [row("gt-%02d" % i, "raw-claude", 250 + i, 1.0) for i in range(1, 26)]
legacy_rows = [row("gt-%02d" % i, "legacy", 260 + i, 0.8) for i in range(1, 4)]

with open(T + "/v10.jsonl", "w") as f:
    f.write("\n".join(json.dumps(r) for r in v10_rows) + "\n")
with open(T + "/raw.jsonl", "w") as f:
    f.write("\n".join(json.dumps(r) for r in raw_rows))  # no trailing newline
with open(T + "/legacy.jsonl", "w") as f:
    f.write("\n".join(json.dumps(r) for r in legacy_rows) + "\n")
PYEOF

run() {
    bash "$SCRIPT" "$T/v10.jsonl" "$T/raw.jsonl" "$T/legacy.jsonl" \
        --metrics "$T/METRICS.md" --changelog "$T/CHANGELOG.md" >"$T/out.log" 2>&1
}

# 1. well-formed three-arm merge
rc=0; run || rc=$?
[ "$rc" = 0 ] && pass "well-formed merge exits 0" || fail "well-formed merge rc=$rc: $(cat "$T/out.log")"
grep -qF '<!-- loki10-gate: met n=25' "$T/METRICS.md" 2>/dev/null && pass "METRICS.md carries the met marker" \
    || fail "METRICS.md missing the met marker: $(cat "$T/METRICS.md" 2>/dev/null)"
grep -qF '<!-- loki10-gate: met n=25' "$T/CHANGELOG.md" 2>/dev/null && pass "CHANGELOG.md carries the met marker" \
    || fail "CHANGELOG.md missing the met marker"
grep -qE '^\| legacy \|' "$T/METRICS.md" 2>/dev/null && pass "legacy arm row present (third file merged in)" \
    || fail "legacy arm row missing -- the third file did not merge"

# 2. missing input leaves targets untouched
rm -f "$T/METRICS.md" "$T/CHANGELOG.md"
rc=0
bash "$SCRIPT" "$T/v10.jsonl" "$T/does-not-exist.jsonl" "$T/legacy.jsonl" \
    --metrics "$T/METRICS.md" --changelog "$T/CHANGELOG.md" >"$T/out2.log" 2>&1 || rc=$?
[ "$rc" != 0 ] && pass "missing input file exits nonzero (rc=$rc)" || fail "missing input file exited 0"
[ -e "$T/METRICS.md" ] && fail "METRICS.md written despite the missing input" || pass "METRICS.md not written on missing input"
[ -e "$T/CHANGELOG.md" ] && fail "CHANGELOG.md written despite the missing input" || pass "CHANGELOG.md not written on missing input"

# 3. rerun is byte-identical
run
cp "$T/METRICS.md" "$T/m1"; cp "$T/CHANGELOG.md" "$T/c1"
run
cmp -s "$T/m1" "$T/METRICS.md" && cmp -s "$T/c1" "$T/CHANGELOG.md" \
    && pass "rerun is byte-identical" || fail "rerun changed a target file"

# 4. mutation: `cat` instead of `awk 1` must go red on the no-trailing-newline fixture
sed 's/^awk 1 /cat /' "$SCRIPT" >"$T/mutant.sh"
chmod +x "$T/mutant.sh"
rc=0
bash "$T/mutant.sh" "$T/v10.jsonl" "$T/raw.jsonl" "$T/legacy.jsonl" \
    --metrics "$T/mut-METRICS.md" --changelog "$T/mut-CHANGELOG.md" >"$T/mut.log" 2>&1 || rc=$?
[ "$rc" != 0 ] && pass "mutation (cat instead of awk 1) fails on the no-newline join (rc=$rc)" \
    || fail "mutation did not fail -- awk 1 vs cat difference is not covered"

# 5. the real repo files are untouched by this whole test
real_metrics_after="$(sha "$REAL_METRICS" 2>/dev/null || echo none)"
real_changelog_after="$(sha "$REAL_CHANGELOG" 2>/dev/null || echo none)"
[ "$real_metrics_before" = "$real_metrics_after" ] && pass "real docs/v10/METRICS.md untouched" \
    || fail "real docs/v10/METRICS.md CHANGED during this test"
[ "$real_changelog_before" = "$real_changelog_after" ] && pass "real CHANGELOG.md untouched" \
    || fail "real CHANGELOG.md CHANGED during this test"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
