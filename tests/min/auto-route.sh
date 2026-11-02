#!/usr/bin/env bash
# Auto routing (loki-ts/src/runner/router/auto_route.ts), opt-in with LOKI_AUTO_ROUTE=1 when no model is pinned: Haiku executes, the platform
# advisor tool is attached only to the plan of a large task (or a normal task in a big repo) and to the first fix round, and
# the executor climbs to Sonnet only after two failed Haiku rounds on a code-owned failure. New file: no min test owned model
# selection per session (scope-and-fix owns read-only tests and fix-loop stopping on a fixed model).
# Asserts:
#   unit:      decisions per size and per fix round; off reasons (not opted in, pin, LOKI_ROUTER=1); resolveModel is
#              Haiku with no pin; a stage pin above Haiku is capped unless auto routing granted it; providers.ts attaches the
#              advisor (with the 100K compact window on Haiku) only when the session asked for it.
#   small:     a small task: every session on haiku, no advisor anywhere, VERIFIED, receipt.routing lists the decisions and
#              one model per session, the start line names the route.
#   fix:       a wrong first attempt: fix 1 runs on haiku with the opus advisor attached, no Opus session runs, VERIFIED.
#   climb:     a stalled Haiku fix round climbs once to sonnet (no advisor on it); then STALLED. No session ever carries
#              the advisor more than the cap (2 per run), never implement or the Wall.
#   conflict:  Haiku answers a spec conflict on implement and again after its one correction: one Sonnet implement session
#              runs and delivers (VERIFIED), instead of a BLOCKED run.
#   big repo:  a normal task in a 1600-file repo: the plan session runs on haiku with the advisor attached.
#   default:   without LOKI_AUTO_ROUTE=1 no route is recorded and no --model haiku is forced.
#   pin:       LOKI_SESSION_MODEL=sonnet (opted in): every session on sonnet, no advisor, no auto route event, no receipt.routing.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. auto_route.ts autoFixDecision: drop the `round >= 2 || stallPending` climb (climb leg: fix 2 stays on haiku).
#   2. auto_route.ts autoRouteOffReason: ignore LOKI_SESSION_MODEL (pin leg and unit fail).
#   3. model_rank.ts capToSessionPin: ignore the grant (climb leg: fix 2 is capped to haiku).
#   4. session.ts childEnv: drop autoChildEnv (fix leg: no advisor on fix 1).
#   5. auto_route.ts autoPlanDecision: never fire for a big repo (big repo leg and unit fail).
#   6. implement.ts: drop the autoConflictClimb call (conflict leg ends BLOCKED).
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
need python3
cd "$ROOT" || exit 2

echo "TEST: auto routing (Haiku executes, advisor and climb only where they pay)"

FIX="$ROOT/tests/min/fixtures/e2e"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 120)

# --- unit: the pure decisions, through the source -------------------------------------------------------------------
U="$(cd "$ROOT/loki-ts" && env -u LOKI_SESSION_MODEL -u LOKI_MODEL_OVERRIDE -u LOKI_CLAUDE_MODEL_DEVELOPMENT -u LOKI_MODEL_DEVELOPMENT -u LOKI_ROUTER -u LOKI_AUTO_ADVISOR LOKI_AUTO_ROUTE=1 \
  bun -e '
