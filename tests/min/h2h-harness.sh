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
#     every learning arm sets its knobs explicitly; step_learning() counts a step's own recurring-class
#     mistakes, the ones an earlier step already made (repeats), and reads lessons-injected.json;
#   accepted without edit: a passing run that weakens a pre-existing test or changes test config is
#     not accepted, appended cases and new test files are, and the acceptance Wilson interval and
#     $ per accepted task are exact on fixed records; provenance, model pins, per-session models,
#     VERIFIED recall and the hard suite's selection rule are checked on fixed inputs;
#   raw-haiku-verify sends the task text plus the verify sentence on Haiku (raw-haiku does not);
#   raw-opus-low runs `claude --model opus --effort low`; loki-opus-low pins opus and sets LOKI_E10_EFFORT=low, which
#     every engine session (plan, implement, Wall, fix rounds 1 and 2, a resumed fix) then runs at; an H2H_LOKI_ENV
#     effort that contradicts the arm is refused before any run; neither arm is in the default config list;
#   replay and hard tasks are pinned specs (meta.json and task.txt only): a tiny local upstream proves the
#     snapshot is rebuilt at the pinned commits, matched against snapshot_sha256, cached, and refused on a
#     digest mismatch, a wrong patch count or an unfetchable commit; the fix passes and the parent fails; the
#     leak check flags hidden content (also over the visible test of the same name) but not namesakes;
#     H2H_SELFCHECK_FETCH=1 also runs oracle/noop over every real replay and hard task.
#   learning curve (--sequences with raw-haiku/raw-sonnet and loki-sonnet-learn, loki-sonnet-nolearn, loki-auto-learn arms, --laps N):
#     each arm's env is exact (the four haiku arms unchanged), a raw sequence step records the arm's own cost and session,
#     every lap starts from the base tree and re-applies work, reset_lap keeps .loki memory, run_index runs 1..laps*steps,
#     summarize_curve and the seeded paired bootstrap are exact on fixed records, and a Loki learning arm on the stub is
#     handed lap 1's worked example in lap 2.
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
#  19. test_weakening(): count every changed pre-existing test (appended cases too); the acceptance
#      case list must fail. 20. ignore added skip markers; same check. 21. ignore test config files;
#      the sabotage acceptance checks and the case list must fail.
#  22. run_one(): accept on pass alone, ignoring weakening; the sabotage acceptance check must fail.
#  23. provenance_gate(): never refuse; the dirty-tree check must fail. 24. provenance(): count
#      results files as dirt; both provenance checks must fail.
#  25. verdict_stats(): VERIFIED recall over all runs; the recall check must fail.
#  26. loki_metrics(): drop session_models; the per-session model check must fail.
#  27. config_env(): pin every Loki config to haiku; the pin check must fail.
#  28. select_tasks(): keep unqualified tasks; the selection check must fail.
#  29. step_learning(): drop the `in before_ids` filter (every mistake counts as a repeat); the repeats check must fail.
#  30. config_env(): leave LOKI_WORKED_EXAMPLE unset in the lessons arm; the arms check must fail.
#  31. loki_env_overrides(): drop the refused-key check; the three refusal checks must fail.
#  32. materialize(): skip the digest comparison; the tampered-snapshot check must fail.
#  33. materialize(): ignore the patch count; the patch-count check must fail.
#  34. materialize(): drop the temp-dir cleanup; the no-partial check must fail.
#  35. materialize(): drop the .complete reuse; the cached check must fail (the upstream is gone).
#  36. load_task(): never materialize; the build check must fail.
#  37. provenance(): drop the gitignored entries; the gitignored-input check must fail.
#  38. inside(): accept any path; the escape check must fail (a file lands outside the build dir).
#  39. materialize(): trust a cached snapshot without re-hashing it; the cache-tamper check must fail.
#  40. contestant_cmd(): drop the --effort low suffix; the raw-opus-low argv check must fail.
#  41. config_env(): leave LOKI_E10_EFFORT unset for loki-opus-low; the low-arm env and every-session checks must fail.
#  42. config_env(): let H2H_LOKI_ENV override the low arm's effort; the refusal check must fail.
#  43. config_env(): pin every sequence arm to haiku again; the loki-sonnet arms' env check must fail.
#  44. run_sequence(): give a raw arm {"cost_usd": 0.0, "sessions": 0} again; the raw sequence cost and session checks must fail.
#  45. run_sequence(): skip reset_lap; the lap-start-clean and oracle lap-2 re-apply checks must fail.
#  46. reset_lap(): `git clean -fdxq` (no -e .loki); the reset_lap memory check must fail.
#  47. first_pass(): ignore fix_rounds; the curve first-pass counts must fail.
#  48. paired(): key records on (sequence, rep, step) instead of run_index; the paired pair count and values must fail.
#  49. config_env(): drop LOKI_WORKED_EXAMPLE from the -learn suffix; the lap-2 injected-example check must fail.

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
# Low-effort Opus arms. raw-opus-low through the runner on the stub: Opus at --effort low, and the patch scores.
E2E_STUB_OVERLAY="$TDIR/solution" E2E_STUB_ARGV_LOG="$T/low.argv" TMPDIR="$T" \
    bash benchmarks/h2h/run.sh --configs raw-opus-low --tasks "$TASK" --out "$T/low.json" >"$T/low.log" 2>&1
check "raw-opus-low: runner exits 0" test "$?" = 0
check "raw-opus-low: correct patch passes" test "$(field "$T/low.json" 'r["pass"]')" = 1
has "raw-opus-low: runs claude --model opus --effort low" "$(cat "$T/low.argv")" "--model opus --output-format json --dangerously-skip-permissions --effort low"
low_out="$(cd benchmarks/h2h && python3 -I -c '
import os, sys; sys.path.insert(0, "."); import h2h
print("env", sorted(h2h.config_env("loki-opus-low", {}).items()), "raw", "--effort" in h2h.contestant_cmd("raw-opus", {"text": "x"}),
      "default", [c for c in h2h.LOW_EFFORT_CONFIGS if c in h2h.CONFIGS])
