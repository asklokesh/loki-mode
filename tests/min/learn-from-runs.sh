#!/usr/bin/env bash
# Learn from runs on the stub provider (tests/min/fixtures/e2e/bin/claude): the real bin/loki -> committed Bun bundle ->
# engine10, several runs in ONE throwaway repo so each run reads what the earlier ones wrote to
# .loki/memory/semantic/pr-lessons.json (util/pr_lessons.ts learnFromRun, retrieveLessons, formatRunLessons).
# Asserts:
#   learn:     run 1 (wrong multiply(), a fix round that changes nothing, an edit to the pre-existing calc.test.ts)
#              ends STALLED and writes a check-failed lesson whose sub-lesson carries the first error line and run 1's
#              id, plus an edited-existing-test lesson naming calc.test.ts.
#   related:   run 2 on a related task gets those lessons (LOKI_PR_LESSONS=1), one imperative line each led by
#              the file it is about, no run ids, and <runDir>/lessons-injected.json records the ids and bytes.
#   merge:     run 2 repeats both mistakes (then its fix round turns the check green); each class stays ONE lesson
#              with two sub-lessons, the check-failed one records the fix-round change, and run 2's use tag is marked
#              recurred.
#   unrelated: run 3 on an unrelated task gets no run-lessons block.
#   cap:       with 12 long seeded lessons, `loki memory brief` keeps the run-lessons block within 400 bytes.
#   precise:   a stage-time-limit or out-of-scope lesson on the task's file is never injected; a check-failed lesson on
#              another file is never injected however many words it shares; a receipt fact never reaches a brief;
#              a spec conflict is injected by the symbols its reason names; with LOKI_PR_LESSONS unset (the default)
#              nothing is injected.
#   stop:      a check that blocked the session stop (runner/stop_checks.ts) is written to .loki/state/stop-blocks.jsonl
#              and becomes a check-failed lesson at run end; the file is consumed and a stale line is dropped.
#   list:      `loki memory lessons` shows the category and sub-lessons.
# Reuse past runs (same store, util/pr_lessons.ts knownVerdict, replayKnownVerdict, workedExampleFor):
#   replay:    receipt.json carries loki_version; an identical rerun of a SPEC_CONFLICT task exits 4 in under 10s with
#              0 sessions and no new run, prints the prior run id, its reason, `loki answer` and --fresh, and records a
#              run.replayed event; --fresh, a changed task and a changed base sha each run the full pipeline.
#   unit:      split history (SC, SC, AS, SC) never replays; ALREADY_SATISFIED replays (exit 0) only after 2 unanimous
#              runs; PARTIAL, FAILED, an altered receipt and a changed task, base, loki_version or provider never replay;
#              a 40-file VERIFIED run's exemplar stays within 2048 bytes.
#   example:   a near-duplicate task (>= 3 shared identifier keywords AND Jaccard >= 0.5) gets exactly one worked-example
#              block within 1200 bytes and the exemplar's files in Relevant files (brief bytes with and without printed);
#              fewer shared keywords, or many shared but a low Jaccard, gets none.
#   default:   with neither LOKI_PR_LESSONS nor LOKI_WORKED_EXAMPLE set (the default, rule 6), the same similar task gets
#              no worked example and no run-lessons block, and the run still records its lesson. Every other leg opts in.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/util/pr_lessons.ts learnFromRun: hash the run id into the lesson id (a repeat duplicates the class).
#   2. loki-ts/src/util/pr_lessons.ts retrieveLessons: score a run lesson `runScore(...) || 1` (an unrelated run gets them).
#   3. pr_lessons.ts REPLAY_MIN: ALREADY_SATISFIED 1 instead of 2 (one success replays).
#   4. pr_lessons.ts replayKnownVerdict: ignore o.fresh (--fresh replays).
#   5. pr_lessons.ts workedExampleFor: require 1 shared keyword instead of EXAMPLE_MIN_SHARED (an unrelated task gets one).
#   6. pr_lessons.ts exampleFiles: return [] (the exemplar's files never reach Relevant files).
#   7. pr_lessons.ts lessonsInjected/workedExampleInjected: return true (the default legs get lessons and an example).
#   8. pr_lessons.ts runScore: drop the RECURRING category check (the stage-time-limit lesson is injected).
#   9. pr_lessons.ts runScore: return the shared-word score without a file overlap (the other-file lesson is injected).
#  10. pr_lessons.ts retrieveLessons: drop `l.kind !== "receipt"` (the receipt fact reaches the brief).
#  11. pr_lessons.ts RUN_LESSON_CAP: 1200 (the 400-byte cap check fails).
#  12. runner/stop_checks.ts createStopChecksHook: drop the recordStopBlock call (no stop lesson).
#  13. pr_lessons.ts workedExampleFor: drop the EXAMPLE_MIN_JACCARD test (the low-Jaccard task gets an example).

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
need python3
cd "$ROOT" || exit 2

echo "TEST: learn from runs on the stub provider"

FIX="$ROOT/tests/min/fixtures/e2e"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
unset LOKI_NO_PR_LESSONS
export LOKI_PR_LESSONS=1 LOKI_WORKED_EXAMPLE=1 # lesson injection is opt-in; these legs test it on, the default legs unset both
UNSET=()
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 120)

