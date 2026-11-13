#!/usr/bin/env bash
# Engine end to end on the stub provider: the real bin/loki -> committed Bun
# bundle -> engine10 pipeline on a throwaway repo, with a stub `claude` that adds
# multiply() to calc.ts. No network, no model, no real key (a throwaway signing
# key lives in the temp dir). Asserts:
#   done run:   exit 0, "Receipt: VERIFIED", `loki verify` says VERIFIED, and the
#               stub session never saw the canary GH_TOKEN (Rule of Two).
#   tamper run: the stub forges an event mid-run; the run must end TAMPERED and
#               exit non-zero, never VERIFIED.
#   after the fact: one appended line in events.jsonl turns VERIFIED into TAMPERED.
#   high tier:  LOKI_RISK_TIER=high through the committed bundle: the security scan finds its script
#               (from the package root, not relative to the bundle file), passes, and the run is VERIFIED.
#   python legs (need pytest on the system interpreter; SKIP without it, a failure when CI=true):
#     a correct change on a repo with no venv and no dependency manifest, whose impacted pytest
#     passes, seals VERIFIED with the system-interpreter note kept as informational (no Playwright,
#     no UI); the same repo with a requirements.txt still caps (the system interpreter may not be
#     the project's); a change to a module no test imports, or to calc.py whose passing test never
#     calls the new function, still caps (nothing exercised it; the stub replaces a comment line
#     below add(), which must not credit add() as changed).
#   PR runs (L003, local bare origin, deep worker awaited): with LOKI_REVIEW_DEFAULT=1, one review session per
#               medium run (the pre-seal cross-review), no -council iteration anywhere,
#               BLOCK caps at PARTIAL, a FLAG lands on the receipt, result-cost sum
#               equals receipt cost on 3 draft runs, a full suite red only on base
#               ids is status success and a new failing id stays failure.
#
#   capped run (FR09): a metered stub run capped between implement's start and end exits 6 with Outcome: PARTIAL and Reason: cost/time
#               cap reached, the start line carries "cap $X (--max-cost)" and "estimate: about", main is untouched and
#               implement's edit is committed on loki/<run>.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. tests/min/fixtures/e2e/bin/claude: in the done branch print LOKI_DONE
#      without appending multiply() (the run must stop reading VERIFIED).
#   2. this script: pass LOKI_ALLOW_AGENT_GITHUB_TOKEN=1 to the engine (the
#      opt-out that hands the token to the agent); the canary assertion must fail.
#   3. loki-ts/dist/loki.js: the pre-L003 bundle with the post-PR council (the
#      council, one-review, cost and base-red assertions must fail).
#   4. stages/deep.ts: drop the base_red exclusion from status_state (the
#      base-red assertion must fail).
#   5. stages/xreview.ts: default reviewer on medium only (the unit line must fail).
#   6. loki-ts/src/engine10/stages/seal.ts: sysInfo always null (the no-manifest leg reads PARTIAL).
#   7. loki-ts/src/util/python.ts: declaresPythonEnv always false (the requirements.txt leg reads VERIFIED).
#   8. loki-ts/src/engine10/stages/seal.ts: drop leanGap from verdictOf (the never-calls-multiply leg reads VERIFIED).
#   9. loki-ts/src/util/check_result.ts: changedSymbols counts any removed line as removed code (the
#      never-calls-multiply leg reads VERIFIED: the replaced comment credits add()).
#   10. loki-ts/src/engine10/stages/deep.ts: DEFAULT_SECRET_SCAN_SH back to new URL("../../../../autonomy/...",
#      import.meta.url) (rebuild dist); the high-tier leg reads "secret-scan.sh not found" and PARTIAL.
#   11. loki-ts/src/engine10/stages/xreview.ts: reviewDefaultOn returns true (the default unit line reads medium=1), or false
#       for high (it reads high=0).
#   12. loki-ts/src/engine10/stages/xreview.ts: drop the run-model pin for the default review (the high-tier leg reads no --model haiku).
#   13. loki-ts/src/engine10/machine.ts capReached: return false always (the capped run completes and reads VERIFIED, exit 0).
#   14. loki-ts/src/util/check_result.ts changedSymbols: drop the ENCLOSING-DECL fallback (the enclosing-declaration unit line reads method=[]).

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
cd "$ROOT" || exit 2

# Unit: ENCLOSING-DECL. An edit inside an indented method whose @@ context is a template-literal line (git's default funcname for .js) names the
# enclosing method from the head file; a context that names something keeps that name only; column-0 code names nothing (commander.js run).
U="$(cd "$ROOT/loki-ts" && bun -e '
const c = await import("./src/util/check_result.ts");
const file = ["class Command {", "  help() {", "    return `", "Expecting one of", "`;", "  }", "  sourceWithGlobals(key) {", "    let source;", "    this.all().forEach((cmd) => {", "      if (cmd.has(key)) {", "        source = cmd.get(key);", "      }", "    });", "  }", "}", "const top = 1;", "run(top);"].join("\n");
const read = (p) => (p === "lib/command.js" ? file : null), hdr = "diff --git a/lib/command.js b/lib/command.js\n--- a/lib/command.js\n+++ b/lib/command.js\n";
const method = c.changedSymbols(hdr + "@@ -10 +10 @@ Expecting one of\n-      if (cmd.get(key) !== undefined) {\n+      if (cmd.has(key)) {\n", read);
const kept = c.changedSymbols(hdr + "@@ -10 +10 @@ function other() {\n-      if (cmd.get(key) !== undefined) {\n+      if (cmd.has(key)) {\n", read);
const col0 = c.changedSymbols(hdr + "@@ -17 +17 @@ }\n-run(1);\n+run(top);\n", read);
const noReader = c.changedSymbols(hdr + "@@ -10 +10 @@ Expecting one of\n-      if (cmd.get(key) !== undefined) {\n+      if (cmd.has(key)) {\n");
process.env.LOKI_E10_ENCLOSING_DECL = "0"; const off = c.changedSymbols(hdr + "@@ -10 +10 @@ Expecting one of\n-      if (cmd.get(key) !== undefined) {\n+      if (cmd.has(key)) {\n", read);
console.log(`method=${JSON.stringify(method)} kept=${JSON.stringify(kept)} col0=${JSON.stringify(col0)} noreader=${JSON.stringify(noReader)} off=${JSON.stringify(off)}`);
' 2>&1)"
[ "$U" = 'method=["sourceWithGlobals"] kept=["other"] col0=[] noreader=[] off=[]' ] \
    && ok "unit: an edit inside an indented method names the enclosing method; a naming @@ context is kept as is; column-0 code names nothing" || bad "unit: enclosing-declaration gave: $U"

echo "TEST: engine10 end to end on the stub provider"

