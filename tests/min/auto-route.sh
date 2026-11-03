#!/usr/bin/env bash
# The router's auto preset (LOKI_ROUTER=auto; runner/router/flag.ts routerPreset, also set by --haiku and --cost lean): Haiku is
# the executor for implement and fix, Opus plans only a hard task, the Opus advisor stays scoped to plan and fix, and every climb is
# the router's own ladder (routeEscalate on a spec conflict, routedFix on a code-owned failure, stallClimb). New file: no min test
# owned model selection per session (scope-and-fix owns read-only tests and fix-loop stopping on a fixed model).
# Asserts:
#   unit:     routerMode auto; the preset executor (Haiku, LOKI_ALLOW_HAIKU=false -> Sonnet, LOKI_ROUTER_EXECUTOR wins); the route
#             record source "preset"; hardReason from task evidence only (large, or a task naming more than 4 distinct
#             non-test files; never repo size, a truncated map included; a basename shared by many files counts once); a fix round never starts below implement's
#             model; a climb's evidence is redacted; providers.ts keeps the Haiku executor on a stage the advisor is not scoped to
#             (the no-advisor floor still raises Haiku when the router is not the preset); --model (LOKI_SESSION_MODEL) and
#             LOKI_MODEL_DEVELOPMENT are pins; an Opus executor gets no Opus advisor under the preset; the
#             kept-LOKI_ROUTER note (TS start path).
#   small:    implement on haiku, no plan session, no advisor on implement, VERIFIED; the start line names the preset and the
#             downgrade; the receipt route block records executor haiku, source preset.
#   fix:      a wrong first attempt: the fix round climbs to sonnet (routedFix) with the opus advisor attached; no opus executor.
#   conflict: Haiku answers a spec conflict on implement: one redo on sonnet (routeEscalate) delivers it; the conflict text's
#             secret never reaches events.jsonl or receipt.json; the fix round that follows a wrong sonnet redo is not on haiku.
#   hard:     a repo with 12 more source files and a one-file task: no plan session, also with the repo map truncated
#             (LOKI_E10_REPOMAP_MAX_FILES=3); index.ts named in a repo with 6 index.ts: no plan; three spelled-out
#             paths in a two-package monorepo: no plan; a task naming 6 files: the plan session
#             runs on opus, with no advisor, and the preset plan instruction.
#   already:  Haiku claims already-done with no diff: one sonnet redo (trigger already_done_claim).
#   notice:   LOKI_IMPLEMENT_HAIKU_FIRST=1 prints the deprecation note once and maps to LOKI_ROUTER=auto; --haiku with
#             LOKI_ROUTER=1 prints one line and keeps LOKI_ROUTER=1.
#   default:  without LOKI_ROUTER=auto (stray LOKI_ROUTER_EXECUTOR=haiku set) nothing is routed: no haiku, no advisor.
#   pins:     LOKI_SESSION_MODEL=sonnet wins over the preset; LOKI_ALLOW_HAIKU=false makes the executor sonnet.
#
# Planted defects used to prove this test can fail (each reverted afterwards):
#   1. flag.ts routerMode: drop the "auto" value (every preset leg fails).
#   2. unit_model.ts routeRecord: drop the preset branch (small leg: implement runs on the floor, not haiku).
#   3. providers.ts planRouterSession: drop the scope-off keep (small leg: haiku implement swapped to sonnet).
#   4. unit_model.ts routedFix: carry the last fix model only (unit: a lint-only round after a sonnet implement descends to haiku).
#   5. model_rank.ts climb: evidence not redacted (unit: the token stays in the climb evidence; the run record is also redacted downstream).
#   6. decision.ts envOverride: drop LOKI_SESSION_MODEL (pins leg: implement on haiku under --model sonnet).
#   7. plan.ts: plan every task under the preset (small leg: a plan session runs).
#   8. sizing.ts hardReason: count repo files instead of task-named files (unit, and hard leg: a one-file task gets an opus plan).
#   9. decision.ts envOverride: drop LOKI_MODEL_DEVELOPMENT (unit: devpin).
#  10. providers.ts planRouterSession: drop the opus-executor no-advisor line (unit, and hard leg: plan advisor opus).
#  11. implement_route.ts routeEscalate: never treat a no-diff already-done claim as a climb (already leg).
#  12. bin/loki: drop the LOKI_IMPLEMENT_HAIKU_FIRST mapping (notice legs).
#  13. bin/loki: drop the kept-LOKI_ROUTER line for --haiku (notice leg).
#  14. start.ts: drop the kept-LOKI_ROUTER line for --haiku (unit: tsnote).
#  15. sizing.ts hardReason: a truncated repo map counts as hard (unit: trunc; hard leg: truncated map plans).
#  16. sizing.ts namedDistinct: count matched repo paths, not names as written (unit: mono1; hard leg: monorepo index.ts plans).
#  17. sizing.ts namedDistinct: add every matched basename even when a spelled-out path has it (unit: spelled3; hard leg:
#      three spelled-out paths in a two-package monorepo plan).
#  18. sizing.ts namedDistinct: drop the optional leading "./" (unit: dot5 is null).
#  19. sizing.ts sizeTask: size "large" on namedFiles again instead of namedDistinct (unit: mono9 is large).
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
need python3
cd "$ROOT" || exit 2

