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
#   auth:     an engine10 SDK session carries the user's credential helper and auth or proxy env from ~/.claude/settings.json (project-only sources).
#   default:  without LOKI_ROUTER=auto (stray LOKI_ROUTER_EXECUTOR=haiku set) nothing is routed: no haiku, no advisor.
#   pins:     LOKI_SESSION_MODEL=sonnet wins over the preset; LOKI_ALLOW_HAIKU=false makes the executor sonnet.
#   wall:     the Wall author runs on the preset executor (sizing.ts wallModel): haiku under the preset (also for a large task and
#             for the sequential Wall's re-author rung); the already-done confirmation stays on the judge tier (wallPinModel: sonnet
#             under the preset, LOKI_E10_WALL_TIER wins) and the cascade model stays sonnet; sonnet without the preset, with LOKI_ALLOW_HAIKU=false, with an explicit
#             LOKI_E10_WALL_TIER and with a model pin (LOKI_MODEL_OVERRIDE, LOKI_SESSION_MODEL); the start line names the reason;
#             e2e: a forced Wall session runs on haiku, its Wall conflict is refereed on sonnet, and on sonnet under LOKI_E10_WALL_TIER=sonnet.
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
#  17. sizing.ts wallModel: drop the preset branch (unit: wall:*; wall leg: the Wall author runs on sonnet).
#  18. sizing.ts wallModel: drop the envOverride check (unit: wall:sesspin, wall:override give haiku).
#  19. conflict_resume.ts refereeModel: wallModel() instead of wallPinModel() (wall leg: the referee runs on haiku).
#  20. already_done.ts: confirm on wallModel() instead of wallPinModel() (unit: ad:preset gives haiku).
#  21. sizing.ts namedDistinct: add every matched basename even when a spelled-out path has it (unit: spelled3; hard leg:
#      three spelled-out paths in a two-package monorepo plan).
#  22. sizing.ts namedDistinct: drop the optional leading "./" (unit: dot5 is null).
#  23. sizing.ts sizeTask: size "large" on namedFiles again instead of namedDistinct (unit: mono9 is large).
#  24. providers.ts claudeProvider: drop the compactWindowSettings merge (small leg: the haiku implement with no
#      advisor carries no window). 25. buildSdkLoopOptions: drop it (unit: sdkwin). 26. compactWindowSettings:
#      give Sonnet the window (unit: win, and the fix leg's sonnet round).
#  26b. providers.ts: drop the `title` option from the SDK query (or engine10SessionTitle): unit sdktitle fails (last field false).
#  27. implement.ts: drop `routerRedid ||` from challenge() (already leg: implement models read 'haiku sonnet sonnet').
#  28. implement_route.ts routeEscalate: run the claim redo with `first` unchanged (already leg: the redo brief has no challenge).
#  29. implement.ts: pass `false` for resumeAfterEmptyDone's challenge (already leg: the empty-done correction after the redo has no challenge).
#  30. providers.ts buildSdkLoopOptions: drop the userAuthSettings block (user-settings auth leg: engine=project;none;noplugins;{}).
# ROLE-MODELS (--plan-model ... --models, util/claude_model.ts): no role set keeps every per-call default and the start header (unit none= leg; the
#   roles-unset e2e legs); a role moves only its own calls, exact (never capped, climbed or downgraded); the legacy engine refuses role flags.
#   Mutations, each run and killed:
#  31. session.ts withRoleModel: return opts unchanged (mixed, plan-only and dev-pin legs).
#  32. providers.ts claudeModelFor: drop the LOKI_E10_ROLE_MODEL return (override leg: plan haiku under LOKI_MODEL_OVERRIDE + ANTHROPIC_BASE_URL).
#  33. fix.ts: let routedFix run under a dev pin (dev pin leg: events.jsonl records a climb).
#  34. advisor_probe.ts routerAdvisorModel: always ROUTER_ADVISOR_MODEL (unit set= and the advisor leg).
#  35. supervisor.ts: drop the role value from the engine10 argv (every role e2e leg).
#   Equivalent, not killable here: childEnv sending a role pin through routerSessionPin (it differs only with the router on and the advisor
#   unavailable, which the stub does not produce); the run() cap guard (childEnv pins opts.roleModel either way).
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
need bun
need git
need python3
cd "$ROOT" || exit 2

echo "TEST: router auto preset (Haiku executes, Opus plans hard tasks, the router ladder climbs)"

FIX="$ROOT/tests/min/fixtures/e2e"
export LOKI_TS_ENTRY="$ROOT/loki-ts/dist/loki.js"
export LOKI_E10_COVERAGE_RESUME=0 # the coverage turn (default on) adds one implement session; these legs count the routed sessions, scope-and-fix owns the coverage legs
TO=(); command -v timeout >/dev/null 2>&1 && TO=(timeout 120)
TOKEN="ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab"

# --- unit: the pure decisions, through the source -------------------------------------------------------------------
U="$(cd "$ROOT/loki-ts" && env -u LOKI_SESSION_MODEL -u LOKI_MODEL_OVERRIDE -u LOKI_CLAUDE_MODEL_DEVELOPMENT -u LOKI_MODEL_DEVELOPMENT -u LOKI_ROUTER_EXECUTOR -u LOKI_ALLOW_HAIKU -u LOKI_IMPLEMENT_HAIKU_FIRST -u LOKI_COST_PROFILE LOKI_ROUTER=auto \
  LOKI_DIR="$T/unit-loki" TOKEN="$TOKEN" bun -e '
