#!/usr/bin/env bash
# The B1 head-to-head benchmark runner (benchmarks/h2h/run.sh) on the stub provider: no
# model, no network. A raw-haiku contestant is the stub claude in overlay mode, which copies
# a fixed patch over the task repo and prints a result JSON. Asserts:
#   known-correct patch (the task's reference solution) scores pass, with the stub's cost,
#     one session and the changed file recorded;
#   known-wrong patch (only one of the two paginate bugs fixed) scores fail;
#   protected test paths (test/, bunfig.toml) go back to base before scoring: a correct
#     patch that also plants a throwing bun preload still passes;
#   the hidden tests are never visible inside the contestant's repo copy: the stub lists
#     every file it can see, and the runner's own pre-scoring check finds nothing;
#   --reps 2 --jobs 2 gives one scored record per rep, the 95% Wilson interval and $ per pass;
#   --resume keeps the runs already in a results file and runs only the missing ones;
#   Loki verdict agreement on fixed records and on the committed v11.104.0 result (5 of 16);
#   oracle passes and noop fails every task in every language, and the task set keeps its
#     shape (>=24 tasks, >=4 languages with 4 to 6 each, >=10 multi-file normal, >=4 hard);
#   the learning protocol (--sequences): reference solutions applied in order pass every step,
#     an untouched repo passes none, no step ever sees another step's hidden file, lesson
#     availability is read from the repo, and an earlier step's loki branch is never re-scored;
#   accepted without edit: a passing run that leaves test edits is not accepted, a clean one is,
#     and the summary's acceptance Wilson interval and $ per accepted task are exact on fixed records;
#   raw-haiku-verify sends the task text plus the verify sentence on Haiku (raw-haiku does not);
#   the replay suite (--suite replay): the merged fix passes every task, the parent commit passes
#     none, every task records a permissive license with its license file vendored, and the leak
#     check flags hidden content (also over the visible test of the same name) but not namesakes.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. benchmarks/h2h/h2h.py score(): `return 1 if rc == 0 else 0` -> `return 1`; the
#      wrong-patch run must stop reading fail.
#   2. benchmarks/h2h/h2h.py prepare_repo(): copy tasks/<id>/hidden into the repo before
#      the base commit; the visibility assertions must fail.
#   3. benchmarks/h2h/h2h.py run_one(): drop the restore_protected() call; the sabotage
#      run must stop reading pass.
#   4. wilson(): z=1.0 instead of 1.959964; both Wilson checks must fail.
#   5. verdict_stats(): count exit 6 as a claim like exit 0; the v11.104.0 check must fail.
#   6. main(): drop the `not in done` filter; both resume checks must fail.
#   7. apply_oracle(): copy nothing; "oracle passes every task" must fail.
#   8. loki_branch_checkout(): drop the `before` skip; "a branch left by an earlier step" must fail.
#   9. run_sequence(): keep each step's hidden file after scoring; the stale-hidden check and the
#      sequence runner's exit code must fail.
#  10. lesson_counts(): count a worked example without a VERIFIED verdict; the counts check must fail.
#  11. commit_step_state(): `git add -A -- . ':(exclude).loki'`; both step-commit checks must fail
#      (git refuses the pathspec once .loki is gitignored, which aborted the first paid learning run).
#  12. run_one(): `"accepted": int(bool(passed))`; the sabotage acceptance check must fail.
#  13. test_edits(): drop the protected-path match; the sabotage test-edit list must lose bunfig.toml.
#  14. hidden_leaks(): drop the content match; both replay "is a leak" checks must fail.
#  15. hidden_leaks(): flag every file with a hidden name (the old name-only check); the replay
#      runner reports leaks on every run and exits 4.
#  16. contestant_cmd(): do not append VERIFY_SENTENCE; both verify-sentence checks must fail.
#  17. summarize(): $ per accepted task divided by passes; the fixed-record check must fail.
#  18. main(): ignore --suite; the replay self-check must fail.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need python3
need bun
need git
cd "$ROOT" || exit 2

echo "TEST: h2h benchmark harness on the stub provider"

TASK=ts-paginate-fix
TDIR="$ROOT/benchmarks/h2h/tasks/$TASK"
export PATH="$ROOT/tests/min/fixtures/e2e/bin:$PATH"
export E2E_STUB_MODE=overlay H2H_NO_AUTH_LINK=1

# field <json> <python expr over r = the single run record>
field() { python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1]))["runs"][0]; print(eval(sys.argv[2]))' "$1" "$2"; }

