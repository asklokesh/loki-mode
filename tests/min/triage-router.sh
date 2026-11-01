#!/usr/bin/env bash
# F1 triage router: every work item gets a class (implement, spec, human) and a one-line reason before
# a run is spent. Offline: a stub gh serves tests/min/fixtures/triage/issues.json (8 issues: 3 clear,
# 2 vague, 1 UI-only, 1 production secret rotation, 1 epic) and the stub claude stands in for every
# model call. Asserts, on throwaway repos:
#   classifier:      `loki internal triage` gives the expected class for each fixture issue.
#   overrides:       a loki:implement label forces implement; LOKI_TRIAGE=0 turns the router off.
#   backlog dry run: one class + reason line per issue, nothing launched, nothing drafted.
#   backlog run:     only implement issues launch (each child gets LOKI_TRIAGE_CLASS/REASON), every
#                    spec issue gets .loki/specs/<slug>.md plus the exact `loki start --spec` command,
#                    human issues are listed with the reason; --issues fetches bodies with gh issue view.
#   direct run:      triage never stops or refuses `loki "<goal>"`: when the ambiguity gate fires, a
#                    spec-class and a human-class goal both RUN to VERIFIED and carry the triage block in
#                    the receipt; a backlog child's class lands in the signed receipt, the run events and
#                    the PR line; a clear goal is untouched (no triage key, receipt shape unchanged).
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/features/triage.ts SECRET_OP_RE: replace the verb list with a word no issue uses
#      (`never_matches`): issue 7 (rotate the production secret) classifies as implement and the
#      classifier, backlog run and direct human-goal receipt checks fail.
#   2. loki-ts/src/features/triage.ts triageItem: return class "implement" instead of "spec" for the
#      vague rule: issues 4 and 5 classify as implement and are launched.
#   3. loki-ts/src/features/triage.ts triageGate: return a stop for a spec-class direct run (as an
#      early draft of this feature did): the direct spec goal exits 1 and its run checks fail.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
need python3
cd "$ROOT" || exit 2

echo "TEST: triage router (backlog and one-line goal)"

FIX="$ROOT/tests/min/fixtures"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js" LOKI_NO_COMPLETIONS=1
export PATH="$FIX/triage/bin:$FIX/e2e/bin:$PATH" LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/e2e/bin/claude"
unset LOKI_PROVIDER GH_TOKEN GITHUB_TOKEN LOKI_TRIAGE LOKI_TRIAGE_CLASS LOKI_TRIAGE_REASON LOKI_E10_ASSUME
mkdir -p "$T/ghcfg"; export GH_CONFIG_DIR="$T/ghcfg"
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 120)

# mkrepo <name> -> REPO (calc fixture with a bun test, origin github.com/example/calc)
mkrepo() {
    REPO="$T/$1"; mkdir -p "$REPO"
    cp -R "$FIX/e2e/repo/." "$REPO/"
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name e2e; git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add calc.ts calc.test.ts bunfig.toml
    git -C "$REPO" commit -q -m base
    git -C "$REPO" remote add origin https://github.com/example/calc.git
}
mkrepo base

# 1. classifier: expected class per fixture issue
EXPECT="1:implement 2:implement 3:implement 4:spec 5:spec 6:implement 7:human 8:spec"
items="$(python3 -I -c 'import json,sys; print(json.dumps([{"id": i["number"], "title": i["title"], "body": i["body"], "labels": i["labels"]} for i in json.load(open(sys.argv[1]))]))' "$FIX/triage/issues.json")"
got="$(printf '%s' "$items" | bash "$ROOT/bin/loki" internal triage --repo-dir "$REPO" 2>&1)"
classes="$(printf '%s' "$got" | python3 -I -c 'import json,sys; print(" ".join("%s:%s" % (r["id"], r["class"]) for r in json.load(sys.stdin)))' 2>/dev/null)"
for want in $EXPECT; do
    case " $classes " in *" $want "*) ok "classifier: issue ${want%%:*} is ${want#*:}" ;; *) bad "classifier: issue ${want%%:*} expected ${want#*:}, got: $classes" ;; esac
done
printf '%s' "$got" | python3 -I -c 'import json,sys; sys.exit(0 if all(r["reason"] and "\n" not in r["reason"] for r in json.load(sys.stdin)) else 1)' 2>/dev/null \
    && ok "classifier: every item has a one-line reason" || bad "classifier: a reason is empty or multi-line"