import { autoRouteOffReason, autoPlanDecision, autoFixDecision, autoStallClimb } from "./src/runner/router/auto_route.ts";
import { resolveModel } from "./src/engine10/session.ts";
import { capToSessionPin } from "./src/runner/model_rank.ts";
import { planRouterSession } from "./src/runner/providers.ts";
const files = (n) => ({ files: Array.from({ length: n }, (_, i) => `f${i}.ts`), truncated: false });
const out = [];
const A = { LOKI_AUTO_ROUTE: "1" };
out.push(`off=${autoRouteOffReason(A)}`, `pin=${autoRouteOffReason({ ...A, LOKI_SESSION_MODEL: "sonnet" })}`, `default=${autoRouteOffReason({}) !== null}`, `router=${autoRouteOffReason({ ...A, LOKI_ROUTER: "1" })}`, `codex=${autoRouteOffReason(A, "codex")}`);
for (const [sz, n] of [["small", 10], ["normal", 10], ["normal", 1600], ["large", 10]]) { const d = autoPlanDecision(sz, files(n), {}); out.push(`plan:${sz}:${n}=${d.fire}:${d.advisor ?? "none"}`); }
out.push(`plan:large:advisor-off=${autoPlanDecision("large", files(10), { LOKI_AUTO_ADVISOR: "off" }).fire}`);
for (const [r, c, st] of [[1, 1, false], [1, 0, false], [2, 1, false], [1, 1, true]]) { const d = autoFixDecision(r, c, st, {}); out.push(`fix:${r}:${c}:${st}=${d.model.replace(/^claude-|-5-5$/g, "")}:${d.advise ? d.advisor : "none"}`); }
const g = { verify: { failures_grouped: [{ signature: "bun:calc.test.ts" }] } };
out.push(`stall:haiku=${autoStallClimb({ ...g, fix: { model: "claude-haiku-5-5" } }, "x")?.to}`, `stall:sonnet=${autoStallClimb({ ...g, fix: { model: "claude-sonnet-5-5" } }, "x")}`, `stall:lint=${autoStallClimb({ verify: { failures_grouped: [{ signature: "lint:eslint" }] }, fix: { model: "claude-haiku-5-5" } }, "x")}`);
out.push(`resolve=${resolveModel("claude")}`, `cap=${capToSessionPin("claude-opus-5-5")}`, `grant=${capToSessionPin("claude-sonnet-5-5", process.env, "fix-climb")}`);
const p = planRouterSession({ model: "claude-haiku-5-5", runDir: "/nonexistent", claudeCodeVersion: "2.1.316", env: { LOKI_AUTO_ADVISOR_MODEL: "opus" } });
out.push(`adv=${JSON.stringify(p?.settings ?? null)}`, `noadv=${JSON.stringify(planRouterSession({ model: "claude-haiku-5-5", runDir: "/nonexistent", claudeCodeVersion: "2.1.316", env: {} }))}`);
console.log(out.join(" "));
' 2>&1)"
want="off=null pin=LOKI_SESSION_MODEL pin default=true router=LOKI_ROUTER=1 codex=provider codex plan:small:10=false:none plan:normal:10=false:none plan:normal:1600=true:opus plan:large:10=true:opus plan:large:advisor-off=false fix:1:1:false=haiku:opus fix:1:0:false=haiku:none fix:2:1:false=sonnet:none fix:1:1:true=sonnet:none stall:haiku=claude-sonnet-5-5 stall:sonnet=null stall:lint=null resolve=claude-haiku-5-5 cap=claude-haiku-5-5 grant=claude-sonnet-5-5 adv={\"advisorModel\":\"opus\",\"autoCompactWindow\":100000} noadv=null"
[ "$U" = "$want" ] && ok "unit: auto decisions per size and fix round, off reasons, Haiku run model, capped stage pins, advisor only when asked" || bad "unit gave: $U"

