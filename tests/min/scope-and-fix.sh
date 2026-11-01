#!/usr/bin/env bash
# Implement and fix stages on the stub provider (tests/min/fixtures/e2e/bin/claude): the real bin/loki -> committed
# Bun bundle -> engine10 on a throwaway repo. Pre-existing tests are read-only and the fix loop stops spending.
# Asserts:
#   restore:     the implement session weakens calc.test.ts (a test file at the base commit: adds a test.skip) and adds multiply.test.ts;
#                the calc.test.ts edit is restored after the session and named in implement.tests_reverted, the new
#                test file is kept, and the run is VERIFIED.
#   scope:       in the same run the session edits util.ts, which plan-scope.json (seeded with the task's calc.ts) does
#                not name; the edit is kept and the receipt lists "outside stated scope: util.ts" without blocking.
#   update:      an edit that keeps every assertion and only adds a test case is kept (not restored), and the
#                verdict stays below VERIFIED with the edited test named on the receipt.
#   named:       the same edit is kept when the task names calc.test.ts.
#   conflict:    implement writes a wrong multiply(); the fix session answers LOKI_SPEC_CONFLICT without editing;
#                no retry session starts (one fix session, no "-r" iteration) and the run ends BLOCKED.
#   no progress: the fix session edits calc.ts but the same test still fails; fixing stops after that one round
#                (one fix session, one fix.round event, two verify runs) and the run ends STALLED.
#   wall defect: a LOKI_SESSION_MODEL=haiku run whose (slow) Wall author calls multiplyAll(), a name the task never
#                asks for. Implement starts before the Wall finishes (the Wall never gates implement), the correct
#                multiply() lands and calc.test.ts passes, the fix session answers LOKI_SPEC_CONFLICT citing the Wall
#                file and the referee runs; the run is delivered PARTIAL (not BLOCKED) with multiply() in calc.ts and
#                the Wall file listed as discarded, and no session (Wall author and referee included) runs off haiku.
#   lean normal: a normal-size task with a relevant visible test runs no Wall session at all.
#   lean fix loop, unit level (bun over loki-ts/src):
#     L005: fix-brief groups built from the checked-in pytest, jest, vitest, go test, surefire and dotnet failure
#           outputs (tests/min/fixtures/failures, raw ANSI included) have a non-empty excerpt, 0 ESC bytes and a
#           signature longer than the check name; two vitest full-suite outputs with different failing ids give
#           different signatures; the recorded jest Validation Error is harness-owned.
#     L006: with LOKI_E10_FIX_RESUME unset a claude SDK fix round resumes the implement session and asks for no
#           effort change, so a session created at medium stays at medium (no effort_escalation_cache_reset);
#           LOKI_E10_FIX_RESUME=0 forces a fresh round at the fix effort.
#     L025: the quick selection; a verify NOT PROVEN (a quick-only last verify) never seals VERIFIED.
#     L026: the brief no longer invites the full suite; the stream parser records full_suite_runs per session.
#   jest:        a stand-in npx prints the jest Validation Error for a committed jest test: 0 fix sessions.
#   quick verify: a 2-round run at risk tier medium re-verifies round 1 quick and the last round complete, runs the
#                full suite twice (3 before), ends VERIFIED, and the full-suite signature carries its first failing line.
#   quick-only end: a no-progress run at tier medium ends on a quick verify that lists the missing complete verify
#                as NOT PROVEN, stops after one round (the unrerun full suite still feeds the stall rule), not VERIFIED.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. loki-ts/src/engine10/stages/implement.ts: drop restoreBaseTests from tests_reverted (the restore run fails).
#   2. loki-ts/src/engine10/machine.ts: stall window back to 3 verifies (the no-progress run takes a second round).
#   3. loki-ts/src/e10ext/scope.ts: ignore plan-scope.json in flagOutsideScope (the receipt no longer lists util.ts).
#   4. loki-ts/src/util/conflict_resume.ts: deliverOverWallConflict returns null (the wall defect run ends BLOCKED).
#   5. loki-ts/src/util/wall_knobs.ts: wallConcurrent default back to sequential (the Wall finishes before implement).
#   6. loki-ts/src/util/session_pin.ts: capToSessionPin returns the stage pin unchanged (the referee runs on sonnet).
#   7. loki-ts/src/engine10/sizing.ts: smallTaskPath lean only for small tasks (the normal task runs a Wall session).
#   8. loki-ts/src/engine10/stages/seal.ts: drop weakTests from the verdict cap (the update run reads VERIFIED).
#   9. loki-ts/src/runner/runner_errors.ts: drop the Validation Error pattern (rebuild dist): the unit check fails and
#       the jest run starts 2 fix sessions.
#   10. loki-ts/src/util/check_result.ts: failureSignature ignores ids (the two full-suite signatures match).
#   11. loki-ts/src/runner/session_resume.ts: chainEnabled back to opt-in === "1" (the three resume checks fail).
#   12. loki-ts/src/e10ext/select.ts: quickScope always null (rebuild dist): scopes all complete, 3 suites.
#   13. loki-ts/src/e10ext/context.ts: restore "including the package's full suite" (the brief check fails).

. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
need python3
cd "$ROOT" || exit 2

echo "TEST: scope and fix loop on the stub provider"

FIX="$ROOT/tests/min/fixtures/e2e"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 120)

# run_engine <task> <env assignments...> -> sets REPO, RC, OUT, RUNDIR, ITERS (one "<stage> <iteration> <bytes>" line per session)
run_engine() {
    local task="$1" d rid; shift
    d="$(mktemp -d "$T/run.XXXXXX")"
    REPO="$d/repo"; ITERS="$d/iters.log"; : > "$ITERS"
    cp -R "$FIX/repo" "$REPO"
    printf 'export const VERSION = 1;\n' > "$REPO/util.ts"
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name e2e
    git -C "$REPO" config user.email e2e@example.invalid
    if [ -n "${SEED:-}" ]; then cp -R "$SEED"/. "$REPO"/; fi # extra committed files (a loki.yaml and its test command)
    git -C "$REPO" add calc.ts calc.test.ts bunfig.toml util.ts
    if [ -n "${SEED:-}" ]; then for f in "$SEED"/*; do git -C "$REPO" add -- "$(basename "$f")"; done; fi
    git -C "$REPO" commit -q -m base
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_RECEIPT_SIGNING_KEY \
        LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" LOKI_NO_COMPLETIONS=1 \
        E2E_STUB_LOG="$d/stub.log" E2E_STUB_ITER_LOG="$ITERS" LOKI_E10_PLAN=1 LOKI_RECEIPT_SIGNING_KEY_FILE="$d/k.pem" \
        "$@" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$task" --no-pr 2>&1)"
    RC=$?
    RUNDIR=""
    if [ -f "$REPO/.loki/engine.json" ]; then
        rid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
        [ -n "$rid" ] && RUNDIR="$REPO/.loki/runs/$rid"
        # the run ends with the checkout back on main and its work on loki/<rid>; look at that work there
        [ -n "$rid" ] && git -C "$REPO" rev-parse -q --verify "refs/heads/loki/$rid" >/dev/null && git -C "$REPO" checkout -q "loki/$rid"
    fi
}

# ev <python expression over E (the events list)>: prints the value, empty when the log is missing
ev() {
    [ -n "$RUNDIR" ] && [ -f "$RUNDIR/events.jsonl" ] || return 0
    python3 -I -c 'import json,sys
E=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
print(eval(sys.argv[2]))' "$RUNDIR/events.jsonl" "$1" 2>/dev/null
}
fix_sessions() { grep -c '^fix ' "$ITERS"; }
outcome() { printf '%s\n' "$OUT" | sed -n 's/^Outcome:[[:space:]]*\([A-Z_]*\).*/\1/p' | head -1; }
dump() { printf '%s\n' "$OUT" | tail -15 | sed 's/^/    | /'; sed 's/^/    iter | /' "$ITERS"; }

TASK="add a multiply(a, b) function to calc.ts"

run_engine "$TASK" E2E_STUB_MODE=done E2E_STUB_TEST_EDIT=1 E2E_STUB_SCOPE_EDIT=1 LOKI_E10_PLAN=auto
reverted="$(ev '[e["data"].get("tests_reverted") for e in E if e["type"]=="stage.completed" and e["stage"]=="implement"]')"
if cmp -s "$FIX/repo/calc.test.ts" "$REPO/calc.test.ts"; then ok "restore: the edit to the pre-existing calc.test.ts was restored"; else bad "restore: calc.test.ts still carries the session's edit"; dump; fi
has "restore: implement.tests_reverted names calc.test.ts" "$reverted" "'calc.test.ts'"
[ -f "$REPO/multiply.test.ts" ] && ok "restore: the new test file multiply.test.ts was kept" || bad "restore: the new test file multiply.test.ts is gone"
[ "$(outcome)" = "VERIFIED" ] && ok "restore: run is VERIFIED" || { bad "restore: outcome is '$(outcome)', not VERIFIED"; dump; }
notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
has "scope: the receipt lists the out-of-scope edit" "$notes" "outside stated scope: util.ts"
grep -q 'MODE = 2' "$REPO/util.ts" && ok "scope: the out-of-scope edit is kept, not reverted" || bad "scope: the util.ts edit was dropped"

run_engine "$TASK" E2E_STUB_MODE=done E2E_STUB_TEST_EDIT=update LOKI_EXOGENOUS_PROOF=0 # proof opt-out: the edited test alone must cap, not the agent-only-proof rule
grep -q 'add again' "$REPO/calc.test.ts" && ok "update: an edit that keeps every assertion and adds a case is kept" || { bad "update: an assertion-preserving edit to calc.test.ts was restored"; dump; }
reverted="$(ev '[e["data"].get("tests_reverted") for e in E if e["type"]=="stage.completed" and e["stage"]=="implement"]')"
case "$reverted" in *calc.test.ts*) bad "update: tests_reverted names calc.test.ts: $reverted" ;; *) ok "update: tests_reverted does not name calc.test.ts" ;; esac
[ -n "$(outcome)" ] && [ "$(outcome)" != "VERIFIED" ] && ok "update: an edited existing test still caps the verdict ($(outcome))" || { bad "update: outcome is '$(outcome)' with an edited existing test"; dump; }
notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
has "update: the receipt names the edited test" "$notes" "weakened test: calc.test.ts"