import { routerMode, presetExecutor } from "./src/runner/router/flag.ts";
import { routeRecord, routedFix, routerActive } from "./src/runner/router/unit_model.ts";
import { hardReason, sizeTask } from "./src/engine10/sizing.ts";
import { buildSdkLoopOptions, compactWindowSettings, engine10SessionTitle } from "./src/runner/providers.ts";
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
{ const saved = process.env.LOKI_ROUTER; delete process.env.LOKI_ROUTER; // router off: the window does not depend on the router
  out.push(`sdkwin=${["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"].map((m) => buildSdkLoopOptions({ tier: "development", model: m, cwd: "/nonexistent" }).settings?.autoCompactWindow ?? "none").join(",")}`);
  { const fs = await import("node:fs"), src = fs.readFileSync("./src/runner/providers.ts", "utf8"); // EXP-0002b: a title in the SDK query options skips the uncached Haiku title call
    out.push(`sdktitle=${engine10SessionTitle({ LOKI_E10_STAGE: "plan" }, "x\n<<<TASK\nfix the off-by-one\nin paginate() please " + "y".repeat(80) + "\nTASK\nmore")}|${engine10SessionTitle({ LOKI_E10_STAGE: "intake" }, "no task block")}|${engine10SessionTitle({}, "<<<TASK\nz\nTASK")}|${/includePartialMessages: true,[^\n]*\n\s*\.\.\.\(engine10SessionTitle\(process\.env, call\.prompt\) \? \{ title: engine10SessionTitle\(process\.env, call\.prompt\) \}/.test(src)}`); }
  out.push(`win=${["haiku", "sonnet", "opus", "openrouter/x/y"].map((m) => (compactWindowSettings(m)?.autoCompactWindow ?? "none") + "/" + (compactWindowSettings(m, true)?.autoCompactWindow ?? "none")).join(",")}`);
  process.env.LOKI_ROUTER = saved; }
out.push(`kept=${routerKeptNote("--haiku", { LOKI_ROUTER: "1" }) !== ""}:${routerKeptNote("--haiku", { LOKI_ROUTER: "auto" })}:${routerKeptNote("--haiku", {})}`);
const errs = []; const pe = {}; const saved = process.env.LOKI_ROUTER; process.env.LOKI_ROUTER = "1";
parseStartArgs(["--haiku", "--cost", "lean", "task"], (x) => errs.push(x), () => {}, (k, v) => { pe[k] = v; }); process.env.LOKI_ROUTER = saved;
out.push(`tsnote=${errs.filter((e) => e.includes("is already set and wins")).length}:${pe.LOKI_ROUTER ?? "unset"}`);
const { wallModel, wallFirstModel } = await import("./src/engine10/sizing.ts"); const { modelDowngrades } = await import("./src/runner/model_downgrades.ts");
const fam = (m) => (m.match(/haiku|sonnet|opus/) ?? [m])[0], A = { LOKI_ROUTER: "auto", LOKI_E10_WALL: "1" };
out.push(`wall:preset=${fam(wallModel(A))}:${fam(wallFirstModel("large", A))}:${fam(wallFirstModel("small", { ...A, LOKI_E10_WALL_CONCURRENT: "0" }))}`, `wall:off=${fam(wallModel({}))}`, `wall:nohaiku=${fam(wallModel({ ...A, LOKI_ALLOW_HAIKU: "false" }))}`, `wall:tier=${fam(wallModel({ ...A, LOKI_E10_WALL_TIER: "sonnet" }))}`, `wall:override=${fam(wallModel({ ...A, LOKI_MODEL_OVERRIDE: "sonnet" }))}`, `wall:sesspin=${fam(wallModel({ ...A, LOKI_SESSION_MODEL: "sonnet" }))}`);
out.push(`wall:why=${modelDowngrades("claude", A).find((d) => d.stage === "wall")?.reason}`);
const { checkAlreadyDone } = await import("./src/engine10/already_done.ts"); const { cascadeImplementModel } = await import("./src/engine10/sizing.ts");
const adModel = async (env) => { const saved = { ...process.env }; Object.assign(process.env, env); const seen = []; const ctx = { model: "claude (provider default)", runId: "r", repoDir: "/nonexistent", sessions: { run: async (o) => { seen.push(o.model); return { markers: { alreadyDone: null } }; } } };
  await checkAlreadyDone(ctx, new AbortController().signal, "add frobnicate", { files: ["src/f.ts"], entries: [{ path: "src/f.ts", symbols: ["frobnicate"] }], truncated: false }, { runners: ["bun"], tests: [{ runner: "bun", path: "tests/frobnicate.test.ts" }] });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); return seen.map(fam).join(",") || "none"; };
out.push(`ad:preset=${await adModel({})}`, `ad:tier=${await adModel({ LOKI_E10_WALL_TIER: "haiku" })}`, `ad:why=${modelDowngrades("claude", A).find((d) => d.stage === "already_done")?.reason}`, `cascade=${fam(cascadeImplementModel(A))}`);
console.log(out.join(" "));
' 2>&1)"
want="mode=auto exec=haiku nohaiku=sonnet fixed=sonnet record=preset:claude-haiku-5-5:true hard:bigrepo=null hard:names4=null hard:names5=true hard:large=task sized large hard:trunc=null hard:spelled3=null hard:suffix=null hard:mono1=null hard:mono5=true hard:dot5=true hard:updir5=null size:mono9=normal size:spelled9=large nodescend=claude-sonnet-5-5 climb1=claude-sonnet-5-5 redact=false scopeoff=null fixadv=opus router1floor=sonnet pin=false devpin=false opusadv=null opusadv1=opus adc=claude-sonnet-5-5 sdkwin=100000,none,none sdktitle=loki plan: fix the off-by-one in paginate() please yyyyyyyyyyyyyyyyyyyy|loki intake|undefined|true win=100000/100000,none/none,none/none,none/100000 kept=true:: tsnote=1:unset wall:preset=haiku:haiku:haiku wall:off=sonnet wall:nohaiku=sonnet wall:tier=sonnet wall:override=sonnet wall:sesspin=sonnet wall:why=Wall pin (LOKI_ROUTER=auto preset executor) ad:preset=sonnet ad:tier=haiku ad:why=already-done check pin cascade=sonnet"
[ "$U" = "$want" ] && ok "unit: preset executor and record, hardReason on task evidence only, never descend, redacted climb evidence, scoped advisor keeps the executor, --model and LOKI_MODEL_DEVELOPMENT pin, no opus advisor on an opus executor, an already-done claim climbs, the kept-router note, the Wall on the preset executor unless pinned" || bad "unit gave: $U"