FIX="$ROOT/tests/min/fixtures/e2e"
CANARY="ghp_E2ECANARYnotarealtoken0000000000000"
TASK="add a multiply(a, b) function to calc.ts"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 120)

# run_engine <mode> -> sets REPO, RC, OUT, RUNDIR, STUBENV, KEY
run_engine() {
    local mode="$1" d; shift
    d="$(mktemp -d "$T/run.XXXXXX")"
    REPO="$d/repo"
    cp -R "$FIX/repo" "$REPO"
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name e2e
    git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add calc.ts calc.test.ts bunfig.toml
    git -C "$REPO" commit -q -m base
    KEY="$d/k.pem"
    STUBENV="$d/stub-env.log"
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" \
        E2E_STUB_MODE="$mode" E2E_STUB_LOG="$d/stub.log" E2E_STUB_ENV_LOG="$STUBENV" \
        LOKI_E10_PLAN=1 GH_TOKEN="$CANARY" LOKI_RECEIPT_SIGNING_KEY_FILE="$KEY" \
        ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$TASK" --no-pr "$@" 2>&1)"
    RC=$?
    RUNDIR=""
    if [ -f "$REPO/.loki/engine.json" ]; then
        local rid
        rid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
        [ -n "$rid" ] && RUNDIR="$REPO/.loki/runs/$rid"
        # the run ends with the checkout back on main and its work on loki/<rid>; look at that work there
        [ -n "$rid" ] && git -C "$REPO" rev-parse -q --verify "refs/heads/loki/$rid" >/dev/null && git -C "$REPO" checkout -q "loki/$rid"
    fi
}

verify_run() { # verify_run -> "<rc> <verdict>"
    local out rc
    out="$(LOKI_RECEIPT_SIGNING_KEY_FILE="$KEY" bash "$ROOT/bin/loki" verify "$RUNDIR/receipt.json" 2>&1)"; rc=$?
    printf '%s %s\n' "$rc" "$(printf '%s\n' "$out" | sed -n 's/^verdict: //p' | head -1)"
}

run_engine done
[ "$RC" -eq 0 ] && ok "done run exits 0" || { bad "done run exited $RC"; printf '%s\n' "$OUT" | tail -15 | sed 's/^/    | /'; }
printf '%s\n' "$OUT" | grep -Eq '^Outcome:[[:space:]]+VERIFIED' && ok "done run prints Outcome: VERIFIED" || bad "done run did not print Outcome: VERIFIED"
grep -q 'export function multiply' "$REPO/calc.ts" && ok "stub's change landed in calc.ts" || bad "calc.ts has no multiply()"
if [ -n "$RUNDIR" ] && [ -f "$RUNDIR/receipt.json" ]; then
    r="$(verify_run)"
    [ "$r" = "0 VERIFIED" ] && ok "loki verify on the run receipt: VERIFIED rc 0" || bad "loki verify gave: $r"
    cp "$RUNDIR/events.jsonl" "$T/events.orig"
    echo '{"v":1,"type":"forged"}' >> "$RUNDIR/events.jsonl"
    r="$(verify_run)"
    [ "$r" = "1 TAMPERED" ] && ok "event appended after the run: TAMPERED rc 1" || bad "edited log gave: $r"
else
    bad "done run left no receipt.json (run dir: '${RUNDIR}')"
fi
if [ -s "$STUBENV" ]; then
    grep -q "$CANARY" "$STUBENV" && bad "the agent session received the GitHub token (Rule of Two broken)" || ok "agent session never saw the GitHub token"
else
    bad "stub env log is empty (the stub never ran)"
fi

run_engine tamper
[ "$RC" -ne 0 ] && ok "tampered run exits non-zero" || bad "tampered run exited 0"
printf '%s\n' "$OUT" | grep -Eq '^Receipt:[[:space:]]+TAMPERED' && ok "tampered run prints Receipt: TAMPERED" || bad "tampered run did not print Receipt: TAMPERED"
printf '%s\n' "$OUT" | grep -q 'Outcome:    VERIFIED' && bad "tampered run claimed Outcome: VERIFIED" || ok "tampered run never claims Outcome: VERIFIED"

# FR09 hard cap: a metered stub (E2E_STUB_USAGE gives every session a $0.01 cost) first runs uncapped; the cap is then set from
# that run's own events (the cost before implement's first cost event, plus half of implement's cost), measured here and
# never hard-coded, so implement starts under the cap and ends over it. A sealed run is never BUDGET_STOP (outcomeOf: BUDGET_STOP
# needs a run that sealed no receipt), so the capped run reads PARTIAL, exit 6, "cost/time cap reached"; the start line states
# the cap and the quote before spending, implement's edit is kept as a commit on loki/<run>, and main is untouched.
E2E_STUB_USAGE=10 run_engine done
cat > "$T/cap.py" <<'PY'
import json, sys
pre, impl, seen = 0.0, 0.0, False
for l in open(sys.argv[1]):
    e = json.loads(l)
    if e["type"] != "cost": continue
    u = e["data"].get("usd") or 0
    if e.get("stage") == "implement": seen = True; impl += u
    elif not seen: pre += u
print(round(pre + impl / 2, 4) if impl > 0 else "")
PY
CAP=""; [ -n "$RUNDIR" ] && CAP="$(python3 -I "$T/cap.py" "$RUNDIR/events.jsonl")"
if [ -n "$CAP" ]; then
    E2E_STUB_USAGE=10 run_engine done --max-cost "$CAP"
    [ "$RC" -eq 6 ] && ok "capped run: cap \$$CAP, exit 6" || { bad "capped run: exit $RC (want 6) with cap $CAP"; printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; }
    printf '%s\n' "$OUT" | grep -Eq '^Outcome:[[:space:]]+PARTIAL' && ok "capped run prints Outcome: PARTIAL, never VERIFIED" || bad "capped run did not print Outcome: PARTIAL"
    printf '%s\n' "$OUT" | grep -Eq '^Reason:[[:space:]]+cost/time cap reached' && ok "capped run names the cap as the reason" || bad "capped run does not name the cap as the reason"
    CAPTXT="$(python3 -I -c 'import sys; print("%.2f" % float(sys.argv[1]))' "$CAP")"
    printf '%s\n' "$OUT" | grep -F "cap \$$CAPTXT (--max-cost)" | grep -q 'estimate: about ' && ok "start line states the cap and quotes cost and time before spending" || bad "start line lacks 'cap \$$CAPTXT (--max-cost)' and 'estimate: about': $(printf '%s\n' "$OUT" | head -1)"
    git -C "$REPO" show main:calc.ts | grep -q multiply && bad "capped run changed main" || ok "capped run leaves main untouched"
    capid="$(basename "$RUNDIR")"
    git -C "$REPO" show "loki/$capid:calc.ts" 2>/dev/null | grep -q multiply && ok "the partial is kept: implement's multiply() is committed on loki/<run>" || bad "loki/<run> has no multiply() after the capped run"
