#!/usr/bin/env bash
# E-160 / D55: scripts/ci/train-verdict-reuse.sh decides when a push to main may
# reuse a train/** run's verdict. HIGH tier: a false reuse=true skips Tier B.
# Every doubtful input must give reuse=false; a positive control proves the
# failure-blocking clause is what turns success-plus-failure false.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/ci/train-verdict-reuse.sh"
WFDIR="$REPO_ROOT/.github/workflows"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/train-reuse-test.XXXXXXXX")" || exit 1
trap 'rm -rf -- "$WORK"' EXIT

SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PATHWF=".github/workflows/test.yml"

# run(id, status, conclusion, [overrides as python dict literal]) -> JSON run
run() {
  python3 - "$@" <<'PY'
import json, sys
i, st, co = sys.argv[1:4]
r = {"id": int(i), "head_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "event": "push",
     "head_branch": "train/66", "path": ".github/workflows/test.yml", "status": st,
     "conclusion": None if co == "null" else co, "run_attempt": 1,
     "created_at": "2026-10-01T00:%02d:00Z" % (int(i) % 60)}
if len(sys.argv) > 4:
    r.update(eval(sys.argv[4]))
print(json.dumps(r))
PY
}

# runs_file(name, total, run...) writes {"total_count":N,"workflow_runs":[...]}
runs_file() {
  local name="$1" total="$2"; shift 2
  local joined="" r
  for r in "$@"; do joined="${joined:+$joined,}$r"; done
  printf '{"total_count":%s,"workflow_runs":[%s]}\n' "$total" "$joined" > "$WORK/$name.json"
}

# decide(label, runs-json-name, extra env assignments...) -> sets OUT
decide() {
  local name="$1"; shift
  OUT="$(env SHA="$SHA" REF=refs/heads/main EVENT_NAME=push RUN_ID=999 WF_FILE=test.yml \
    RUNS_JSON="$WORK/$name.json" "$@" bash "${SCRIPT_UNDER_TEST:-$SCRIPT}" decide; echo "exit=$?")"
}
val() { printf '%s\n' "$OUT" | sed -n "s/^$1=//p" | head -1; }
expect() { # label want [extra]
  local label="$1" want="$2"
  if [ "$(val reuse)" = "$want" ] && printf '%s\n' "$OUT" | grep -qx 'exit=0'; then
    ok "$label -> reuse=$want"
  else
    bad "$label -> wanted reuse=$want, got: $(printf '%s' "$OUT" | tr '\n' ' ')"
  fi
}

S="$(run 1 completed success)"
echo "== true cases =="
runs_file ok 1 "$S"; decide ok; expect "train success" true
[ "$(val reused_run_id)" = "1" ] && [ "$(val reused_branch)" = "train/66" ] && ok "reports run id and branch" || bad "run id/branch not reported"
runs_file att2 1 "$(run 2 completed success '{"run_attempt":2}')"; decide att2; expect "success on attempt 2" true
[ "$(val reused_attempt)" = "2" ] && ok "attempt 2 recorded" || bad "attempt not recorded"
runs_file newest 2 "$(run 3 completed success '{"created_at":"2026-10-01T00:05:00Z"}')" "$(run 4 completed success '{"created_at":"2026-10-01T00:09:00Z"}')"
decide newest; expect "two successes" true
[ "$(val reused_run_id)" = "4" ] && ok "newest success by created_at reported" || bad "did not report newest"
runs_file mixed 3 "$S" "$(run 5 completed cancelled)" "$(run 6 completed skipped)"
decide mixed; expect "success plus cancelled and skipped" true