# --- user-settings auth on the SDK route: an engine10 session loads only the project source, so the user's credential helper and auth or proxy env ------
# from ~/.claude/settings.json are carried by Loki (never other env, never over a value the process has); outside engine10 the user source is loaded.
mkdir -p "$T/ua-home/.claude"; printf '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:9","OTEL_FIXTURE_X":"no","ANTHROPIC_CUSTOM_HEADERS":"from-settings"},"apiKeyHelper":"/x/helper.sh","enabledPlugins":{"p@m":true}}\n' > "$T/ua-home/.claude/settings.json"
UA="$(cd "$ROOT/loki-ts" && env -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL -u LOKI_E10_STAGE -u CLAUDE_CONFIG_DIR -u LOKI_ROUTER HOME="$T/ua-home" ANTHROPIC_CUSTOM_HEADERS=from-env bun -e '
import { buildSdkLoopOptions } from "./src/runner/providers.ts";
const fs = await import("node:fs"), src = fs.readFileSync("./src/runner/providers.ts", "utf8");
const pick = (o) => [o.settingSources.join(","), o.settings?.apiKeyHelper ?? "none", o.settings?.enabledPlugins ? "plugins" : "noplugins", JSON.stringify(o.authEnv ?? {})].join(";");
process.env.LOKI_E10_STAGE = "implement"; const e = pick(buildSdkLoopOptions({ tier: "development", model: "claude-sonnet-5-5", cwd: "/nonexistent" }));
delete process.env.LOKI_E10_STAGE; const l = pick(buildSdkLoopOptions({ tier: "development", model: "claude-sonnet-5-5", cwd: "/nonexistent" }));
console.log(`engine=${e} legacy=${l} merge=${src.includes("for (const [k, v] of Object.entries(extra.authEnv ?? {})) if (env[k] === undefined) env[k] = v;")}`);
' 2>&1)"
[ "$UA" = 'engine=project;/x/helper.sh;noplugins;{"ANTHROPIC_BASE_URL":"http://127.0.0.1:9"} legacy=user,project,local;none;noplugins;{} merge=true' ] \
    && ok "user-settings auth (SDK route): an engine10 session carries the user's apiKeyHelper and auth or proxy env from ~/.claude/settings.json (not other env, not plugins, not over a value the process has) and merges that env under the process env; outside engine10 the user source is loaded instead" \
    || bad "user-settings auth (SDK route) gave: $UA"

# --- ROLE-MODELS unit: one model per role (util/claude_model.ts), through the source ---------------------------------------------
# No role set: every per-call model helper returns today's literal default (the byte-identical baseline); a role moves only its own calls;
# an older per-call variable still wins; parse errors refuse; opencode tool-less calls with a non-Claude role are skipped with the reason.
RU="$(cd "$ROOT/loki-ts" && env -u LOKI_MODELS -u LOKI_ROLE_PLAN -u LOKI_ROLE_DEV -u LOKI_ROLE_TEST -u LOKI_ROLE_REVIEW -u LOKI_ROLE_ADVISOR -u LOKI_ROLE_HELPER -u LOKI_ROLE_ESCALATE \
  -u LOKI_ROUTER -u LOKI_SESSION_MODEL -u LOKI_MODEL_OVERRIDE -u LOKI_MODEL_ROUTE -u LOKI_PROVIDER -u LOKI_E10_PROVIDER -u LOKI_E10_RUN_PROVIDER -u LOKI_E10_CONSULT_MODEL -u LOKI_E10_WALL_TIER LOKI_DIR="$T/role-loki" bun -e '
