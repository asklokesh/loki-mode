#!/usr/bin/env bash
# The first-touch path a new user takes.
#   tour:      `loki tour` replays the bundled demo receipt offline, prints the verifier's VERIFIED
#              line, then TAMPERED on a one-byte copy, and leaves the bundled files untouched.
#   L034 key:  with only ANTHROPIC_API_KEY and no claude CLI on PATH, preflight passes, doctor says
#              the API-key path is ready with no LOKI_SDK_MODE item, and `loki "<goal>"` runs end to
#              end on the bundled Agent SDK (a stub SDK binary, tests/min/fixtures/e2e/sdk) to VERIFIED.
#   L050 deps: that same run has no python3 and no jq on PATH and matches a control run that has
#              them (exit code, outcome, verify checks); doctor exits 0 and lists both as optional.
#   L035 all:  no git identity, no commits and a logged-out claude give one exit 2 with 3 numbered
#              blockers; --dry-run prints the same list; running the printed fixes verbatim passes.
#   L009 one engine: bare `loki start` and `loki quick` exit 64 with the loki "<goal>" usage; `loki start
#              ./prd.md`, `loki quickstart <prd> --yes` and `loki demo --yes` each seal an engine10 receipt;
#              no bun and LOKI_PROVIDER=foo each exit 2 with the fix; none writes .loki/autonomy-state.json.
#              quickstart in an empty folder and demo with no git identity still seal; LOKI_PRD_FILE is a bare
#              start's PRD; bare start outside a repo shows the sample; data commands ignore the provider.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. skills/fixtures/demo-receipt/pubkey.jwk replaced with {}: the tour stops printing VERIFIED.
#   2. loki-ts/src/commands/doctor.ts claudeSdkReady returns false: the key-only preflight, doctor
#      and run checks fail (no_provider).
#   3. loki-ts/src/engine10/preflight.ts keeps only the first blocker: the L035 list checks fail.
#   4. autonomy/lib/setup-requirements.json python3 level back to required: the doctor checks fail.
#   5. autonomy/route.sh: a no-positional start returns undecided again (legacy cmd_start): the bare start checks fail.
#   6. autonomy/quickstart.sh: build with `cmd_start "$target" --yes --no-plan` again: the quickstart receipt check fails.
#   7. autonomy/loki cmd_demo: build with `cmd_start prd.md --simple --yes` again: the demo receipt check fails.
#   8. bin/loki: no working bun sets _e10=0 (legacy fallback) instead of exit 2: the no-bun checks fail.
#   9. autonomy/quickstart.sh: never initialise the empty folder: the empty-folder quickstart checks fail (exit 2).
#   10. autonomy/loki _loki_init_fresh_repo: no repo-local identity: the no-identity demo and empty-folder checks fail.
#   11. bin/loki: drop the data-command arm (provider checked for every engine10 call): keys export, verify,
#       export --sarif and the no-bun bare verify checks fail.
#   12. autonomy/route.sh: ignore LOKI_PRD_FILE: the LOKI_PRD_FILE start checks fail (exit 64).
# No network, no model, no real key: the fake key never leaves the machine (stubs answer every call).

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
cd "$ROOT" || exit 2

echo "TEST: newcomer path (loki tour)"

export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
FX="$ROOT/skills/fixtures/demo-receipt"
for f in receipt.json events.jsonl pubkey.jwk proof.json; do
    [ -s "$FX/$f" ] && ok "fixture present: $f" || bad "fixture missing or empty: $f"
done
before="$(cat "$FX/receipt.json" "$FX/events.jsonl" "$FX/pubkey.jwk" | shasum -a 256 | cut -d' ' -f1)"