echo "== false cases =="
runs_file empty 0; decide empty; expect "no runs" false
runs_file canc 1 "$(run 7 completed cancelled)"; decide canc; expect "cancelled only" false
runs_file sf 2 "$S" "$(run 8 completed failure)"; decide sf; expect "success plus failure" false
runs_file to 2 "$S" "$(run 9 completed timed_out)"; decide to; expect "success plus timed_out" false
runs_file su 2 "$S" "$(run 10 completed startup_failure)"; decide su; expect "success plus startup_failure" false
runs_file mainonly 1 "$(run 11 completed success '{"head_branch":"main"}')"; decide mainonly; expect "success on main only" false
runs_file pr 1 "$(run 12 completed success '{"event":"pull_request"}')"; decide pr; expect "pull_request success" false
runs_file badsha 1 "$(run 13 completed success '{"head_sha":"bbbb"}')"; decide badsha; expect "mismatched head_sha" false
runs_file badpath 1 "$(run 14 completed success '{"path":".github/workflows/other.yml"}')"; decide badpath; expect "mismatched path" false
runs_file inprog 1 "$(run 15 in_progress null)"; decide inprog; expect "in_progress only" false
runs_file self 1 "$(run 999 completed success)"; decide self; expect "only this run's own id" false
decide ok EVENT_NAME=schedule; expect "schedule" false
decide ok EVENT_NAME=workflow_dispatch; expect "workflow_dispatch" false
decide ok EVENT_NAME=pull_request; expect "pull_request event" false
decide ok REF=refs/heads/train/66; expect "REF refs/heads/train/66" false
decide ok LOKI_E160_REUSE=0; expect "kill switch 0" false
echo '{not json' > "$WORK/bad.json"; decide bad; expect "malformed JSON" false
: > "$WORK/blank.json"; decide blank; expect "empty file" false
decide nosuchfile; expect "missing runs file" false
runs_file big 101 "$S"; decide big; expect "total_count 101" false

echo "== lockfile / compare cases =="
KEYS="loki-ts/bun.lock requirements-test.txt"
B1=1111111111111111111111111111111111111111
printf '{"files":[{"filename":"README.md"}]}\n' > "$WORK/cmp-clean.json"
printf '{"files":[{"filename":"README.md"},{"filename":"loki-ts/bun.lock"}]}\n' > "$WORK/cmp-lock.json"
python3 -c "import json;print(json.dumps({'files':[{'filename':'f%d'%i} for i in range(300)]}))" > "$WORK/cmp-300.json"
decide ok CACHE_KEY_FILES="$KEYS" BEFORE=$B1 COMPARE_JSON="$WORK/cmp-clean.json"; expect "clean compare" true
decide ok CACHE_KEY_FILES="$KEYS" BEFORE=$B1 COMPARE_JSON="$WORK/cmp-lock.json"; expect "touched lockfile" false
decide ok CACHE_KEY_FILES="$KEYS" BEFORE=$B1 COMPARE_JSON="$WORK/cmp-300.json"; expect "300-file compare" false
decide ok CACHE_KEY_FILES="$KEYS" BEFORE=0000000000000000000000000000000000000000 COMPARE_JSON="$WORK/cmp-clean.json"; expect "BEFORE all zeros" false
decide ok CACHE_KEY_FILES="$KEYS" BEFORE=$B1; expect "compare call failed (no COMPARE_JSON)" false
decide ok CACHE_KEY_FILES="$KEYS" BEFORE=$B1 COMPARE_JSON="$WORK/bad.json"; expect "malformed compare" false

echo "== gate subcommand with a stub gh =="
mkdir -p "$WORK/bin"
cat > "$WORK/bin/gh" <<EOF
#!/bin/bash
case "\$2" in
  *actions/workflows*) cat "$WORK/ok.json" ;;
  *compare*) [ -n "\${STUB_COMPARE_FAIL:-}" ] && exit 1; cat "$WORK/cmp-clean.json" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$WORK/bin/gh"