import { roleSettings, roleModel, roleStartLine, roleModelsReceiptBlock, stageRole, roleConflictError } from "./src/util/claude_model.ts";
import { wallModel, wallFirstModel } from "./src/engine10/sizing.ts";
import { consultModel } from "./src/features/opus_consult.ts";
import { attemptsReviewModel } from "./src/features/attempts.ts";
import { execSpecModel } from "./src/features/exec_spec.ts";
import { lineCheckModel } from "./src/engine10/stages/xreview.ts";
import { routerAdvisorModel } from "./src/runner/router/advisor_probe.ts";
import { toolLessCall } from "./src/runner/sdk_invoker.ts";
import { parseStartArgs } from "./src/commands/start.ts";
import { fixRoundModel } from "./src/engine10/stages/fix.ts";
const out = [], fam = (m) => (String(m).match(/haiku|sonnet|opus/) ?? [m])[0];
const helpers = (e) => [wallModel(e), wallFirstModel("small", e), consultModel(e), attemptsReviewModel(e), execSpecModel(e), lineCheckModel("sonnet", e), routerAdvisorModel(e)].join(",");
out.push(`none=${helpers({})}|${JSON.stringify(roleSettings({}))}|${roleStartLine({}) === ""}|${JSON.stringify(roleModelsReceiptBlock({}))}`);
const R = { LOKI_MODELS: "plan=opus,dev=haiku,test=sonnet,review=sonnet,advisor=sonnet,helper=haiku", LOKI_ROLE_DEV: "sonnet" };
out.push(`set=${helpers(R).split(",").map(fam).join(",")}|dev=${fam(roleModel("dev", R))}|plan=${fam(roleModel("plan", R))}`);
out.push(`narrow=${consultModel({ ...R, LOKI_E10_CONSULT_MODEL: "claude-opus-5-5" })}:${fam(wallModel({ ...R, LOKI_E10_WALL_TIER: "haiku" }))}`);
out.push(`line=${roleStartLine({ LOKI_ROLE_PLAN: "opus", LOKI_ROLE_DEV: "haiku" }, "claude")}`);
out.push(`route=${roleModel("plan", { LOKI_ROLE_PLAN: "opus", LOKI_MODEL_ROUTE: "openrouter/x/y" }, "claude") ?? "inert"}`);
const refuse = (e) => { try { roleSettings(e); return "accepted"; } catch (x) { return "refused"; } };
out.push(`refuse=${[{ LOKI_MODELS: "chef=opus" }, { LOKI_MODELS: "plan" }, { LOKI_ROLE_TEST: "so net" }, { LOKI_ROLE_PLAN: "fable" }, { LOKI_ROLE_TEST: "gpt-5" }].map(refuse).join(",")}`);
out.push(`ceil=${roleConflictError({ LOKI_MAX_TIER: "sonnet", LOKI_ROLE_PLAN: "opus" }, "claude") !== null}:${roleConflictError({ LOKI_MAX_TIER: "sonnet", LOKI_ROLE_PLAN: "haiku" }, "claude")}:${roleConflictError({ LOKI_ROLE_PLAN: "opus" }, "claude")}:${roleConflictError({ LOKI_MAX_TIER: "opus", LOKI_ROLE_DEV: "claude-fable-5-2" }, "claude") !== null}:${roleConflictError({ LOKI_MAX_TIER: "fable", LOKI_ROLE_DEV: "fable" }, "claude")}`, `routeconf=${roleConflictError({ LOKI_MODEL_ROUTE: "openrouter/x/y", LOKI_ROLE_PLAN: "opus" }, "claude") !== null}:${roleConflictError({ LOKI_MODEL_ROUTE: "openrouter/x/y" }, "claude")}`);
out.push(`stages=${["plan", "wall", "prove", "intake", "implement", "fix"].map(stageRole).join(",")}`);
process.env.LOKI_E10_RUN_PROVIDER = "opencode"; process.env.LOKI_ROLE_REVIEW = "openai/gpt-5"; const oc = await toolLessCall({ model: "openai/gpt-5", prompt: "x", maxTokens: 10, thinking: "off" }); delete process.env.LOKI_E10_RUN_PROVIDER; delete process.env.LOKI_ROLE_REVIEW; // the role names the model, so no request is sent
out.push(`oc=${oc.outcome.kind}`, `skipped=${JSON.stringify(roleModelsReceiptBlock({}).tool_calls_skipped)}`);
const pe = {}, errs = []; const rc = parseStartArgs(["task", "--plan-model", "opus", "--models=dev=haiku,escalate=opus", "--dry-run"], (x) => errs.push(x), () => {}, (k, v) => { pe[k] = v; });
const bad = parseStartArgs(["task", "--test-model", "so net"], (x) => errs.push(x), () => {}, () => {});
out.push(`start=${pe.LOKI_ROLE_PLAN}:${pe.LOKI_MODELS}:${typeof rc === "number" ? rc : "opts"}:${bad}`);
const fx = (env, rep) => fam(fixRoundModel("claude (provider default)", rep, false, 1, env).pinnedModel ?? "run");
out.push(`fix=${fx({}, true)},${fx({}, false)},${fx({ LOKI_ROLE_DEV: "haiku" }, true)},${fx({ LOKI_ROLE_DEV: "haiku", LOKI_ROLE_ESCALATE: "opus" }, true)},${fx({ LOKI_ROLE_DEV: "haiku", LOKI_ROLE_ESCALATE: "opus" }, false)},${fx({ LOKI_ROLE_ESCALATE: "sonnet" }, true)}`);
console.log(out.join(" "));
' 2>&1)"
RWANT='none=claude-sonnet-5-5,claude-sonnet-5-5,claude-opus-5-5,claude-sonnet-5-5,haiku,claude-sonnet-5-5,opus|{}|true|{} set=sonnet,sonnet,sonnet,sonnet,sonnet,sonnet,sonnet|dev=sonnet|plan=opus narrow=claude-opus-5-5:haiku line=models: plan opus, dev haiku, test auto, review auto, advisor auto, helper auto, escalate none route=inert refuse=refused,refused,refused,accepted,accepted ceil=true:null:null:true:null routeconf=true:null stages=plan,test,test,helper,dev,dev oc=unsupported skipped=[{"call":"toolless","reason":"openai/gpt-5 is not a Claude model and this call runs on the Anthropic API only (opencode run)"}] start=opus:dev=haiku,escalate=opus:opts:2 fix=opus,run,haiku,opus,haiku,sonnet'
[ "$RU" = "$RWANT" ] && ok "role unit: no role keeps every per-call default; a role moves its calls; older per-call vars win; LOKI_ROLE_<R> beats LOKI_MODELS; inert under a route; bad values refused; a role above LOKI_MAX_TIER or under LOKI_MODEL_ROUTE refused; opencode non-Claude tool-less call skipped and its reason recorded for the receipt; start flags export; fix escalates to opus only with no dev pin, to escalate= when set, never under a bare dev pin" \
    || { bad "role unit gave: $RU"; printf '    want: %s\n' "$RWANT"; }
RW="$(cd "$ROOT/loki-ts" && env -u LOKI_MODELS -u LOKI_ROLE_PLAN -u LOKI_ROLE_DEV -u LOKI_ROLE_ESCALATE -u LOKI_ROUTER -u LOKI_SESSION_MODEL -u LOKI_MODEL_OVERRIDE -u LOKI_MODEL_DEVELOPMENT -u LOKI_ALLOW_HAIKU bun -e '
import { withRoleModel, childEnv, startedModelOf } from "./src/engine10/session.ts";
process.env.LOKI_ROLE_DEV = "haiku"; process.env.LOKI_ROLE_ESCALATE = "opus"; process.env.LOKI_ROLE_PLAN = "openai/gpt-5";
const fam = (m) => (String(m).match(/haiku|sonnet|opus/) ?? [m])[0];
const w1 = withRoleModel({ stage: "fix", tier: "development", role: "escalate" }, "claude"), w2 = withRoleModel({ stage: "fix", tier: "development", model: "claude-opus-5-5" }, "claude");
const oc = childEnv({ ...withRoleModel({ stage: "plan", tier: "fast", brief: "b" }, "opencode"), iterationId: "x", limitS: 5 }, { provider: "opencode" });
const cl = childEnv({ ...withRoleModel({ stage: "fix", tier: "development", brief: "b" }, "claude"), iterationId: "x", limitS: 5 }, { provider: "claude" });
delete process.env.LOKI_ROLE_DEV; delete process.env.LOKI_ROLE_ESCALATE; delete process.env.LOKI_ROLE_PLAN;
const none = withRoleModel({ stage: "fix", tier: "development", model: "m" }, "claude");
console.log(`wire=${fam(w1.model)},${fam(w2.model)},${oc.LOKI_OPENCODE_MODEL},${oc.LOKI_E10_ROLE_MODEL ?? "unset"},${fam(cl.LOKI_E10_ROLE_MODEL)},${none.model}:${none.roleModel ?? "none"} started=${startedModelOf({ stage: "plan", tier: "fast" }, "claude", { LOKI_MODEL_DEVELOPMENT: "opus" })},${startedModelOf({ stage: "implement", tier: "development" }, "claude", { LOKI_MODEL_DEVELOPMENT: "opus" })}`);' 2>&1)"
[ "$RW" = "wire=opus,haiku,openai/gpt-5,unset,haiku,m:none started=sonnet,opus" ] \
    && ok "role wiring: an escalate round runs the escalate role, a dev pin replaces a stage pin, opencode gets the role as LOKI_OPENCODE_MODEL, claude as LOKI_E10_ROLE_MODEL; no role leaves the call alone; the receipt names an unpinned plan by its fast tier" \
    || bad "role wiring gave: $RW"