out="$(bash bin/loki tour 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "loki tour exits 0" || bad "loki tour exited $rc"
v_line="$(printf '%s\n' "$out" | grep -n 'Result: VERIFIED' | head -1 | cut -d: -f1)"
t_line="$(printf '%s\n' "$out" | grep -n 'Result: TAMPERED' | head -1 | cut -d: -f1)"
[ -n "$v_line" ] && ok "tour prints Result: VERIFIED" || bad "tour never prints Result: VERIFIED"
[ -n "$t_line" ] && ok "tour prints Result: TAMPERED for the one-byte copy" || bad "tour never prints Result: TAMPERED"
[ -n "$v_line" ] && [ -n "$t_line" ] && [ "$v_line" -lt "$t_line" ] && ok "VERIFIED comes before TAMPERED" || bad "tour verdict order is wrong"
has "tour says it is a sample" "$out" "This is a SAMPLE"

after="$(cat "$FX/receipt.json" "$FX/events.jsonl" "$FX/pubkey.jwk" | shasum -a 256 | cut -d' ' -f1)"
[ "$before" = "$after" ] && ok "bundled fixture untouched by the tour" || bad "the tour modified the bundled fixture"

# ---------------------------------------------------------------------------
echo "TEST: newcomer path (first run: key only, optional tools, every blocker at once)"
E2E="$ROOT/tests/min/fixtures/e2e"
SDKNM="$E2E/sdk"
GOAL="add a multiply(a, b) function to calc.ts"
FAKEKEY="sk-ant-test-not-a-real-key"
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 120)

# A PATH with the system tools but no claude, python3 or jq: what a fresh machine or slim image has.
BARE="$T/bare-bin"; mkdir -p "$BARE"
for d in /usr/bin /bin; do
    for f in "$d"/*; do
        n="${f##*/}"
        case "$n" in claude|jq|python|python3*) continue ;; esac
        [ -e "$BARE/$n" ] || ln -s "$f" "$BARE/$n"
    done
done
for tool in bun git node; do p="$(command -v "$tool")" && ln -sf "$p" "$BARE/$tool"; done
for tool in claude jq python3; do
    PATH="$BARE" command -v "$tool" >/dev/null 2>&1 && bad "bare PATH still has $tool" || ok "bare PATH has no $tool"
done
FULLPATH="$BARE:$PATH"

# fixture_repo <name> [noid] [nocommit] -> REPO: the e2e calc repo, with or without identity and a first commit
fixture_repo() {
    REPO="$T/$1"; mkdir -p "$REPO"; cp -R "$E2E/repo/." "$REPO/"
    git -C "$REPO" init -q -b main
    [ "${2:-}" = noid ] || { git -C "$REPO" config user.name e2e; git -C "$REPO" config user.email e2e@example.invalid; }
    [ "${3:-}" = nocommit ] || { git -C "$REPO" add calc.ts calc.test.ts bunfig.toml; git -C "$REPO" -c user.name=e2e -c user.email=e2e@example.invalid commit -q -m base; }
}
run_id() { sed -n 's/.*"run_id" *: *"\([^"]*\)".*/\1/p' "$1/.loki/engine.json" 2>/dev/null | head -1; }
# verify_checks <repo>: "<name>=<result>" for each verify check of the run, sorted
verify_checks() {
    local rid; rid="$(run_id "$1")"
    [ -n "$rid" ] && bun -e '
const ev = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map((l) => JSON.parse(l));
const v = ev.filter((e) => e.type === "stage.completed" && e.stage === "verify").pop();
console.log(((v && v.data && v.data.checks) || []).map((c) => `${c.name}=${c.result}`).sort().join(" "));' "$1/.loki/runs/$rid/events.jsonl"
}