# run_case <name> <overlay dir> -> sets RC, J, SEEN
run_case() {
    J="$T/$1.json"; SEEN="$T/$1.seen"
    : > "$SEEN"
    E2E_STUB_OVERLAY="$2" E2E_STUB_SEEN_LOG="$SEEN" TMPDIR="$T" \
        bash benchmarks/h2h/run.sh --configs raw-haiku --tasks "$TASK" --out "$J" >"$T/$1.log" 2>&1
    RC=$?
}

run_case good "$TDIR/solution"
check "correct patch: runner exits 0" test "$RC" = 0
check "correct patch scores pass" test "$(field "$J" 'r["pass"]')" = 1
check "correct patch: cost read from the result JSON" test "$(field "$J" 'r["cost_usd"]')" = 0.0123
check "correct patch: one model session" test "$(field "$J" 'r["sessions"]')" = 1
check "correct patch: the changed file is recorded" test "$(field "$J" '",".join(r["files"])')" = src/paginate.ts
has "markdown table printed" "$(cat "$T/good.log")" "| raw-haiku | 1/1 (100%)"
check "stub saw the repo (visibility log is live)" grep -q 'src/paginate.ts' "$SEEN"
check "hidden tests absent from what the contestant saw" sh -c "! grep -q -e h2h_hidden -e hidden.test '$SEEN'"
check "runner's pre-scoring leak check is empty" test "$(field "$J" 'len(r["hidden_leaked_before_scoring"])')" = 0

mkdir -p "$T/wrong/src"
sed 's|Math.floor(items.length / pageSize)|Math.ceil(items.length / pageSize)|' "$TDIR/repo/src/paginate.ts" > "$T/wrong/src/paginate.ts"
check "wrong patch differs from the base file" sh -c "! cmp -s '$T/wrong/src/paginate.ts' '$TDIR/repo/src/paginate.ts'"
run_case wrong "$T/wrong"
check "wrong patch: runner exits 0" test "$RC" = 0
check "wrong patch scores fail" test "$(field "$J" 'r["pass"]')" = 0
check "hidden tests absent from what the wrong contestant saw" sh -c "! grep -q -e h2h_hidden -e hidden.test '$SEEN'"

# Correct code plus a test config that breaks every bun test run (a preload that throws, kept
# under test/): it passes only if the protected paths really go back to base before scoring.
mkdir -p "$T/sabotage/test"
cp -R "$TDIR/solution/." "$T/sabotage/"
printf 'throw new Error("preload sabotage");\n' > "$T/sabotage/test/boom.ts"
printf '[test]\npreload = ["./test/boom.ts"]\n' > "$T/sabotage/bunfig.toml"
run_case sabotage "$T/sabotage"
check "edits to protected test paths are reverted before scoring" test "$(field "$J" 'r["pass"]')" = 1
# Accepted without edit: hidden pass AND no test edits left in the tree. The sabotage run passes but leaves
# test edits behind, so it is not accepted; the clean correct patch is.
check "sabotage run passes but is not accepted without edit" test "$(field "$J" 'r["accepted"]')" = 0
check "sabotage run records its test edits" test "$(field "$J" '",".join(r["test_edits"])')" = "bunfig.toml,test/boom.ts"
check "clean correct patch is accepted without edit" test "$(field "$T/good.json" 'r["accepted"]')" = 1
check "sabotage run: only the new test config counts against acceptance" test "$(field "$J" '",".join(r["test_weakened"])')" = "bunfig.toml"
# What counts against acceptance: a pre-existing test file deleted, with a line removed or changed, or with
# an added skip; and any test config change. A new test file, or new cases appended to an existing one, do not.
weak_out="$(cd benchmarks/h2h && python3 -I -c '
import subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, "."); import h2h
r = Path(tempfile.mkdtemp(dir=sys.argv[1]))
g = lambda *a: subprocess.run(["git", "-C", str(r), *a], capture_output=True, text=True, check=True).stdout.strip()
g("init", "-q", "-b", "main"); g("config", "user.email", "t@example.invalid"); g("config", "user.name", "t")
(r / "tests").mkdir()
base_text = "def test_a():\n    assert f(1) == 1\n    assert f(2) == 2\n"
for n in ("test_a.py", "test_b.py", "test_c.py", "test_d.py", "test_e.py"):
    (r / "tests" / n).write_text(base_text)