new_repo() {
    REPO="$1"
    cp -R "$FIX/repo" "$REPO"
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name e2e
    git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add calc.ts calc.test.ts bunfig.toml
    git -C "$REPO" commit -q -m base
    LESSONS="$REPO/.loki/memory/semantic/pr-lessons.json"
}

# run_engine <n> <task> <env assignments...> -> RC, OUT, RID, PROMPTS (all prompts the stub classed as implement), ITERS. Extra loki args: XARGS array.
run_engine() {
    local n="$1" task="$2"; shift 2
    PROMPTS="$T/prompt$n"; ITERS="$T/iters$n.log"; : > "$ITERS"
    git -C "$REPO" checkout -q -- . 2>/dev/null; git -C "$REPO" clean -qfd -e .loki 2>/dev/null
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY ${UNSET[@]+"${UNSET[@]}"} \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" LOKI_NO_COMPLETIONS=1 \
        E2E_STUB_PROMPT_LOG="$PROMPTS" E2E_STUB_ITER_LOG="$ITERS" LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$T/k.pem" \
        "$@" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$task" --no-pr ${XARGS[@]+"${XARGS[@]}"} 2>&1)"
    RC=$?
    RID="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
}
outcome() { printf '%s\n' "$OUT" | sed -n 's/^Outcome:[[:space:]]*\([A-Z_]*\).*/\1/p' | head -1; }
dump() { printf '%s\n' "$OUT" | tail -15 | sed 's/^/    | /'; }
# lq <python expression over L (the run lessons list)>
lq() {
    python3 -I -c 'import json,sys
L=[l for l in json.load(open(sys.argv[1]))["lessons"] if l.get("kind")=="run"]
print(eval(sys.argv[2]))' "$LESSONS" "$1" 2>/dev/null
}
# block <file>: the run-lessons block of the first implement brief in the file, empty when there is none
block() {
    [ -f "$1" ] || return 0
    python3 -I -c 'import sys
s=open(sys.argv[1]).read(); a=s.find("\n\nLessons from earlier runs here"); b=s.find("</untrusted-run-lessons>\n", a)
print(s[a:b+len("</untrusted-run-lessons>\n")] if a>=0 and b>=0 else "", end="")' "$1"
}
impl_bytes() { awk '$1=="implement"{print $3; exit}' "$ITERS"; }

# Baseline: run 2's exact task and stub behaviour in a repo with no history, for the before byte count.
new_repo "$T/repo0"
run_engine 0 "add a divide(a, b) function to calc.ts" E2E_STUB_MODE=wrong E2E_STUB_FIX=fixit E2E_STUB_TEST_EDIT=1
BEFORE="$(impl_bytes)"

# Run 1: fails in a specific way.
new_repo "$T/repo"
run_engine 1 "add a multiply(a, b) function to calc.ts" E2E_STUB_MODE=wrong E2E_STUB_FIX=noprogress E2E_STUB_TEST_EDIT=1
RID1="$RID"
[ "$(outcome)" = "STALLED" ] && ok "learn: run 1 ends STALLED" || { bad "learn: run 1 outcome is '$(outcome)', not STALLED"; dump; }
[ -z "$(block "$PROMPTS.implement0")" ] && ok "learn: run 1 brief had no run lessons (nothing learned yet)" || bad "learn: run 1 brief already carried run lessons"
cf="$(lq '[l for l in L if l["category"]=="check-failed"]')"
has "learn: a check-failed lesson was written" "$cf" "'category': 'check-failed'"
has "learn: its sub-lesson carries the first error line" "$cf" "first error: "
has "learn: its sub-lesson carries run 1's id" "$cf" "'run_id': '$RID1'"
has "learn: the lesson names the failing test file" "$cf" "calc.test.ts"
et="$(lq '[l for l in L if l["category"]=="edited-existing-test"]')"
has "learn: an edited-existing-test lesson was written" "$et" "restored calc.test.ts"
echo "    run 1 ($RID1): $(lq 'len(L)') run lessons: $(lq '", ".join(l["category"]+" x"+str(l["seen"]) for l in L)')"