gate() {
  OUT="$(env PATH="$WORK/bin:$PATH" SHA="$SHA" REF=refs/heads/main EVENT_NAME=push RUN_ID=999 WF_FILE=test.yml \
    REPO=o/r GH_TOKEN=x BEFORE=$B1 "$@" bash "$SCRIPT" gate; echo "exit=$?")"
}
gate; expect "gate: no CACHE_KEY_FILES, train success" true
gate CACHE_KEY_FILES="$KEYS"; expect "gate: compare ok" true
gate CACHE_KEY_FILES="$KEYS" STUB_COMPARE_FAIL=1; expect "gate: compare API error" false
gate EVENT_NAME=pull_request; expect "gate: pull_request" false
GITHUB_OUTPUT="$WORK/gh-out" GITHUB_STEP_SUMMARY="$WORK/gh-sum" gate
if grep -qx 'reuse=true' "$WORK/gh-out" && grep -q 'E-160' "$WORK/gh-sum" && printf '%s\n' "$OUT" | grep -q '^::notice::'; then
  ok "gate writes GITHUB_OUTPUT, step summary and a notice on reuse"
else
  bad "gate output/summary/notice missing"
fi

echo "== positive control: remove the failure-blocking clause =="
sed '/E160-FAILURE-BLOCK/d' "$SCRIPT" > "$WORK/mutant.sh"
if ! cmp -s "$SCRIPT" "$WORK/mutant.sh"; then
  SCRIPT_UNDER_TEST="$WORK/mutant.sh" decide sf
  if [ "$(val reuse)" = "true" ]; then
    ok "mutant (clause deleted) turns success-plus-failure TRUE, so the real clause is load-bearing"
  else
    bad "mutant still false: the success-plus-failure case does not exercise the clause"
  fi
  unset SCRIPT_UNDER_TEST
else
  bad "mutation marker E160-FAILURE-BLOCK not found in the script"
fi

echo "== workflow wiring =="
python3 - "$WFDIR" <<'PY'
import sys, yaml
d = sys.argv[1]
ok = True
def chk(c, m):
    global ok
    print(("  [PASS] " if c else "  [FAIL] ") + m)
    ok = ok and c
for wf in ("test", "bun-parity", "coverage", "first-run-gate", "security-audit", "release"):
    yaml.safe_load(open(f"{d}/{wf}.yml"))
    print(f"  [PASS] {wf}.yml parses")
for wf in ("bun-parity", "coverage", "first-run-gate", "security-audit"):
    y = yaml.safe_load(open(f"{d}/{wf}.yml"))
    jobs = y["jobs"]
    chk("train-reuse" in jobs, f"{wf}: has train-reuse job")
    chk(list(jobs)[0] == "train-reuse", f"{wf}: train-reuse is the first job")
    tr = jobs["train-reuse"]
    chk(tr["permissions"] == {"contents": "read", "actions": "read"}, f"{wf}: train-reuse permissions")
    chk("reuse" in tr.get("outputs", {}), f"{wf}: train-reuse outputs reuse")
    for name, j in jobs.items():
        if name == "train-reuse":
            continue
        needs = j.get("needs", [])
        needs = [needs] if isinstance(needs, str) else needs
        cond = str(j.get("if", ""))
        if name == "sast":
            chk("train-reuse" not in needs and "cancelled" not in cond, f"{wf}: sast is ungated")
        else:
            chk("train-reuse" in needs and "!cancelled()" in cond and "train-reuse.outputs.reuse != 'true'" in cond,
                f"{wf}: {name} needs train-reuse and runs unless reuse")
t = yaml.safe_load(open(f"{d}/test.yml"))
g = t["jobs"]["version-bump-gate"]
chk("steps.reuse.outputs.reuse == 'true'" in str(g["outputs"]["skip"]) and "steps.gate.outputs.skip == 'true'" in str(g["outputs"]["skip"]),
    "test.yml: version-bump-gate skip output ORs both gates")
rs = [s for s in g["steps"] if s.get("id") == "reuse"]
chk(len(rs) == 1 and rs[0].get("continue-on-error") is True, "test.yml: reuse step is continue-on-error")
for wf in ("coverage", "first-run-gate"):
    y = yaml.safe_load(open(f"{d}/{wf}.yml"))
    chk(y["concurrency"] == t["concurrency"], f"{wf}: concurrency matches test.yml")
sys.exit(0 if ok else 1)
PY
[ $? -eq 0 ] && ok "workflow wiring assertions" || bad "workflow wiring assertions"

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