run_engine "add a multiply(a, b) function to calc.ts and extend calc.test.ts" E2E_STUB_MODE=done E2E_STUB_TEST_EDIT=1
grep -q 'add again' "$REPO/calc.test.ts" && ok "named: the task names calc.test.ts, so the edit is kept" || bad "named: the edit to a test the task names was restored"

run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=conflict
n="$(fix_sessions)"
[ "$n" = "1" ] && ok "conflict: one fix session, no retry" || { bad "conflict: $n fix sessions (want 1)"; dump; }
grep -q -- '-r ' "$ITERS" && bad "conflict: a '-r' retry session started" || ok "conflict: no '-r' retry iteration"
[ "$(outcome)" = "BLOCKED" ] && ok "conflict: run ends BLOCKED" || bad "conflict: outcome is '$(outcome)', not BLOCKED"

run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=noprogress
n="$(fix_sessions)"
[ "$n" = "1" ] && ok "no progress: one fix round, then fixing stops" || { bad "no progress: $n fix sessions (want 1)"; dump; }
[ "$(ev 'sum(1 for e in E if e["type"]=="fix.round")')" = "1" ] && ok "no progress: one fix.round event" || bad "no progress: fix.round events: $(ev 'sum(1 for e in E if e["type"]=="fix.round")')"
[ "$(ev 'sum(1 for e in E if e["type"]=="stage.started" and e["stage"]=="verify")')" = "2" ] && ok "no progress: verify ran twice" || bad "no progress: verify ran $(ev 'sum(1 for e in E if e["type"]=="stage.started" and e["stage"]=="verify")') times (want 2)"
[ "$(outcome)" = "STALLED" ] && ok "no progress: run ends STALLED" || bad "no progress: outcome is '$(outcome)', not STALLED"