# Run 2: a related task reads them, then repeats both mistakes (its fix round turns the check green).
run_engine 2 "add a divide(a, b) function to calc.ts" E2E_STUB_MODE=wrong E2E_STUB_FIX=fixit E2E_STUB_TEST_EDIT=1
RID2="$RID"; B2="$(block "$PROMPTS.implement0")"
printf '%s\n' "$B2" | sed 's/^/    | /'
has "related: run 2 brief carries the run-lessons block" "$B2" "<untrusted-run-lessons>"
has "related: run 2 brief carries the check-failed lesson as one imperative line" "$B2" "pass; it failed last run"
has "related: run 2 brief carries the edited-existing-test lesson led by the test file" "$B2" "- calc.test.ts: do not edit this existing test"
case "$B2" in *"run $RID1"*) bad "related: run 2 brief still carries run ids" ;; *) ok "related: no run ids in the block" ;; esac
nonline="$(printf '%s\n' "$B2" | sed '1,4d;$d' | grep -vc '^- ')"
[ "$nonline" = "0" ] && ok "related: every lesson is one line starting with '- '" || bad "related: $nonline body lines are not one-line lessons"
inj="$REPO/.loki/runs/$RID2/lessons-injected.json"
injb="$(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["run_bytes"], len(d["run_ids"]))' "$inj" 2>/dev/null)"
[ "${injb%% *}" = "$(block "$PROMPTS.implement0" | wc -c | tr -d ' ')" ] && [ "${injb#* }" -ge 2 ] && ok "related: lessons-injected.json records $injb (run-lesson bytes, ids) matching the brief" || bad "related: lessons-injected.json '$injb' vs block $(block "$PROMPTS.implement0" | wc -c | tr -d ' ') bytes"
echo "    run 2 ($RID2): implement brief $(impl_bytes) bytes (same task with no history: $BEFORE bytes), run-lessons block $(block "$PROMPTS.implement0" | wc -c | tr -d ' ') bytes"
[ "$(block "$PROMPTS.implement0" | wc -c)" -le 400 ] && ok "cap: run 2's injected run-lessons block is within 400 bytes" || bad "cap: run 2's run-lessons block is over 400 bytes"
[ "$(outcome)" = "VERIFIED" ] && ok "merge: run 2 ends VERIFIED after its fix round" || { bad "merge: run 2 outcome is '$(outcome)', not VERIFIED"; dump; }
[ "$(lq 'sum(1 for l in L if l["category"]=="edited-existing-test")')" = "1" ] && ok "merge: one edited-existing-test lesson, not a duplicate" || bad "merge: edited-existing-test lessons: $(lq 'sum(1 for l in L if l["category"]=="edited-existing-test")')"
[ "$(lq '[len(l["subs"]) for l in L if l["category"]=="edited-existing-test"]')" = "[2]" ] && ok "merge: it holds two sub-lessons (runs 1 and 2)" || bad "merge: sub-lessons: $(lq '[len(l["subs"]) for l in L if l["category"]=="edited-existing-test"]')"
CF='[l for l in L if l["category"]=="check-failed" and "calc.test.ts" in l["text"]]'
[ "$(lq "[len(l['subs']) for l in $CF]")" = "[2]" ] && ok "merge: one check-failed lesson for the repeated calc.test.ts failure, two sub-lessons" || bad "merge: calc.test.ts check-failed lessons and their sub counts: $(lq "[len(l['subs']) for l in $CF]")"
has "merge: the check-failed lesson records the fix-round change that turned it green" "$(lq "[s['text'] for l in $CF for s in l['subs']]")" "a fix round turned it green by changing calc.ts (+1 -1)"
has "merge: run 2's use tag is marked recurred" "$(lq '[u for l in L for u in l["uses"] if l["category"]=="edited-existing-test"]')" "'run_id': '$RID2', 'verdict': 'VERIFIED'"
has "merge: recurred flag set" "$(lq '[u.get("recurred") for l in L for u in l["uses"] if u["run_id"]=="'"$RID2"'"]')" "True"

# Run 3: an unrelated task gets nothing.
run_engine 3 "document the install steps in README.md" E2E_STUB_MODE=done
[ -z "$(block "$PROMPTS.implement0")" ] && ok "unrelated: run 3 brief has no run-lessons block" || bad "unrelated: run 3 brief carries run lessons: $(block "$PROMPTS.implement0" | head -3)"
grep -q "untrusted-run-lessons" "$PROMPTS.implement0" 2>/dev/null && bad "unrelated: the fence tag appears in run 3's prompts" || ok "unrelated: no run-lessons fence anywhere in run 3's prompts"
echo "    run 3 ($RID): implement brief $(impl_bytes) bytes"

# Cap: many long lessons, one block within the cap.
python3 -I -c 'import json,sys
p=sys.argv[1]; j=json.load(open(p))
for i in range(12):
    j["lessons"].append({"id":"run-seed%02d"%i,"kind":"run","category":"check-failed","text":"Check test:calc.test.ts failed: "+("long error text "*20),
      "source":{"pr":"run:seed","pr_url":"","comment_url":"","kind":"run","author":"loki"},"learned_at":"2026-01-01T00:00:00Z","uses":[],
      "subs":[{"run_id":"seed-%d-%d"%(i,k),"text":"first error: "+("x"*300),"files":["calc.ts"],"at":"2026-01-01T00:00:00Z"} for k in range(5)],
      "seen":5,"files":["calc.ts","calc.test.ts"],"terms":["multiply","calc"]})
json.dump(j,open(p,"w"))' "$LESSONS"
(cd "$REPO" && LOKI_NO_COMPLETIONS=1 bash "$ROOT/bin/loki" memory brief --task "add a modulo(a, b) function to calc.ts" > "$T/cap.txt" 2>&1)
# `memory brief` trims the leading blank lines, so the two the brief carries are added back before counting.
capblk="$(python3 -I -c 'import sys
s=open(sys.argv[1]).read(); a=s.find("Lessons from earlier runs here"); t="</untrusted-run-lessons>\n"; b=s.find(t, a)
print(len(("\n\n"+s[a:b+len(t)]).encode()) if a>=0 and b>=0 else -1)' "$T/cap.txt")"
if [ "$capblk" -gt 0 ] && [ "$capblk" -le 400 ]; then ok "cap: run-lessons block is $capblk bytes with $(lq 'len(L)') run lessons stored (cap 400)"; else bad "cap: run-lessons block is $capblk bytes (want 1..400)"; fi