# ROLE-MODELS: on the claude provider a role value is haiku|sonnet|opus or a catalog id; a typo or another vendor's id exits 2 naming the nearest id.
# `loki start --dry-run` runs the same check and prints the same models line as the real start.
mkdir -p "$T/dry"
dry() { (cd "$T/dry" && env -u LOKI_PROVIDER -u LOKI_MODELS -u LOKI_ROLE_DEV -u LOKI_ROLE_PLAN -u LOKI_MODEL_ROUTE -u LOKI_MAX_TIER bash "$ROOT/bin/loki" start "add a multiply fn" "$@" --dry-run 2>&1); printf 'rc=%s' "$?"; }
DT=""; for v in sonet opsu claude-sonet-5-5 gpt-5; do o="$(dry --dev-model "$v")"; case "$o" in *"role dev: unknown model '$v'"*"nearest: "*rc=2) DT="$DT $v:2" ;; *) DT="$DT $v:${o##*rc=}" ;; esac; done
[ "$DT" = " sonet:2 opsu:2 claude-sonet-5-5:2 gpt-5:2" ] && ok "role typos: sonet, opsu, claude-sonet-5-5 and gpt-5 exit 2 at the dry-run preflight, naming the role, the value and the nearest known id" || bad "role typos gave:$DT"
o="$(dry --dev-model claude-sonet-5-5)"; has "role typos: claude-sonet-5-5 names claude-sonnet-5-5 as the nearest id" "$o" "nearest: claude-sonnet-5-5"
DV=""; for v in claude-opus-5-5 claude-sonnet-5-5 claude-haiku-5-5 claude-fable-5-2 claude-fable-5-1 haiku fable; do o="$(dry --dev-model "$v")"; DV="$DV $v:${o##*rc=}"; done
[ "$DV" = " claude-opus-5-5:0 claude-sonnet-5-5:0 claude-haiku-5-5:0 claude-fable-5-2:0 claude-fable-5-1:0 haiku:0 fable:0" ] && ok "role ids: catalog ids (claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, claude-fable-5-2, claude-fable-5-1) and the aliases, fable included, pass the dry-run" || bad "role ids gave:$DV"
o="$(dry --plan-model opus --dev-model haiku)"; has "dry-run: prints the same models line as the real start" "$o" "models: plan opus, dev haiku, test auto, review auto, advisor auto, helper auto, escalate none"
o="$(dry --dev-model openrouter/a/b)"; has "role ids: a route id on the claude provider exits 2 (a route covers the whole run)" "$o" "'openrouter/a/b' is a route"
o="$(dry --provider opencode --dev-model openrouter/deepseek/deepseek-v3.2)"; case "$o" in *"models: plan auto, dev openrouter/deepseek/deepseek-v3.2"*"opencode checks the ids"*rc=0) ok "role ids on opencode: passed through as given, and the models line says opencode checks them" ;; *) bad "role ids on opencode gave: $(printf '%s' "$o" | tail -4 | tr '\n' '|')" ;; esac
RF="$(cd "$ROOT/loki-ts" && env -u ANTHROPIC_API_KEY bun -e '
import { toolLessCall, __setSdkClientForTests, __setTokenCounterForTests } from "./src/runner/sdk_invoker.ts";
__setTokenCounterForTests(async () => 10); const seen = [];
__setSdkClientForTests({ messages: { create: async (b) => { seen.push(b.model); return /fable/.test(b.model) ? { stop_reason: "refusal", content: [], usage: { input_tokens: 1, output_tokens: 0 }, model: b.model, stop_details: { category: "cyber" } } : { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 }, model: b.model }; } } });
const r = await toolLessCall({ model: "claude-fable-5-2", prompt: "x", maxTokens: 50, thinking: "off" });
console.log(`${r.outcome.kind}:${r.outcome.category} ${seen.join(",")}`);' 2>&1)"
[ "$RF" = "loki: claude-fable-5-2 on the raw API: refused (cyber) (not retried on another model)
refused:cyber claude-fable-5-2" ] && ok "fable raw API: a refused Fable call is reported with the API's reason on stderr and never re-run (no server-side fallback to another model)" || bad "fable raw API gave: $RF"
RT="$(env -u LOKI_ENGINE bash -c '. "$1/providers/loader.sh"; . "$1/autonomy/route.sh"; loki_route_dispatch start "add multiply" --plan-model opus --models dev=haiku --no-pr 2>/dev/null; printf "%s|%s|%s|%s" "$R_ENGINE" "${R_ROLE_ENV[*]}" "${R_E10_ARGS[*]}" "$R_ERR"; loki_route_dispatch start "add multiply" --dev-model haiku --engine legacy 2>/dev/null; printf " legacy=%s" "${R_ERR:0:40}"' _ "$ROOT" 2>&1)"
[ "$RT" = "engine10|LOKI_ROLE_PLAN=opus LOKI_MODELS=dev=haiku|add multiply --no-pr| legacy=loki: per-role model flags (--plan-model" ] \
    && ok "route.sh: role flags stay on engine10 as LOKI_ROLE_<R>/LOKI_MODELS (their values are never a task word); the legacy engine refuses them" || bad "route.sh role flags gave: $RT"

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
        "$@" ${TO[@]+"${TO[@]}"} bash "$ROOT/bin/loki" ${START_VERB:+"$START_VERB"} "$task" --no-pr ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} 2>&1)" # START_VERB=start: the `loki start` route (route.sh, the --model rewrite)
    RUNDIR=""
    if [ -f "$REPO/.loki/engine.json" ]; then
        rid="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$REPO/.loki/engine.json" 2>/dev/null)"
        [ -n "$rid" ] && RUNDIR="$REPO/.loki/runs/$rid"
    fi
}
outcome() { printf '%s\n' "$OUT" | sed -n 's/^Outcome:[[:space:]]*\([A-Z_]*\).*/\1/p' | head -1; }
dump() { printf '%s\n' "$OUT" | tail -12 | sed 's/^/    | /'; sed 's/^/    route | /' "$ROUTES"; }
fam() { sed 's/^claude-\([a-z]*\)-.*/\1/'; }
# The SR pre-delivery review (LOKI_E10_SELF_REVIEW, iteration suffix -rv) resumes the implement session it reviews, so it is left out of a stage's
# session list; rv_of lists those resumes, and the routing contract (the review runs on the model it resumes) is checked on its own.
model_of() { awk -v s="$1" '$1 == s && $2 !~ /-rv$/ { sub(/^model=/, "", $3); print $3 }' "$ROUTES" | fam | tr '\n' ' ' | sed 's/ $//'; } # models of one engine stage, in order
rv_of() { awk -v s="$1" '$1 == s && $2 ~ /-rv$/ { sub(/^model=/, "", $3); print $3 }' "$ROUTES" | fam | tr '\n' ' ' | sed 's/ $//'; } # models of the SR review resumes of that stage
win_of() { awk -v s="$1" '$1 == s && $2 !~ /-rv$/ { sub(/^window=/, "", $6); print $6 }' "$ROUTES" | tr '\n' ' ' | sed 's/ $//'; } # T036: autoCompactWindow per session
adv_of() { awk -v s="$1" '$1 == s && $2 !~ /-rv$/ { sub(/^advisor=/, "", $4); print $4 }' "$ROUTES" | tr '\n' ' ' | sed 's/ $//'; }
route_block() { [ -n "$RUNDIR" ] && python3 -I -c 'import json,sys
r=json.load(open(sys.argv[1])).get("route")
print("none" if r is None else str(r.get("executor")) + "|" + str(r.get("source")))' "$RUNDIR/receipt.json" 2>/dev/null; }
TASK="add a multiply(a, b) function to calc.ts"

run_engine "$TASK" E2E_STUB_MODE=done
[ "$(model_of implement)" = "haiku" ] && ok "small: implement ran on haiku" || { bad "small: implement on '$(model_of implement)'"; dump; }
case "$(rv_of implement)" in "") ok "small: no SR review resume ran" ;; haiku) ok "small: the SR review resume ran on the routed implement model (haiku)" ;; *) bad "small: SR review resume on '$(rv_of implement)', not the routed haiku" ;; esac
[ -z "$(model_of plan)" ] && ok "small: no plan session (the task is not hard)" || { bad "small: a plan session ran"; dump; }
[ "$(adv_of implement)" = "none" ] && ok "small: implement carried no advisor" || bad "small: implement advisor '$(adv_of implement)'"
[ "$(win_of implement)" = "100000" ] && ok "small: the haiku implement with no advisor still carries the 100K compact window (T036)" || { bad "small: implement window '$(win_of implement)'"; dump; }
[ "$(outcome)" = "VERIFIED" ] && ok "small: run is VERIFIED" || { bad "small: outcome '$(outcome)'"; dump; }
has "small: the start line names the auto preset" "$OUT" "route: auto preset"
has "small: the start line names the haiku downgrade" "$OUT" "implement,fix claude-haiku-5-5 (LOKI_ROUTER=auto preset"
case "$(route_block)" in *haiku*"|preset") ok "small: the receipt route block records executor haiku, source preset" ;; *) bad "small: route block is '$(route_block)'" ;; esac