g("add", "-A"); g("commit", "-q", "-m", "base"); base = g("rev-parse", "HEAD")
(r / "tests/test_a.py").write_text(base_text + "\n\ndef test_new():\n    assert f(3) == 3\n")
(r / "tests/test_b.py").write_text(base_text.replace("    assert f(2) == 2\n", ""))
(r / "tests/test_c.py").write_text("import pytest\n\n@pytest.mark.skip\n" + base_text)
(r / "tests/test_d.py").write_text(base_text.replace("f(2) == 2", "f(2) is not None"))
(r / "tests/test_e.py").unlink()
(r / "tests/test_new.py").write_text("def test_x():\n    assert True\n")
(r / "conftest.py").write_text("collect_ignore = [\"tests\"]\n")
files = sorted(["tests/test_a.py", "tests/test_b.py", "tests/test_c.py", "tests/test_d.py", "tests/test_e.py", "tests/test_new.py", "conftest.py"])
print("weak", h2h.test_weakening(r, base, h2h.test_edits({"protected": ["tests"]}, files)))
' "$T")"
has "acceptance: appended cases and new test files pass; dropped, changed, skipped, deleted tests and test config count" "$weak_out" "weak ['conftest.py', 'tests/test_b.py', 'tests/test_c.py', 'tests/test_d.py', 'tests/test_e.py']"

# raw-haiku-verify: the same task text plus the one verify sentence, on Haiku; raw-haiku gets the text alone.
E2E_STUB_OVERLAY="$TDIR/solution" E2E_STUB_PROMPT_LOG="$T/verify.prompt" E2E_STUB_ARGV_LOG="$T/verify.argv" TMPDIR="$T" \
    bash benchmarks/h2h/run.sh --configs raw-haiku-verify --tasks "$TASK" --out "$T/verify.json" >"$T/verify.log" 2>&1
check "raw-haiku-verify: runner exits 0" test "$?" = 0
check "raw-haiku-verify: correct patch passes" test "$(field "$T/verify.json" 'r["pass"]')" = 1
verify_prompt="$(cat "$T/verify.prompt.other0" 2>/dev/null)"
has "raw-haiku-verify: prompt carries the task text" "$verify_prompt" "$(head -1 "$TDIR/task.txt")"
has "raw-haiku-verify: prompt carries the verify sentence" "$verify_prompt" "Before you finish, run the repository's tests and check that your change works."
has "raw-haiku-verify: runs on Haiku" "$(cat "$T/verify.argv")" "--model haiku"
E2E_STUB_OVERLAY="$TDIR/solution" E2E_STUB_PROMPT_LOG="$T/plain.prompt" TMPDIR="$T" \
    bash benchmarks/h2h/run.sh --configs raw-haiku --tasks "$TASK" --out "$T/plain.json" >"$T/plain.log" 2>&1
check "raw-haiku: prompt has no verify sentence" sh -c "! grep -q 'Before you finish' '$T/plain.prompt.other0'"
cmd_out="$(cd benchmarks/h2h && python3 -I -c '
import sys; sys.path.insert(0, "."); import h2h
c = h2h.contestant_cmd("raw-opus-verify", {"text": "do X"})
print("opus", c[c.index("--model") + 1], c[c.index("-p") + 1].endswith(h2h.VERIFY_SENTENCE))')"
has "raw-opus-verify: Opus with the verify sentence" "$cmd_out" "opus opus True"
# Loki model pins and the per-session model record: loki-haiku/-sonnet/-opus pin the whole run, loki-default
# pins nothing; every cost event's model is kept in order with its stage.
pin_out="$(cd benchmarks/h2h && python3 -I -c '
import json, sys, tempfile
from pathlib import Path
sys.path.insert(0, "."); import h2h
print("pins", [h2h.config_env(c, {}).get("LOKI_SESSION_MODEL") for c in ("loki-haiku", "loki-sonnet", "loki-opus", "loki-default")])
print("rawmodel", h2h.contestant_cmd("raw-sonnet", {"text": "x"})[7], h2h.contestant_cmd("raw-sonnet-verify", {"text": "x"})[5].endswith(h2h.VERIFY_SENTENCE))
r = Path(tempfile.mkdtemp(dir=sys.argv[1])); d = r / ".loki/runs/run1"; d.mkdir(parents=True)
ev = [{"type": "cost", "stage": "plan", "ts": "2026-01-01T00:00:00Z", "data": {"usd": 0.01, "model": "claude-sonnet-4"}},
      {"type": "cost", "stage": "implement", "ts": "2026-01-01T00:00:01Z", "data": {"usd": 0.02, "model": "claude-haiku-4"}},
      {"type": "cost", "stage": "implement", "ts": "2026-01-01T00:00:02Z", "data": {"usd": 0.03, "model": "claude-haiku-4"}}]