# --- e2e on the stub provider ---------------------------------------------------------------------------------------
# run_engine <task> <env...> -> REPO, OUT, RUNDIR, ROUTES ("<stage> <iteration> model=<m> advisor=<a> wall=<0|1>" per session)
run_engine() {
    local task="$1" d rid; shift
    d="$(mktemp -d "$T/run.XXXXXX")"
    REPO="$d/repo"; ROUTES="$d/routes.log"; : > "$ROUTES"
    cp -R "$FIX/repo" "$REPO"
    [ -n "${BIG_REPO:-}" ] && { mkdir -p "$REPO/pad"; for i in $(seq 1 1600); do printf 'export const v%s = %s;\n' "$i" "$i" > "$REPO/pad/m$i.ts"; done; }
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name e2e
    git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add -- .
    git -C "$REPO" commit -q -m base
    OUT="$(cd "$REPO" && env -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_SESSION_MODEL -u LOKI_ROUTER -u LOKI_RECEIPT_SIGNING_KEY \
        LOKI_AUTO_ROUTE=1 LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" LOKI_NO_COMPLETIONS=1 \
        E2E_STUB_ROUTE_LOG="$ROUTES" LOKI_RECEIPT_SIGNING_KEY_FILE="$d/k.pem" \
        "$@" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$task" --no-pr 2>&1)"
    RUNDIR=""
    if [ -f "$REPO/.loki/engine.json" ]; then
        rid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
        [ -n "$rid" ] && RUNDIR="$REPO/.loki/runs/$rid"
    fi
}
outcome() { printf '%s\n' "$OUT" | sed -n 's/^Outcome:[[:space:]]*\([A-Z_]*\).*/\1/p' | head -1; }
dump() { printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; sed 's/^/    route | /' "$ROUTES"; }
# models: the distinct --model values; advised: "<stage>" per session that carried the advisor
models() { sed -n 's/.* model=\([^ ]*\) .*/\1/p' "$ROUTES" | sed 's/^claude-\([a-z]*\)-.*/\1/' | sort -u | tr '\n' ' ' | sed 's/ $//'; }
advised() { awk '$4 != "advisor=none" { print $1 ($5 == "wall=1" ? "(wall)" : "") }' "$ROUTES" | tr '\n' ' ' | sed 's/ $//'; }
receipt() { [ -n "$RUNDIR" ] && python3 -I -c 'import json,sys
r=json.load(open(sys.argv[1])).get("routing")
print("none" if r is None else ",".join(d["decision"] for d in r["decisions"]) + "|" + str(len(r["sessions"])) + "|" + ",".join(sorted({s["model"] for s in r["sessions"]})))' "$RUNDIR/receipt.json" 2>/dev/null; }
TASK="add a multiply(a, b) function to calc.ts"

run_engine "$TASK" E2E_STUB_MODE=done
[ "$(models)" = "haiku" ] && ok "small: every session ran on haiku" || { bad "small: models were '$(models)'"; dump; }
[ -z "$(advised)" ] && ok "small: no session carried the advisor" || bad "small: advisor on: $(advised)"
[ "$(outcome)" = "VERIFIED" ] && ok "small: run is VERIFIED" || { bad "small: outcome '$(outcome)'"; dump; }
R="$(receipt)"
case "$R" in *implement-executor*\|*haiku*) ok "small: receipt.routing records the implement decision and the sessions ($R)" ;; *) bad "small: receipt.routing is '$R'" ;; esac
has "small: the start line names the auto route" "$OUT" "route: auto (Haiku executes"

run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=fixit
[ "$(advised)" = "fix" ] && ok "fix: only fix round 1 carried the advisor" || { bad "fix: advisor on '$(advised)' (want fix)"; dump; }
grep -q '^fix .*-fix1 model=[^ ]*haiku[^ ]* advisor=opus' "$ROUTES" && ok "fix: fix 1 ran on haiku with the opus advisor" || { bad "fix: fix 1 route wrong"; dump; }
grep -q 'model=opus\|model=claude-opus' "$ROUTES" && bad "fix: an Opus session ran on a small task" || ok "fix: no Opus session on a small task"
[ "$(outcome)" = "VERIFIED" ] && ok "fix: run is VERIFIED after the advised Haiku round" || { bad "fix: outcome '$(outcome)'"; dump; }
case "$(receipt)" in *implement-executor,fix-advisor\|*) ok "fix: receipt.routing records fix-advisor with its reason" ;; *) bad "fix: receipt.routing is '$(receipt)'" ;; esac