os.environ["H2H_LOKI_ENV"] = "LOKI_E10_EFFORT=high"
try: h2h.config_env("loki-opus-low", {}); print("refused no")
except SystemExit as e: print("refused", "LOKI_E10_EFFORT=high" in str(e))
print("other", h2h.config_env("loki-opus", {}).get("LOKI_E10_EFFORT"))')"
has "loki-opus-low: pins opus at LOKI_E10_EFFORT=low; raw-opus has no --effort; neither low arm is a default config" "$low_out" "env [('LOKI_E10_EFFORT', 'low'), ('LOKI_SESSION_MODEL', 'opus')] raw False default []"
has "loki-opus-low: an H2H_LOKI_ENV effort that contradicts the arm is refused; other arms still take it" "$low_out" "refused True"
has "loki-opus: H2H_LOKI_ENV LOKI_E10_EFFORT still applies to a non-low arm" "$low_out" "other high"
out="$(H2H_LOKI_ENV=LOKI_E10_EFFORT=high python3 -I benchmarks/h2h/h2h.py --configs loki-opus-low --tasks none 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'may not set LOKI_E10_EFFORT=high' && ok "loki-opus-low: contradicting effort refused at startup, before any run" || bad "startup refusal: rc=$rc out=$out"
# The env the arm sets is the effort every engine session runs at (contrib/effort_policy.ts resolveEffort, session.ts sessionEffortFor).
every="$(cd loki-ts && env $(cd ../benchmarks/h2h && python3 -I -c 'import sys; sys.path.insert(0, "."); import h2h; print(" ".join(f"{k}={v}" for k, v in h2h.config_env("loki-opus-low", {}).items()))') bun -e '
(await import("./src/contrib/index.ts")).registerContrib();
const { sessionEffortFor, rememberSessionEffort } = await import("./src/engine10/session.ts");
const { hooks } = await import("./src/engine10/hooks.ts");
rememberSessionEffort("s1", "high");
const r = [["plan", undefined], ["implement", undefined], ["wall", undefined], ["fix", hooks.effort!.fix(1, true)], ["fix", hooks.effort!.fix(2, true)]].map(([stage, effort]) => sessionEffortFor({ stage, effort } as never).effort);
r.push(sessionEffortFor({ stage: "fix", effort: hooks.effort!.fix(1, true), resumeSessionId: "s1" } as never).effort);
console.log(r.join(","));' 2>&1)"
[ "$every" = "low,low,low,low,low,low" ] && ok "loki-opus-low: plan, implement, Wall, fix rounds 1 and 2 and a resumed fix all run at low" || bad "loki-opus-low per-session effort: $every"

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
(r / "engine.ts").write_text("1"); (r / ".gitignore").write_text("internal/\n__pycache__/\n"); g("add", "-A"); g("commit", "-q", "-m", "base")
(r / "benchmarks/h2h/results").mkdir(parents=True); (r / "benchmarks/h2h/results/x.json").write_text("{}")
(r / "benchmarks/h2h/__pycache__").mkdir(); (r / "benchmarks/h2h/__pycache__/h2h.cpython-314.pyc").write_text("x")
p = h2h.provenance(r)
print("clean", p["citable"], p["engine_sha"] == g("rev-parse", "HEAD"), p["dirty_count"], h2h.provenance_gate(["loki-haiku"], p, False))
(r / "engine.ts").write_text("2")
p = h2h.provenance(r)
print("dirty", p["citable"], p["dirty"], h2h.provenance_gate(["loki-haiku"], p, False) is not None, h2h.provenance_gate(["loki-haiku"], p, True), h2h.provenance_gate(["raw-haiku"], p, False))
(r / "engine.ts").write_text("1"); (r / "benchmarks/h2h/fixtures/t/repo/internal").mkdir(parents=True)
(r / "benchmarks/h2h/fixtures/t/repo/internal/pkg.go").write_text("package internal\n")
p = h2h.provenance(r)
print("ignored", p["citable"], p["dirty"], h2h.provenance_gate(["loki-haiku"], p, False) is not None)
' "$T")"
has "provenance: a clean commit is citable, results files are not dirt, Loki may run" "$prov_out" "clean True True 0 None"
has "provenance: an uncommitted change is not citable; Loki refuses unless --allow-dirty; raw runs" "$prov_out" "dirty False ['engine.ts'] True None None"
has "provenance: a gitignored benchmark input is not citable (bytecode is not dirt); Loki refuses" "$prov_out" "ignored False ['benchmarks/h2h/fixtures/t/repo/internal/pkg.go (gitignored)'] True"
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

