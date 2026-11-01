#!/usr/bin/env bash
# Learn from runs on the stub provider (tests/min/fixtures/e2e/bin/claude): the real bin/loki -> committed Bun bundle ->
# engine10, several runs in ONE throwaway repo so each run reads what the earlier ones wrote to
# .loki/memory/semantic/pr-lessons.json (util/pr_lessons.ts learnFromRun, retrieveLessons, formatRunLessons).
# Asserts:
#   learn:     run 1 (wrong multiply(), a fix round that changes nothing, an edit to the pre-existing calc.test.ts)
#              ends STALLED and writes a check-failed lesson whose sub-lesson carries the first error line and run 1's
#              id, plus an edited-existing-test lesson naming calc.test.ts.
#   related:   run 2 on a related task gets those lessons in its implement brief (byte count printed).
#   merge:     run 2 repeats both mistakes (then its fix round turns the check green); each class stays ONE lesson
#              with two sub-lessons, the check-failed one records the fix-round change, and run 2's use tag is marked
#              recurred.
#   unrelated: run 3 on an unrelated task gets no run-lessons block.
#   cap:       with 12 long seeded lessons, `loki memory brief` keeps the run-lessons block within 1200 bytes.
#   list:      `loki memory lessons` shows the category and sub-lessons.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/util/pr_lessons.ts learnFromRun: hash the run id into the lesson id (a repeat duplicates the class).
#   2. loki-ts/src/util/pr_lessons.ts retrieveLessons: score a run lesson `runScore(...) || 1` (an unrelated run gets them).

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
need python3
cd "$ROOT" || exit 2

echo "TEST: learn from runs on the stub provider"

FIX="$ROOT/tests/min/fixtures/e2e"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
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

# run_engine <n> <task> <env assignments...> -> RC, OUT, RID, PROMPTS (all prompts the stub classed as implement), ITERS
run_engine() {
    local n="$1" task="$2"; shift 2
    PROMPTS="$T/prompt$n"; ITERS="$T/iters$n.log"; : > "$ITERS"
    git -C "$REPO" checkout -q -- . 2>/dev/null; git -C "$REPO" clean -qfd -e .loki 2>/dev/null
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" LOKI_NO_COMPLETIONS=1 \
        E2E_STUB_PROMPT_LOG="$PROMPTS" E2E_STUB_ITER_LOG="$ITERS" LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$T/k.pem" \
        "$@" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$task" --no-pr 2>&1)"
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
s=open(sys.argv[1]).read(); a=s.find("\n\nLessons from earlier runs on this repo"); b=s.find("</untrusted-run-lessons>\n", a)
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
has "related: run 2 brief carries the run-lessons block" "$B2" "<untrusted-run-lessons>"
has "related: run 2 brief carries the check-failed lesson" "$B2" "[check-failed"
has "related: run 2 brief carries run 1's sub-lesson" "$B2" "run $RID1: "
has "related: run 2 brief carries the edited-existing-test lesson" "$B2" "[edited-existing-test"
echo "    run 2 ($RID2): implement brief $(impl_bytes) bytes (same task with no history: $BEFORE bytes), run-lessons block $(block "$PROMPTS.implement0" | wc -c | tr -d ' ') bytes"
[ "$(block "$PROMPTS.implement0" | wc -c)" -le 1200 ] && ok "cap: run 2's injected run-lessons block is within 1200 bytes" || bad "cap: run 2's run-lessons block is over 1200 bytes"
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
s=open(sys.argv[1]).read(); a=s.find("Lessons from earlier runs on this repo"); t="</untrusted-run-lessons>\n"; b=s.find(t, a)
print(len(("\n\n"+s[a:b+len(t)]).encode()) if a>=0 and b>=0 else -1)' "$T/cap.txt")"
if [ "$capblk" -gt 0 ] && [ "$capblk" -le 1200 ]; then ok "cap: run-lessons block is $capblk bytes with $(lq 'len(L)') run lessons stored (cap 1200)"; else bad "cap: run-lessons block is $capblk bytes (want 1..1200)"; fi

lst="$(cd "$REPO" && LOKI_NO_COMPLETIONS=1 bash "$ROOT/bin/loki" memory lessons 2>&1)"
has "list: loki memory lessons shows the category" "$lst" "category edited-existing-test, seen 2x"
has "list: loki memory lessons shows a sub-lesson" "$lst" "- run $RID1: restored calc.test.ts"

finish