echo "TEST: router auto preset (Haiku executes, Opus plans hard tasks, the router ladder climbs)"

FIX="$ROOT/tests/min/fixtures/e2e"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 120)
TOKEN="ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab"

# --- unit: the pure decisions, through the source -------------------------------------------------------------------
U="$(cd "$ROOT/loki-ts" && env -u LOKI_SESSION_MODEL -u LOKI_MODEL_OVERRIDE -u LOKI_CLAUDE_MODEL_DEVELOPMENT -u LOKI_MODEL_DEVELOPMENT -u LOKI_ROUTER_EXECUTOR -u LOKI_ALLOW_HAIKU -u LOKI_IMPLEMENT_HAIKU_FIRST -u LOKI_COST_PROFILE LOKI_ROUTER=auto \
  LOKI_DIR="$T/unit-loki" TOKEN="$TOKEN" bun -e '
import { routerMode, presetExecutor } from "./src/runner/router/flag.ts";
import { routeRecord, routedFix, routerActive } from "./src/runner/router/unit_model.ts";
import { hardReason, sizeTask } from "./src/engine10/sizing.ts";
import { climb } from "./src/runner/model_rank.ts";
import { planRouterSession } from "./src/runner/providers.ts";
import { routerKeptNote } from "./src/util/cost_profile.ts";
import { parseStartArgs } from "./src/commands/start.ts";
const files = (n) => ({ files: Array.from({ length: n }, (_, i) => `src/f${i}.ts`).concat(["tests/a.test.ts", "b_test.go"]), entries: [], truncated: false });
const out = [];
out.push(`mode=${routerMode({ LOKI_ROUTER: "auto" })}`, `exec=${presetExecutor({}).model}`, `nohaiku=${presetExecutor({ LOKI_ALLOW_HAIKU: "false" }).model}`, `fixed=${presetExecutor({ LOKI_ROUTER_EXECUTOR: "sonnet" }).model}`);
const rr = routeRecord("claude (provider default)", undefined); out.push(`record=${rr.source}:${rr.model}:${rr.valid}`);
const named = (n) => "change " + Array.from({ length: n }, (_, i) => `f${i}.ts`).join(", ") + " and a.test.ts";
out.push(`hard:bigrepo=${hardReason("normal", files(50), "fix the add function")}`, `hard:names4=${hardReason("normal", files(12), named(4))}`, `hard:names5=${hardReason("normal", files(12), named(5)) !== null}`, `hard:large=${hardReason("large", files(1), "x")}`, `hard:trunc=${hardReason("small", { ...files(1), truncated: true }, "fix the add function")}`);
const mono = { files: Array.from({ length: 6 }, (_, i) => `pkg${i}/index.ts`), entries: [], truncated: false };
const pk = { files: ["web", "api"].flatMap((p) => ["index", "utils", "types"].map((n) => `packages/${p}/src/${n}.ts`)), entries: [], truncated: false };
out.push(`hard:spelled3=${hardReason("normal", pk, "Fix the date bug in packages/web/src/index.ts, packages/web/src/utils.ts and packages/web/src/types.ts")}`, `hard:suffix=${hardReason("normal", { files: ["src/index.ts", "packages/a/src/index.ts", "a/x.ts", "b/x.ts", "c/x.ts", "d/x.ts"], entries: [], truncated: false }, "Fix src/index.ts")}`);
out.push(`hard:mono1=${hardReason("normal", mono, "fix the export in index.ts")}`, `hard:mono5=${hardReason("normal", mono, "fix pkg0/index.ts, pkg1/index.ts, pkg2/index.ts, pkg3/index.ts and pkg4/index.ts") !== null}`);
out.push(`hard:dot5=${hardReason("normal", mono, "fix ./pkg0/index.ts, ./pkg1/index.ts, ./pkg2/index.ts, ./pkg3/index.ts and ./pkg4/index.ts") !== null}`, `hard:updir5=${hardReason("normal", mono, "fix ../pkg0/index.ts, ../pkg1/index.ts, ../pkg2/index.ts, ../pkg3/index.ts and ../pkg4/index.ts")}`);
const mono9 = { files: Array.from({ length: 9 }, (_, i) => `pkg${i}/index.ts`), entries: [], truncated: false }, bunTests = { runners: ["bun"], tests: [] };
out.push(`size:mono9=${sizeTask("fix the export in index.ts", mono9, bunTests).size}`, `size:spelled9=${sizeTask("fix " + mono9.files.map((f) => "./" + f).join(", "), mono9, bunTests).size}`);
const lint = [{ signature: "lint:eslint" }];
const f = routedFix("claude (provider default)", { implement: { route_model: "claude-sonnet-5-5" }, fix: { model: "claude-haiku-5-5" } }, { repeated: false, stall: false, groups: lint, reason: "lint" });
out.push(`nodescend=${f.pin}`);
const g = routedFix("claude (provider default)", { implement: { route_model: "claude-haiku-5-5" } }, { repeated: false, stall: false, groups: [{ signature: "bun:calc.test.ts" }], reason: "x" });
out.push(`climb1=${g.pin}`);
out.push(`redact=${climb("run", "claude-haiku-5-5", "spec_conflict", `token ${process.env.TOKEN} here`).evidence.includes(process.env.TOKEN)}`);
const keep = planRouterSession({ model: "claude-haiku-5-5", runDir: "/nonexistent", claudeCodeVersion: "2.1.316", env: { LOKI_ROUTER: "auto", LOKI_ADVISOR_SCOPE: "off" } });
const fix = planRouterSession({ model: "claude-sonnet-5-5", runDir: "/nonexistent", claudeCodeVersion: "2.1.316", env: { LOKI_ROUTER: "auto" } });
const r1 = planRouterSession({ model: "claude-haiku-5-5", runDir: "/nonexistent", claudeCodeVersion: "2.1.316", env: { LOKI_ROUTER: "1", LOKI_ADVISOR_SCOPE: "off" } });
out.push(`scopeoff=${JSON.stringify(keep)}`, `fixadv=${fix?.settings?.advisorModel}`, `router1floor=${r1?.model}`);
out.push(`pin=${routerActive({ LOKI_ROUTER: "auto", LOKI_SESSION_MODEL: "sonnet" })}`, `devpin=${routerActive({ LOKI_ROUTER: "auto", LOKI_MODEL_DEVELOPMENT: "sonnet" })}`);
out.push(`opusadv=${JSON.stringify(planRouterSession({ model: "claude-opus-5-5", runDir: "/nonexistent", claudeCodeVersion: "2.1.316", env: { LOKI_ROUTER: "auto" } }))}`, `opusadv1=${planRouterSession({ model: "claude-opus-5-5", runDir: "/nonexistent", claudeCodeVersion: "2.1.316", env: { LOKI_ROUTER: "1" } })?.settings?.advisorModel}`);
out.push(`adc=${climb("run", "claude-haiku-5-5", "already_done_claim", "x")?.to}`);
out.push(`kept=${routerKeptNote("--haiku", { LOKI_ROUTER: "1" }) !== ""}:${routerKeptNote("--haiku", { LOKI_ROUTER: "auto" })}:${routerKeptNote("--haiku", {})}`);
const errs = []; const pe = {}; const saved = process.env.LOKI_ROUTER; process.env.LOKI_ROUTER = "1";
parseStartArgs(["--haiku", "--cost", "lean", "task"], (x) => errs.push(x), () => {}, (k, v) => { pe[k] = v; }); process.env.LOKI_ROUTER = saved;
out.push(`tsnote=${errs.filter((e) => e.includes("is already set and wins")).length}:${pe.LOKI_ROUTER ?? "unset"}`);
console.log(out.join(" "));
' 2>&1)"
want="mode=auto exec=haiku nohaiku=sonnet fixed=sonnet record=preset:claude-haiku-5-5:true hard:bigrepo=null hard:names4=null hard:names5=true hard:large=task sized large hard:trunc=null hard:spelled3=null hard:suffix=null hard:mono1=null hard:mono5=true hard:dot5=true hard:updir5=null size:mono9=normal size:spelled9=large nodescend=claude-sonnet-5-5 climb1=claude-sonnet-5-5 redact=false scopeoff=null fixadv=opus router1floor=sonnet pin=false devpin=false opusadv=null opusadv1=opus adc=claude-sonnet-5-5 kept=true:: tsnote=1:unset"
[ "$U" = "$want" ] && ok "unit: preset executor and record, hardReason on task evidence only, never descend, redacted climb evidence, scoped advisor keeps the executor, --model and LOKI_MODEL_DEVELOPMENT pin, no opus advisor on an opus executor, an already-done claim climbs, the kept-router note" || bad "unit gave: $U"