# H2H_LOKI_ENV: extra LOKI_* variables for Loki contestants only; a model pin or learning-arm key is refused.
knob() { H2H_LOKI_ENV="$1" python3 -I -c '
import sys; sys.path.insert(0, sys.argv[1]); import h2h
try:
    o = h2h.loki_env_overrides(); print("ok", sorted(o.items()), h2h.config_env("loki-haiku", {}).get("LOKI_SESSION_MODEL"), "LOKI_E10_FIX_RESUME" in h2h.config_env("raw-haiku", {}))
except SystemExit as e:
    print("refused", e)' "$ROOT/benchmarks/h2h"; }
has "loki env: a plain LOKI_ knob reaches Loki contestants, the haiku pin stays, raw configs never see it" "$(knob LOKI_E10_FIX_RESUME=1)" "ok [('LOKI_E10_FIX_RESUME', '1')] haiku False"
has "loki env: the model pin is refused" "$(knob LOKI_SESSION_MODEL=opus)" "refused h2h: H2H_LOKI_ENV may not set LOKI_SESSION_MODEL"
has "loki env: a model route key is refused" "$(knob LOKI_MODEL_OVERRIDE=opus)" "refused"
has "loki env: a learning-arm knob is refused" "$(knob LOKI_PR_LESSONS=1)" "refused h2h: H2H_LOKI_ENV may not set LOKI_PR_LESSONS"
has "loki env: a non-LOKI entry is refused" "$(knob PATH=/tmp)" "refused"

# The task set checks itself: the reference solution passes every task's hidden tests and an
# untouched repo passes none, across every language in the set.
need go
need cargo
J="$T/selfcheck.json"
TMPDIR="$T" H2H_LOKI_ENV=LOKI_E10_FIX_RESUME=1 bash benchmarks/h2h/run.sh --configs oracle,noop --jobs 4 --out "$J" >"$T/selfcheck.log" 2>&1
check "oracle/noop self-check: runner exits 0" test "$?" = 0
check "loki env: the results file records H2H_LOKI_ENV" test "$(runs 'd.get("loki_env")')" = "{'LOKI_E10_FIX_RESUME': '1'}"
ntasks="$(find benchmarks/h2h/tasks -mindepth 2 -maxdepth 2 -name meta.json | wc -l | tr -d ' ')"
check "self-check covered every task ($ntasks)" test "$(runs 'len(d["tasks"])')" = "$ntasks"
failed_oracle="$(runs '",".join(r["task"] for r in d["runs"] if r["config"] == "oracle" and not r["pass"])')"
[ -z "$failed_oracle" ] || echo "  oracle failed on: $failed_oracle"
# Some hidden tests carry wall-clock budgets (py-semver-range: 1s and 2s) that an overloaded runner can miss; a task the oracle
# failed under load must pass when run alone, so a wrong reference solution (which fails alone too) still fails this check.
oracle_ok="$(runs '[s["passed"] == s["n"] for s in d["summary"] if s["config"] == "oracle"]')"
if [ "$oracle_ok" != "[True]" ] && [ -n "$failed_oracle" ]; then
    TMPDIR="$T" bash benchmarks/h2h/run.sh --configs oracle --tasks "$failed_oracle" --jobs 1 --out "$T/selfcheck-retry.json" >"$T/selfcheck-retry.log" 2>&1
    [ "$(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print([s["passed"] == s["n"] for s in d["summary"] if s["config"] == "oracle"])' "$T/selfcheck-retry.json" 2>/dev/null)" = "[True]" ] && oracle_ok="[True]"
fi
check "oracle passes every task" test "$oracle_ok" = "[True]"
check "noop passes no task" test "$(runs '[s["passed"] for s in d["summary"] if s["config"] == "noop"]')" = "[0]"
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
check "sequences: at least 8 with 3 steps or more" test "$(python3 -I -c '
import json, glob
print(sum(1 for p in glob.glob("benchmarks/h2h/sequences/*/meta.json") if len(json.load(open(p))["steps"]) >= 3))')" -ge 8
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
# Every arm sets its knobs explicitly, so an engine default never decides which arm is which.
pick = lambda c: {k: v for k, v in h2h.config_env(c, {}).items() if k in ("LOKI_PR_LESSONS", "LOKI_WORKED_EXAMPLE", "LOKI_NO_PR_LESSONS")}
print("arms", sorted(pick("loki-haiku-learn").items()), sorted(pick("loki-haiku-nolearn").items()))
print("arms2", sorted(pick("loki-haiku-lessons").items()), sorted(pick("loki-haiku-example").items()))
# One step: its own mistakes, the repeats among them, and what it was told.
(r / ".loki/runs/e10-b").mkdir(parents=True)
(r / ".loki/runs/e10-b/lessons-injected.json").write_text(json.dumps({"ids": ["run-a"], "run_ids": ["run-a"], "bytes": 210, "run_bytes": 190, "worked": None}))
sub = lambda rid: {"run_id": rid, "text": "x", "files": [], "at": "t"}
(r / ".loki/memory/semantic/pr-lessons.json").write_text(json.dumps({"version": 2, "lessons": [
    {"id": "run-a", "kind": "run", "category": "check-failed", "seen": 2, "subs": [sub("e10-a"), sub("e10-b")]},
    {"id": "run-n", "kind": "run", "category": "edited-existing-test", "seen": 1, "subs": [sub("e10-b")]},
    {"id": "run-t", "kind": "run", "category": "stage-time-limit", "seen": 2, "subs": [sub("e10-a"), sub("e10-b")]}]}))
sl = h2h.step_learning(r, {"run-a", "run-t"}, "e10-b")
print("learning", sl["mistakes"], sl["repeats"], sl["injected_run_bytes"], sl["injected_ids"])
' "$T")"
has "lessons: run, receipt and VERIFIED worked-example counts" "$learn_out" "counts {'run': 1, 'receipt': 3, 'worked_example': 1}"
has "a branch left by an earlier step is skipped" "$learn_out" "picked loki/b-new"
has "step state commits when .loki is gitignored, without .loki" "$learn_out" "step-commit True h2h: state after step 2 False True"
has "step state commits when .loki is not gitignored, without .loki" "$learn_out" "step-commit False h2h: state after step 2 False True"
has "learning arms: learn opts in to lessons and the worked example, nolearn turns them off" "$learn_out" "arms [('LOKI_PR_LESSONS', '1'), ('LOKI_WORKED_EXAMPLE', '1')] [('LOKI_NO_PR_LESSONS', '1')]"
has "learning arms: lessons-only and example-only set both knobs explicitly" "$learn_out" "arms2 [('LOKI_PR_LESSONS', '1'), ('LOKI_WORKED_EXAMPLE', '0')] [('LOKI_PR_LESSONS', '0'), ('LOKI_WORKED_EXAMPLE', '1')]"
has "step learning: recurring-class mistakes, repeats of an earlier step's class, injected bytes and ids" "$learn_out" "learning ['run-a', 'run-n'] ['run-a'] 190 ['run-a']"

# Learning curve vs raw Claude Code (--sequences with raw and Sonnet arms, --laps): arms, raw cost, laps, memory
# across a lap, curve and paired statistics on fixed records.
arm_out="$(cd benchmarks/h2h && python3 -I -c '
import sys; sys.path.insert(0, "."); import h2h
keys = ("LOKI_SESSION_MODEL", "LOKI_PR_LESSONS", "LOKI_WORKED_EXAMPLE", "LOKI_NO_PR_LESSONS", "LOKI_ROUTER")
pick = lambda c: sorted((k, v) for k, v in h2h.config_env(c, {}).items() if k in keys)
for c in ("loki-sonnet-learn", "loki-sonnet-nolearn", "loki-auto-learn", "loki-haiku-learn", "loki-haiku-lessons", "loki-haiku-example", "loki-haiku-nolearn"):
    print("arm", c, pick(c))
print("raw", h2h.SEQUENCE_RAW_CONFIGS, all(c in h2h.CONFIGS for c in h2h.SEQUENCE_RAW_CONFIGS))')"
has "arms: loki-sonnet-learn pins sonnet and turns both learn knobs on" "$arm_out" "arm loki-sonnet-learn [('LOKI_PR_LESSONS', '1'), ('LOKI_SESSION_MODEL', 'sonnet'), ('LOKI_WORKED_EXAMPLE', '1')]"
has "arms: loki-sonnet-nolearn pins sonnet and turns learning off" "$arm_out" "arm loki-sonnet-nolearn [('LOKI_NO_PR_LESSONS', '1'), ('LOKI_SESSION_MODEL', 'sonnet')]"
has "arms: loki-auto-learn has no model pin, LOKI_ROUTER=auto and both learn knobs" "$arm_out" "arm loki-auto-learn [('LOKI_PR_LESSONS', '1'), ('LOKI_ROUTER', 'auto'), ('LOKI_WORKED_EXAMPLE', '1')]"
has "arms: the haiku learn arm is unchanged" "$arm_out" "arm loki-haiku-learn [('LOKI_PR_LESSONS', '1'), ('LOKI_SESSION_MODEL', 'haiku'), ('LOKI_WORKED_EXAMPLE', '1')]"
has "arms: the haiku lessons arm is unchanged" "$arm_out" "arm loki-haiku-lessons [('LOKI_PR_LESSONS', '1'), ('LOKI_SESSION_MODEL', 'haiku'), ('LOKI_WORKED_EXAMPLE', '0')]"
has "arms: the haiku example arm is unchanged" "$arm_out" "arm loki-haiku-example [('LOKI_PR_LESSONS', '0'), ('LOKI_SESSION_MODEL', 'haiku'), ('LOKI_WORKED_EXAMPLE', '1')]"
has "arms: the haiku nolearn arm is unchanged" "$arm_out" "arm loki-haiku-nolearn [('LOKI_NO_PR_LESSONS', '1'), ('LOKI_SESSION_MODEL', 'haiku')]"
has "arms: raw sequence arms are valid raw configs" "$arm_out" "raw ['raw-haiku', 'raw-sonnet'] True"
python3 -I benchmarks/h2h/h2h.py --sequences all --configs raw-opus-verify >"$T/badarm.log" 2>&1
check "sequences: a raw arm outside the sequence list is refused" test "$?" != 0
H2H_LOKI_ENV=LOKI_ROUTER=0 python3 -I benchmarks/h2h/h2h.py --sequences all --configs loki-auto-learn >"$T/badrouter.log" 2>&1
check "sequences: H2H_LOKI_ENV may not switch the router off on loki-auto-learn" test "$?" != 0
has "sequences: the router refusal names LOKI_ROUTER" "$(cat "$T/badrouter.log")" "LOKI_ROUTER"

# A raw arm in a sequence records its own cost and session (not the $0 a non-Loki arm used to get). The stub applies
# step 1's solution at every step, so step 1 passes and the later steps are recorded as scored.
SQ=py-report-formats
J="$T/rawseq.json"
E2E_STUB_OVERLAY="$ROOT/benchmarks/h2h/sequences/$SQ/steps/s1/solution" TMPDIR="$T" \
    bash benchmarks/h2h/run.sh --sequences "$SQ" --configs raw-sonnet --out "$J" >"$T/rawseq.log" 2>&1
check "raw sequence arm: runner exits 0" test "$?" = 0
check "raw sequence arm: every step records the stub's cost" test "$(runs 'sorted({r["cost_usd"] for r in d["runs"]})')" = "[0.0123]"
check "raw sequence arm: every step is one session" test "$(runs 'sorted({r["sessions"] for r in d["runs"]})')" = "[1]"
check "raw sequence arm: step 1 passes, later steps are scored" test "$(runs '[r["pass"] for r in d["runs"]]')" = "[1, 0, 0]"
check "raw sequence arm: run_index counts the steps" test "$(runs '[r["run_index"] for r in d["runs"]]')" = "[1, 2, 3]"

# --laps: every sequence runs again from its base commit in the same repo. Oracle passes every step of both laps, noop none;
# each lap starts from a clean base, and the oracle's second-lap step 1 really re-applies work (the reset removed lap 1).
J="$T/laps.json"
TMPDIR="$T" bash benchmarks/h2h/run.sh --sequences all --configs oracle,noop --laps 2 --jobs 4 --out "$J" >"$T/laps.log" 2>&1
check "laps 2: runner exits 0" test "$?" = 0
check "laps 2: records carry lap 1 and 2" test "$(runs 'sorted({r["lap"] for r in d["runs"]})')" = "[1, 2]"
check "laps 2: run_index runs 1..2*steps for every sequence" test "$(runs 'all(sorted(r["run_index"] for r in d["runs"] if (r["config"], r["sequence"]) == (c, s)) == list(range(1, 2 * n + 1)) for c, s, n in {(r["config"], r["sequence"], max(x["step"] for x in d["runs"] if x["sequence"] == r["sequence"])) for r in d["runs"]})')" = True
check "laps 2: every lap starts from the base tree" test "$(runs 'all(r["lap_start_clean"] for r in d["runs"] if r["step"] == 1) and sum(1 for r in d["runs"] if r["step"] == 1) > 0')" = True
check "laps 2: oracle lap-2 step 1 re-applies work" test "$(runs 'all(r["files_changed"] > 0 for r in d["runs"] if r["config"] == "oracle" and r["lap"] == 2 and r["step"] == 1)')" = True
check "laps 2: oracle passes every step of both laps" test "$(runs 'all(r["pass"] for r in d["runs"] if r["config"] == "oracle")')" = True
check "laps 2: noop passes none" test "$(runs 'sum(r["pass"] for r in d["runs"] if r["config"] == "noop")')" = 0
check "laps 2: no stale hidden file at any step" test "$(runs 'sum(len(r["stale_hidden"]) for r in d["runs"])')" = 0
check "laps 2: the results file records laps, the curve and the paired list" test "$(runs '(d["laps"], sorted(d["curve"]), d["paired"])')" = "(2, ['by_run_index', 'first_vs_last'], [])"

# reset_lap keeps Loki's memory and removes the step work.
lap_out="$(cd benchmarks/h2h && python3 -I -c '
import sys, tempfile
from pathlib import Path
sys.path.insert(0, "."); import h2h
d = Path(tempfile.mkdtemp(dir=sys.argv[1])); r = d / "repo"
base0 = h2h.prepare_repo({"dir": h2h.SEQUENCES_DIR / "py-report-formats"}, r)
(r / ".loki/memory/semantic").mkdir(parents=True); (r / ".loki/memory/semantic/pr-lessons.json").write_text("{}")
(r / "step_work.py").write_text("x = 1\n"); h2h.commit_step_state(r, 1)
(r / "step_extra.py").write_text("y = 2\n")
h2h.git(r, "checkout", "-q", "-b", "loki/e10-x")
h2h.reset_lap(r, base0)
print("lap-reset", (r / ".loki/memory/semantic/pr-lessons.json").exists(), (r / "step_work.py").exists(), (r / "step_extra.py").exists(),
      h2h.git(r, "rev-parse", "HEAD^{tree}") == h2h.git(r, "rev-parse", f"{base0}^{{tree}}"), h2h.git(r, "branch", "--show-current").strip())' "$T")"
has "reset_lap: .loki memory survives, step work and strays are gone, tree is the base, back on main" "$lap_out" "lap-reset True False False True main"

# Curve and paired statistics on fixed records: 2 sequences x 2 reps x run_index 1..4 (2 steps, 2 laps), raw-sonnet and loki-sonnet-learn.
# raw: run 3 fails on rep 1; one cost unmeasured. loki: one failure at run 1; one pass needed a fix round.
stat_out="$(cd benchmarks/h2h && python3 -I -c '
import json, sys
sys.path.insert(0, "."); import h2h
runs = []
for seq in "AB":
    for rep in (1, 2):
        for ri in (1, 2, 3, 4):
            base = {"sequence": seq, "rep": rep, "run_index": ri, "step": (ri - 1) % 2 + 1, "lap": (ri - 1) // 2 + 1}
            runs.append({**base, "config": "raw-sonnet", "pass": 0 if (ri == 3 and rep == 1) else 1,
                         "cost_usd": None if (seq, rep, ri) == ("A", 2, 1) else 0.10, "sessions": 1})
            runs.append({**base, "config": "loki-sonnet-learn", "pass": 0 if (seq, rep, ri) == ("B", 2, 1) else 1, "cost_usd": 0.05,
                         "fix_rounds": 1 if (seq, rep, ri) == ("A", 1, 2) else 0, "sessions": 2})
cfgs = ["raw-sonnet", "loki-sonnet-learn"]
cv = h2h.summarize_curve(runs, cfgs)
for c in cfgs:
    rows = [x for x in cv["by_run_index"] if x["config"] == c]
    print("curve", c, [(x["n"], x["passed"], x["first_pass"], x["cost_unmeasured"]) for x in rows], [x["mean_cost_usd"] for x in rows])
    f = [x for x in cv["first_vs_last"] if x["config"] == c][0]
    print("fvl", c, f["first"]["run_index"], f["first"]["pass_ci95"], f["last"]["run_index"], f["last"]["pass_ci95"], f["first"]["cost_per_pass_usd"])
p = h2h.paired(runs, "loki-sonnet-learn", "raw-sonnet")
print("paired", p["n_pairs"], p["delta_pass"]["point"], p["delta_first_pass"]["point"], p["cost_ratio"]["point"], p["cost_ratio"]["n_cost_pairs"])
print("ci-same", json.dumps(p, sort_keys=True) == json.dumps(h2h.paired(runs, "loki-sonnet-learn", "raw-sonnet"), sort_keys=True),
      all(p[k]["ci95"] and p[k]["ci95"][0] <= p[k]["point"] <= p[k]["ci95"][1] for k in ("delta_pass", "delta_first_pass", "cost_ratio")))
print("all", [(x["a"], x["b"], x["n_pairs"]) for x in h2h.paired_all(runs, cfgs)])')"
has "curve: raw-sonnet per-run n, passes, first-pass, unmeasured costs and mean cost" "$stat_out" "curve raw-sonnet [(4, 4, 4, 1), (4, 4, 4, 0), (4, 2, 2, 0), (4, 4, 4, 0)] [0.1, 0.1, 0.1, 0.1]"
has "curve: a Loki pass with a fix round is not first-pass" "$stat_out" "curve loki-sonnet-learn [(4, 3, 3, 0), (4, 4, 3, 0), (4, 4, 4, 0), (4, 4, 4, 0)] [0.05, 0.05, 0.05, 0.05]"
has "first vs last: Wilson bounds for run 1 (3/4) and run 4 (4/4), and $ per pass" "$stat_out" "fvl loki-sonnet-learn 1 [0.3006, 0.9544] 4 [0.5101, 1.0] 0.0667"
has "paired: 16 pairs, pass +1/16, first-pass 0, cost ratio 0.5 over 15 measured pairs" "$stat_out" "paired 16 0.0625 0.0 0.5 15"
has "paired: the bootstrap interval is deterministic and brackets the point" "$stat_out" "ci-same True True"
has "paired: loki-sonnet-learn is compared with raw-sonnet only" "$stat_out" "all [('loki-sonnet-learn', 'raw-sonnet', 16)]"

# A Loki learning arm end to end on the stub provider, next to a raw arm, over two laps: a 2-step sequence built here from
# tests/min/fixtures/e2e/repo (no committed duplicate fixture). Lap 2 step 1 must be handed lap 1's worked example, which
# is what the -learn suffix switches on; the results file carries the curve and the paired list.
# The stub appends a test case (E2E_STUB_TEST_EDIT=update): kept and uncapped, so lap 1 is VERIFIED and teaches a worked example. =1 adds a skip,
# which seal now caps at PARTIAL (weakened test), and a PARTIAL receipt rightly teaches no worked example.
FIX="$ROOT/tests/min/fixtures/e2e"
SD="$T/seqs/calc"; mkdir -p "$SD/repo" "$SD/steps/s1/hidden" "$SD/steps/s1/solution" "$SD/steps/s2/hidden" "$SD/steps/s2/solution"
cp "$FIX/repo/"* "$SD/repo/"
cat > "$SD/meta.json" <<'JSON'
{"lang": "ts", "protected": ["calc.test.ts", "bunfig.toml"], "steps": [
 {"id": "s1", "hidden": {"mul.hidden.test.ts": "h2h_hidden_s1.test.ts"}, "hidden_cmd": ["bun", "test", "./h2h_hidden_s1.test.ts"]},
 {"id": "s2", "hidden": {"mul.hidden.test.ts": "h2h_hidden_s2.test.ts"}, "hidden_cmd": ["bun", "test", "./h2h_hidden_s2.test.ts"]}]}
JSON
printf 'add multiply(a, b) to calc.ts returning the product of two numbers\n' > "$SD/steps/s1/task.txt"
printf 'add multiply(a, b) to calc.ts returning the product of two numbers\n' > "$SD/steps/s2/task.txt"
for s in s1 s2; do
  printf 'import { expect, test } from "bun:test";\nimport { multiply } from "./calc";\n\ntest("multiply", () => {\n  expect(multiply(3, 4)).toBe(12);\n});\n' > "$SD/steps/$s/hidden/mul.hidden.test.ts"
  printf 'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function multiply(a: number, b: number): number {\n  return a * b;\n}\n' > "$SD/steps/$s/solution/calc.ts"
done
H2H_SEQUENCES_DIR="$T/seqs" E2E_STUB_MODE=done E2E_STUB_TEST_EDIT=update E2E_STUB_USAGE=50 LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js" \
    H2H_LOKI_ENV="LOKI_E10_INVOKER=cli,LOKI_CLAUDE_CLI=$FIX/bin/claude,LOKI_E10_PLAN=1" TMPDIR="$T" \
    bash benchmarks/h2h/run.sh --sequences calc --configs raw-sonnet,loki-sonnet-learn --laps 2 --timeout 120 --allow-dirty \
    --out "$T/learnseq.json" >"$T/learnseq.log" 2>&1
J="$T/learnseq.json"
check "learning arm on the stub: runner exits 0" test "$?" = 0
check "learning arm on the stub: 4 raw and 4 Loki step records" test "$(runs '(sum(r["config"] == "raw-sonnet" for r in d["runs"]), sum(r["config"] == "loki-sonnet-learn" for r in d["runs"]))')" = "(4, 4)"
check "learning arm on the stub: every Loki step has a run id and a numeric cost" test "$(runs 'all(r["run_id"] and isinstance(r["cost_usd"], (int, float)) for r in d["runs"] if r["config"].startswith("loki"))')" = True
check "learning arm on the stub: lap-2 step 1 saw lap 1's worked example in its repo" test "$(runs '[r["lessons_before"]["worked_example"] >= 1 for r in d["runs"] if r["config"].startswith("loki") and r["lap"] == 2 and r["step"] == 1]')" = "[True]"
check "learning arm on the stub: lap-2 step 1 was injected a worked example" test "$(runs '[bool(r["worked_example"]) for r in d["runs"] if r["config"].startswith("loki") and r["lap"] == 2 and r["step"] == 1]')" = "[True]"
check "learning arm on the stub: lap-1 step 1 had nothing to inject" test "$(runs '[r["worked_example"] for r in d["runs"] if r["config"].startswith("loki") and r["run_index"] == 1]')" = "[None]"
check "learning arm on the stub: curve and paired are in the results file" test "$(runs '(sorted(d["curve"]), [(p["a"], p["b"], p["n_pairs"]) for p in d["paired"]])')" = "(['by_run_index', 'first_vs_last'], [('loki-sonnet-learn', 'raw-sonnet', 4)])"

# Replay and hard suites keep only meta.json and task.txt here; the snapshot is rebuilt from the upstream at the
# pinned commits and must match meta's snapshot_sha256. Offline: a tiny local upstream proves the rebuild, the
# cache, every refusal, oracle/noop scoring and the leak check. H2H_SELFCHECK_FETCH=1 also fetches every real
# replay and hard task and runs their oracle/noop self-check (network, about a minute on a cold cache).
export H2H_CACHE="${H2H_CACHE:-$T/h2h-cache}"
UP="$T/upstream-tiny"
mkdir -p "$UP/calc" "$UP/tests"
git -C "$UP" init -q -b main
git -C "$UP" config user.name t; git -C "$UP" config user.email t@example.invalid; git -C "$UP" config commit.gpgsign false
printf 'MIT License\n' >"$UP/LICENSE"
printf 'def add(a, b):\n    return a - b  # BUG\n' >"$UP/calc/core.py"
printf 'def twice(x):\n    return x\n' >"$UP/calc/util.py"
: >"$UP/calc/__init__.py"
printf 'from calc.core import add\n\n\ndef test_add_zero():\n    assert add(1, 0) == 1\n' >"$UP/tests/test_core.py"
printf 'not vendored\n' >"$UP/NOTES.txt"
git -C "$UP" add -A; git -C "$UP" commit -qm parent
printf 'def add(a, b):\n    return a + b\n' >"$UP/calc/core.py"
printf 'def twice(x):\n    return 2 * x\n' >"$UP/calc/util.py"
printf 'from calc.core import add\nfrom calc.util import twice\n\n\ndef test_add_zero():\n    assert add(1, 0) == 1\n\n\ndef test_add():\n    assert add(2, 3) == 5 and twice(2) == 4\n' >"$UP/tests/test_core.py"
git -C "$UP" add -A; git -C "$UP" commit -qm fix
tiny_out="$(cd benchmarks/h2h && python3 -I -c '
import json, os, shutil, subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, "."); import h2h
T, UP = Path(sys.argv[1]), Path(sys.argv[2])
g = lambda *a: subprocess.run(["git", "-C", str(UP), *a], capture_output=True, text=True, check=True).stdout
parent, fix = g("rev-parse", "HEAD~1").strip(), g("rev-parse", "HEAD").strip()
# The expected snapshot, written out independently of the fetch path.
exp = T / "tiny-expected"
for rel, body in (("repo/LICENSE", "MIT License\n"), ("repo/calc/__init__.py", ""),
                  ("repo/calc/core.py", "def add(a, b):\n    return a - b  # wrong sign\n"),
                  ("repo/calc/util.py", "def twice(x):\n    return x\n"),
                  ("repo/tests/test_core.py", "from calc.core import add\n\n\ndef test_add_zero():\n    assert add(1, 0) == 1\n"),
                  ("repo/conftest.py", "# added by the harness\n"),
                  ("hidden/tests/test_core.py", g("show", f"{fix}:tests/test_core.py")),
                  ("solution/calc/core.py", g("show", f"{fix}:calc/core.py")), ("solution/calc/util.py", g("show", f"{fix}:calc/util.py"))):
    (exp / rel).parent.mkdir(parents=True, exist_ok=True); (exp / rel).write_text(body)
meta = {"difficulty": "normal", "shape": "multi-file", "lang": "py", "kind": "replay",
        "hidden": {"tests/test_core.py": "tests/test_core.py"},
        "hidden_cmd": ["python3", "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests"],
        "visible_cmd": ["python3", "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests"], "protected": ["tests"],
        "snapshot_sha256": h2h.snapshot_digest(exp),
        "source": {"upstream": UP.as_uri(), "license": "MIT", "license_file": "LICENSE", "parent_commit": parent, "fix_commit": fix,
                   "vendored_paths": ["LICENSE", "calc", "tests"], "solution_files": ["calc/core.py", "calc/util.py"],
                   "add_files": {"conftest.py": "# added by the harness\n"},
                   "patch_files": {"repo/calc/core.py": [["# BUG", "# wrong sign", 1]]}}}
suite = T / "tiny-suite"
def put(tid, m):
    (suite / tid).mkdir(parents=True, exist_ok=True)
    (suite / tid / "meta.json").write_text(json.dumps(m)); (suite / tid / "task.txt").write_text("add() subtracts\n")
put("py-tiny", meta)
t = h2h.load_task("py-tiny", suite)
d = t["dir"]
print("built", d.parent == Path(os.environ["H2H_CACHE"]) / "tasks", sorted(p.name for p in d.iterdir()),
      (d / "repo/NOTES.txt").exists(), (d / "repo/calc/core.py").read_text().endswith("# wrong sign\n"),
      (d / "repo/conftest.py").is_file(), (d / "hidden/tests/test_core.py").read_text().count("def test_") == 2)
moved = UP.with_name("upstream-moved"); UP.rename(moved); shutil.rmtree(Path(os.environ["H2H_CACHE"]) / "git")
print("cached", h2h.load_task("py-tiny", suite)["dir"] == d)
moved.rename(UP)
hf = d / "hidden/tests/test_core.py"; keep = hf.read_bytes(); hf.write_bytes(keep + b"\n")
try:
    h2h.load_task("py-tiny", suite); print("tamper built")
except RuntimeError as e:
    print("tamper", "refused" if "not snapshot_sha256" in str(e) else str(e))
hf.write_bytes(keep)
def refused(tid, **edit):
    m = json.loads(json.dumps(meta)); src = edit.pop("source", {}); m.update(edit); m["source"].update(src); put(tid, m)
    try:
        h2h.load_task(tid, suite); return "built"
    except RuntimeError as e:
        return "refused: " + ("digest" if "does not match" in str(e) else "patch" if "occurs" in str(e) else "fetch" if "cannot fetch" in str(e)
                              else "escape" if "leaves the snapshot" in str(e) else str(e))
print("tampered", refused("py-tiny-b", snapshot_sha256="0" * 64))
print("patchcount", refused("py-tiny-c", snapshot_sha256="1" * 64, source={"patch_files": {"repo/calc/core.py": [["# BUG", "# x", 2]]}}))
print("unfetchable", refused("py-tiny-d", snapshot_sha256="2" * 64, source={"parent_commit": "f" * 40}))
print("escape", refused("py-tiny-e", snapshot_sha256="3" * 64, source={"add_files": {"../../escape.txt": "x"}}),
      refused("py-tiny-f", snapshot_sha256="4" * 64, source={"patch_files": {"/tmp/escape.txt": [["a", "b", 1]]}}),
      [str(p) for p in Path(os.environ["H2H_CACHE"]).rglob("escape.txt")])
print("no-partial", sorted(p.name for p in (Path(os.environ["H2H_CACHE"]) / "tasks").iterdir()) == [d.name])
work = T / "tiny-work"; work.mkdir()
o, n = h2h.run_one("oracle", t, 1, work, 120, False), h2h.run_one("noop", t, 1, work, 120, False)
print("score", o["pass"], n["pass"], o["hidden_leaked_before_scoring"], n["hidden_leaked_before_scoring"])
# Leak check: the hidden file is scored over the visible test of the same name, so only its exact content counts.
r = Path(tempfile.mkdtemp(dir=T)) / "repo"; base = h2h.prepare_repo(t, r)
print("clean", h2h.hidden_leaks(t, r, base))
(r / "calc/tests").mkdir(); (r / "calc/tests/test_core.py").write_text("x = 1\n")
print("namesake", h2h.hidden_leaks(t, r, base))
shutil.copyfile(d / "hidden/tests/test_core.py", r / "calc/tests/test_core.py")
print("copied", h2h.hidden_leaks(t, r, base))
shutil.copyfile(d / "hidden/tests/test_core.py", r / "tests/test_core.py")
print("overlaid", h2h.hidden_leaks(t, r, base))
' "$T" "$UP" 2>&1)"
has "pinned task: rebuilt in the cache from the upstream with only the vendored paths, the patch, the added file and the fix tests" "$tiny_out" "built True ['.complete', 'hidden', 'repo', 'solution'] False True True True"
has "pinned task: a built snapshot is reused without the upstream or the git cache" "$tiny_out" "cached True"
has "pinned task: a snapshot that does not match snapshot_sha256 is refused" "$tiny_out" "tampered refused: digest"
has "pinned task: a patch target with the wrong count is refused" "$tiny_out" "patchcount refused: patch"
has "pinned task: an unfetchable commit is refused" "$tiny_out" "unfetchable refused: fetch"
has "pinned task: a cached snapshot edited after it was built is refused" "$tiny_out" "tamper refused"
has "pinned task: an add_files or patch_files path outside the snapshot is refused before anything is written" "$tiny_out" "escape refused: escape refused: escape []"
has "pinned task: a refused build leaves nothing in the cache" "$tiny_out" "no-partial True"
has "pinned task: the fix passes, the parent fails, no leak" "$tiny_out" "score 1 0 [] []"
has "leak check: clean copy" "$tiny_out" "clean []"
has "leak check: a namesake file is not a leak" "$tiny_out" "namesake []"
has "leak check: hidden content under another path is a leak" "$tiny_out" "copied ['calc/tests/test_core.py']"
has "leak check: hidden content over the visible test is a leak" "$tiny_out" "overlaid ['calc/tests/test_core.py', 'tests/test_core.py']"

# Every replay and hard task is a pinned spec: no snapshot is committed, and each records a permissive license,
# the license file among its vendored paths, the issue, both commits and the snapshot digest.
spec_check='
import json, glob, os, re, sys
ok, n = True, 0
for p in glob.glob(sys.argv[1] + "/*/meta.json"):
    m = json.load(open(p)); s = m["source"]; d = os.path.dirname(p); n += 1
    ok &= sorted(os.listdir(d)) == ["meta.json", "task.txt"] and os.path.getsize(os.path.join(d, "task.txt")) > 0
    ok &= s["license"] in ("MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause") and m["kind"] == "replay"
    ok &= any(s["license_file"] == v or s["license_file"].startswith(v.rstrip("/") + "/") for v in s["vendored_paths"])
    ok &= all(re.fullmatch("[0-9a-f]{40}", s[k]) is not None for k in ("fix_commit", "parent_commit")) and "/issues/" in s["issue"]
    ok &= re.fullmatch("[0-9a-f]{64}", m["snapshot_sha256"]) is not None and s["upstream"].startswith("https://github.com/")
    ok &= all(re.fullmatch("[0-9a-f]{40}", sm["commit"]) is not None for sm in (s.get("submodules") or {}).values())
    if sys.argv[2] == "hard":
        ok &= len(s["solution_files"]) >= 2 and m["difficulty"] == "hard"
print(ok, n)'
nrep="$(python3 -I -c "$spec_check" benchmarks/h2h/replay replay)"
check "replay: every task is a pinned spec with a permissive license, its license file, the issue and both commits" test "${nrep% *}" = True
check "replay: 6 to 10 tasks (${nrep#* })" test "${nrep#* }" -ge 6 -a "${nrep#* }" -le 10
nhard="$(python3 -I -c "$spec_check" benchmarks/h2h/fixtures/hard hard)"
check "hard: every task is a pinned multi-file spec with a permissive license, its license file, the issue and both commits" test "${nhard% *}" = True
check "hard: at least 8 candidate tasks (${nhard#* })" test "${nhard#* }" -ge 8

if [ "${H2H_SELFCHECK_FETCH:-0}" = 1 ]; then
    for suite in replay hard; do
        J="$T/$suite.json"
        case "$suite" in replay) n="${nrep#* }" ;; *) n="${nhard#* }" ;; esac
        TMPDIR="$T" bash benchmarks/h2h/run.sh --suite "$suite" --configs oracle,noop --jobs 4 --out "$J" >"$T/$suite.log" 2>&1
        check "$suite oracle/noop: runner exits 0 (snapshots rebuilt, no leak, no harness error)" test "$?" = 0
        check "$suite: self-check covered every task ($n)" test "$(runs 'len(d["tasks"])')" = "$n"
        check "$suite: the merged fix passes every task" test "$(runs '[s["passed"] == s["n"] for s in d["summary"] if s["config"] == "oracle"]')" = "[True]"
        check "$suite: the parent commit passes no task" test "$(runs '[s["passed"] for s in d["summary"] if s["config"] == "noop"]')" = "[0]"
        failed_oracle="$(runs '",".join(r["task"] for r in d["runs"] if r["config"] == "oracle" and not r["pass"])')"
        [ -z "$failed_oracle" ] || echo "  $suite oracle failed on: $failed_oracle"
    done