# L034 unit: checkPreflight with no claude on PATH, a key set and the SDK binary present.
fixture_repo pf-key
pf() { # pf <repo> <env...> -> JSON {fatal, blocker} of checkPreflight
    local repo="$1"; shift
    env -i HOME="$HOME" PATH="$BARE" "$@" bun -e '
const { checkPreflight } = await import(process.argv[1]);
const r = await checkPreflight({ repoDir: process.argv[2], provider: "claude", pr: false, env: process.env });
console.log(JSON.stringify({ fatal: r.fatal, blocker: r.blocker ?? null }));' "$ROOT/loki-ts/src/engine10/preflight.ts" "$repo" 2>&1
}
r="$(pf "$REPO" ANTHROPIC_API_KEY="$FAKEKEY" LOKI_SDK_NODE_MODULES="$SDKNM")"
[ "$r" = '{"fatal":null,"blocker":null}' ] && ok "L034 preflight: key + SDK binary, no claude CLI -> fatal null" || bad "L034 preflight refused a key-only host: $r"
r="$(pf "$REPO" LOKI_SDK_NODE_MODULES="$SDKNM")"
has "L034 preflight: no key and no CLI still refuses as no_provider" "$r" '"blocker":"no_provider"'
has "L034 preflight: that refusal offers the key as a fix" "$r" "export ANTHROPIC_API_KEY=<your key>"
r="$(pf "$REPO" ANTHROPIC_API_KEY="$FAKEKEY" LOKI_SDK_NODE_MODULES="$SDKNM" LOKI_E10_INVOKER=cli)"
has "L034 preflight: LOKI_E10_INVOKER=cli still needs the claude CLI" "$r" '"blocker":"no_provider"'

# L034 AC3 + L050 doctor: only a key, no claude, python3 or jq.
doc_env=(env -i HOME="$HOME" PATH="$BARE" TERM=dumb CI=true LOKI_TELEMETRY_DISABLED=true LOKI_NO_UPDATE_CHECK=1 ANTHROPIC_API_KEY="$FAKEKEY" LOKI_SDK_NODE_MODULES="$SDKNM" LOKI_TS_ENTRY="$LOKI_TS_ENTRY")
out="$(cd "$T" && "${doc_env[@]}" bash "$ROOT/bin/loki" doctor --requirements 2>&1)"
has "L034 doctor --requirements: API-key path ready" "$out" "Anthropic API-key path (Agent SDK, no claude CLI): ready"
case "$out" in *LOKI_SDK_MODE*) bad "L034 doctor --requirements still asks for LOKI_SDK_MODE" ;; *) ok "L034 doctor --requirements has no LOKI_SDK_MODE item" ;; esac
has "L050 doctor --requirements: All paths ready without python3 and jq" "$out" "All paths: ready"
printf '%s\n' "$out" | grep -q '\[MISS\] optional *Python 3.8' && ok "L050 doctor lists Python 3.8 as optional" || bad "L050 doctor does not list Python as optional"
printf '%s\n' "$out" | grep -q '\[MISS\] optional *jq' && ok "L050 doctor lists jq as optional" || bad "L050 doctor does not list jq as optional"
out="$(cd "$T" && "${doc_env[@]}" bash "$ROOT/bin/loki" doctor 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "L050 loki doctor exits 0 with only a key, no python3, no jq" || { bad "loki doctor exited $rc on a key-only host"; printf '%s\n' "$out" | grep -E 'FAIL|^  - ' | sed 's/^/    | /'; }
has "L034 loki doctor names loki \"<goal>\" on the bundled SDK" "$out" 'loki "<goal>" needs no separate CLI'