(d / "events.jsonl").write_text("\n".join(json.dumps(e) for e in ev) + "\n")
m = h2h.loki_metrics(r)
print("sessions", m["session_models"], m["sessions"])
' "$T")"
has "loki pins: haiku, sonnet, opus, and none for loki-default" "$pin_out" "pins ['haiku', 'sonnet', 'opus', None]"
has "raw-sonnet and raw-sonnet-verify run on Sonnet, the latter with the verify sentence" "$pin_out" "rawmodel sonnet True"
# Provenance gate: a clean commit is citable (results files do not count as dirt); an uncommitted change makes
# the tree dirty, Loki configs then refuse to run unless --allow-dirty, and raw configs still run.
prov_out="$(cd benchmarks/h2h && python3 -I -c '
import subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, "."); import h2h
r = Path(tempfile.mkdtemp(dir=sys.argv[1]))
g = lambda *a: subprocess.run(["git", "-C", str(r), *a], capture_output=True, text=True, check=True).stdout.strip()
g("init", "-q", "-b", "main"); g("config", "user.email", "t@example.invalid"); g("config", "user.name", "t")
(r / "engine.ts").write_text("1"); g("add", "-A"); g("commit", "-q", "-m", "base")
(r / "benchmarks/h2h/results").mkdir(parents=True); (r / "benchmarks/h2h/results/x.json").write_text("{}")
p = h2h.provenance(r)
print("clean", p["citable"], p["engine_sha"] == g("rev-parse", "HEAD"), p["dirty_count"], h2h.provenance_gate(["loki-haiku"], p, False))
(r / "engine.ts").write_text("2")
p = h2h.provenance(r)
print("dirty", p["citable"], p["dirty"], h2h.provenance_gate(["loki-haiku"], p, False) is not None, h2h.provenance_gate(["loki-haiku"], p, True), h2h.provenance_gate(["raw-haiku"], p, False))
' "$T")"
has "provenance: a clean commit is citable, results files are not dirt, Loki may run" "$prov_out" "clean True True 0 None"
has "provenance: an uncommitted change is not citable; Loki refuses unless --allow-dirty; raw runs" "$prov_out" "dirty False ['engine.ts'] True None None"
check "results file records its provenance and citability" test "$(field "$T/good.json" '0') $(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(isinstance(d["citable"], bool), bool(d["provenance"][0]["engine_sha"]), "bun" in d["provenance"][0])' "$T/good.json")" = "0 True True True"
has "loki per-session models recorded in order with their stage" "$pin_out" "sessions [['plan', 'claude-sonnet-4'], ['implement', 'claude-haiku-4'], ['implement', 'claude-haiku-4']] 3"

# Repetitions in parallel: --reps 2 --jobs 2 gives one record per rep, both scored, and the summary
# carries the Wilson interval and $ per passed task.
J="$T/reps.json"
E2E_STUB_OVERLAY="$TDIR/solution" E2E_STUB_SEEN_LOG="$T/reps.seen" TMPDIR="$T" \
    bash benchmarks/h2h/run.sh --configs raw-haiku --tasks "$TASK" --reps 2 --jobs 2 --out "$J" >"$T/reps.log" 2>&1