else
    echo "  SKIP: replay and hard oracle/noop self-checks fetch upstream snapshots (set H2H_SELFCHECK_FETCH=1)"
fi

# Selection rule: a hard task qualifies only if its fix touches 2+ files and raw-haiku-verify passed under half
# of its pilot runs; a paid run without --tasks takes only qualifying tasks.
check "hard: every qualified task meets the selection rule, and every candidate records its pilot" test "$(python3 -I -c '
import json, glob
ms = [json.load(open(p)) for p in glob.glob("benchmarks/h2h/fixtures/hard/*/meta.json")]
ok = all("pilot" in m and "qualified" in m for m in ms)
ok &= all(m["pilot"]["runs"] >= 2 and m["pilot"]["passed"] / m["pilot"]["runs"] < 0.5 and len(m["source"]["solution_files"]) >= 2 for m in ms if m["qualified"])
ok &= all(m.get("excluded_because") for m in ms if not m["qualified"])
print(ok, sum(m["qualified"] for m in ms) >= 8)')" = "True True"
check "hard: every task's pilot counts and engine match the committed pilot results file" test "$(python3 -I -c '
import json, glob, os
d = json.load(open("benchmarks/h2h/results/2026-11-01-2499d6aee-hard-pilot.json"))
c = {}
for r in d["runs"]:
    c.setdefault(r["task"], [0, 0]); c[r["task"]][0] += bool(r["pass"]); c[r["task"]][1] += 1