# 2. overrides
ov="$(printf '[{"id":1,"title":"Make onboarding better","labels":["loki:implement"]},{"id":2,"title":"Add multiply(a, b) to calc.ts","labels":[{"name":"loki:human"}]}]' | bash "$ROOT/bin/loki" internal triage --repo-dir "$REPO" 2>&1)"
has "override: loki:implement label forces implement" "$ov" '"id":1,"class":"implement","reason":"label loki:implement"'
has "override: loki:human label forces human" "$ov" '"id":2,"class":"human"'
off="$(cd "$REPO" && LOKI_TRIAGE=0 ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" backlog example/calc --all --dry-run 2>&1)"
[ "$(printf '%s\n' "$off" | grep -c 'implement .*LOKI_TRIAGE=0: router off')" -eq 8 ] && ok "override: LOKI_TRIAGE=0 runs every issue untriaged" || bad "override: LOKI_TRIAGE=0 did not mark all 8 implement"

# 3. backlog --dry-run: class and reason per issue, nothing launched or drafted
cat > "$T/launcher" <<'EOF'
#!/usr/bin/env bash
echo "$1 class=${LOKI_TRIAGE_CLASS:-} reason=${LOKI_TRIAGE_REASON:-}" >> "$LAUNCH_LOG"
echo "Outcome: VERIFIED"
EOF
chmod +x "$T/launcher"
export LOKI_BACKLOG_LAUNCHER="$T/launcher" LAUNCH_LOG="$T/launch.log"
dry="$(cd "$REPO" && ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" backlog example/calc --all --dry-run 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "dry run: exit 0" || bad "dry run: exit $rc"
for want in $EXPECT; do
    printf '%s\n' "$dry" | grep -Eq "^backlog: #${want%%:*} ${want#*:} +.+ \| .+" && ok "dry run: #${want%%:*} printed as ${want#*:} with a reason" || bad "dry run: #${want%%:*} not printed as ${want#*:}"
done
has "dry run: summary counts" "$dry" "dry run: 4 would run, 3 would get a drafted spec, 1 need a human; nothing launched"
[ ! -e "$T/launch.log" ] && [ ! -d "$REPO/.loki/specs" ] && ok "dry run: nothing launched, no spec drafted" || bad "dry run: launched or drafted something"

# 4. backlog run: implement runs, spec drafts, human is listed
run="$(cd "$REPO" && E2E_STUB_LOG="$T/stub-backlog.log" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" backlog example/calc --all 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "backlog run: exit 0" || { bad "backlog run: exit $rc"; printf '%s\n' "$run" | tail -12 | sed 's/^/    | /'; }
launched="$(sed 's/ .*//' "$T/launch.log" 2>/dev/null | sort | tr '\n' ' ')"
[ "$launched" = "example/calc#1 example/calc#2 example/calc#3 example/calc#6 " ] && ok "backlog run: only implement issues launched (#1 #2 #3 #6)" || bad "backlog run: launched: ${launched:-nothing}"
[ "$(grep -c ' class=implement reason=concrete target' "$T/launch.log" 2>/dev/null)" = 4 ] && ok "backlog run: each child gets LOKI_TRIAGE_CLASS and LOKI_TRIAGE_REASON" || bad "backlog run: child env lacks the triage class or reason"
nspec="$(find "$REPO/.loki/specs" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
[ "$nspec" = 3 ] && ok "backlog run: 3 spec issues drafted under .loki/specs" || bad "backlog run: $nspec spec file(s) drafted, want 3"
for n in 4 5 8; do
    line="$(printf '%s\n' "$run" | grep "^#$n " | head -1)"
    f="$(printf '%s\n' "$line" | sed -n 's/.*loki start --spec \([^ ]*\).*/\1/p')"
    [ -n "$f" ] && [ -f "$REPO/$f" ] && head -1 "$REPO/$f" | grep -q 'loki-spec v1' && ok "backlog run: #$n prints the exact command for its drafted spec" || bad "backlog run: #$n has no runnable spec command: $line"
done
for n in 7; do
    printf '%s\n' "$run" | grep -Eq "^#$n +- +HUMAN: .+" && ok "backlog run: #$n listed as HUMAN with its reason" || bad "backlog run: #$n not listed as HUMAN"