else
    bad "capped run: no metered implement cost in the uncapped run's events (run dir '${RUNDIR}')"
fi

# py_engine <target> [manifest file...] -> REPO, OUT, NOTES (receipt not_proven, one per line)
py_engine() {
    local target="$1" d f rid; shift
    d="$(mktemp -d "$T/py.XXXXXX")"; REPO="$d/repo"; mkdir -p "$REPO/tests"
    printf 'def add(a, b):\n    return a + b\n# LOKI_STUB_INSERT\n' > "$REPO/calc.py"
    printf '"""Formatting helpers."""\n# LOKI_STUB_INSERT\n' > "$REPO/extra.py"
    printf 'import calc\n\n\ndef test_add():\n    assert calc.add(2, 3) == 5\n' > "$REPO/tests/test_calc.py"
    [ "${PY_UNTESTED:-0}" = 1 ] || printf '    if hasattr(calc, "multiply"):\n        assert calc.multiply(3, 4) == 12\n' >> "$REPO/tests/test_calc.py"
    printf '[pytest]\npythonpath = .\n' > "$REPO/pytest.ini"
    for f in "$@"; do printf 'pytest\n' > "$REPO/$f"; done
    git -C "$REPO" init -q -b main; git -C "$REPO" config user.name e2e; git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add -A .; git -C "$REPO" commit -q -m base
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u VIRTUAL_ENV \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" E2E_STUB_MODE="${PY_MODE:-stack}" \
        E2E_STUB_TARGET="$target" E2E_STUB_SNIPPET="$(printf 'def multiply(a, b):\n    return a * b')" \
        LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$d/k.pem" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "add a multiply(a, b) function to $target" --no-pr 2>&1)"
    NOTES=""
    rid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
    [ -n "$rid" ] && NOTES="$(python3 -I -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))["not_proven"]))' "$REPO/.loki/runs/$rid/receipt.json" 2>/dev/null)"
}
outcome() { printf '%s\n' "$OUT" | sed -n 's/^Outcome:[[:space:]]*\([A-Z_]*\).*/\1/p' | head -1; }
SYS="tests ran on the system interpreter"
# High tier through the BUNDLE (LOKI_TS_ENTRY is dist/loki.js): the security scan must find its script from the package
# root. A path relative to the bundle file points outside the package and reads "secret-scan.sh not found" (PARTIAL).
LOKI_RISK_TIER=high LOKI_SESSION_MODEL=haiku E2E_STUB_ARGV_LOG="$T/high-argv.log" run_engine done
rv="$(grep '^review ' "$T/high-argv.log" 2>/dev/null | grep -o -- '--model [^ ]*' | sort -u | tr '\n' ' ')"
[ "$rv" = "--model haiku " ] && ok "high tier: the default review runs (on by default for high risk), on the run's own Haiku pin" || bad "high tier: review --model arguments '$rv' (want one review on haiku)"
scan="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(" ".join(c["result"] for c in json.load(open(sys.argv[1]))["checks"] if c["name"]=="security scan"))' "$RUNDIR/receipt.json" 2>/dev/null)"
[ "$scan" = "pass" ] && ok "high tier through the bundle: the security scan ran and passed" || { bad "high tier through the bundle: security scan result '$scan'"; printf '%s\n' "$OUT" | grep -E '^(Outcome|NOT PROVEN)' | sed 's/^/    | /'; }
printf '%s\n' "$OUT" | grep -Eq '^Outcome:[[:space:]]+VERIFIED' && ok "high tier through the bundle: VERIFIED" || bad "high tier through the bundle: not VERIFIED"
if python3 -m pytest --version >/dev/null 2>&1; then
    py_engine calc.py
    [ "$(outcome)" = "VERIFIED" ] && ok "python, no dependency manifest: impacted pytest passed, VERIFIED" || { bad "python, no dependency manifest: outcome '$(outcome)', not VERIFIED"; printf '%s\n' "$NOTES" | sed 's/^/    np | /'; }
    printf '%s\n' "$NOTES" | grep -q "^$SYS (.*informational, does not cap)$" && ok "python, no dependency manifest: system-interpreter note kept as informational" || bad "python, no dependency manifest: informational note missing"
    py_engine calc.py requirements.txt
    [ "$(outcome)" = "PARTIAL" ] && ok "python, requirements.txt declared: still capped at PARTIAL" || bad "python, requirements.txt declared: outcome '$(outcome)', not PARTIAL"
    printf '%s\n' "$NOTES" | grep -qx "$SYS" && ok "python, requirements.txt declared: system-interpreter note caps (no suffix)" || bad "python, requirements.txt declared: note missing or marked informational"
    py_engine extra.py
    [ -n "$(outcome)" ] && [ "$(outcome)" != "VERIFIED" ] && ok "python, change no test imports: not VERIFIED ($(outcome))" || { bad "python, change no test imports: outcome '$(outcome)'"; printf '%s\n' "$NOTES" | sed 's/^/    np | /'; }
    PY_UNTESTED=1 py_engine calc.py
    [ -n "$(outcome)" ] && [ "$(outcome)" != "VERIFIED" ] && ok "python, impacted test passes but never calls multiply(): not VERIFIED ($(outcome))" || { bad "python, unexercised change: outcome '$(outcome)'"; printf '%s\n' "$NOTES" | sed 's/^/    np | /'; }
    printf '%s\n' "$NOTES" | grep -q "no passing check references a changed symbol.*multiply" && ok "python, unexercised change: the receipt names multiply as unexercised" || bad "python, unexercised change: no changed-symbol note"
elif [ "${CI:-}" = "true" ]; then
    bad "python legs: pytest is not installed on the CI runner"
else
    echo "SKIP: python legs (pytest not installed)"
fi

