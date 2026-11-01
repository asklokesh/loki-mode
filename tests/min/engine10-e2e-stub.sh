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
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. tests/min/fixtures/e2e/bin/claude: in the done branch print LOKI_DONE
#      without appending multiply() (the run must stop reading VERIFIED).
#   2. this script: pass LOKI_ALLOW_AGENT_GITHUB_TOKEN=1 to the engine (the
#      opt-out that hands the token to the agent); the canary assertion must fail.
#   3. loki-ts/src/engine10/stages/seal.ts: sysInfo always null (the no-manifest leg reads PARTIAL).
#   4. loki-ts/src/util/python.ts: declaresPythonEnv always false (the requirements.txt leg reads VERIFIED).
#   5. loki-ts/src/engine10/stages/seal.ts: drop leanGap from verdictOf (the never-calls-multiply leg reads VERIFIED).
#   6. loki-ts/src/util/check_result.ts: changedSymbols counts any removed line as removed code (the
#      never-calls-multiply leg reads VERIFIED: the replaced comment credits add()).
#   7. loki-ts/src/engine10/stages/deep.ts: DEFAULT_SECRET_SCAN_SH back to new URL("../../../../autonomy/...",
#      import.meta.url) (rebuild dist); the high-tier leg reads "secret-scan.sh not found" and PARTIAL.

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
cd "$ROOT" || exit 2

echo "TEST: engine10 end to end on the stub provider"

FIX="$ROOT/tests/min/fixtures/e2e"
CANARY="ghp_E2ECANARYnotarealtoken0000000000000"
TASK="add a multiply(a, b) function to calc.ts"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 120)

# run_engine <mode> -> sets REPO, RC, OUT, RUNDIR, STUBENV, KEY
run_engine() {
    local mode="$1" d
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
        ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$TASK" --no-pr 2>&1)"
    RC=$?
    RUNDIR=""
    if [ -f "$REPO/.loki/engine.json" ]; then
        local rid
        rid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
        [ -n "$rid" ] && RUNDIR="$REPO/.loki/runs/$rid"
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
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" E2E_STUB_MODE=stack \
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
LOKI_RISK_TIER=high run_engine done
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

finish