done
sel="$(cd "$REPO" && TRIAGE_GH_LOG="$T/gh.log" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" backlog example/calc --issues 4,7 --dry-run 2>&1)"
grep -q 'gh issue view 4' "$T/gh.log" 2>/dev/null && printf '%s\n' "$sel" | grep -q '^backlog: #4 spec ' && printf '%s\n' "$sel" | grep -q '^backlog: #7 human ' \
    && ok "backlog --issues: bodies fetched with gh issue view and triaged" || bad "backlog --issues: not triaged from fetched bodies"

# 5. direct runs through the engine (stub provider, headless): triage records, never stops
goal() { # goal <repo-name> <text> -> OUT, RC, REPO
    mkrepo "$1"; git -C "$REPO" remote remove origin
    OUT="$(cd "$REPO" && E2E_STUB_MODE=done E2E_STUB_LOG="$T/stub-$1.log" LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$T/k.pem" \
        ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$2" </dev/null 2>&1)"; RC=$?
}
receipt_key() { python3 -I -c 'import glob,json,sys; r=[json.load(open(f)) for f in glob.glob(sys.argv[1] + "/.loki/runs/*/receipt.json")]; print(json.dumps(r[0].get("triage")) if r else "NO_RECEIPT")' "$1"; }
receipt_class() { python3 -I -c 'import glob,json,sys; r=[json.load(open(f)) for f in glob.glob(sys.argv[1] + "/.loki/runs/*/receipt.json")]; t=(r[0].get("triage") or {}) if r else {}; print("%s:%s" % (t.get("class"), "reason" if t.get("reason") else "noreason") if r else "NO_RECEIPT")' "$1"; }
direct() { # direct <name> <class> <goal>: the direct run must not stop, must implement, and must record the class
    goal "$1" "$3"
    [ "$RC" -eq 0 ] && printf '%s\n' "$OUT" | grep -Eq '^Outcome:[[:space:]]+VERIFIED' && ok "direct $2 goal: runs to VERIFIED (exit 0), not stopped by triage" || { bad "direct $2 goal: exit $RC, not VERIFIED"; printf '%s\n' "$OUT" | grep -E '^(Outcome|Reason)' | sed 's/^/    | /'; }
    grep -q implement "$T/stub-$1.log" 2>/dev/null && ok "direct $2 goal: the implement session ran" || bad "direct $2 goal: no implement session"
    [ -z "$(find "$REPO/.loki/specs" -name '*.md' 2>/dev/null)" ] && ok "direct $2 goal: no spec drafted" || bad "direct $2 goal: drafted a spec"
    [ "$(receipt_class "$REPO")" = "$2:reason" ] && ok "direct $2 goal: receipt carries triage class $2 with a reason" || bad "direct $2 goal: receipt triage is $(receipt_class "$REPO")"
}
direct amb spec "Make the calc module fast and robust somehow. TBD which functions. Maybe add caching or something?"
direct hum human "Rotate the production API key somehow, TBD. Maybe whatever works? Should it be weekly or monthly?"
LOKI_TRIAGE_CLASS=implement LOKI_TRIAGE_REASON="concrete target (call)" goal child "add a multiply(a, b) function to calc.ts"
[ "$RC" -eq 0 ] && [ "$(receipt_key "$REPO")" = '{"class": "implement", "reason": "concrete target (call)"}' ] && ok "backlog child: class and reason sealed in the receipt" || bad "backlog child: receipt triage is $(receipt_key "$REPO") (exit $RC)"
grep -q '"triage":{"class":"implement"' "$REPO"/.loki/runs/*/events.jsonl 2>/dev/null && ok "backlog child: class recorded in the run events" || bad "backlog child: no triage in events.jsonl"
pr="$(bun --no-env-file --config=/dev/null -e 'const m = await import(process.argv[1]); process.stdout.write(m.triagePrLine({ triage: { class: "implement", reason: "concrete target (call)" } }) + "|" + m.triagePrLine({}))' "$ROOT/loki-ts/src/features/triage.ts" 2>&1)"
[ "$pr" = $'\nTriage: implement (concrete target (call))\n|' ] && ok "PR body: Triage line present with a class, absent without" || bad "PR body line: $pr"
goal clear "add a multiply(a, b) function to calc.ts"
[ "$RC" -eq 0 ] && [ "$(receipt_key "$REPO")" = "null" ] && ok "clear goal: runs as before, no triage key in the receipt" || bad "clear goal: exit $RC, receipt triage $(receipt_key "$REPO")"

finish