# L003: one review per run, before seal. PR runs push to a local bare origin (engine10-push.sh local mode, no
# network); the detached deep worker is awaited. run_pr <label> <basered: none|stable|new> [env...] -> REPO, RUNDIR, D, OUT
run_pr() {
    local label="$1" basered="$2" i pid; shift 2
    D="$T/pr-$label"; REPO="$D/repo"; mkdir -p "$D"
    git init -q --bare -b main "$D/origin.git"
    cp -R "$FIX/repo" "$REPO"
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name e2e
    git -C "$REPO" config user.email e2e@example.invalid
    if [ "$basered" != none ]; then # a root npm suite already red on base (TAP ids); "new" adds a second failure once multiply() exists
        printf '{"name":"calc","private":true,"scripts":{"test":"node check.cjs"}}\n' > "$REPO/package.json"
        printf 'const extra = %s && require("fs").readFileSync("calc.ts", "utf8").includes("multiply");\nconsole.log("TAP version 13\\nnot ok 1 - legacy broken\\n" + (extra ? "not ok 2 - multiply broken\\n1..2\\n# fail 2" : "1..1\\n# fail 1"));\nprocess.exit(1);\n' \
            "$([ "$basered" = new ] && echo true || echo false)" > "$REPO/check.cjs"
        git -C "$REPO" add package.json check.cjs
    fi
    git -C "$REPO" add calc.ts calc.test.ts bunfig.toml
    git -C "$REPO" commit -q -m base
    git -C "$REPO" remote add origin "$D/origin.git"
    git -C "$REPO" push -q origin main
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u GH_TOKEN -u GITHUB_TOKEN \
        -u LOKI_REVIEW_PROVIDER -u LOKI_REVIEW_DEFAULT -u LOKI_XVENDOR_DEFAULT -u LOKI_RISK_TIER -u LOKI_PR_DRAFT \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" GH_CONFIG_DIR="$D/ghcfg" \
        E2E_STUB_MODE=done E2E_STUB_LOG="$D/stub.log" E2E_STUB_ITER_LOG="$D/iter.log" E2E_STUB_USAGE=10 \
        LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$D/k.pem" "$@" \
        ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$TASK" 2>&1)"
    RUNDIR="$REPO/.loki/runs/$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
    for i in $(seq 1 90); do [ -f "$RUNDIR/receipt-addendum-1.json" ] && break; sleep 1; done
    pid="$(python3 -I -c 'import json,sys; print(next((json.loads(l)["data"]["pid"] for l in open(sys.argv[1]) if "\"deep.started\"" in l), ""))' "$RUNDIR/events.jsonl" 2>/dev/null)"
    for i in $(seq 1 30); do [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || break; sleep 1; done
}
# pr_facts -> "<pr.opened> <draft> <deep.started> <review sessions> <council files+events> <verdict> <cost sum == receipt to the cent> <addendum status_state>"
pr_facts() {
    python3 -I - "$REPO" "$RUNDIR" "$D/stub.log" <<'PY'
import glob, json, os, sys
repo, rd, stub = sys.argv[1:4]
ev = [json.loads(l) for l in open(os.path.join(rd, "events.jsonl")) if l.strip().startswith("{")]
pr = [e for e in ev if e.get("type") == "pr.opened"]
costs = glob.glob(os.path.join(repo, ".loki", "metrics", "result-cost-*.json"))
council = sum(f.endswith("-council.json") for f in costs) + sum("-council" in json.dumps(e) for e in ev)
reviews = sum(1 for l in open(stub) if l.strip() == "review") if os.path.exists(stub) else 0
rec = json.load(open(os.path.join(rd, "receipt.json")))
total = sum(json.load(open(f)).get("total_cost_usd") or 0 for f in costs)
usd = rec.get("cost", {}).get("usd")
add = os.path.join(rd, "receipt-addendum-1.json")
state = json.load(open(add))["status_state"] if os.path.exists(add) else "none"
print(len(pr), bool(pr and pr[0]["data"].get("draft")), sum(e.get("type") == "deep.started" for e in ev), reviews, council,
      rec.get("verdict"), usd is not None and round(total, 2) == round(usd, 2), state)
PY
}