run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=noprogress
grep -q '^fix .*-fix1 model=[^ ]*haiku[^ ]* advisor=opus' "$ROUTES" && ok "climb: fix 1 on haiku with the advisor" || { bad "climb: fix 1 route wrong"; dump; }
grep -q '^fix .*-fix2 model=[^ ]*sonnet[^ ]* advisor=none' "$ROUTES" && ok "climb: fix 2 climbed to sonnet, no advisor" || { bad "climb: fix 2 route wrong"; dump; }
[ "$(grep -c '^fix ' "$ROUTES")" = "2" ] && ok "climb: two fix sessions, then stop" || { bad "climb: $(grep -c '^fix ' "$ROUTES") fix sessions"; dump; }
[ "$(outcome)" = "STALLED" ] && ok "climb: run ends STALLED after the Sonnet round" || bad "climb: outcome '$(outcome)'"
n="$(awk '$4 != "advisor=none"' "$ROUTES" | wc -l | tr -d ' ')"
[ "$n" -le 2 ] && ! grep -q '^implement .*advisor=opus\|wall=1.*' <(awk '$4 != "advisor=none"' "$ROUTES") && ok "climb: the advisor stays within its cap ($n of at most 2 sessions, never implement or the Wall)" || bad "climb: advisor on $n sessions: $(advised)"

run_engine "$TASK" E2E_STUB_MODE=done E2E_STUB_IMPL_CONFLICT="the 2 s limit cannot be met"
grep -q '^implement .*-climb model=[^ ]*sonnet' "$ROUTES" && ok "conflict: a spec conflict Haiku repeated gets one Sonnet implement session" || { bad "conflict: no Sonnet implement climb"; dump; }
[ "$(grep -c '^implement ' "$ROUTES")" = "3" ] && ok "conflict: Haiku, its one correction, then Sonnet (3 implement sessions)" || { bad "conflict: $(grep -c '^implement ' "$ROUTES") implement sessions"; dump; }
[ "$(outcome)" = "VERIFIED" ] && ok "conflict: the Sonnet session delivered (VERIFIED, not BLOCKED)" || { bad "conflict: outcome '$(outcome)'"; dump; }

LONG="$TASK. Background: the calculator module is used by the billing service and the reporting service, both of which need integer multiplication with the same semantics as add(): plain numbers in, a plain number out, no rounding, no overflow checks, no currency handling. Keep the existing add() untouched, export the new function next to it, keep the module free of new imports, and do not rename or move calc.ts, because both services import it by path. The new function must accept negative numbers and zero, and its behaviour must be covered by the existing test file conventions used for add()."
BIG_REPO=1 run_engine "$LONG" E2E_STUB_MODE=done LOKI_E10_WALL=0
grep -q '^plan .* model=[^ ]*haiku[^ ]* advisor=opus' "$ROUTES" && ok "big repo: the plan session ran on haiku with the advisor attached" || { bad "big repo: plan route wrong"; dump; }
case "$(receipt)" in plan-advisor,*) ok "big repo: receipt.routing records plan-advisor" ;; *) bad "big repo: receipt.routing is '$(receipt)'" ;; esac

run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=fixit LOKI_AUTO_ROUTE=
[ "$(receipt)" = "none" ] && [ ! -f "$RUNDIR/auto-route.jsonl" ] && ok "default: without LOKI_AUTO_ROUTE=1 nothing is auto-routed" || bad "default: receipt.routing is '$(receipt)'"
grep -q 'model=[^ ]*haiku' "$ROUTES" && bad "default: a session was forced onto haiku" || ok "default: no session forced onto haiku"
[ -z "$(advised)" ] && ok "default: no advisor attached" || bad "default: advisor on $(advised)"

run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=noprogress LOKI_SESSION_MODEL=sonnet
[ "$(models)" = "sonnet" ] && ok "pin: every session ran on the pinned sonnet" || { bad "pin: models were '$(models)'"; dump; }
[ -z "$(advised)" ] && ok "pin: no advisor attached" || bad "pin: advisor on $(advised)"
[ "$(receipt)" = "none" ] && [ ! -f "$RUNDIR/auto-route.jsonl" ] && ok "pin: no auto routing record" || bad "pin: receipt.routing is '$(receipt)'"
case "$OUT" in *"route: auto"*) bad "pin: the start line still names the auto route" ;; *) ok "pin: the start line names no auto route" ;; esac

finish