run_engine "$TASK" E2E_STUB_MODE=wallphantom E2E_STUB_FIX=wallconflict E2E_STUB_WALL_SLEEP=3 LOKI_SESSION_MODEL=haiku E2E_STUB_ARGV_LOG="$T/argv.log"
order="$(ev 'min([e["seq"] for e in E if e["type"]=="stage.started" and e["stage"]=="implement"] or [10**9]) < min([e["seq"] for e in E if e["type"] in ("stage.completed","stage.failed") and e["stage"]=="wall"] or [-1])')"
[ "$order" = "True" ] && ok "wall defect: implement started before the Wall author finished" || { bad "wall defect: the Wall finished before implement started (order: $order)"; dump; }
[ "$(outcome)" = "PARTIAL" ] && ok "wall defect: delivered PARTIAL, not BLOCKED" || { bad "wall defect: outcome is '$(outcome)', not PARTIAL"; dump; }
grep -q 'export function multiply' "$REPO/calc.ts" && ok "wall defect: the correct multiply() is kept" || bad "wall defect: multiply() was discarded"
grep -q -- '-wa ' "$ITERS" && ok "wall defect: the referee ran on the Wall-anchored conflict" || bad "wall defect: no referee session ran"
notes="$([ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get("not_proven"))' "$RUNDIR/receipt.json" 2>/dev/null)"
has "wall defect: the receipt lists the discarded Wall file" "$notes" "wall test discarded: loki_wall_multiply.test.ts"
models="$(ev 'sorted({str(e["data"].get("model")) for e in E if e["type"]=="cost"})')"
case "$models" in *haiku*) ;; *) models="none recorded: $models" ;; esac
printf '%s\n' "$models" | tr -d "[]'" | tr ',' '\n' | grep -v haiku | grep -q '[a-z]' && bad "wall defect: a session ran off haiku: $models" || ok "wall defect: every session ran on haiku ($models)"
if [ -s "$T/argv.log" ]; then
    pinned="$(grep -o -- '--model [^ ]*' "$T/argv.log" | sort -u)"
    [ -n "$pinned" ] && [ -z "$(printf '%s\n' "$pinned" | grep -v haiku)" ] && ok "wall defect: every --model argument was haiku ($pinned)" || bad "wall defect: --model arguments: '${pinned}'"
else
    bad "wall defect: argv log is empty"
fi