check "reps 2 jobs 2: runner exits 0" test "$?" = 0
s() { python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1]))["summary"][0]; print(eval(sys.argv[2]))' "$J" "$1"; }
runs() { python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$J" "$1"; }
check "reps 2: one record per rep" test "$(runs 'sorted(r["rep"] for r in d["runs"])')" = "[1, 2]"
check "reps 2: both reps pass" test "$(s 'r["passed"]')" = 2
check "reps 2: 95% Wilson interval for 2/2" test "$(s 'r["pass_ci95"]')" = "[0.3424, 1.0]"
check "reps 2: dollars per passed task" test "$(s 'r["cost_per_pass_usd"]')" = 0.0123
# --resume keeps the runs already in a results file and runs only what is missing.
J2="$T/resume.json"
E2E_STUB_OVERLAY="$TDIR/solution" TMPDIR="$T" \
    bash benchmarks/h2h/run.sh --configs raw-haiku --tasks "$TASK" --reps 3 --resume "$J" --out "$J2" >"$T/resume.log" 2>&1
check "resume: runner exits 0" test "$?" = 0
check "resume: only rep 3 ran" test "$(grep -c 'h2h:   raw-haiku' "$T/resume.log")" = 1
check "resume: all three reps in the result" test "$(python3 -I -c 'import json,sys; print(sorted(r["rep"] for r in json.load(open(sys.argv[1]))["runs"]))' "$J2")" = "[1, 2, 3]"

# Verdict agreement and the summary statistics, on fixed records: Loki's exit 0 is its claim; it agrees
# with a hidden pass, exit 0 on a hidden fail is a false VERIFIED, and exit 6 (PARTIAL) is split out.
# The committed v11.104.0 result (9571a21f7) must read 5 agreements out of its 16 Loki runs.
verdict_out="$(cd benchmarks/h2h && python3 -I -c '
import json, sys; sys.path.insert(0, "."); import h2h
def r(rc, p, fr=0): return {"config": "loki-haiku", "task": "t", "exit_code": rc, "pass": p, "seconds": 1.0, "timed_out": False, "cost_usd": 0.01, "sessions": 2, "fix_rounds": fr}
rows = h2h.summarize([r(0, 1), r(0, 0), r(6, 1, 2), r(6, 0, 1), r(4, 0), r(4, 1, 1)], ["loki-haiku"])
x = rows[0]
print("agree", x["verdict_agree_n"], "fv", x["false_verified"], "pp", x["partial_pass"], "pf", x["partial_fail"], "mp", x["missed_pass"], "fr", x["mean_fix_rounds"], "cpp", x["cost_per_pass_usd"])
print("recall", x["verified_recall"])
d = json.load(open("results/2026-11-01-9571a21f7.json"))
v = h2h.verdict_stats([q for q in d["runs"] if q["config"].startswith("loki")])
print("old", v["verdict_agree_n"], v["false_verified"], v["partial_pass"])
print("wilson", h2h.wilson(0, 10), h2h.wilson(5, 10))
a = lambda p, acc, cost: {"config": "raw-haiku", "task": "t", "exit_code": 0, "pass": p, "accepted": acc, "test_edits": [] if acc or not p else ["t.test.ts"], "seconds": 1.0, "timed_out": False, "cost_usd": cost, "sessions": 1}
x = h2h.summarize([a(1, 1, 0.02), a(1, 0, 0.02), a(0, 0, 0.04), a(1, 1, 0.04)], ["raw-haiku"])[0]
print("accepted", x["accepted"], x["accepted_n"], x["accept_ci95"], x["cost_per_accepted_usd"], x["cost_per_accepted_ci95"], x["runs_with_test_edits"], x["cost_per_pass_usd"])
')"
has "verdict: agreement, false VERIFIED, PARTIAL split, missed passes, fix rounds" "$verdict_out" "agree 3 fv 1 pp 1 pf 1 mp 2 fr 0.67 cpp 0.02"
has "verdict: VERIFIED recall is VERIFIED passes over all passes (1 of 3)" "$verdict_out" "recall 0.3333"
has "verdict: the v11.104.0 result reads 5 of 16, 0 false VERIFIED, 11 PARTIAL passes" "$verdict_out" "old 5 0 11"
has "wilson: 0/10 and 5/10" "$verdict_out" "wilson [0.0, 0.2775] [0.2366, 0.7634]"
# 2 of 4 accepted, $0.12 over 4 runs: $0.06 per accepted task; its interval is $ per task over the Wilson bounds of 2/4.
has "accepted: count, Wilson interval, \$ per accepted task and its interval" "$verdict_out" "accepted 2 4 [0.15, 0.85] 0.06 [0.0353, 0.2]"
has "accepted: test-edit runs counted, \$ per pass unchanged" "$verdict_out" "1 0.04"

# The task set checks itself: the reference solution passes every task's hidden tests and an
# untouched repo passes none, across every language in the set.
need go
need cargo
J="$T/selfcheck.json"
TMPDIR="$T" bash benchmarks/h2h/run.sh --configs oracle,noop --jobs 4 --out "$J" >"$T/selfcheck.log" 2>&1
check "oracle/noop self-check: runner exits 0" test "$?" = 0
ntasks="$(find benchmarks/h2h/tasks -mindepth 2 -maxdepth 2 -name meta.json | wc -l | tr -d ' ')"
check "self-check covered every task ($ntasks)" test "$(runs 'len(d["tasks"])')" = "$ntasks"
check "oracle passes every task" test "$(runs '[s["passed"] == s["n"] for s in d["summary"] if s["config"] == "oracle"]')" = "[True]"
check "noop passes no task" test "$(runs '[s["passed"] for s in d["summary"] if s["config"] == "noop"]')" = "[0]"
failed_oracle="$(runs '",".join(r["task"] for r in d["runs"] if r["config"] == "oracle" and not r["pass"])')"
[ -z "$failed_oracle" ] || echo "  oracle failed on: $failed_oracle"
passed_noop="$(runs '",".join(r["task"] for r in d["runs"] if r["config"] == "noop" and r["pass"])')"
[ -z "$passed_noop" ] || echo "  noop passed on: $passed_noop"
meta() { python3 -I -c '
import json, glob, sys
m = [json.load(open(p)) for p in sorted(glob.glob("benchmarks/h2h/tasks/*/meta.json"))]
print(eval(sys.argv[1]))' "$1"; }
check "task set: at least 24 tasks" test "$ntasks" -ge 24
check "task set: at least 4 languages" test "$(meta 'len({x["lang"] for x in m})')" -ge 4
check "task set: 4 to 6 tasks per language" test "$(meta 'all(4 <= sum(1 for y in m if y["lang"] == l) <= 6 for l in {x["lang"] for x in m})')" = True
check "task set: at least 10 multi-file normal tasks" test "$(meta 'sum(1 for x in m if x["kind"] == "multifile" and x.get("difficulty", "normal") == "normal")')" -ge 10
check "task set: at least 4 hard tasks" test "$(meta 'sum(1 for x in m if x.get("difficulty") == "hard")')" -ge 4

# Learning protocol (--sequences): every step of every sequence runs in one repo copy. The reference
# solutions applied in order pass each step's hidden tests, an untouched repo passes none, and no
# step's hidden test file is ever present when a step starts.
J="$T/seq.json"
TMPDIR="$T" bash benchmarks/h2h/run.sh --sequences all --configs oracle,noop --jobs 4 --out "$J" >"$T/seq.log" 2>&1
check "sequences oracle/noop: runner exits 0" test "$?" = 0
nseq="$(find benchmarks/h2h/sequences -mindepth 2 -maxdepth 2 -name meta.json | wc -l | tr -d ' ')"
check "sequences: at least 4 with 3 steps or more" test "$(python3 -I -c '
import json, glob
print(sum(1 for p in glob.glob("benchmarks/h2h/sequences/*/meta.json") if len(json.load(open(p))["steps"]) >= 3))')" -ge 4
check "sequences: every one ran ($nseq)" test "$(runs 'len(d["sequences"])')" = "$nseq"
check "sequences: oracle passes every step" test "$(runs 'all(r["pass"] for r in d["runs"] if r["config"] == "oracle") and any(r["config"] == "oracle" for r in d["runs"])')" = True
check "sequences: noop passes no step" test "$(runs 'sum(r["pass"] for r in d["runs"] if r["config"] == "noop")')" = 0
check "sequences: steps after the first ran in the same repo" test "$(runs 'sorted({r["step"] for r in d["runs"]})[:3]')" = "[1, 2, 3]"
check "sequences: no earlier hidden test file is present when a step starts" test "$(runs 'sum(len(r["stale_hidden"]) for r in d["runs"])')" = 0
# What Loki could learn from is read from the repo's lessons file; a branch an earlier step left
# behind is never re-scored as this step's work.
learn_out="$(cd benchmarks/h2h && python3 -I -c '
import json, subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, ".")
import h2h
r = Path(tempfile.mkdtemp(dir=sys.argv[1]))
(r / ".loki/memory/semantic").mkdir(parents=True)
(r / ".loki/memory/semantic/pr-lessons.json").write_text(json.dumps({"version": 2, "lessons": [
    {"kind": "run"}, {"kind": "receipt", "example": {"files": []}, "justified_by": {"verdict": "VERIFIED"}},
    {"kind": "receipt", "example": {"files": []}, "justified_by": {"verdict": "PARTIAL"}}, {"kind": "receipt"}]}))
print("counts", h2h.lesson_counts(r))
g = lambda *a: subprocess.run(["git", "-C", str(r), *a], capture_output=True, text=True, check=True).stdout.strip()
g("init", "-q", "-b", "main"); g("config", "user.email", "t@example.invalid"); g("config", "user.name", "t")
(r / "a").write_text("1"); g("add", "a"); g("commit", "-q", "-m", "base"); base = g("rev-parse", "HEAD")
g("checkout", "-q", "-b", "loki/a-old"); (r / "a").write_text("2"); g("commit", "-qam", "old")
g("checkout", "-q", "main"); before = h2h.loki_branches(r)
g("checkout", "-q", "-b", "loki/b-new"); (r / "a").write_text("3"); g("commit", "-qam", "new"); g("checkout", "-q", "main")
print("picked", h2h.loki_branch_checkout(r, base, before))
# The step state commit works whether or not the contestant gitignored .loki, and never commits it.
for ignored in (True, False):
    (r / ".gitignore").write_text(".loki/\n" if ignored else "")
    (r / ".loki/state.json").write_text("{}"); (r / "a").write_text("step" + str(ignored))
    h2h.commit_step_state(r, 2)
    print("step-commit", ignored, g("log", "-1", "--format=%s"), ".loki" in g("ls-tree", "-r", "--name-only", "HEAD"), g("status", "--porcelain", "--untracked-files=no") == "")
# Lesson injection is opt-in in the engine, so the learn arm must turn it on and the nolearn arm must not.
pick = lambda c: {k: v for k, v in h2h.config_env(c, {}).items() if k in ("LOKI_PR_LESSONS", "LOKI_WORKED_EXAMPLE", "LOKI_NO_PR_LESSONS")}
print("arms", sorted(pick("loki-haiku-learn").items()), sorted(pick("loki-haiku-nolearn").items()))
' "$T")"
has "lessons: run, receipt and VERIFIED worked-example counts" "$learn_out" "counts {'run': 1, 'receipt': 3, 'worked_example': 1}"
has "a branch left by an earlier step is skipped" "$learn_out" "picked loki/b-new"
has "step state commits when .loki is gitignored, without .loki" "$learn_out" "step-commit True h2h: state after step 2 False True"
has "step state commits when .loki is not gitignored, without .loki" "$learn_out" "step-commit False h2h: state after step 2 False True"
has "learning arms: learn opts in to lessons and the worked example, nolearn turns them off" "$learn_out" "arms [('LOKI_PR_LESSONS', '1'), ('LOKI_WORKED_EXAMPLE', '1')] [('LOKI_NO_PR_LESSONS', '1')]"

# Replay suite (--suite replay): real closed issues replayed at the fix's parent commit, scored by the fix's
# own test files at their own paths. The reference fix passes every task, the parent commit passes none, and
# no run reports a leak (the visible test file of the same name is not the hidden one).
J="$T/replay.json"
TMPDIR="$T" bash benchmarks/h2h/run.sh --suite replay --configs oracle,noop --jobs 4 --out "$J" >"$T/replay.log" 2>&1
check "replay oracle/noop: runner exits 0 (no leak, no harness error)" test "$?" = 0
nrep="$(find benchmarks/h2h/replay -mindepth 2 -maxdepth 2 -name meta.json | wc -l | tr -d ' ')"
check "replay: 6 to 10 tasks ($nrep)" test "$nrep" -ge 6 -a "$nrep" -le 10
check "replay: self-check covered every task" test "$(runs 'len(d["tasks"])')" = "$nrep"
check "replay: the merged fix passes every task" test "$(runs '[s["passed"] == s["n"] for s in d["summary"] if s["config"] == "oracle"]')" = "[True]"
check "replay: the parent commit passes no task" test "$(runs '[s["passed"] for s in d["summary"] if s["config"] == "noop"]')" = "[0]"
failed_oracle="$(runs '",".join(r["task"] for r in d["runs"] if r["config"] == "oracle" and not r["pass"])')"
[ -z "$failed_oracle" ] || echo "  replay oracle failed on: $failed_oracle"
check "replay: every task records a permissive license, its vendored license file, the issue and both commits" test "$(python3 -I -c '
import json, glob, os
ok = True
for p in glob.glob("benchmarks/h2h/replay/*/meta.json"):
    m = json.load(open(p)); s = m["source"]; d = os.path.dirname(p)
    ok &= s["license"] in ("MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause")
    ok &= os.path.isfile(os.path.join(d, "repo", s["license_file"]))
    ok &= all(len(s[k]) == 40 for k in ("fix_commit", "parent_commit")) and "/issues/" in s["issue"]
    ok &= m["kind"] == "replay" and os.path.getsize(os.path.join(d, "task.txt")) > 0
print(ok)')" = True
# Leak check on a replay task: the hidden file is scored over the visible test of the same name, so only its
# exact content counts as a leak; a new file that merely shares the name __init__.py does not.
leak_out="$(cd benchmarks/h2h && python3 -I -c '
import shutil, sys, tempfile
from pathlib import Path
sys.path.insert(0, "."); import h2h
t = h2h.load_task("py-cachetools-grow-evict", h2h.SUITES["replay"])
r = Path(tempfile.mkdtemp(dir=sys.argv[1])) / "repo"; base = h2h.prepare_repo(t, r)
print("clean", h2h.hidden_leaks(t, r, base))
(r / "src/cachetools/extra").mkdir(); (r / "src/cachetools/extra/__init__.py").write_text("x = 1\n")
print("namesake", h2h.hidden_leaks(t, r, base))
shutil.copyfile(t["dir"] / "hidden/tests/__init__.py", r / "src/cachetools/extra/__init__.py")
print("copied", h2h.hidden_leaks(t, r, base))
shutil.copyfile(t["dir"] / "hidden/tests/__init__.py", r / "tests/__init__.py")
print("overlaid", h2h.hidden_leaks(t, r, base))
' "$T")"
has "replay leak check: clean copy" "$leak_out" "clean []"
has "replay leak check: a namesake file is not a leak" "$leak_out" "namesake []"
has "replay leak check: hidden content under another path is a leak" "$leak_out" "copied ['src/cachetools/extra/__init__.py']"
has "replay leak check: hidden content over the visible test is a leak" "$leak_out" "overlaid ['src/cachetools/extra/__init__.py', 'tests/__init__.py']"

# Hard suite (--suite hard): the same replay format, chosen for multi-file fixes in larger projects.
J="$T/hard.json"
TMPDIR="$T" bash benchmarks/h2h/run.sh --suite hard --configs oracle,noop --jobs 4 --out "$J" >"$T/hard.log" 2>&1
check "hard oracle/noop: runner exits 0 (no leak, no harness error)" test "$?" = 0
nhard="$(find benchmarks/h2h/fixtures/hard -mindepth 2 -maxdepth 2 -name meta.json | wc -l | tr -d ' ')"
check "hard: at least 8 candidate tasks ($nhard)" test "$nhard" -ge 8
check "hard: self-check covered every task" test "$(runs 'len(d["tasks"])')" = "$nhard"
check "hard: the merged fix passes every task" test "$(runs '[s["passed"] == s["n"] for s in d["summary"] if s["config"] == "oracle"]')" = "[True]"
check "hard: the parent commit passes no task" test "$(runs '[s["passed"] for s in d["summary"] if s["config"] == "noop"]')" = "[0]"
failed_oracle="$(runs '",".join(r["task"] for r in d["runs"] if r["config"] == "oracle" and not r["pass"])')"
[ -z "$failed_oracle" ] || echo "  hard oracle failed on: $failed_oracle"
check "hard: every task is a multi-file fix with a permissive license, its license file, the issue and both commits" test "$(python3 -I -c '
import json, glob, os
ok = True
for p in glob.glob("benchmarks/h2h/fixtures/hard/*/meta.json"):
    m = json.load(open(p)); s = m["source"]; d = os.path.dirname(p)
    ok &= s["license"] in ("MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause") and len(s["solution_files"]) >= 2
    ok &= os.path.isfile(os.path.join(d, "repo", s["license_file"])) and m["difficulty"] == "hard"
    ok &= all(len(s[k]) == 40 for k in ("fix_commit", "parent_commit")) and "/issues/" in s["issue"]
print(ok)')" = True
# Selection rule: a hard task qualifies only if its fix touches 2+ files and raw-haiku-verify passed under half
# of its pilot runs; a paid run without --tasks takes only qualifying tasks.
check "hard: every qualified task meets the selection rule, and every candidate records its pilot" test "$(python3 -I -c '
import json, glob
ms = [json.load(open(p)) for p in glob.glob("benchmarks/h2h/fixtures/hard/*/meta.json")]
ok = all("pilot" in m and "qualified" in m for m in ms)
ok &= all(m["pilot"]["runs"] >= 2 and m["pilot"]["passed"] / m["pilot"]["runs"] < 0.5 and len(m["source"]["solution_files"]) >= 2 for m in ms if m["qualified"])
ok &= all(m.get("excluded_because") for m in ms if not m["qualified"])
print(ok, sum(m["qualified"] for m in ms) >= 8)')" = "True True"
q_out="$(cd benchmarks/h2h && python3 -I -c '
import sys; sys.path.insert(0, "."); import h2h
ids = sorted(p.name for p in h2h.SUITES["hard"].iterdir() if (p / "meta.json").is_file())
ts = [h2h.load_task(i, h2h.SUITES["hard"]) for i in ids]
paid = h2h.select_tasks(ts, ["raw-haiku", "loki-haiku"], False)
print("select", all(t["qualified"] for t in paid), len(paid) == sum(t["qualified"] for t in ts) < len(ts),
      len(h2h.select_tasks(ts, ["oracle", "noop"], False)) == len(ts), len(h2h.select_tasks(ts, ["raw-haiku"], True)) == len(ts))')"
has "hard: paid runs take only qualifying tasks; the self-check and named tasks take every one" "$q_out" "select True True True True"

leftover="$(find "$T" -maxdepth 1 -name 'loki-h2h.*' | head -1)"
check "runner removed its own temp dir" test -z "$leftover"

finish