# Precise: only a recurring class on a file this run will touch reaches the brief; receipts never do.
python3 -I -c 'import json,sys
p=sys.argv[1]; j=json.load(open(p)); j["lessons"]=[l for l in j["lessons"] if not l["id"].startswith("run-seed")]
src={"pr":"run:seed","pr_url":"","comment_url":"","kind":"run","author":"loki"}
def run(i,cat,text,files,sub="first error: boom"): return {"id":i,"kind":"run","category":cat,"text":text,"source":src,"learned_at":"2026-01-01T00:00:00Z","uses":[],"subs":[{"run_id":"seed","text":sub,"files":files,"at":"2026-01-01T00:00:00Z"}],"seen":1,"files":files,"terms":[]}
j["lessons"]+= [run("run-plant-limit","stage-time-limit","The implement stage hit its time limit; PLANTLIMIT",["power.ts"]),
  run("run-plant-scope","out-of-scope-edit","Edits outside the stated scope were flagged; PLANTSCOPE",["power.ts"]),
  run("run-plant-other","check-failed","Check bun:other.test.ts failed: power exponent calc modulo PLANTOTHER",["other.ts","other.test.ts"]),
  run("run-plant-spec","spec-conflict","A run here stopped on a spec conflict; check the requirement against the existing tests before editing",[],"reason: squareRoot of negativeInput must throw RangeError PLANTSPEC"),
  {"id":"rcp-plant","kind":"receipt","text":"Run e10-x sealed VERIFIED: add power(a, b) to power.ts PLANTRECEIPT","source":{"pr":"run:x","pr_url":"","comment_url":"","kind":"receipt","author":"loki"},"learned_at":"2026-01-01T00:00:00Z","uses":[],"justified_by":{"run_id":"e10-x","receipt_sha256":None,"verdict":"unverified"}}]
json.dump(j,open(p,"w"))' "$LESSONS"
pb="$(cd "$REPO" && LOKI_NO_COMPLETIONS=1 bash "$ROOT/bin/loki" memory brief --task "add a power(base, exponent) function to power.ts" 2>&1)"
case "$pb" in *boom*|*PLANTLIMIT*|*PLANTSCOPE*) bad "precise: a stage-time-limit or out-of-scope lesson reached the brief" ;; *) ok "precise: stage-time-limit and out-of-scope lessons on the task's own file are not injected" ;; esac
case "$pb" in *PLANTOTHER*) bad "precise: a check-failed lesson on another file reached the brief" ;; *) ok "precise: a check-failed lesson on another file is not injected despite shared words" ;; esac
case "$pb" in *PLANTRECEIPT*) bad "precise: a receipt fact reached the brief" ;; *) ok "precise: a receipt fact never reaches the brief" ;; esac
sb="$(cd "$REPO" && LOKI_NO_COMPLETIONS=1 bash "$ROOT/bin/loki" memory brief --task "make squareRoot reject negativeInput values" 2>&1)"
has "precise: a spec conflict is injected by the symbols its reason names" "$sb" "a run stopped on a spec conflict (squareRoot of negativeInput"
ob="$(cd "$REPO" && env -u LOKI_PR_LESSONS LOKI_NO_COMPLETIONS=1 bash "$ROOT/bin/loki" memory brief --task "add a modulo(a, b) function to calc.ts" 2>&1)"
case "$ob" in *untrusted-run-lessons*) bad "default: run lessons injected with LOKI_PR_LESSONS unset" ;; *) ok "default: no run lessons with LOKI_PR_LESSONS unset, though related lessons exist" ;; esac