# --- e2e on the stub provider ---------------------------------------------------------------------------------------
# run_engine <task> <env...> -> REPO, OUT, RUNDIR, ROUTES ("<stage> <iteration> model=<m> advisor=<a> wall=<0|1>" per session)
run_engine() {
    local task="$1" d rid; shift
    d="$(mktemp -d "$T/run.XXXXXX")"
    REPO="$d/repo"; ROUTES="$d/routes.log"; : > "$ROUTES"
    cp -R "$FIX/repo" "$REPO"
    [ -n "${PKG_REPO:-}" ] && for p in web api; do mkdir -p "$REPO/packages/$p/src"; for n in index utils types; do printf 'export const %s = 1;\n' "$n" > "$REPO/packages/$p/src/$n.ts"; done; done
    [ -n "${MONO_REPO:-}" ] && for i in 1 2 3 4 5 6; do mkdir -p "$REPO/pkg$i"; printf 'export const v = %s;\n' "$i" > "$REPO/pkg$i/index.ts"; done
    [ -n "${HARD_REPO:-}" ] && { mkdir -p "$REPO/lib"; for i in $(seq 1 12); do printf 'export const v%s = %s;\n' "$i" "$i" > "$REPO/lib/m$i.ts"; done; }
    git -C "$REPO" init -q -b main
    git -C "$REPO" config user.name e2e
    git -C "$REPO" config user.email e2e@example.invalid
    git -C "$REPO" add -- .
    git -C "$REPO" commit -q -m base
    OUT="$(cd "$REPO" && env -u LOKI_IMPLEMENT_HAIKU_FIRST -u LOKI_ALLOW_AGENT_GITHUB_TOKEN -u LOKI_MODEL_OVERRIDE -u LOKI_SESSION_MODEL -u LOKI_ROUTER_EXECUTOR -u LOKI_ALLOW_HAIKU -u LOKI_RECEIPT_SIGNING_KEY \
        LOKI_ROUTER=auto LOKI_E10_INVOKER=cli LOKI_CLAUDE_CLI="$FIX/bin/claude" PATH="$FIX/bin:$PATH" LOKI_NO_COMPLETIONS=1 \
        E2E_STUB_ROUTE_LOG="$ROUTES" E2E_STUB_PROMPT_LOG="$d/prompt" LOKI_RECEIPT_SIGNING_KEY_FILE="$d/k.pem" \
        "$@" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" "$task" --no-pr ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} 2>&1)"
    RUNDIR=""
    if [ -f "$REPO/.loki/engine.json" ]; then
        rid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
        [ -n "$rid" ] && RUNDIR="$REPO/.loki/runs/$rid"
    fi
}
outcome() { printf '%s\n' "$OUT" | sed -n 's/^Outcome:[[:space:]]*\([A-Z_]*\).*/\1/p' | head -1; }
dump() { printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; sed 's/^/    route | /' "$ROUTES"; }
fam() { sed 's/^claude-\([a-z]*\)-.*/\1/'; }
model_of() { awk -v s="$1" '$1 == s { sub(/^model=/, "", $3); print $3 }' "$ROUTES" | fam | tr '\n' ' ' | sed 's/ $//'; } # models of one engine stage, in order
adv_of() { awk -v s="$1" '$1 == s { sub(/^advisor=/, "", $4); print $4 }' "$ROUTES" | tr '\n' ' ' | sed 's/ $//'; }
route_block() { [ -n "$RUNDIR" ] && python3 -I -c 'import json,sys
r=json.load(open(sys.argv[1])).get("route")
print("none" if r is None else str(r.get("executor")) + "|" + str(r.get("source")))' "$RUNDIR/receipt.json" 2>/dev/null; }
TASK="add a multiply(a, b) function to calc.ts"

run_engine "$TASK" E2E_STUB_MODE=done
[ "$(model_of implement)" = "haiku" ] && ok "small: implement ran on haiku" || { bad "small: implement on '$(model_of implement)'"; dump; }
[ -z "$(model_of plan)" ] && ok "small: no plan session (the task is not hard)" || { bad "small: a plan session ran"; dump; }
[ "$(adv_of implement)" = "none" ] && ok "small: implement carried no advisor" || bad "small: implement advisor '$(adv_of implement)'"
[ "$(outcome)" = "VERIFIED" ] && ok "small: run is VERIFIED" || { bad "small: outcome '$(outcome)'"; dump; }
has "small: the start line names the auto preset" "$OUT" "route: auto preset"
has "small: the start line names the haiku downgrade" "$OUT" "implement,fix claude-haiku-5-5 (LOKI_ROUTER=auto preset"
case "$(route_block)" in *haiku*"|preset") ok "small: the receipt route block records executor haiku, source preset" ;; *) bad "small: route block is '$(route_block)'" ;; esac