# L034 e2e + L050: `loki "<goal>"` on the bundled SDK path, no claude, python3 or jq; and a control run with them.
run_goal() { # run_goal <repo> <PATH> -> RC, OUT
    OUT="$(cd "$1" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY -u LOKI_E10_INVOKER ANTHROPIC_BASE_URL=http://127.0.0.1:9 \
        PATH="$2" ANTHROPIC_API_KEY="$FAKEKEY" LOKI_SDK_NODE_MODULES="$SDKNM" E2E_STUB_MODE=done E2E_SDK_STUB_LOG="$1.sdk.log" \
        LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$1.pem" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$GOAL" --no-pr 2>&1)"
    RC=$?
}
fixture_repo key-bare
run_goal "$REPO" "$BARE"; bare_rc=$RC; bare_out="$OUT"; bare_repo="$REPO"
[ "$bare_rc" -eq 0 ] && ok "L034 key-only run on the bundled SDK exits 0" || { bad "L034 key-only run exited $bare_rc"; printf '%s\n' "$bare_out" | tail -15 | sed 's/^/    | /'; }
printf '%s\n' "$bare_out" | grep -Eq '^Outcome:[[:space:]]+VERIFIED' && ok "L034 key-only run prints Outcome: VERIFIED" || bad "L034 key-only run did not reach VERIFIED"
[ -s "$bare_repo.sdk.log" ] && ok "L034 sessions ran through the SDK binary ($(wc -l < "$bare_repo.sdk.log" | tr -d ' ') calls)" || bad "L034 the SDK binary never ran"
{ grep -q 'export function multiply' "$bare_repo/calc.ts" || git -C "$bare_repo" for-each-ref --format='%(refname:short)' 'refs/heads/loki/' | while read -r b; do git -C "$bare_repo" show "$b:calc.ts"; done | grep -q 'export function multiply'; } && ok "L034 the session's change landed (checkout or run branch)" || bad "L034 calc.ts has no multiply()"
fixture_repo key-full
run_goal "$REPO" "$FULLPATH"; full_rc=$RC; full_out="$OUT"; full_repo="$REPO"
bare_outcome="$(printf '%s\n' "$bare_out" | sed -n 's/^Outcome:[[:space:]]*//p' | head -1)"
full_outcome="$(printf '%s\n' "$full_out" | sed -n 's/^Outcome:[[:space:]]*//p' | head -1)"
bare_checks="$(verify_checks "$bare_repo")"; full_checks="$(verify_checks "$full_repo")"
echo "  L050 record: no python3/jq rc=$bare_rc outcome=$bare_outcome checks=[$bare_checks]; control rc=$full_rc outcome=$full_outcome checks=[$full_checks]"
not_run="$(printf '%s\n' $bare_checks | grep '=not_run$' || true)"
echo "  L050 record: checks that became not_run without python3/jq: ${not_run:-none}"
[ "$bare_rc" = "$full_rc" ] && [ -n "$bare_outcome" ] && [ "$bare_outcome" = "$full_outcome" ] && ok "L050 no python3/jq run matches the control (rc $full_rc, $full_outcome)" || bad "L050 outcome differs without python3/jq: rc $bare_rc/$full_rc outcome '$bare_outcome'/'$full_outcome'"
[ -n "$full_checks" ] && [ "$bare_checks" = "$full_checks" ] && ok "L050 verify checks identical with and without python3/jq" || bad "L050 verify checks differ: [$bare_checks] vs [$full_checks]"