# Stop: a blocked stop is recorded by the real hook and learned at run end; a stale line is dropped and the file consumed.
S="$(cd "$ROOT/loki-ts" && SRC="$ROOT/loki-ts/src" SD="$T/stop" bun -e '
const src = process.env.SRC, d = process.env.SD, fs = await import("node:fs"), { join } = await import("node:path");
fs.mkdirSync(d, { recursive: true });
const SC = await import(src + "/runner/stop_checks.ts"), L = await import(src + "/util/pr_lessons.ts");
const p = SC.stopBlocksPath(d); fs.mkdirSync(join(d, ".loki", "state"), { recursive: true });
fs.writeFileSync(p, JSON.stringify({ at: "2000-01-01T00:00:00.000Z", name: "pytest:tests/stale_test.py", first_error: "STALE" }) + "\n");
const since = new Date(Date.now() - 1000).toISOString();
const hook = SC.createStopChecksHook({ checks: [{ cwd: d, cmd: "sh", args: ["-c", "echo FAILED tests/test_conventions.py::test_registered - AssertionError: register km_to_miles; exit 1"], name: "pytest:tests/test_conventions.py" }], rounds: 1, budgetS: 20, repoDir: d, baseSha: "HEAD" });
const r = await hook({}, undefined, {});
console.log("stop decision", r.decision ?? "none", "| file lines", fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").length : 0);
const found = L.learnFromRun(d, "e10-stop-1", [{ type: "run.started", stage: null, data: {}, ts: since }], "VERIFIED");
const ls = L.loadLessons(d).filter((l) => l.kind === "run");
console.log("stop lessons", JSON.stringify(ls.map((l) => [l.category, l.text, l.subs.map((s) => s.text), l.files])));
console.log("stop consumed", !fs.existsSync(p), "| stale learned", ls.some((l) => l.text.includes("STALE")));
' 2>&1)"
printf '%s\n' "$S" | sed 's/^/    /'
has "stop: a failing stop check blocks the stop and is recorded (stale line + this block)" "$S" "stop decision block | file lines 2"
has "stop: the blocked check becomes a check-failed lesson named by its verify check name" "$S" '"check-failed","Check pytest:tests/test_conventions.py failed'
has "stop: its sub-lesson says it blocked the session stop" "$S" "blocked the session stop: "
has "stop: the stop-blocks file is consumed and the stale line is not learned" "$S" "stop consumed true | stale learned false"

lst="$(cd "$REPO" && LOKI_NO_COMPLETIONS=1 bash "$ROOT/bin/loki" memory lessons 2>&1)"
has "list: loki memory lessons shows the category" "$lst" "category edited-existing-test, seen 2x"
has "list: loki memory lessons shows a sub-lesson" "$lst" "- run $RID1: restored calc.test.ts"

# ---- Reuse past runs (L007 replay, L043 worked example) ----
nruns() { find "$REPO/.loki/runs" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' '; }
sessions() { wc -l < "$ITERS" | tr -d ' '; }

# replay: an identical SPEC_CONFLICT rerun returns the known verdict with no session.
new_repo "$T/repo-replay"
TASK_SC="add a multiply(a, b) function to calc.ts"
run_engine 10 "$TASK_SC" E2E_STUB_MODE=wrong E2E_STUB_FIX=conflict
RIDSC="$RID"; S10="$(sessions)"
[ "$(outcome)" = "BLOCKED" ] && [ "$RC" -eq 4 ] && ok "replay: run 1 ends BLOCKED (SPEC_CONFLICT), exit 4, $S10 sessions" || { bad "replay: run 1 outcome '$(outcome)' rc $RC"; dump; }
lv="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("loki_version"))' "$REPO/.loki/runs/$RIDSC/receipt.json" 2>/dev/null)"
[ "$lv" = "$VERSION_NOW" ] && ok "replay: receipt.json records loki_version $lv" || bad "replay: receipt loki_version is '$lv', want $VERSION_NOW"
before_runs="$(nruns)"; t0="$(date +%s)"
run_engine 11 "$TASK_SC" E2E_STUB_MODE=wrong E2E_STUB_FIX=conflict
dt=$(( $(date +%s) - t0 ))
[ "$RC" -eq 4 ] && ok "replay: run 2 exits 4" || { bad "replay: run 2 exit $RC, want 4"; dump; }
[ "$(sessions)" = "0" ] && [ "$(nruns)" = "$before_runs" ] && ok "replay: run 2 started 0 sessions and wrote no run (no session.started anywhere)" || bad "replay: run 2 sessions $(sessions), runs $before_runs -> $(nruns)"
[ "$dt" -lt 10 ] && ok "replay: run 2 took ${dt}s (< 10s)" || bad "replay: run 2 took ${dt}s"
has "replay: prints the prior run id" "$OUT" "Prior run:  $RIDSC"
has "replay: prints the prior spec_conflict_reason" "$OUT" "Reason:     calc.test.ts:7 expects multiply(3, 4) to be 12"
has "replay: offers loki answer" "$OUT" "loki answer $RIDSC --text"
has "replay: offers --fresh" "$OUT" "rerun with --fresh"
rep="$(tail -1 "$REPO/.loki/memory/replays.jsonl" 2>/dev/null)"
has "replay: a run.replayed event is recorded" "$rep" '"type":"run.replayed"'
has "replay: run.replayed names the prior run id" "$rep" "\"prior_run_id\":\"$RIDSC\""
has "replay: run.replayed names the receipt sha256" "$rep" "\"receipt_sha256\":\"$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["receipt_sha256"])' "$REPO/.loki/runs/$RIDSC/receipt.json")\""
echo "    replay: identical rerun $S10 sessions -> $(sessions) sessions"
# Negative cases on the same history: each runs the full pipeline.
XARGS=(--fresh); run_engine 12 "$TASK_SC" E2E_STUB_MODE=wrong E2E_STUB_FIX=conflict; XARGS=()
[ "$(sessions)" -ge 1 ] && ok "replay: --fresh runs the full pipeline ($(sessions) sessions)" || bad "replay: --fresh started no session"
run_engine 13 "add a multiply(x, y) function to calc.ts" E2E_STUB_MODE=wrong E2E_STUB_FIX=conflict
[ "$(sessions)" -ge 1 ] && ok "replay: a changed task runs the full pipeline ($(sessions) sessions)" || bad "replay: a changed task started no session"
printf 'export const VERSION = 1;\n' > "$REPO/version.ts"; git -C "$REPO" add version.ts; git -C "$REPO" commit -q -m "new base"
run_engine 14 "$TASK_SC" E2E_STUB_MODE=wrong E2E_STUB_FIX=conflict
[ "$(sessions)" -ge 1 ] && ok "replay: a changed base sha runs the full pipeline ($(sessions) sessions)" || bad "replay: a changed base started no session"

# Unit: the verdict rules on synthetic signed-shape receipts (history of task 231ec8a5ea41 on base dd6bee3845 included).
U="$(cd "$ROOT/loki-ts" && SRC="$ROOT/loki-ts/src" UT="$T/unit" bun -e '
const src = process.env.SRC, ut = process.env.UT;
const L = await import(src + "/util/pr_lessons.ts"), { canonicalJson } = await import(src + "/util/receipt_signer.ts");
const { createHash } = await import("node:crypto"), fs = await import("node:fs"), { join } = await import("node:path"), { execFileSync } = await import("node:child_process");
const h = (s) => createHash("sha256").update(s).digest("hex"), V = (await import(src + "/version.ts")).getVersion();
const TASK = "add the hosted feature", BASE = "dd6bee3845".padEnd(40, "0");
let n = 0;
const seal = (repo, verdict, o = {}) => {
  const runId = `e10-unit-${++n}`, body = { schema: "loki.v10.receipt/1", run_id: runId, task: { source: "text", sha256: h(o.task ?? TASK) }, base_sha: o.base ?? BASE, head_sha: o.head ?? o.base ?? BASE,
    checks: o.checks ?? [], verdict, loki_version: o.version ?? V, provider: "claude", model: "m", ...(verdict === "SPEC_CONFLICT" ? { spec_conflict_reason: "built in a hosted service, not in this repo" } : {}) };
  const sha = h(canonicalJson(body)); fs.mkdirSync(join(repo, ".loki", "runs", runId), { recursive: true });
  fs.writeFileSync(join(repo, ".loki", "runs", runId, "receipt.json"), JSON.stringify({ ...body, receipt_sha256: sha, verification: { jwt: "x", kid: "k" } }));
  L.appendReceiptFact(repo, { runId, verdict, receiptSha256: sha, title: o.task ?? TASK, receipt: body, task: o.task ?? TASK }); return runId;
};
const key = (o = {}) => ({ task_sha256: h(o.task ?? TASK), base_sha: o.base ?? BASE, loki_version: o.version ?? V, provider: o.provider ?? "claude", model: "m" });
const repo = (name) => { const d = join(ut, name); fs.mkdirSync(d, { recursive: true }); return d; };
const show = (r) => (r ? `${r.verdict} x${r.runs}` : "full pipeline");
let d = repo("dd6bee"); for (const v of ["SPEC_CONFLICT", "SPEC_CONFLICT", "ALREADY_SATISFIED", "SPEC_CONFLICT"]) seal(d, v);
console.log("unit dd6bee SC,SC,AS,SC ->", show(L.knownVerdict(d, key())));
d = repo("sc1"); seal(d, "SPEC_CONFLICT"); console.log("unit SC x1 ->", show(L.knownVerdict(d, key())));
console.log("unit SC x1 changed task ->", show(L.knownVerdict(d, key({ task: "add the hosted feature now" }))));
console.log("unit SC x1 changed base ->", show(L.knownVerdict(d, key({ base: "980a166236".padEnd(40, "0") }))));
console.log("unit SC x1 changed loki_version ->", show(L.knownVerdict(d, key({ version: "0.0.1" }))));
console.log("unit SC x1 changed provider ->", show(L.knownVerdict(d, key({ provider: "codex" }))));
d = repo("as"); seal(d, "ALREADY_SATISFIED"); console.log("unit AS x1 ->", show(L.knownVerdict(d, key())));
seal(d, "ALREADY_SATISFIED"); console.log("unit AS x2 ->", show(L.knownVerdict(d, key())));
d = repo("partial"); for (let i = 0; i < 3; i++) seal(d, "PARTIAL"); console.log("unit PARTIAL x3 ->", show(L.knownVerdict(d, key())));
d = repo("failed"); for (let i = 0; i < 3; i++) seal(d, "FAILED"); console.log("unit FAILED x3 ->", show(L.knownVerdict(d, key())));
d = repo("altered"); const ar = seal(d, "SPEC_CONFLICT"), rp = join(d, ".loki", "runs", ar, "receipt.json");
fs.writeFileSync(rp, fs.readFileSync(rp, "utf8").replace("hosted service", "hosted servicf")); console.log("unit altered receipt ->", show(L.knownVerdict(d, key())));
// replayKnownVerdict on a real repo: ALREADY_SATISFIED x2 at HEAD exits 0 with no session; --fresh does not replay.
const g = repo("git"), git = (...a) => execFileSync("git", ["-C", g, ...a], { encoding: "utf8" }).trim();
git("init", "-q", "-b", "main"); fs.writeFileSync(join(g, "a.ts"), "export const a = 1;\n"); git("add", "a.ts"); git("-c", "user.name=u", "-c", "user.email=u@e.x", "commit", "-q", "-m", "base");
const head = git("rev-parse", "HEAD"); seal(g, "ALREADY_SATISFIED", { base: head }); seal(g, "ALREADY_SATISFIED", { base: head });
const out = process.stdout.write.bind(process.stdout); let printed = ""; process.stdout.write = (s) => { printed += s; return true; };
const rc = await L.replayKnownVerdict(g, TASK, { fresh: false, json: false, skip: false, provider: "claude", model: "m" }), rcf = await L.replayKnownVerdict(g, TASK, { fresh: true, json: false, skip: false, provider: "claude", model: "m" });
process.stdout.write = out;
console.log("unit replay AS x2 exit ->", rc, "| --fresh ->", rcf === null ? "full pipeline" : rcf, "|", printed.split("\n")[0]);
// Exemplar byte cap: 40 long changed files and 40 long passing checks still store <= 2KB.
const e = repo("exemplar"), ge = (...a) => execFileSync("git", ["-C", e, ...a], { encoding: "utf8" }).trim();
ge("init", "-q", "-b", "main"); fs.writeFileSync(join(e, "seed.ts"), "x\n"); ge("add", "seed.ts"); ge("-c", "user.name=u", "-c", "user.email=u@e.x", "commit", "-q", "-m", "base"); const eb = ge("rev-parse", "HEAD");
for (let i = 0; i < 40; i++) fs.writeFileSync(join(e, `module_with_a_rather_long_descriptive_name_number_${i}.ts`), "export const v = 1;\n".repeat(i + 1));
ge("add", "."); ge("-c", "user.name=u", "-c", "user.email=u@e.x", "commit", "-q", "-m", "work"); const eh = ge("rev-parse", "HEAD");
seal(e, "VERIFIED", { base: eb, head: eh, task: "add forty descriptive modules alpha beta gamma delta", checks: Array.from({ length: 40 }, (_, i) => ({ name: `test:tests/some/deeply/nested/directory/module_${i}.test.ts`, cmd: "bun test", result: "pass", duration_s: 1 })) });
const ex = L.loadLessons(e).find((l) => l.example)?.example;
console.log("unit exemplar bytes ->", ex ? Buffer.byteLength(JSON.stringify(ex)) : -1, "files", ex?.files.length, "tests", ex?.tests.length, "cap", L.EXEMPLAR_CAP);
' 2>&1)"
printf '%s\n' "$U" | sed 's/^/    /'
has "unit: a split history (SC, SC, AS, SC on dd6bee3845) never replays" "$U" "unit dd6bee SC,SC,AS,SC -> full pipeline"
has "unit: one SPEC_CONFLICT replays" "$U" "unit SC x1 -> SPEC_CONFLICT x1"
has "unit: a changed task does not replay" "$U" "unit SC x1 changed task -> full pipeline"
has "unit: a changed base sha does not replay" "$U" "unit SC x1 changed base -> full pipeline"
has "unit: a changed loki_version does not replay" "$U" "unit SC x1 changed loki_version -> full pipeline"
has "unit: a changed provider does not replay" "$U" "unit SC x1 changed provider -> full pipeline"
has "unit: one ALREADY_SATISFIED does not replay" "$U" "unit AS x1 -> full pipeline"
has "unit: two unanimous ALREADY_SATISFIED replay" "$U" "unit AS x2 -> ALREADY_SATISFIED x2"
has "unit: PARTIAL never replays" "$U" "unit PARTIAL x3 -> full pipeline"
has "unit: FAILED never replays" "$U" "unit FAILED x3 -> full pipeline"
has "unit: an altered receipt never replays" "$U" "unit altered receipt -> full pipeline"
has "unit: ALREADY_SATISFIED replay exits 0, --fresh runs the pipeline" "$U" "unit replay AS x2 exit -> 0 | --fresh -> full pipeline"
exb="$(printf '%s\n' "$U" | sed -n 's/^unit exemplar bytes -> \([0-9-]*\) .*/\1/p')"
[ -n "$exb" ] && [ "$exb" -gt 0 ] && [ "$exb" -le 2048 ] && ok "unit: the exemplar of a 40-file VERIFIED run stores $exb bytes (<= 2048)" || bad "unit: exemplar bytes '$exb'"

# worked example: a VERIFIED run leaves an exemplar; a similar task gets it in its brief and Relevant files.
new_repo "$T/repo-example"
TASK_V="add multiply(a, b) to calc.ts returning the product of two numbers"
TASK_S="add multiplyAll(numbers) to calc.ts returning the product of all numbers"
run_engine 20 "$TASK_V" E2E_STUB_TEST_EDIT=1
RIDV="$RID"
[ "$(outcome)" = "VERIFIED" ] && ok "example: run V ends VERIFIED" || { bad "example: run V outcome '$(outcome)'"; dump; }
exv="$(python3 -I -c 'import json,sys
L=[l for l in json.load(open(sys.argv[1]))["lessons"] if l.get("example") and l["justified_by"]["run_id"]==sys.argv[2]]
print(len(json.dumps(L[0]["example"],separators=(",",":"),ensure_ascii=False).encode()) if L else -1, " ".join(f["path"] for f in L[0]["example"]["files"]) if L else "")' "$LESSONS" "$RIDV")"
exvb="${exv%% *}"; EXFILES="${exv#* }"
[ "$exvb" -gt 0 ] && [ "$exvb" -le 2048 ] && ok "example: run V stored an exemplar of $exvb bytes (<= 2048): $EXFILES" || bad "example: exemplar of run V: '$exv'"
git -C "$REPO" checkout -q main && git -C "$REPO" merge -q --ff-only "loki/$RIDV" # V's work accepted, as after its PR merges: its files are on the base
cp -R "$REPO" "$T/repo-example-off"
cp -R "$REPO" "$T/repo-example-default"
run_engine 21 "$TASK_S"
B21="$(impl_bytes)"; P21="$PROMPTS.implement0"
n_ex="$(grep -c "^Worked example from run " "$P21" 2>/dev/null)"
[ "$n_ex" = "1" ] && grep -q "^Worked example from run $RIDV " "$P21" && ok "example: the similar task's brief has exactly one worked example, from run V" || bad "example: worked example blocks in the similar task's brief: $n_ex"
exblk="$(python3 -I -c 'import sys
s=open(sys.argv[1]).read(); a=s.find("\n\nWorked example from run "); t="</untrusted-worked-example>\n"; b=s.find(t, a)
print(len(s[a:b+len(t)].encode()) if a>=0 and b>=0 else -1)' "$P21")"
[ "$exblk" -gt 0 ] && [ "$exblk" -le 1200 ] && ok "example: the worked example block is $exblk bytes (<= 1200)" || bad "example: worked example block bytes $exblk"
relf="$(python3 -I -c 'import sys
s=open(sys.argv[1]).read(); a=s.find("Relevant files:\n"); print(s[a:s.find("\n\n", a)] if a>=0 else "")' "$P21")"
for f in $EXFILES; do printf '%s\n' "$relf" | grep -qx "$f" && ok "example: exemplar file $f is in Relevant files" || bad "example: exemplar file $f missing from Relevant files"; done
REPO="$T/repo-example-off"; LESSONS="$REPO/.loki/memory/semantic/pr-lessons.json"
run_engine 22 "$TASK_S" LOKI_WORKED_EXAMPLE=0
B22="$(impl_bytes)"
grep -q "Worked example from run" "$PROMPTS.implement0" 2>/dev/null && bad "example: LOKI_WORKED_EXAMPLE=0 still injected a worked example" || ok "example: LOKI_WORKED_EXAMPLE=0 injects none"
echo "    example: similar task implement brief $B21 bytes with the worked example, $B22 bytes without (same repo and history)"
REPO="$T/repo-example-default"; LESSONS="$REPO/.loki/memory/semantic/pr-lessons.json"
nles0="$(python3 -I -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["lessons"]))' "$LESSONS" 2>/dev/null)"
UNSET=(-u LOKI_PR_LESSONS -u LOKI_WORKED_EXAMPLE); run_engine 23 "$TASK_S"; UNSET=()
grep -q "Worked example from run" "$PROMPTS.implement0" 2>/dev/null && bad "default: a worked example was injected with nothing opted in" || ok "default: no worked example in the brief by default"
grep -q "untrusted-run-lessons\|untrusted-worked-example" "$PROMPTS.implement0" 2>/dev/null && bad "default: a lessons block was injected with nothing opted in" || ok "default: no lessons block in the brief by default"
nles1="$(python3 -I -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["lessons"]))' "$LESSONS" 2>/dev/null)"
[ -n "$nles0" ] && [ -n "$nles1" ] && [ "$nles1" -gt "$nles0" ] && ok "default: the run still recorded its lesson ($nles0 -> $nles1)" || bad "default: lessons before $nles0, after $nles1 (recording must stay on)"
REPO="$T/repo-example"; LESSONS="$REPO/.loki/memory/semantic/pr-lessons.json"
for tk in "add a divide(a, b) function to calc.ts" "document the install steps in README.md" "add multiply(a, b) to calc.ts returning the product of two numbers, with overflow checks, logging, metrics and validation of inputs"; do
    br="$(cd "$REPO" && LOKI_NO_COMPLETIONS=1 bash "$ROOT/bin/loki" memory brief --task "$tk" 2>&1)"
    case "$br" in *"Worked example from run"*) bad "example: '$tk' (not a near-duplicate) got a worked example" ;; *) ok "example: '$tk' (not a near-duplicate) gets none" ;; esac
done
br="$(cd "$REPO" && LOKI_NO_COMPLETIONS=1 bash "$ROOT/bin/loki" memory brief --task "$TASK_S" 2>&1)"
has "example: loki memory brief shows the worked example for the similar task" "$br" "Worked example from run"
lst="$(cd "$REPO" && LOKI_NO_COMPLETIONS=1 bash "$ROOT/bin/loki" memory lessons 2>&1)"
has "example: loki memory lessons shows the exemplar" "$lst" "worked example: "
has "example: loki memory lessons shows the replay key" "$lst" "replay key: task "

finish