run_engine "$TASK" E2E_STUB_MODE=done LOKI_E10_PLAN=auto LOKI_E10_SMALL_MAX_CHARS=10
[ "$(ev 'next((e["data"].get("size") for e in E if e["type"]=="variant" and "size" in e["data"]), None)')" = "normal" ] && ok "lean normal: the task sized normal" || bad "lean normal: the task did not size normal"
grep -q '^wall ' "$ITERS" && { bad "lean normal: a Wall session ran despite a relevant visible test"; dump; } || ok "lean normal: no Wall session"
[ "$(outcome)" = "VERIFIED" ] && ok "lean normal: run is VERIFIED" || { bad "lean normal: outcome is '$(outcome)'"; dump; }
# ---------------------------------------------------------------- lean fix loop, unit level (L005, L006, L025, L026)
mkdir -p "$T/l006" "$T/l026"
cat > "$T/lean-fix.ts" <<TS
import { readFileSync } from "node:fs";
import { firstError, failureExcerpt } from "$ROOT/loki-ts/src/util/check_result.ts";
import { failIds, failureGroup } from "$ROOT/loki-ts/src/engine10/failures.ts";
import { classifyRunnerOutput } from "$ROOT/loki-ts/src/runner/runner_errors.ts";
import { runFixSession } from "$ROOT/loki-ts/src/runner/session_resume.ts";
import { rememberSessionEffort, sessionEffortFor } from "$ROOT/loki-ts/src/engine10/session.ts";
import { quickSplit } from "$ROOT/loki-ts/src/e10ext/select.ts";
import { verdictOf } from "$ROOT/loki-ts/src/engine10/stages/seal.ts";
import { FIXED_RULES } from "$ROOT/loki-ts/src/e10ext/context.ts";
import { buildImplementBrief } from "$ROOT/loki-ts/src/engine10/stages/implement.ts";
import { consumeSdkStream, isSuiteRun } from "$ROOT/loki-ts/src/runner/sdk_stream_parser.ts";
const res = (name: string, pass: boolean) => console.log((pass ? "OK " : "NO ") + name);
const FX = "$ROOT/tests/min/fixtures/failures/";
const group = (f: string, suite = false) => { const out = readFileSync(FX + f, "utf8"); return failureGroup({ name: "full suite: x", cmd: "runner cmd", first_error: firstError(out), ids: failIds(out) }, failureExcerpt(out, "/work/repo"), suite); };
for (const f of ["pytest", "jest", "vitest", "gotest", "surefire", "dotnet"]) {
  const g = group(f + ".txt"), body = g.sample.split("\n").slice(1).join("\n");
  res("L005 " + f + ": the brief group has a non-empty excerpt", body.trim() !== "");
  res("L005 " + f + ": the brief group has 0 ESC (0x1b) bytes", !Buffer.from(g.signature + g.sample).includes(0x1b));
  res("L005 " + f + ": the signature names the failure, not only the check", g.signature.length > "full suite: x".length);
}
const a = group("vitest-suite-a.txt", true), b = group("vitest-suite-b.txt", true);
res("L005 full suite: the signature carries the failing ids", a.signature.includes("divides") && b.signature.includes("subtracts"));
res("L005 full suite: two different failing sets give two stall signatures", a.signature !== b.signature);
const jv = classifyRunnerOutput(readFileSync(FX + "jest-validation.txt", "utf8"));
res("L005 jest Validation Error is harness-owned", jv.kind === "load_error" && jv.owner === "harness");

delete process.env.LOKI_E10_FIX_RESUME; delete process.env.LOKI_E10_INVOKER; delete process.env.LOKI_E10_EFFORT;
const calls: Record<string, unknown>[] = [];
const ctx = { provider: "claude", repoDir: "$T/l006", runId: "e10-x", outputs: () => ({}), sessions: { run: async (o: Record<string, unknown>) => { calls.push(o); return { exit: 0, killed: false, markers: {}, summary: null }; } }, cost: { read: () => ({ cacheReadTokens: 0 }) } } as never;
const base = { stage: "fix", tier: "development", limitS: 180, signal: new AbortController().signal, cwd: "$T/l006", effort: "high" } as never;
const r1 = await runFixSession(ctx, base, "e10-x-fix1", [], { sessionId: "S1", model: "m" }, "m", "FULL", "RESUME");
res("L006 env unset: the fix round resumes the implement session", r1.mode === "resumed" && calls[0]!.resumeSessionId === "S1" && calls[0]!.brief === "RESUME");
res("L006 env unset: the resumed call asks for no effort change", !("effort" in calls[0]!));
rememberSessionEffort("S1", "medium");
const warm = sessionEffortFor(calls[0] as never), cold = sessionEffortFor({ ...calls[0], effort: "high" } as never);
res("L006 a resumed round 1 keeps the session effort (no effort_escalation_cache_reset)", warm.effort === "medium" && !warm.escalated && !!cold.escalated);
process.env.LOKI_E10_FIX_RESUME = "0";
const r0 = await runFixSession(ctx, base, "e10-x-fix1b", [], { sessionId: "S1", model: "m" }, "m", "FULL", "RESUME");
res("L006 LOKI_E10_FIX_RESUME=0 forces a fresh round", r0.mode === "fresh" && !calls[1]!.resumeSessionId && calls[1]!.brief === "FULL" && calls[1]!.effort === "high");
delete process.env.LOKI_E10_FIX_RESUME;