run_pr block none LOKI_RISK_TIER=medium LOKI_REVIEW_DEFAULT=1 E2E_STUB_REVIEW=BLOCK
f="$(pr_facts)"; set -- $f
[ "$1" = 1 ] && [ "$3" = 1 ] && ok "medium PR run: PR opened and deep verify ran" || { bad "medium PR run facts: $f"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
[ "$5" = 0 ] && ok "no result-cost file or event carries a -council iteration" || bad "council iteration found after the run ($5)"
[ "$4" = 1 ] && ok "exactly one review session in the run (the pre-seal cross-review)" || bad "review sessions in the run: $4 (want 1)"
[ "$6" = PARTIAL ] && [ "$2" = True ] && ok "reviewer BLOCK caps the verdict at PARTIAL (draft PR)" || bad "BLOCK review gave verdict $6, draft $2"
[ "$7" = True ] && ok "draft run: result-cost sum equals receipt cost to the cent" || bad "draft run: cost sum differs from the receipt"
grep -q '"base_red"' "$RUNDIR/receipt-addendum-1.json" 2>/dev/null && bad "addendum marked a suite base_red with no red base" || ok "no base_red mark on a green base"
# FR08: the review queue and the merge gate bind a receipt to a PR by head_sha, so the pushed PR branch must be exactly the sealed head
pushed="$(git -C "$D/origin.git" rev-parse "loki/$(basename "$RUNDIR")" 2>/dev/null)"
sealed="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("head_sha",""))' "$RUNDIR/receipt.json" 2>/dev/null)"
[ -n "$sealed" ] && [ "$pushed" = "$sealed" ] && ok "pushed PR branch tip equals the receipt head_sha (passport and merge gate bind to it)" || bad "pushed loki/<run> tip '$pushed' differs from receipt head_sha '$sealed'"

run_pr highrev none LOKI_RISK_TIER=high E2E_STUB_REVIEW=FLAG LOKI_PR_DRAFT=1
grep -q 'cross-review flag (claude): stub reviewer concern' "$RUNDIR/receipt.json" && ok "high-risk default-model run: the cross-review ran (no --model label passed to the CLI)" || bad "high-risk default-model run: cross-review did not run (reviewer got the provider-default label as --model?)"
grep -q 'cross-review not run: claude exited' "$RUNDIR/receipt.json" && bad "high-risk run: reviewer exited non-zero" || ok "high-risk run: reviewer exit clean"

run_pr flag none LOKI_RISK_TIER=medium LOKI_REVIEW_DEFAULT=1 E2E_STUB_REVIEW=FLAG LOKI_PR_DRAFT=1
f="$(pr_facts)"; set -- $f
[ "$4" = 1 ] && [ "$5" = 0 ] && ok "FLAG run: one review session, no council" || bad "FLAG run facts: $f"
grep -q 'cross-review flag (claude): stub reviewer concern' "$RUNDIR/receipt.json" && ok "reviewer FLAG finding lands on the receipt as NOT PROVEN" || bad "FLAG finding missing from the receipt"
[ "$2" = True ] && [ "$7" = True ] && ok "draft run 2: result-cost sum equals receipt cost to the cent" || bad "draft run 2 facts: $f"

run_pr stable stable LOKI_PR_DRAFT=1
f="$(pr_facts)"; set -- $f
[ "$8" = success ] && ok "deep full suite red only on base-red ids: status success" || bad "base-red full suite gave status $8 ($f)"
grep -q '"base_red": true' "$RUNDIR/receipt-addendum-1.json" && ok "addendum marks the base-red suite" || bad "addendum lacks base_red"
[ "$4" = 0 ] && [ "$5" = 0 ] && ok "low tier PR run: zero review sessions" || bad "low tier review sessions: $4, council $5"
[ "$2" = True ] && [ "$7" = True ] && ok "draft run 3: result-cost sum equals receipt cost to the cent" || bad "draft run 3 facts: $f"

run_pr new new
f="$(pr_facts)"; set -- $f
[ "$8" = failure ] && ok "a new failing id beyond the base-red ones keeps status failure" || bad "new full-suite failure gave status $8 ($f)"

# Unit: every risk tier plans at most the one pre-seal reviewer, and the receipt credits "one reviewer" only from it.
# The unconfigured same-vendor review stays on for high risk and is opt-in for medium (LOKI_REVIEW_DEFAULT=1, xreview.ts reviewDefaultOn).
# The run start sits 60s back: readRiskRecord ignores a record older than the run, and a same-millisecond start raced it on Linux CI.
unit_review() { (cd "$ROOT/loki-ts" && env -u LOKI_REVIEW_PROVIDER -u LOKI_XVENDOR_DEFAULT "$@" bun -e '
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs"), { join } = require("node:path");
const x = await import("./src/engine10/stages/xreview.ts"), cr = await import("./src/util/check_result.ts");
const out = [];
for (const tier of ["low", "medium", "high"]) {
  const d = mkdtempSync(join(process.argv[1], "u-")); mkdirSync(join(d, ".loki", "state"), { recursive: true });
  writeFileSync(join(d, ".loki", "state", "risk-tier.json"), JSON.stringify({ tier }));
  out.push(`${tier}=${x.reviewExtraLimitS({ repoDir: d, provider: "claude", capS: 3600, startedAtMs: Date.now() - 60000, clock: { now: () => Date.now() } }) > 0 ? 1 : 0}`);
}
out.push(`block=${x.minVerdict("VERIFIED", { provider: "claude", level: "block", notes: [] })}`, `flag=${x.minVerdict("VERIFIED", { provider: "claude", level: "flag", notes: ["n"] })}`);
const risk = { tier: "high", checks_selected: ["targeted tests", "one reviewer"], checks_deferred: ["one reviewer"] };
out.push(`gapsReviewed=${cr.deepGaps(risk, [], [], true).notProven.join("|") || "-"}`, `gapsNot=${cr.deepGaps(risk, [], [], false).notProven.join("|") || "-"}`, `council=${cr.DEEP_ITEMS.includes("council")}`);
console.log(out.join(" "));
' "$T" 2>&1); }
U="$(unit_review LOKI_REVIEW_DEFAULT=1)"
[ "$U" = "low=0 medium=1 high=1 block=PARTIAL flag=VERIFIED gapsReviewed=- gapsNot=one reviewer council=false" ] \
    && ok "unit: reviewer planned on medium and high only, BLOCK caps at PARTIAL, one reviewer credited only by a run review" || bad "unit gave: $U"
U="$(unit_review -u LOKI_REVIEW_DEFAULT)"
case "$U" in "low=0 medium=0 high=1 "*) ok "unit: with no reviewer configured and no LOKI_REVIEW_DEFAULT, only the high tier plans a review session" ;; *) bad "unit (default) gave: $U" ;; esac

# EXP-0010: parallel attempts after a red first attempt. The stub (mode attempts) writes a wrong multiply() in every session except the one in
# the attempt worktree B<E2E_STUB_RIGHT>; E2E_STUB_FIX=noprogress keeps the primary's fix round red so the extra attempts run. Real bun test, real pytest, real vitest.
att_ev() { python3 -I -c '
import json, sys
for l in open(sys.argv[1]):
    e = json.loads(l)
    if e["type"] == "attempts.selected": d = e["data"]; print("winner=%s total=%s early=%s launched=%s" % (d.get("winner"), d.get("total"), d.get("early_accept"), d.get("launched"))); break
else: print("none")
' "$RUNDIR/events.jsonl" 2>/dev/null; }
E2E_STUB_RIGHT=2 E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 run_engine attempts
[ "$(outcome)" = "VERIFIED" ] && ok "attempts (bun test): the first attempt is wrong, attempt 2 is right: the run is VERIFIED" || { bad "attempts (bun test): outcome '$(outcome)', not VERIFIED"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
[ "$(att_ev)" = "winner=x2 total=3 early=True launched=2" ] && ok "attempts (bun test): the receipt journal names attempt 2 as the winner of 3 total attempts (2 extra), early accept ($(att_ev))" || bad "attempts (bun test): attempts.selected is '$(att_ev)'"
git -C "$REPO" show HEAD:calc.ts | grep -A1 'function multiply' | grep -q 'a \* b' && ok "attempts (bun test): the committed multiply() is the right one" || bad "attempts (bun test): the committed calc.ts holds the wrong multiply()"
[ "$(verify_run)" = "0 VERIFIED" ] && ok "attempts (bun test): loki verify agrees ($(verify_run))" || bad "attempts (bun test): loki verify says '$(verify_run)'"
att_rc() { python3 -I -c 'import json,sys; a=json.load(open(sys.argv[1])).get("attempts"); print("none" if a is None else "%d|%s" % (len(a), a[-1]))' "$RUNDIR/receipt.json" 2>/dev/null; }
case "$(att_rc)" in *"|selected attempt 3 (x2) of "*" scored (3 requested): early accept"*) ok "attempts (bun test): the signed receipt records every attempt and the selection reason ($(att_rc))" ;; *) bad "attempts (bun test): receipt attempts is '$(att_rc)'" ;; esac
[ "$(git -C "$REPO" worktree list | wc -l | tr -d ' ')" = 1 ] && ok "attempts (bun test): no worktree registration is left in the repo" || bad "attempts (bun test): git worktree list shows a leftover"

E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 run_engine attempts
[ "$(outcome)" = "FAILED" ] && ok "attempts (bun test): every attempt wrong: the repo's checks stay red, so the run is FAILED (a red check is never PARTIAL or VERIFIED)" || { bad "attempts (bun test): all wrong gave outcome '$(outcome)'"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
case "$(att_ev)" in winner=*" total=3 early=False launched=2") ok "attempts (bun test): all wrong: the best partial is kept without an early accept ($(att_ev))" ;; *) bad "attempts (bun test): all-wrong attempts.selected is '$(att_ev)'" ;; esac
git -C "$REPO" show HEAD:calc.ts | grep -q 'export function multiply' && ok "attempts (bun test): all wrong: the best partial is on loki/<run>" || bad "attempts (bun test): all wrong: no partial on loki/<run>"