run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=fixit
[ "$(model_of fix)" = "sonnet" ] && ok "fix: the code-owned failure climbed the fix round to sonnet" || { bad "fix: fix on '$(model_of fix)'"; dump; }
[ "$(adv_of fix)" = "opus" ] && ok "fix: the fix round carried the opus advisor" || bad "fix: fix advisor '$(adv_of fix)'"
[ "$(win_of fix)" = "none" ] && [ "$(win_of implement)" = "100000" ] && ok "fix: the sonnet fix round has no compact window, the haiku implement has it" || { bad "fix: windows implement='$(win_of implement)' fix='$(win_of fix)'"; dump; }
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
prompts="$(cat "$(dirname "$ROUTES")"/prompt.* 2>/dev/null)"
[ "$(printf '%s\n' "$prompts" | grep -c 'An earlier session claimed LOKI_ALREADY_DONE')" = 1 ] && ok "already: the sonnet redo's brief carries the already-done challenge (no extra session)" || { bad "already: the redo brief has no challenge"; dump; }
run_engine "$TASK" E2E_STUB_MODE=redothenempty
prompts="$(cat "$(dirname "$ROUTES")"/prompt.* 2>/dev/null)"
has "already: an empty-done correction after the redo carries the challenge" "$prompts" "Before you claim LOKI_ALREADY_DONE: A task's example code"
case "$prompts" in *"You finished with LOKI_ALREADY_DONE"*) bad "already: a separate challenge session ran after the redo" ;; *) ok "already: no separate challenge session after the redo" ;; esac

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

run_engine "$TASK" E2E_STUB_MODE=done LOKI_E10_PLAN=1 LOKI_E10_WALL=1 # the Wall session is off by default; these legs exercise it
[ "$(model_of wall)" = "haiku" ] && ok "wall: the Wall author ran on the preset executor (haiku)" || { bad "wall: Wall author on '$(model_of wall)'"; dump; }
[ "$(outcome)" = "VERIFIED" ] && ok "wall: run is VERIFIED" || { bad "wall: outcome '$(outcome)'"; dump; }
has "wall: the start line names the Wall downgrade and its reason" "$OUT" "LOKI_ROUTER=auto preset executor"
run_engine "$TASK" E2E_STUB_MODE=done LOKI_E10_PLAN=1 LOKI_E10_WALL=1 LOKI_E10_WALL_TIER=sonnet
[ "$(model_of wall)" = "sonnet" ] && ok "wall: LOKI_E10_WALL_TIER=sonnet still pins the Wall author" || { bad "wall: pinned Wall author on '$(model_of wall)'"; dump; }

run_engine "$TASK" E2E_STUB_MODE=wallphantom E2E_STUB_FIX=wallconflict E2E_STUB_WALL_SLEEP=3 LOKI_E10_PLAN=1 LOKI_E10_WALL=1
ref="$(awk '$2 ~ /-wa$/ { sub(/^model=/, "", $3); print $3 }' "$ROUTES" | fam | tr '\n' ' ' | sed 's/ $//')"
auth="$(awk '$1 == "wall" && $2 !~ /-wa$/ { sub(/^model=/, "", $3); print $3 }' "$ROUTES" | fam | tr '\n' ' ' | sed 's/ $//')"
[ "$auth" = "haiku" ] && [ "$ref" = "sonnet" ] && ok "wall: a Haiku Wall's conflict is refereed on sonnet (the judge tier)" || { bad "wall: Wall author '$auth', referee '$ref'"; dump; }