run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=fixit
[ "$(model_of fix)" = "sonnet" ] && ok "fix: the code-owned failure climbed the fix round to sonnet" || { bad "fix: fix on '$(model_of fix)'"; dump; }
[ "$(adv_of fix)" = "opus" ] && ok "fix: the fix round carried the opus advisor" || bad "fix: fix advisor '$(adv_of fix)'"
grep -q 'model=[^ ]*opus' "$ROUTES" && bad "fix: an opus executor ran on a small task" || ok "fix: no opus executor on a small task"
[ "$(outcome)" = "VERIFIED" ] && ok "fix: run is VERIFIED" || { bad "fix: outcome '$(outcome)'"; dump; }

run_engine "$TASK" E2E_STUB_MODE=done E2E_STUB_IMPL_CONFLICT="cannot meet it, see $TOKEN"
[ "$(model_of implement)" = "haiku sonnet" ] && ok "conflict: Haiku's spec conflict got one sonnet redo" || { bad "conflict: implement models '$(model_of implement)'"; dump; }
[ "$(outcome)" = "VERIFIED" ] && ok "conflict: the sonnet redo delivered (VERIFIED, not BLOCKED)" || { bad "conflict: outcome '$(outcome)'"; dump; }
! grep -q "$TOKEN" "$RUNDIR/events.jsonl" "$RUNDIR/receipt.json" 2>/dev/null && ok "conflict: the secret in the conflict text is in neither events.jsonl nor receipt.json" || bad "conflict: the raw token leaked into the run record"
run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=fixit E2E_STUB_IMPL_CONFLICT="cannot meet it"
case "$(model_of fix)" in ""|*haiku*) bad "conflict: the fix after a sonnet redo ran '$(model_of fix)'"; dump ;; *) ok "conflict: the fix after a sonnet redo never descends to haiku ($(model_of fix))" ;; esac