fix_rounds() { grep -c '"type":"fix.round"' "$RUNDIR/events.jsonl" 2>/dev/null; }
# EXP-0010 early: LOKI_E10_ATTEMPTS_EARLY=1 runs the attempts before any fix round (Haiku only) and skips the fix rounds when one goes green.
E2E_STUB_RIGHT=1 LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS_EARLY=1 run_engine attempts
[ "$(outcome)" = "VERIFIED" ] && [ "$(att_ev)" = "winner=x1 total=2 early=True launched=1" ] && [ "$(fix_rounds)" = 0 ] && ok "attempts early: a wrong first attempt, a right second: VERIFIED with no fix round ($(att_ev))" || { bad "attempts early: outcome '$(outcome)', attempts '$(att_ev)', fix rounds '$(fix_rounds)'"; printf '%s\n' "$OUT" | tail -6 | sed 's/^/    | /'; }
E2E_STUB_RIGHT=2 E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 run_engine attempts
[ "$(att_ev)" != none ] && [ "$(fix_rounds)" -ge 1 ] && ok "attempts early: without the switch the fix round runs first ($(fix_rounds) round(s)), then the attempts" || bad "attempts early: switch off gave attempts '$(att_ev)', fix rounds '$(fix_rounds)'"
E2E_STUB_RIGHT=2 LOKI_E10_ATTEMPTS_EARLY=1 run_engine attempts
[ "$(att_ev)" = none ] && ok "attempts early: not on Haiku, the switch starts no attempt" || bad "attempts early: a non-Haiku run started attempts ('$(att_ev)')"
E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS_EARLY=1 run_engine attempts
[ "$(outcome)" != "VERIFIED" ] && [ "$(att_ev)" != none ] && [ "$(fix_rounds)" -ge 1 ] && ok "attempts early: every attempt wrong: the fix rounds still run afterwards, not VERIFIED ($(outcome), $(fix_rounds) round(s))" || bad "attempts early: all wrong gave '$(outcome)', attempts '$(att_ev)', fix rounds '$(fix_rounds)'"
E2E_STUB_NEWFILE=1 E2E_STUB_RIGHT=2 E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 run_engine attempts
rid="$(basename "$RUNDIR")"; files="$(git -C "$REPO" ls-tree -r --name-only "loki/$rid" 2>/dev/null | tr '\n' ' ')"
[ "$(outcome)" = "VERIFIED" ] && ok "attempts (new files): attempt 2 wins when every attempt creates new files: VERIFIED" || { bad "attempts (new files): outcome '$(outcome)'"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
case " $files " in *" new_2.ts "*) case " $files " in *" shared_new.ts "*) ok "attempts (new files): the winner's own new file and the file every attempt created are committed" ;; *) bad "attempts (new files): shared_new.ts missing: $files" ;; esac ;; *) bad "attempts (new files): new_2.ts missing: $files" ;; esac
case " $files " in *" new_0.ts "*|*" new_1.ts "*|*" new_3.ts "*) bad "attempts (new files): a losing attempt's new file leaked into the winner's tree: $files" ;; *) ok "attempts (new files): no losing attempt's new file is in the winner's tree" ;; esac
E2E_STUB_WEAKEN=1 E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 run_engine attempts
case "$(att_ev)" in winner=x1*) bad "attempts (bun test): an attempt that deleted the failing assertion won ($(att_ev))" ;; *) [ "$(outcome)" != "VERIFIED" ] && ok "attempts (bun test): an attempt that loosens an existing test never wins by passing it ($(att_ev), $(outcome))" || bad "attempts (bun test): a weakened test reached VERIFIED" ;; esac
E2E_STUB_RIGHT=2 E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=0 run_engine attempts
[ "$(att_ev)" = none ] && [ "$(outcome)" = "STALLED" ] && ok "attempts: LOKI_E10_ATTEMPTS=0 turns it off (no extra session; the fix rounds' stall stands)" || bad "attempts: LOKI_E10_ATTEMPTS=0 gave '$(att_ev)' / '$(outcome)'"
E2E_STUB_RIGHT=2 E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku run_engine attempts
[ "$(att_ev)" = none ] && ok "attempts: opt-in, so unset starts none even on Haiku" || bad "attempts: an unset LOKI_E10_ATTEMPTS started attempts ('$(att_ev)')"
E2E_STUB_RIGHT=1 E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=on run_engine attempts
[ "$(att_ev)" = "winner=x1 total=2 early=True launched=1" ] && ok "attempts: LOKI_E10_ATTEMPTS=on is 2 total attempts (one extra) ($(att_ev))" || bad "attempts: =on gave '$(att_ev)'"
E2E_STUB_RIGHT=1 E2E_STUB_FIX=noprogress LOKI_E10_ATTEMPTS=2 run_engine attempts
[ "$(att_ev)" = "winner=x1 total=2 early=True launched=1" ] && [ "$(outcome)" = "VERIFIED" ] && ok "attempts: LOKI_E10_ATTEMPTS=2 is 2 total attempts on any model (it meant 2 extra before 11.140) ($(att_ev))" || bad "attempts: LOKI_E10_ATTEMPTS=2 gave '$(att_ev)' / '$(outcome)'"
LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 run_engine done
[ "$(att_ev)" = none ] && [ "$(att_rc)" = none ] && [ "$(outcome)" = "VERIFIED" ] && ok "attempts: a clean first attempt (verify green, nothing NOT PROVEN) starts no extra session even with LOKI_E10_ATTEMPTS=3" || bad "attempts: a green first attempt gave '$(att_ev)' / '$(outcome)'"