# --- ROLE-MODELS e2e: what the stub provider receives per session (--model on its argv, advisorModel in --settings) --------------
norm() { sed -E 's/e10-[0-9TZ]+-[0-9a-f]+//' "$ROUTES"; }
head3() { printf '%s\n' "$OUT" | sed -n '1,3p' | sed -E 's/e10-[0-9TZ]+-[0-9a-f]+//g'; } # sed -n reads all input: no early-exit reader under pipefail
run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=fixit LOKI_ROUTER= LOKI_E10_PLAN=1 LOKI_E10_WALL=1
R0="$(norm)"; H0="$(head3)"; rcpt_none() { python3 -I -c 'import json,sys; print("absent" if "models_by_role" not in json.load(open(sys.argv[1])) else "present")' "$RUNDIR/receipt.json" 2>/dev/null; }
run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=fixit LOKI_ROUTER= LOKI_E10_PLAN=1 LOKI_E10_WALL=1 LOKI_MODELS= LOKI_ROLE_PLAN= LOKI_ROLE_DEV= LOKI_ROLE_TEST= LOKI_ROLE_REVIEW= LOKI_ROLE_ADVISOR= LOKI_ROLE_HELPER= LOKI_ROLE_ESCALATE=
[ "$(norm)" = "$R0" ] && [ "$(head3)" = "$H0" ] && [ -n "$R0" ] && ok "roles unset: empty role vars give the same sessions, models and start header as none (no models line: $(printf '%s' "$OUT" | grep -c '^models:'))" \
    || { bad "roles unset: sessions or header differ"; printf '%s\n' "$R0" | sed 's/^/    before | /'; dump; }
case "$H0" in *"models:"*) bad "roles unset: the start header has a models line" ;; *) ok "roles unset: the start header has no models line" ;; esac
[ "$(rcpt_none)" = "absent" ] && ok "roles unset: the receipt has no models_by_role key (receipt bytes unchanged)" || bad "roles unset: models_by_role '$(rcpt_none)'"
[ "$(model_of plan) $(model_of wall) $(model_of implement) $(model_of fix)" = "sonnet sonnet sonnet sonnet" ] && ok "roles unset: plan, wall, implement and fix keep today's models (the Loki default sonnet)" || { bad "roles unset: models '$(model_of plan) $(model_of wall) $(model_of implement) $(model_of fix)'"; dump; }