HARD_REPO=1 run_engine "$TASK" E2E_STUB_MODE=done
[ -z "$(model_of plan)" ] && ok "hard: a large repo alone gets no plan session (repo size is not task evidence)" || { bad "hard: plan on '$(model_of plan)' for a one-file task"; dump; }
HARD_REPO=1 run_engine "$TASK" E2E_STUB_MODE=done LOKI_E10_REPOMAP_MAX_FILES=3
[ -z "$(model_of plan)" ] && ok "hard: a truncated repo map alone gets no plan session (truncation is repo size)" || { bad "hard: plan on '$(model_of plan)' with a truncated map and a one-file task"; dump; }
MONO_REPO=1 run_engine "add a multiply(a, b) function to calc.ts and export it from index.ts" E2E_STUB_MODE=done
[ -z "$(model_of plan)" ] && ok "hard: a basename six repo files share counts once (no plan session)" || { bad "hard: plan on '$(model_of plan)' for a task naming index.ts in a monorepo"; dump; }
PKG_REPO=1 run_engine "Fix the date bug in packages/web/src/index.ts, packages/web/src/utils.ts and packages/web/src/types.ts" E2E_STUB_MODE=done
[ -z "$(model_of plan)" ] && ok "hard: three spelled-out paths in a two-package monorepo count three (no plan session)" || { bad "hard: plan on '$(model_of plan)' for a three-file task in a two-package monorepo"; dump; }
HARD_REPO=1 run_engine "add a multiply(a, b) function to calc.ts and re-export it from m1.ts, m2.ts, m3.ts, m4.ts and m5.ts" E2E_STUB_MODE=done
[ "$(model_of plan)" = "opus" ] && ok "hard: opus planned a task naming 6 files" || { bad "hard: plan on '$(model_of plan)'"; dump; }
[ "$(adv_of plan)" = "none" ] && ok "hard: the opus plan carried no opus advisor" || bad "hard: plan advisor '$(adv_of plan)'"
has "hard: the plan brief asks for files, pitfalls and the proving test" "$(cat "$(dirname "$ROUTES")"/prompt.plan* 2>/dev/null)" "the pitfalls"
[ "$(model_of implement)" = "haiku" ] && ok "hard: haiku implemented the plan" || bad "hard: implement on '$(model_of implement)'"