# L035: no git identity, no commits, a logged-out claude -> one exit 2 listing all three, each with its fix.
STUB="$T/stub-bin"; mkdir -p "$STUB"; LOGIN="$T/claude-logged-in"
cat > "$STUB/claude" <<EOF
#!/bin/sh
if [ "\$1 \$2" = "auth status" ]; then if [ -f "$LOGIN" ]; then echo '{"loggedIn":true}'; else echo '{"loggedIn":false}'; fi; exit 0; fi
if [ "\$1 \$2" = "auth login" ]; then : > "$LOGIN"; exit 0; fi
exec "$E2E/bin/claude" "\$@"
EOF
chmod +x "$STUB/claude"
fixture_repo l035 noid nocommit
l035_env=(env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u LOKI_SDK_NODE_MODULES -u LOKI_RECEIPT_SIGNING_KEY PATH="$STUB:$BARE" LOKI_E10_INVOKER=cli E2E_STUB_MODE=done LOKI_RECEIPT_SIGNING_KEY_FILE="$T/l035.pem")
out="$(cd "$REPO" && "${l035_env[@]}" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$GOAL" --no-pr 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && ok "L035 first run exits 2" || bad "L035 first run exited $rc"
has "L035 says how many things to fix" "$out" "3 things to fix before this run can start:"
blk="$(printf '%s\n' "$out" | grep -E '^  [0-9]+\. ')"
[ "$(printf '%s\n' "$blk" | grep -c .)" -eq 3 ] && ok "L035 exactly 3 numbered blockers" || bad "L035 numbered blockers: $(printf '%s\n' "$blk" | grep -c .)"
printf '%s\n' "$blk" | grep -q '^  1\. git identity is not set; run: ' && ok "L035 1: git identity with its fix" || bad "L035 line 1 is not the identity fix"
printf '%s\n' "$blk" | grep -q '^  2\. repository has no commits; run: ' && ok "L035 2: no commits with its fix" || bad "L035 line 2 is not the first-commit fix"
printf '%s\n' "$blk" | grep -q '^  3\. claude is not logged in; run: ' && ok "L035 3: logged-out claude with its fix" || bad "L035 line 3 is not the login fix"
dry="$(cd "$REPO" && "${l035_env[@]}" bash "$ROOT/bin/loki" start --dry-run "$GOAL" 2>&1)"; drc=$?
[ "$drc" -eq 2 ] && [ -n "$blk" ] && [ "$(printf '%s\n' "$dry" | grep -E '^  [0-9]+\. ')" = "$blk" ] && ok "L035 --dry-run reports the same 3 blockers" || { bad "L035 --dry-run differs (rc $drc)"; printf '%s\n' "$dry" | tail -6 | sed 's/^/    | /'; }
# Apply each printed fix verbatim: the text after "run: ", up to a trailing parenthesised alternative.
while IFS= read -r line; do
    case "$line" in *"; run: "*) ;; *) continue ;; esac # a blocker with no copy-paste fix already failed above
    fix="$(printf '%s\n' "$line" | sed -e 's/^.*; run: //' -e 's/ (or .*)$//')"
    (cd "$REPO" && PATH="$STUB:$BARE" bash -c "$fix" >/dev/null 2>&1) && ok "L035 printed fix runs: $fix" || bad "L035 printed fix failed: $fix"
done <<< "$blk"
out="$(cd "$REPO" && "${l035_env[@]}" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$GOAL" --no-pr 2>&1)"; rc=$?
[ -n "$(run_id "$REPO")" ] && [ "$rc" -ne 2 ] && ok "L035 after the printed fixes the next run passes preflight (exit $rc)" || { bad "L035 still refused after the printed fixes (exit $rc)"; printf '%s\n' "$out" | tail -6 | sed 's/^/    | /'; }