EXTRA_ARGS=(--plan-model opus --test-model sonnet); run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=fixit LOKI_ROUTER= LOKI_SESSION_MODEL=haiku LOKI_E10_PLAN=1 LOKI_E10_WALL=1; EXTRA_ARGS=()
[ "$(model_of plan)" = "opus" ] && [ "$(model_of wall)" = "sonnet" ] && ok "roles mixed: --model haiku --plan-model opus --test-model sonnet: the plan runs on opus and the Wall on sonnet, above the haiku pin (never capped)" || { bad "roles mixed: plan '$(model_of plan)', wall '$(model_of wall)'"; dump; }
[ "$(model_of implement)" = "haiku" ] && [ "$(model_of fix)" = "haiku" ] && ok "roles mixed: implement and fix stay on --model haiku (dev unset)" || { bad "roles mixed: implement '$(model_of implement)', fix '$(model_of fix)'"; dump; }
has "roles mixed: the start line names the model per role" "$OUT" "models: plan opus, dev auto, test sonnet, review auto, advisor auto, helper auto, escalate auto"
[ "$(outcome)" = "VERIFIED" ] && ok "roles mixed: run is VERIFIED" || { bad "roles mixed: outcome '$(outcome)'"; dump; }
rcpt() { [ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); m=r.get("models_by_role"); print("absent" if m is None else ";".join(k + "=" + ",".join(m[k]) for k in sorted(m)))' "$RUNDIR/receipt.json" 2>/dev/null; }
[ "$(rcpt)" = "dev=haiku;plan=claude-opus-5-5;test=claude-sonnet-5-5" ] && ok "roles mixed: the receipt's models_by_role names the model each role started" || { bad "roles mixed: models_by_role '$(rcpt)'"; dump; }

EXTRA_ARGS=(--model haiku --plan-model opus); START_VERB=start run_engine "$TASK" E2E_STUB_MODE=done LOKI_ROUTER= LOKI_E10_PLAN=1; EXTRA_ARGS=()
[ "$(model_of plan)" = "opus" ] && [ "$(model_of implement)" = "haiku" ] && ok "roles via loki start: --model haiku --plan-model opus reaches engine10 through route.sh (plan opus, implement haiku)" || { bad "roles via loki start: plan '$(model_of plan)', implement '$(model_of implement)'"; dump; }
has "roles via loki start: the start line names the plan role" "$OUT" "models: plan opus, dev auto"
EXTRA_ARGS=(--test-model haiku); run_engine "$TASK" E2E_STUB_MODE=done LOKI_ROUTER= LOKI_MODEL_DEVELOPMENT=opus LOKI_E10_PLAN=1 LOKI_E10_WALL=1; EXTRA_ARGS=()
[ "$(rcpt)" = "dev=opus;plan=sonnet;test=claude-haiku-5-5" ] && [ "$(model_of plan)" = "sonnet" ] && ok "roles receipt: an unset role is recorded by the model its session ran (plan on the fast tier, sonnet, not the opus development tier)" || { bad "roles receipt: models_by_role '$(rcpt)', plan ran '$(model_of plan)'"; dump; }
EXTRA_ARGS=(--models plan=opus); run_engine "$TASK" E2E_STUB_MODE=done LOKI_ROUTER= LOKI_E10_PLAN=1; EXTRA_ARGS=()
[ "$(model_of plan)" = "opus" ] && [ "$(model_of implement)" = "sonnet" ] && ok "roles plan-only (--models plan=opus, no --model): the plan runs on opus over the default sonnet pin; implement keeps sonnet" || { bad "roles plan-only: plan '$(model_of plan)', implement '$(model_of implement)'"; dump; }

EXTRA_ARGS=(--plan-model opus); run_engine "$TASK" E2E_STUB_MODE=done LOKI_ROUTER= LOKI_E10_PLAN=1 LOKI_MODEL_OVERRIDE=claude-haiku-5-5 ANTHROPIC_BASE_URL=http://127.0.0.1:9; EXTRA_ARGS=()
[ "$(model_of plan)" = "opus" ] && [ "$(model_of implement)" = "haiku" ] && ok "roles over --model <id> with ANTHROPIC_BASE_URL: the plan role wins over LOKI_MODEL_OVERRIDE; implement keeps the override" || { bad "roles over override: plan '$(model_of plan)', implement '$(model_of implement)'"; dump; }
EXTRA_ARGS=(--dev-model haiku); run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=fixit; EXTRA_ARGS=()
[ "$(model_of implement)" = "haiku" ] && [ "$(model_of fix)" = "haiku" ] && ok "roles dev pin under the auto preset: the code-owned failure does not climb the fix round (exact pin, no surprise model)" || { bad "roles dev pin: implement '$(model_of implement)', fix '$(model_of fix)'"; dump; }
! grep -q '"route.escalated"' "$RUNDIR/events.jsonl" 2>/dev/null && grep -q '"type":"fix.round".*"model":"claude-haiku-5-5"' "$RUNDIR/events.jsonl" 2>/dev/null \
    && ok "roles dev pin: the run record names no climb and the fix round's recorded model is the pin" || { bad "roles dev pin: events.jsonl records a climb or another fix model"; grep -E '"route.escalated"|"fix.round"' "$RUNDIR/events.jsonl" 2>/dev/null | cut -c1-200 | sed 's/^/    | /'; }
EXTRA_ARGS=(--advisor-model sonnet); run_engine "$TASK" E2E_STUB_MODE=wrong E2E_STUB_FIX=fixit; EXTRA_ARGS=()
[ "$(adv_of fix)" = "sonnet" ] && [ "$(model_of fix)" = "sonnet" ] && ok "roles advisor: the router advisor attached to the fix round is the advisor role (sonnet), the ladder is unchanged" || { bad "roles advisor: fix '$(model_of fix)' advisor '$(adv_of fix)'"; dump; }
EXTRA_ARGS=(--dev-model claude-fable-5-2 --plan-model claude-opus-5-5); run_engine "$TASK" E2E_STUB_MODE=done LOKI_ROUTER= LOKI_E10_PLAN=1 LOKI_MAX_TIER=fable; EXTRA_ARGS=()
raw_of() { awk -v s="$1" '$1 == s && $2 !~ /-rv$/ { sub(/^model=/, "", $3); print $3 }' "$ROUTES" | tr '\n' ' ' | sed 's/ $//'; }
[ "$(raw_of plan)" = "claude-opus-5-5" ] && [ "$(raw_of implement)" = "claude-fable-5-2" ] && ok "roles full id: a catalog model id a role names reaches the provider exactly (no alias rewrite, no tier clamp under LOKI_MAX_TIER=fable)" || { bad "roles full id: plan '$(raw_of plan)', implement '$(raw_of implement)'"; dump; }
# FABLE: --model fable and --session-model fable run fable on engine10 (the opus collapse was removed; the legacy bash engine keeps it).
EXTRA_ARGS=(--model fable); START_VERB=start run_engine "$TASK" E2E_STUB_MODE=done LOKI_ROUTER= LOKI_E10_PLAN=1; EXTRA_ARGS=()
[ "$(raw_of plan)" = "fable" ] && [ "$(raw_of implement)" = "fable" ] && ok "fable: loki start --model fable sends fable to the provider for plan and implement, never opus" || { bad "fable: plan '$(raw_of plan)', implement '$(raw_of implement)'"; dump; }
run_engine "$TASK" E2E_STUB_MODE=done LOKI_ROUTER= LOKI_SESSION_MODEL=fable
[ "$(raw_of implement)" = "fable" ] && ! grep -q 'model=[^ ]*opus' "$ROUTES" && ok "fable: LOKI_SESSION_MODEL=fable runs fable (no session on opus)" || { bad "fable: session pin gave implement '$(raw_of implement)'"; dump; }
EXTRA_ARGS=(--dev-model fable); run_engine "$TASK" E2E_STUB_MODE=done LOKI_ROUTER= ANTHROPIC_API_KEY=sk-ant-fake-for-the-stub; EXTRA_ARGS=()
has "fable: with an API key the start line says fable on the raw API is not verified" "$OUT" "fable on the raw API is not verified; a refused call is reported, never swapped for another model"
[ "$(raw_of implement)" = "claude-fable-5-2" ] && [ -n "$RUNDIR" ] && python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r.get("fable_raw_api","").startswith("fable on the raw API is not verified") else 1)' "$RUNDIR/receipt.json" \
    && ok "fable: the dev role runs claude-fable-5-2 and the receipt carries the raw-API note" || { bad "fable: implement '$(raw_of implement)' or no fable_raw_api in the receipt"; dump; }
EXTRA_ARGS=(--plan-model opus); run_engine "$TASK" E2E_STUB_MODE=done LOKI_ROUTER= LOKI_E10_PLAN=1 LOKI_MODEL_ROUTE=openrouter/x/y; EXTRA_ARGS=()
has "roles under a route: a Claude role with LOKI_MODEL_ROUTE exits before any session, naming the role" "$OUT" "role plan names opus, but LOKI_MODEL_ROUTE=openrouter/x/y serves every call of the run"
[ ! -s "$ROUTES" ] && ok "roles under a route: no session started" || { bad "roles under a route: sessions ran"; dump; }
EXTRA_ARGS=(--dev-model "so net"); run_engine "$TASK" E2E_STUB_MODE=done LOKI_ROUTER=; EXTRA_ARGS=()
has "roles refused: a bad role value exits before any session" "$OUT" "engine10: bad model 'so net' for role dev"
[ ! -s "$ROUTES" ] && ok "roles refused: no session started" || { bad "roles refused: sessions ran"; dump; }
EXTRA_ARGS=(--dev-model sonet); run_engine "$TASK" E2E_STUB_MODE=done LOKI_ROUTER=; EXTRA_ARGS=()
has "roles typo on a real run: --dev-model sonet exits before any session, naming the nearest id" "$OUT" "engine10: role dev: unknown model 'sonet' on the claude provider; use haiku, sonnet, opus or fable, or a model id from the catalog (nearest: sonnet)"
[ ! -s "$ROUTES" ] && ok "roles typo on a real run: no session started" || { bad "roles typo on a real run: sessions ran"; dump; }

finish