run_engine "$TASK" E2E_STUB_MODE=already
[ "$(model_of implement)" = "haiku sonnet" ] && ok "already: Haiku's no-diff already-done claim got one sonnet redo" || { bad "already: implement models '$(model_of implement)'"; dump; }
grep -q '"already_done_claim"' "$RUNDIR/events.jsonl" 2>/dev/null && ok "already: the climb is recorded as already_done_claim" || bad "already: no already_done_claim climb in events.jsonl"

run_engine "$TASK" E2E_STUB_MODE=done LOKI_ROUTER= LOKI_IMPLEMENT_HAIKU_FIRST=1
has "notice: LOKI_IMPLEMENT_HAIKU_FIRST prints the deprecation note" "$OUT" "Note: 'LOKI_IMPLEMENT_HAIKU_FIRST' is deprecated"
[ "$(model_of implement)" = "haiku" ] && ok "notice: LOKI_IMPLEMENT_HAIKU_FIRST maps to LOKI_ROUTER=auto (implement on haiku)" || { bad "notice: implement on '$(model_of implement)'"; dump; }
[ "$(printf '%s\n' "$OUT" | grep -c "LOKI_IMPLEMENT_HAIKU_FIRST' is deprecated")" = 1 ] && ok "notice: the deprecation note prints once" || bad "notice: the deprecation note count is not 1"
EXTRA_ARGS=(--haiku); run_engine "$TASK" E2E_STUB_MODE=done LOKI_ROUTER=1; EXTRA_ARGS=()
[ "$(printf '%s\n' "$OUT" | grep -c -- "--haiku: LOKI_ROUTER=1 is already set and wins")" = 1 ] && ok "notice: --haiku with LOKI_ROUTER=1 prints one line and the explicit value wins" || { bad "notice: no single kept-router line"; dump; }
case "$OUT" in *"route: auto preset"*) bad "notice: --haiku overrode LOKI_ROUTER=1" ;; *) ok "notice: --haiku did not override LOKI_ROUTER=1" ;; esac

run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=fixit LOKI_ROUTER= LOKI_ROUTER_EXECUTOR=haiku
grep -q 'model=[^ ]*haiku' "$ROUTES" && bad "default: a session ran on haiku without the preset" || ok "default: without LOKI_ROUTER=auto no session runs on haiku"
grep -q 'advisor=opus' "$ROUTES" && bad "default: an advisor was attached without the router" || ok "default: no advisor without the router"
case "$OUT" in *"route: auto preset"*) bad "default: the start line names the preset" ;; *) ok "default: the start line names no route" ;; esac

run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=fixit LOKI_SESSION_MODEL=sonnet
[ "$(model_of implement)" = "sonnet" ] && [ "$(model_of fix)" = "sonnet" ] && ok "pins: --model sonnet wins over the preset" || { bad "pins: implement '$(model_of implement)', fix '$(model_of fix)'"; dump; }
run_engine "$TASK" E2E_STUB_MODE=done LOKI_ALLOW_HAIKU=false
[ "$(model_of implement)" = "sonnet" ] && ok "pins: LOKI_ALLOW_HAIKU=false makes the preset executor sonnet" || { bad "pins: implement '$(model_of implement)'"; dump; }

finish