ok = d["configs"] == ["raw-haiku-verify"] and d["provenance"][0]["dirty_count"] == 0
for p in glob.glob("benchmarks/h2h/fixtures/hard/*/meta.json"):
    pl = json.load(open(p))["pilot"]; t = os.path.basename(os.path.dirname(p))
    ok &= pl["config"] == "raw-haiku-verify" and [pl["passed"], pl["runs"]] == c.get(t) and pl["engine_sha"] == d["provenance"][0]["engine_sha"]
print(ok)')" = True
q_out="$(cd benchmarks/h2h && python3 -I -c '
import json, sys; sys.path.insert(0, "."); import h2h
ids = sorted(p.name for p in h2h.SUITES["hard"].iterdir() if (p / "meta.json").is_file())
ts = [dict(json.loads((h2h.SUITES["hard"] / i / "meta.json").read_text()), id=i) for i in ids]
paid = h2h.select_tasks(ts, ["raw-haiku", "loki-haiku"], False)
print("select", all(t["qualified"] for t in paid), len(paid) == sum(t["qualified"] for t in ts) < len(ts),
      len(h2h.select_tasks(ts, ["oracle", "noop"], False)) == len(ts), len(h2h.select_tasks(ts, ["raw-haiku"], True)) == len(ts))')"
has "hard: paid runs take only qualifying tasks; the self-check and named tasks take every one" "$q_out" "select True True True True"

leftover="$(find "$T" -maxdepth 1 -name 'loki-h2h.*' | head -1)"
check "runner removed its own temp dir" test -z "$leftover"

finish