# ---------------------------------------------------------------------------
echo "TEST: newcomer path (L009: every first-run entry point runs the default engine, never the legacy loop)"
# The legacy loop (autonomy/run.sh) writes .loki/autonomy-state.json; engine10 seals .loki/runs/e10-*/receipt.json.
printf '[user]\n\tname = e2e\n\temail = e2e@example.invalid\n' > "$HOME/.gitconfig"
l009_env=(env -u ANTHROPIC_API_KEY -u LOKI_RECEIPT_SIGNING_KEY -u LOKI_PROVIDER -u LOKI_ENGINE PATH="$E2E/bin:$BARE" LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$E2E/bin/claude" E2E_STUB_MODE=done)
no_legacy() { [ ! -e "$1/.loki/autonomy-state.json" ] && ok "L009 $2: no legacy state (.loki/autonomy-state.json)" || bad "L009 $2 ran the legacy loop"; }
e10_receipt() { ls "$1"/.loki/runs/e10-*/receipt.json >/dev/null 2>&1 && ok "L009 $2: engine10 sealed a receipt" || bad "L009 $2: no .loki/runs/e10-*/receipt.json"; }
fixture_repo l009-bare
out="$(cd "$REPO" && "${l009_env[@]}" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" start </dev/null 2>&1)"; rc=$?
[ "$rc" -eq 64 ] && ok "L009 bare loki start exits 64" || bad "L009 bare loki start exited $rc"
has "L009 bare loki start prints the goal usage" "$out" 'usage: loki "<goal>"'
no_legacy "$REPO" "bare start"
out="$(cd "$REPO" && "${l009_env[@]}" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" quick </dev/null 2>&1)"; rc=$?
[ "$rc" -eq 64 ] && ok "L009 bare loki quick exits 64" || bad "L009 bare loki quick exited $rc"
no_legacy "$REPO" "bare quick"
fixture_repo l009-prd
printf '# PRD\n\nAdd a multiply(a, b) function to calc.ts.\n' > "$REPO/prd.md"
out="$(cd "$REPO" && "${l009_env[@]}" LOKI_RECEIPT_SIGNING_KEY_FILE="$T/l009a.pem" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" start ./prd.md --no-pr </dev/null 2>&1)"; rc=$?
e10_receipt "$REPO" "start ./prd.md"; no_legacy "$REPO" "start ./prd.md"
fixture_repo l009-qs
printf '# PRD\n\nAdd a multiply(a, b) function to calc.ts.\n' > "$T/l009-prd.md"
# quickstart's plan step runs the PRD estimator, which needs python3 (absent from BARE).
out="$(cd "$REPO" && "${l009_env[@]}" PATH="$E2E/bin:$PATH" LOKI_RECEIPT_SIGNING_KEY_FILE="$T/l009b.pem" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" quickstart "$T/l009-prd.md" --yes </dev/null 2>&1)"; rc=$?
e10_receipt "$REPO" "quickstart <prd> --yes"; no_legacy "$REPO" "quickstart"
NOID=(GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1) # a machine with no git identity
DEMO="$T/l009-demo"
out="$("${l009_env[@]}" "${NOID[@]}" LOKI_RECEIPT_SIGNING_KEY_FILE="$T/l009c.pem" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" demo --yes --dir "$DEMO" </dev/null 2>&1)"; rc=$?
e10_receipt "$DEMO" "demo --yes with no git identity"; no_legacy "$DEMO" "demo"
# quickstart in an EMPTY folder that is not a repo, with no git identity: quickstart writes prd.md, then makes the repo.
QSE="$T/l009-qs-empty"; mkdir -p "$QSE"
out="$(cd "$QSE" && "${l009_env[@]}" "${NOID[@]}" PATH="$E2E/bin:$PATH" LOKI_RECEIPT_SIGNING_KEY_FILE="$T/l009d.pem" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" quickstart "$T/l009-prd.md" --yes </dev/null 2>&1)"; rc=$?
[ "$rc" -ne 2 ] && ok "L009 quickstart in an empty folder does not exit 2 (exit $rc)" || { bad "L009 quickstart in an empty folder exited 2"; printf '%s\n' "$out" | tail -4 | sed 's/^/    | /'; }
e10_receipt "$QSE" "quickstart in an empty folder"; no_legacy "$QSE" "quickstart in an empty folder"
# LOKI_PRD_FILE is the PRD of a bare start (loki start --help documents it).
fixture_repo l009-prdenv
printf '# PRD\n\nAdd a multiply(a, b) function to calc.ts.\n' > "$REPO/prd.md"
out="$(cd "$REPO" && "${l009_env[@]}" LOKI_PRD_FILE=./prd.md LOKI_RECEIPT_SIGNING_KEY_FILE="$T/l009e.pem" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" start --no-pr </dev/null 2>&1)"; rc=$?
[ "$rc" -ne 64 ] && ok "L009 LOKI_PRD_FILE start is not the no-goal usage (exit $rc)" || bad "L009 LOKI_PRD_FILE start ignored the PRD (exit 64)"
e10_receipt "$REPO" "LOKI_PRD_FILE start"
# Bare start outside a repo shows the offline sample receipt and spends nothing (README).
NR="$T/l009-norepo"; mkdir -p "$NR"
out="$(cd "$NR" && "${l009_env[@]}" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" start </dev/null 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "L009 bare start outside a repo exits 0" || bad "L009 bare start outside a repo exited $rc"
has "L009 bare start outside a repo shows the sample receipt" "$out" "Showing a real receipt"
no_legacy "$NR" "bare start outside a repo"
# An interrupted run of the previous loop is named, with how to resume it.
fixture_repo l009-oldrun
mkdir -p "$REPO/.loki"; printf '{"status": "running", "iterationCount": 3}\n' > "$REPO/.loki/autonomy-state.json"
out="$(cd "$REPO" && "${l009_env[@]}" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" start </dev/null 2>&1)"; rc=$?
has "L009 bare start names the interrupted previous-loop run" "$out" "run 'loki resume'"
# --issue N points to the issue-ref form.
out="$(cd "$REPO" && "${l009_env[@]}" bash "$ROOT/bin/loki" start --issue 5 </dev/null 2>&1)"; rc=$?
has "L009 --issue N points to loki start owner/repo#N" "$out" "loki start owner/repo#N"
# No working bun: exit 2 with the install command, nothing runs. bun on PATH is the only one (no bundled @oven/bun-* here).
NOBUN="$T/nobun-bin"; mkdir -p "$NOBUN"
for f in "$BARE"/*; do [ "${f##*/}" = bun ] || ln -s "$f" "$NOBUN/${f##*/}"; done
fixture_repo l009-nobun
if ls "$ROOT"/node_modules/@oven/bun-*/bin/bun >/dev/null 2>&1; then
    ok "L009 no-bun leg not applicable: this checkout bundles bun"
else
    out="$(cd "$REPO" && "${l009_env[@]}" PATH="$E2E/bin:$NOBUN" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "fix the login bug" </dev/null 2>&1)"; rc=$?
    [ "$rc" -eq 2 ] && ok "L009 no bun: exits 2" || bad "L009 no bun: exited $rc"
    has "L009 no bun: prints the install command" "$out" "curl -fsSL https://bun.sh/install | bash"
    no_legacy "$REPO" "no bun"
    # A bare verify needs no model: with no bun it reads the run with the bash verify instead of refusing.
    out="$(cd "$T/l009-prd" && "${l009_env[@]}" PATH="$E2E/bin:$NOBUN" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" verify </dev/null 2>&1)"; rc=$?
    case "$out" in *"no working bun"*) bad "L009 no bun: bare verify refused (exit $rc)" ;; *) ok "L009 no bun: bare verify falls back to the bash verify (exit $rc)" ;; esac
fi
out="$(cd "$REPO" && "${l009_env[@]}" LOKI_PROVIDER=foo ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "fix the login bug" </dev/null 2>&1)"; rc=$?
[ "$rc" -eq 2 ] && ok "L009 LOKI_PROVIDER=foo exits 2" || bad "L009 LOKI_PROVIDER=foo exited $rc"
has "L009 LOKI_PROVIDER=foo names the five providers" "$out" "claude, codex, cline, aider, opencode"
# Commands that start no model session never check the provider.
for cmd in "keys export" "verify --pubkey $T/none.jwk" "export --sarif" "verify"; do
    out="$(cd "$T/l009-prd" && "${l009_env[@]}" LOKI_PROVIDER=foo LOKI_RECEIPT_SIGNING_KEY_FILE="$T/l009a.pem" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" ${cmd} </dev/null 2>&1)"; rc=$?
    case "$out" in *"is not supported"*) bad "L009 LOKI_PROVIDER=foo blocks loki $cmd (exit $rc)" ;; *) ok "L009 LOKI_PROVIDER=foo does not block loki ${cmd%% $T*} (exit $rc)" ;; esac
done
no_legacy "$REPO" "LOKI_PROVIDER=foo"

finish