const t = (p: string) => ({ runner: "bun" as const, path: p });
const sp = quickSplit([t("wall.test.ts"), t("a.test.ts"), t("b.test.ts"), t("c.test.ts")], new Set(["bun:wall.test.ts", "bun:b.test.ts"]), [t("c.test.ts")]);
res("L025 quick selection: blocking, Wall and impacted-since tests first, the rest after", sp.first.map((x) => x.path).join() === "wall.test.ts,b.test.ts,c.test.ts" && sp.rest.map((x) => x.path).join() === "a.test.ts");
const pass = [{ name: "bun:a.test.ts", cmd: "bun test a.test.ts", result: "pass", duration_s: 0 }] as never;
res("L025 a run whose last verify was quick-only never seals VERIFIED", verdictOf({ implement: { exit: "done" } }, pass, false, true, false, true) !== "VERIFIED" && verdictOf({ implement: { exit: "done" } }, pass, false, false, false, true) === "VERIFIED");

res("L026 brief: no invitation to run the full suite", !FIXED_RULES.includes("including the package's full suite") && FIXED_RULES.includes("not the package's full suite") && FIXED_RULES.includes("medium or high"));
const nb = buildImplementBrief("task", null, []);
res("L026 brief: with no impacted tests it names targeted tests, not the full test command", !nb.includes("run the project's full test command") && nb.includes("medium or high"));
res("L026 parser: a full-suite command line counts", isSuiteRun("cd pkg && bun test", ["bun test"]) && isSuiteRun("CI=1 npx vitest run --reporter=dot 2>&1", ["npx vitest run"]));
res("L026 parser: a targeted run does not count", !isSuiteRun("bun test calc.test.ts", ["bun test"]) && !isSuiteRun("npx vitest run src/a.test.ts", ["npx vitest run"]));
process.env.LOKI_E10_SUITE_CMDS = JSON.stringify(["bun test"]);
const tool = (id: string, command: string) => ({ type: "assistant", message: { id, content: [{ type: "tool_use", id: "t" + id, name: "Bash", input: { command } }] } });
await consumeSdkStream([tool("1", "bun test"), tool("2", "bun test calc.test.ts"), tool("3", "cd . && bun test --bail"), { type: "result", subtype: "success", total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, session_id: "s" }] as never, { cwd: "$T/l026", iteration: "it1", hookEventsEnabled: false, write: () => {} });
const rc = JSON.parse(readFileSync("$T/l026/.loki/metrics/result-cost-it1.json", "utf8"));
res("L026 parser: result-cost records full_suite_runs per session (2 of 3 Bash calls)", rc.full_suite_runs === 2);
TS
out="$(cd "$ROOT/loki-ts" && bun "$T/lean-fix.ts" 2>&1)"
while IFS= read -r line; do
    case "$line" in "OK "*) ok "${line#OK }" ;; "NO "*) bad "${line#NO }" ;; esac
done <<< "$out"
printf '%s\n' "$out" | grep -q '^OK ' || { bad "lean-fix unit script produced no results"; printf '%s\n' "$out" | tail -8 | sed 's/^/    | /'; }