if python3 -m pytest --version >/dev/null 2>&1; then
    PY_MODE=attempts E2E_STUB_RIGHT=1 E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 py_engine calc.py
    [ "$(outcome)" = "VERIFIED" ] && ok "attempts (pytest): attempt 1 is right after a wrong first attempt: VERIFIED" || { bad "attempts (pytest): outcome '$(outcome)'"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
    rid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
    git -C "$REPO" show "loki/$rid:calc.py" 2>/dev/null | grep -A1 'def multiply' | grep -q 'a \* b' && ok "attempts (pytest): the committed multiply() is the right one" || bad "attempts (pytest): the committed calc.py holds the wrong multiply()"
    PY_MODE=attempts E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 py_engine calc.py
    [ -n "$(outcome)" ] && [ "$(outcome)" != "VERIFIED" ] && ok "attempts (pytest): every attempt wrong: not VERIFIED ($(outcome))" || bad "attempts (pytest): all wrong gave '$(outcome)'"
elif [ "${CI:-}" = "true" ]; then
    bad "attempts: pytest is not installed on the CI runner"
else
    echo "SKIP: attempts pytest legs (pytest not installed)"
fi

# real vitest in a temp fixture (skips cleanly offline; LOKI_STACKS_REQUIRE=1 makes a missing install a failure)
vt_attempts() { # vt_attempts <right: 2|none> -> REPO, RUNDIR, OUT
    local d="$T/vt-att-$1"; REPO="$d/repo"; mkdir -p "$REPO"
    printf '{"name":"vt","private":true,"type":"module"}\n' > "$REPO/package.json"
    printf 'export function add(a: number, b: number): number {\n  return a + b;\n}\n' > "$REPO/calc.ts"
    printf 'import { expect, test } from "vitest";\nimport * as calc from "./calc";\n\ntest("add", () => {\n  expect(calc.add(2, 3)).toBe(5);\n});\n\ntest("multiply", () => {\n  const m = (calc as unknown as { multiply?: (a: number, b: number) => number }).multiply;\n  if (m) expect(m(3, 4)).toBe(12);\n});\n' > "$REPO/calc.test.ts"
    printf 'node_modules\n' > "$REPO/.gitignore"
    git -C "$REPO" init -q -b main; git -C "$REPO" config user.name e2e; git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add -A .; git -C "$REPO" commit -q -m base
    cp -R "$VTNM" "$REPO/node_modules"
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" E2E_STUB_MODE=attempts E2E_STUB_RIGHT="$1" E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=haiku LOKI_E10_ATTEMPTS=3 \
        LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$d/k.pem" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "add a multiply(a, b) function to calc.ts" --no-pr 2>&1)"
    local rid; rid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"; RUNDIR="$REPO/.loki/runs/$rid"
    [ -n "$rid" ] && git -C "$REPO" rev-parse -q --verify "refs/heads/loki/$rid" >/dev/null && git -C "$REPO" checkout -q "loki/$rid"
}
VTDIR="$T/vt-install"; mkdir -p "$VTDIR"; printf '{"private":true}\n' > "$VTDIR/package.json"; VTNM="$VTDIR/node_modules"
if (cd "$VTDIR" && ${TO[@]+"${TO[@]}"} npm install vitest@2 --no-audit --no-fund --silent >/dev/null 2>&1) && [ -x "$VTNM/.bin/vitest" ]; then
    vt_attempts 2
    [ "$(outcome)" = "VERIFIED" ] && [ "$(att_ev)" = "winner=x2 total=3 early=True launched=2" ] && ok "attempts (real vitest 2): attempt 2 is right after a wrong first attempt: VERIFIED, winner x2" || { bad "attempts (real vitest 2): outcome '$(outcome)', attempts '$(att_ev)'"; printf '%s\n' "$OUT" | tail -8 | sed 's/^/    | /'; }
    vt_attempts none
    [ -n "$(outcome)" ] && [ "$(outcome)" != "VERIFIED" ] && ok "attempts (real vitest 2): every attempt wrong: not VERIFIED ($(outcome))" || bad "attempts (real vitest 2): all wrong gave '$(outcome)'"
elif [ "${LOKI_STACKS_REQUIRE:-0}" = 1 ]; then
    bad "attempts: vitest@2 could not be installed (LOKI_STACKS_REQUIRE=1: this leg must run here)"
else
    echo "SKIP: attempts vitest legs (vitest@2 could not be installed, offline?)"
fi

# Unit: the N rule (LOKI_E10_ATTEMPTS is the TOTAL count; before 11.140 it was the extra count), the rank order (verify green, then no spec conflict, then fewer NOT PROVEN lines;
# pre red lines never count; a disqualified attempt never wins), the PICK parser, and the order-swapped tie review (it counts only when both orders name the same attempt).
U="$(cd "$ROOT/loki-ts" && bun -e '
const a = await import("./src/features/attempts.ts"), s = await import("./src/e10ext/select.ts"), { FINISH_LINE } = await import("./src/engine10/types.ts");
const sig = (red, np, conflict = false) => ({ red, conflict, notProven: Array.from({ length: np }, (_, i) => `n${i}`) });
const cand = (index, g, o = {}) => ({ index, killedOrErrored: !!o.killed, diff: o.empty ? "" : "@@ -1 +1 @@\n-a\n+b\n", alreadyDoneEvidence: false, weakensTest: !!o.weak, ...(g ? { signal: g } : {}) });
const pick = (...c) => s.rankAttempts(c).index;
const out = [];
out.push(`total=${[undefined, "on", "0", "1", "3", "9", "x", "-1", "2.5"].map((v) => a.attemptsTotal("haiku", v === undefined ? {} : { LOKI_E10_ATTEMPTS: v })).join(",")}`);
out.push(`extra=${a.attemptsK("haiku", { LOKI_E10_ATTEMPTS: "3" })},${a.attemptsK("haiku", { LOKI_E10_ATTEMPTS_EARLY: "1" })},${a.attemptsK("haiku", { LOKI_E10_ATTEMPTS_EARLY: "1", LOKI_E10_ATTEMPTS: "0" })},${a.attemptsK("sonnet", { LOKI_E10_ATTEMPTS_EARLY: "1" })}`);
out.push(`green_first=${pick(cand(0, sig(true, 0)), cand(1, sig(false, 3)))}`);
out.push(`no_conflict_second=${pick(cand(0, sig(false, 1, true)), cand(1, sig(false, 4)))}`);
out.push(`fewer_np=${pick(cand(0, sig(true, 3)), cand(1, sig(true, 1)))}`);
const t = s.rankAttempts([cand(1, sig(true, 2)), cand(0, sig(true, 2)), cand(2, sig(true, 5))]);
out.push(`tie=${t.index}:${t.tied.join("+")}`);
out.push(`weak_out=${pick(cand(0, sig(false, 0), { weak: true }), cand(1, sig(true, 9)))} empty_out=${pick(cand(0, sig(false, 0), { empty: true }), cand(1, sig(true, 9)))} unverified_out=${pick(cand(0, undefined), cand(1, sig(true, 9)))}`);
out.push(`prered=${a.signalNotProven(["pre red: x", "a", "a", ""]).join("+")} clean=${a.isClean(sig(false, 0))},${a.isClean(sig(false, 1))},${a.isClean(sig(true, 0))},${a.isClean(sig(false, 0, true))}`);
out.push(`parse=${a.parsePick("why\nPICK: B", 2)},${a.parsePick("PICK: C", 2)},${a.parsePick("no pick", 2)},${a.parsePick("PICK: A\nPICK: **B**", 3)}`);
const ctx = { issue: "i", conventions: [], tree: [], prefix: [] }, tied = [{ index: 0, diff: "bad" }, { index: 2, diff: "GOOD" }];
const byContent = async (sys, p) => { const m = /CANDIDATE ([A-Z]) \(unified diff against the pre-fix code\):\nGOOD/.exec(p); return { text: m ? `PICK: ${m[1]}` : "PICK: A", usd: 0, outcome: "ok" }; };
const alwaysA = async () => ({ text: "PICK: A", usd: 0, outcome: "ok" }), fails = async () => ({ text: null, usd: null, outcome: "transport" }), throws = async () => { throw new Error("x"); };
out.push(`review=${(await a.reviewTie(byContent, ctx, tied)).index},${(await a.reviewTie(alwaysA, ctx, tied)).index},${(await a.reviewTie(fails, ctx, tied)).index},${(await a.reviewTie(throws, ctx, tied)).index}`);
out.push(`variants=${[1, 2, 3, 4].map((i) => a.variantBrief("BODY\n\n" + FINISH_LINE, i).includes(a.VARIANTS[(i - 1) % 3])).join(",")}`);
console.log(out.join(" "));
' 2>&1)"
[ "$U" = "total=1,2,1,1,3,6,1,1,1 extra=2,1,0,0 green_first=1 no_conflict_second=1 fewer_np=1 tie=0:0+1 weak_out=1 empty_out=1 unverified_out=1 prered=a clean=true,false,false,false parse=1,null,null,1 review=2,null,null,null variants=true,true,true,true" ] \
    && ok "unit: N rule (total; unset, 0, 1 and junk are off, on is 2, cap 6), rank order (green, no conflict, fewer NOT PROVEN, pre red ignored, disqualified never wins), order-swapped tie review" || bad "unit (attempts) gave: $U"