# ---------------------------------------------------------------- lean fix loop on the stub provider
# jest: a committed jest test of util.ts (the stub's scope edit touches util.ts, so verify selects it) whose runner, a stand-in
# npx, prints the recorded jest Validation Error on head and base alike.
mkdir -p "$T/seed-jest" "$T/fakejest"
printf 'module.exports = {};\n' > "$T/seed-jest/jest.config.js"
printf 'import { expect, test } from "@jest/globals";\nimport { VERSION } from "./util";\n\ntest("version", () => {\n  expect(VERSION).toBeGreaterThan(0);\n});\n' > "$T/seed-jest/util.jest.test.ts"
cp "$ROOT/tests/min/fixtures/failures/jest-validation.txt" "$T/fakejest/out.txt"
printf '#!/usr/bin/env bash\ncase " $* " in *" jest "*) cat "%s/out.txt"; exit 1 ;; esac\nexit 127\n' "$T/fakejest" > "$T/fakejest/npx"
chmod +x "$T/fakejest/npx"
SEED="$T/seed-jest" run_engine "$TASK" E2E_STUB_MODE=done E2E_STUB_SCOPE_EDIT=1 E2E_STUB_FIX=fixit PATH="$T/fakejest:$FIX/bin:$PATH"
n="$(fix_sessions)"
ran="$(ev '[e["data"].get("result") for e in E if e["type"]=="test.result" and "util.jest" in str(e["data"].get("name",""))]')"
has "jest Validation Error: verify ran the jest check" "$ran" "'not_run'"
[ "$n" = "0" ] && ok "jest Validation Error: harness-owned, 0 fix sessions" || { bad "jest Validation Error: $n fix sessions (want 0)"; dump; }

# twostep: round 1 fixes multiply() but adds a failing extra.test.ts, round 2 fixes that. Risk tier medium runs the full suite.
run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=twostep LOKI_RISK_TIER=medium
scopes="$(ev '[e["data"].get("verify_scope") for e in E if e["type"]=="stage.completed" and e["stage"]=="verify"]')"
suites="$(ev 'sum(1 for e in E if e["type"]=="test.result" and str(e["data"].get("name","")).startswith("full suite") and e["data"].get("result") in ("pass","fail"))')"
[ "$scopes" = "['complete', 'quick', 'complete']" ] && ok "quick verify: round 1 is re-verified quick, the last round complete" || { bad "quick verify: verify scopes $scopes"; dump; }
[ "$suites" = "2" ] && ok "quick verify: the full suite ran 2 times in a 2-round run (was 3)" || bad "quick verify: the full suite ran $suites times (want 2)"
[ "$(outcome)" = "VERIFIED" ] && ok "quick verify: the 2-round run is VERIFIED" || { bad "quick verify: outcome is '$(outcome)', not VERIFIED"; dump; }
sig="$(ev '[g["signature"] for e in E if e["type"]=="fix.round" for g in e["data"]["groups"] if g["signature"].startswith("full suite")][0]')"
case "$sig" in "full suite: bun "?*) ok "full suite signature carries its first failing line: $sig" ;; *) bad "full suite signature is only the check name: '$sig'" ;; esac

run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=noprogress LOKI_RISK_TIER=medium
last="$(ev '[e["data"] for e in E if e["type"]=="stage.completed" and e["stage"]=="verify"][-1]')"
has "quick-only end: the last verify is quick" "$last" "'verify_scope': 'quick'"
has "quick-only end: verify lists the missing complete verify as NOT PROVEN" "$last" "quick re-verify only"
[ "$(fix_sessions)" = "1" ] && ok "quick-only end: one fix round, then STALLED (the unrerun full suite still counts toward the stall)" || { bad "quick-only end: $(fix_sessions) fix sessions (want 1)"; dump; }
[ "$(outcome)" != "VERIFIED" ] && ok "quick-only end: not VERIFIED (Outcome $(outcome))" || bad "quick-only end: VERIFIED without a complete verify"

finish