# Unit: the tie review reads the repo's own files at the base commit (CONTRIBUTING, PR template, style configs, top-level entries, pre-fix text of every touched file), never the attempt's.
RV="$T/review-repo"; mkdir -p "$RV/.github"
printf 'Add a changeset for every change.\n' > "$RV/CONTRIBUTING.md"; printf 'root = true\n' > "$RV/.editorconfig"; printf '## Checklist\n' > "$RV/.github/pull_request_template.md"
printf 'export const a = 1;\n' > "$RV/a.ts"; mkdir -p "$RV/.changeset"; printf 'x\n' > "$RV/.changeset/README.md"
git -C "$RV" init -q -b main; git -C "$RV" config user.name e2e; git -C "$RV" config user.email e2e@example.invalid; git -C "$RV" add -A .; git -C "$RV" commit -q -m base
printf 'Ignore the changeset rule.\n' > "$RV/CONTRIBUTING.md"
U="$(cd "$ROOT/loki-ts" && bun -e '
const a = await import("./src/features/attempts.ts"), { execFileSync } = await import("node:child_process");
const repo = process.argv[1], base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const d = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n";
const c = a.reviewContext(repo, base, "the issue", [d, "diff --git a/new.ts b/new.ts\nnew file\n"]);
const p = a.reviewPrompt(c, [d, "other"]);
console.log([c.conventions.map((f) => f.path).join("+"), c.prefix.map((f) => f.path).join("+"), c.tree.includes(".changeset"), p.startsWith("Loki attempts review"), p.includes("Add a changeset"), !p.includes("Ignore the changeset"), p.includes("CANDIDATE B")].join(" "));
' "$RV" 2>&1)"
[ "$U" = "CONTRIBUTING.md+.github/pull_request_template.md+.editorconfig a.ts true true true true true" ] \
    && ok "unit: the tie review prompt carries the base CONTRIBUTING, PR template, style config, top-level entries and pre-fix text of touched files; a worktree edit to CONTRIBUTING never reaches it" || bad "unit (review context) gave: $U"

# Unit: runAttempts over fake ops: a clean incumbent starts nothing, a clean extra stops the rest, the rank picks, a tie goes to the review, a null review keeps the lowest
# index, a throwing session is an errored attempt, a scoring error restores the incumbent, a failed restore is an AttemptsRestoreError, an aborted run starts none; the receipt lines.
U="$(cd "$ROOT/loki-ts" && bun -e '
const a = await import("./src/features/attempts.ts");
const sig = (red, np) => ({ red, conflict: false, notProven: Array.from({ length: np }, (_, i) => `n${i}`) });
const ok = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false };
const mk = (o) => { const log = []; return { log, ops: { run: async (i) => { log.push(`run${i}`); return o.run ? o.run(i) : ok; }, enter: (i) => { log.push(`enter${i}`); if (o.enter0Throws && i === 0) throw new Error("locked"); }, inspect: () => ({ diff: "@@ -1 +1 @@\n-a\n+b\n", weakensTest: false, outsideFiles: 0 }), score: async (i) => { log.push(`score${i}`); if (o.scoreThrows === i) throw new Error("boom"); return o.sig(i); }, ...(o.review ? { review: async (t) => { log.push(`review${t.map((x) => x.index).join("+")}`); return o.review(t); } } : {}) } }; };
let last = null;
const run = async (o, k = 1, sg = new AbortController().signal) => { const m = mk(o), r = await a.runAttempts(m.ops, k, sg, {}); last = r; return `${r.winner}/${r.launched}/${m.log.join(",")}`; };
const out = [];
out.push(`clean=${await run({ sig: () => sig(false, 0) })}`);
out.push(`early=${await run({ sig: (i) => (i === 0 ? sig(false, 2) : sig(false, 0)) })}`);
out.push(`rank=${await run({ sig: (i) => [sig(true, 2), sig(true, 3), sig(true, 1)][i] }, 2)}`);
out.push(`tie_review=${await run({ sig: () => sig(true, 2), review: async () => ({ index: 1, reason: "picked" }) })}:${/review: picked/.test(last.reason)}`);
out.push(`tie_null=${await run({ sig: () => sig(true, 2), review: async () => ({ index: null, reason: "disagreed" }) })}`);
out.push(`receipt=${a.attemptsReceiptLines(last, 2).length}:${a.attemptsReceiptLines(last, 2).at(-1).startsWith("selected attempt 1 (first) of 2 scored (2 requested): tie")}`);
out.push(`throws=${await run({ sig: (i) => sig(true, 1), run: () => { throw new Error("spawn failed"); } }, 2)}`);
out.push(`score_error=${await run({ sig: () => sig(true, 1), scoreThrows: 1 })}`);
out.push(`restore_fail=${await run({ sig: () => sig(true, 1), scoreThrows: 1, enter0Throws: true }).catch((e) => e.name)}`);
const ac = new AbortController(); ac.abort();
out.push(`aborted=${await run({ sig: () => sig(true, 1) }, 2, ac.signal)}`);
out.push(`no_receipt_when_none=${a.attemptsReceiptLines({ launched: 0, scored: [], winner: 0, reason: "" }, 3).length}`);
console.log(out.join(" "));
' 2>&1)"
[ "$U" = "clean=0/0/score0 early=1/1/score0,run1,enter1,score1 rank=2/2/score0,run1,run2,enter1,score1,enter2,score2 tie_review=1/1/score0,run1,enter1,score1,review0+1:true tie_null=0/1/score0,run1,enter1,score1,review0+1,enter0 receipt=3:true throws=0/2/score0,run1,run2 score_error=0/1/score0,run1,enter1,score1,enter0 restore_fail=AttemptsRestoreError aborted=0/0/score0 no_receipt_when_none=0" ] \
    && ok "unit: attempts over fake ops (clean first starts none, clean extra stops the rest, rank picks, a tie goes to the review, a null review keeps the first, errored and aborted keep it, receipt lines)" || bad "unit (attempts ops) gave: $U"

finish
